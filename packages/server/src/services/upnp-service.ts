import dgram from 'node:dgram';
import net from 'node:net';
import type {
  GameTemplate,
  ServerInstance,
  UpnpExistingRouterMapping,
  UpnpInstanceStatus,
  UpnpMappingRecord,
  UpnpMode,
  UpnpPortMapAttempt,
  UpnpProtocolKind,
  UpnpRouterInfo,
} from '@serverforge/shared';
import type { CatalogService } from '../catalog/catalog-service.js';
import type { AppConfig } from '../config.js';
import type { AppDatabase } from '../db/database.js';
import { getExternalPortSpecs, sanitizeFirewallLabel, validatePortNumber } from './firewall-service.js';
import type { NetworkAddressService } from './network-service.js';

const SSDP_MULTICAST_ADDR = '239.255.255.250';
const SSDP_PORT = 1900;
const NAT_PMP_PORT = 5351;
const DEFAULT_LEASE_SECONDS = 3600;
const RENEW_INTERVAL_MS = 25 * 60_000;

const SSDP_SEARCH_TARGETS = [
  'urn:schemas-upnp-org:device:InternetGatewayDevice:2',
  'urn:schemas-upnp-org:device:InternetGatewayDevice:1',
  'urn:schemas-upnp-org:service:WANIPConnection:2',
  'urn:schemas-upnp-org:service:WANIPConnection:1',
  'urn:schemas-upnp-org:service:WANPPPConnection:1',
];

const SUPPORTED_SERVICE_TYPES = [
  'urn:schemas-upnp-org:service:WANIPConnection:2',
  'urn:schemas-upnp-org:service:WANIPConnection:1',
  'urn:schemas-upnp-org:service:WANPPPConnection:1',
];

export interface ParsedIgdDescriptor {
  friendlyName: string | null;
  modelName: string | null;
  routerIp: string;
  serviceType: string;
  controlUrl: string;
  protocol: 'upnp-igd-v2' | 'upnp-igd-v1';
}

export interface UpnpSoapError {
  code: string;
  description: string;
  friendlyMessage: string;
}

export interface UpnpServiceOptions {
  fetchImpl?: typeof fetch;
  ssdpDiscoverImpl?: () => Promise<string[]>;
  natPmpRequestImpl?: (gatewayIp: string, packet: Buffer) => Promise<Buffer | null>;
  disableNetworkDiscovery?: boolean;
  leaseDurationSeconds?: number;
}

/**
 * Strictly checks whether an IPv4 address is a private RFC1918 LAN IP
 * (10.0.0.0/8, 172.16.0.0/12, 192.168.0.0/16).
 * Used as an SSRF guard so UPnP SSDP discovery never fetches public URLs or localhost.
 */
export function isPrivateLanIpv4(host: string): boolean {
  const clean = host.trim().replace(/^\[|\]$/g, '');
  if (net.isIP(clean) !== 4) return false;
  const [a, b] = clean.split('.').map(Number);
  if (a === 10) return true;
  if (a === 192 && b === 168) return true;
  if (a === 172 && b >= 16 && b <= 31) return true;
  return false;
}

function escapeXml(raw: string): string {
  return raw
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

function extractXmlTag(xml: string, tagName: string): string | null {
  const re = new RegExp(`<(?:[a-z0-9_-]+:)?${tagName}\\b[^>]*>([\\s\\S]*?)<\\/(?:[a-z0-9_-]+:)?${tagName}>`, 'i');
  const match = re.exec(xml);
  return match ? match[1].trim() : null;
}

/**
 * Parses a UPnP IGD device description XML document and extracts the preferred
 * WANIPConnection / WANPPPConnection control URL (validating same-LAN-router host).
 */
export function parseIgdDeviceDescription(
  xml: string,
  locationUrl: string
): ParsedIgdDescriptor | null {
  let baseUrl: URL;
  try {
    baseUrl = new URL(locationUrl);
  } catch {
    return null;
  }
  if ((baseUrl.protocol !== 'http:' && baseUrl.protocol !== 'https:') || !isPrivateLanIpv4(baseUrl.hostname)) {
    return null;
  }

  const friendlyName = extractXmlTag(xml, 'friendlyName');
  const modelName = extractXmlTag(xml, 'modelName');

  const serviceBlocks = xml.match(/<service\b[^>]*>[\s\S]*?<\/service>/gi) ?? [];
  const candidates: Array<{ serviceType: string; controlUrl: string; priority: number }> = [];

  for (const block of serviceBlocks) {
    const serviceType = extractXmlTag(block, 'serviceType');
    const controlRaw = extractXmlTag(block, 'controlURL');
    if (!serviceType || !controlRaw) continue;
    const priority = SUPPORTED_SERVICE_TYPES.findIndex(
      (st) => st.toLowerCase() === serviceType.toLowerCase()
    );
    if (priority === -1) continue;

    try {
      const resolved = new URL(controlRaw, baseUrl);
      if (resolved.hostname !== baseUrl.hostname || !isPrivateLanIpv4(resolved.hostname)) {
        continue;
      }
      candidates.push({
        serviceType,
        controlUrl: resolved.toString(),
        priority,
      });
    } catch {
      continue;
    }
  }

  if (candidates.length === 0) return null;
  candidates.sort((a, b) => a.priority - b.priority);
  const chosen = candidates[0];

  return {
    friendlyName,
    modelName,
    routerIp: baseUrl.hostname,
    serviceType: chosen.serviceType,
    controlUrl: chosen.controlUrl,
    protocol: chosen.serviceType.endsWith(':2') ? 'upnp-igd-v2' : 'upnp-igd-v1',
  };
}

/**
 * Parses a UPnP SOAP fault XML response into a structured error with actionable guidance.
 */
export function parseUpnpSoapError(
  xml: string,
  port?: number,
  protocol?: string
): UpnpSoapError {
  const code = extractXmlTag(xml, 'errorCode') ?? 'UNKNOWN';
  const description = extractXmlTag(xml, 'errorDescription') ?? 'Router rejected UPnP request';
  const portRef = port && protocol ? `${port}/${protocol}` : 'this port';

  if (code === '718' || /ConflictInMappingEntry/i.test(description)) {
    return {
      code: '718',
      description,
      friendlyMessage: `Router Conflict (718): Another device or manual rule already holds ${portRef}. Delete the old manual rule in your router or change to an alternate port in Configuration.`,
    };
  }
  if (code === '725' || /OnlyPermanentLeasesSupported/i.test(description)) {
    return {
      code: '725',
      description,
      friendlyMessage: `Router only supports permanent UPnP leases (725). ServerForge automatically retries with lease duration 0.`,
    };
  }
  if (code === '724' || /SamePortValuesRequired/i.test(description)) {
    return {
      code: '724',
      description,
      friendlyMessage: `Router requires external and internal port numbers to match (724) for ${portRef}.`,
    };
  }
  if (code === '714' || /NoSuchEntryInArray/i.test(description)) {
    return {
      code: '714',
      description,
      friendlyMessage: `Mapping for ${portRef} was already removed on the router (714).`,
    };
  }
  if (code === '715' || code === '716' || /WildCard/i.test(description)) {
    return {
      code,
      description,
      friendlyMessage: `Router rejected wildcard parameter (${code}: ${description}).`,
    };
  }
  if (code === '606' || /ActionNotAuthorized/i.test(description)) {
    return {
      code: '606',
      description,
      friendlyMessage: `Router denied UPnP port mapping (606 ActionNotAuthorized). Check that UPnP is enabled in your router settings.`,
    };
  }

  return {
    code,
    description,
    friendlyMessage: `Router UPnP error (${code}): ${description}`,
  };
}

function buildSoapEnvelope(serviceType: string, action: string, bodyXml: string): string {
  return [
    '<?xml version="1.0"?>',
    '<s:Envelope xmlns:s="http://schemas.xmlsoap.org/soap/envelope/" s:encodingStyle="http://schemas.xmlsoap.org/soap/encoding/">',
    '<s:Body>',
    `<u:${action} xmlns:u="${escapeXml(serviceType)}">`,
    bodyXml,
    `</u:${action}>`,
    '</s:Body>',
    '</s:Envelope>',
  ].join('');
}

async function defaultSsdpDiscover(timeoutMs = 2200): Promise<string[]> {
  return new Promise((resolve) => {
    const locations = new Set<string>();
    const socket = dgram.createSocket({ type: 'udp4', reuseAddr: true });
    let finished = false;

    const done = () => {
      if (finished) return;
      finished = true;
      clearTimeout(timer);
      try {
        socket.close();
      } catch {
        // ignore close errors
      }
      resolve(Array.from(locations));
    };

    const timer = setTimeout(done, timeoutMs);

    socket.on('error', () => done());
    socket.on('message', (msg) => {
      const text = msg.toString('utf8');
      const locMatch = /^location:\s*(.+)$/im.exec(text);
      if (locMatch) {
        const rawUrl = locMatch[1].trim();
        try {
          const u = new URL(rawUrl);
          if ((u.protocol === 'http:' || u.protocol === 'https:') && isPrivateLanIpv4(u.hostname)) {
            locations.add(u.toString());
          }
        } catch {
          // ignore invalid location URL
        }
      }
    });

    socket.bind(0, () => {
      for (const st of SSDP_SEARCH_TARGETS) {
        const payload = Buffer.from(
          [
            'M-SEARCH * HTTP/1.1',
            `HOST: ${SSDP_MULTICAST_ADDR}:${SSDP_PORT}`,
            'MAN: "ssdp:discover"',
            'MX: 2',
            `ST: ${st}`,
            '',
            '',
          ].join('\r\n'),
          'utf8'
        );
        socket.send(payload, SSDP_PORT, SSDP_MULTICAST_ADDR, () => {
          // ignore send errors
        });
      }
    });
  });
}

async function defaultNatPmpRequest(gatewayIp: string, packet: Buffer, timeoutMs = 1500): Promise<Buffer | null> {
  if (!isPrivateLanIpv4(gatewayIp)) return null;
  return new Promise((resolve) => {
    const socket = dgram.createSocket('udp4');
    let finished = false;

    const done = (res: Buffer | null) => {
      if (finished) return;
      finished = true;
      clearTimeout(timer);
      try {
        socket.close();
      } catch {
        // ignore
      }
      resolve(res);
    };

    const timer = setTimeout(() => done(null), timeoutMs);
    socket.on('error', () => done(null));
    socket.on('message', (msg) => done(Buffer.from(msg)));
    socket.send(packet, NAT_PMP_PORT, gatewayIp, (err) => {
      if (err) done(null);
    });
  });
}

function guessGatewayCandidates(lanIp: string | null): string[] {
  if (!lanIp || !isPrivateLanIpv4(lanIp)) return [];
  const octets = lanIp.split('.');
  const prefix = `${octets[0]}.${octets[1]}.${octets[2]}`;
  return [`${prefix}.1`, `${prefix}.254`].filter((ip) => ip !== lanIp);
}

export class UpnpService {
  private readonly fetchImpl: typeof fetch;
  private readonly ssdpDiscoverImpl: () => Promise<string[]>;
  private readonly natPmpRequestImpl: (gatewayIp: string, packet: Buffer) => Promise<Buffer | null>;
  private readonly disableNetworkDiscovery: boolean;
  private readonly leaseDurationSeconds: number;

  private cachedRouter: UpnpRouterInfo | null = null;
  private cachedDescriptor: ParsedIgdDescriptor | null = null;
  private lastAttemptsByInstance = new Map<string, UpnpPortMapAttempt[]>();
  private renewTimer: NodeJS.Timeout | null = null;

  constructor(
    private readonly config: AppConfig,
    private readonly db: AppDatabase,
    private readonly catalog: CatalogService,
    private readonly network: NetworkAddressService,
    options: UpnpServiceOptions = {}
  ) {
    this.fetchImpl = options.fetchImpl ?? fetch;
    this.ssdpDiscoverImpl = options.ssdpDiscoverImpl ?? (() => defaultSsdpDiscover());
    this.natPmpRequestImpl = options.natPmpRequestImpl ?? ((gw, pkt) => defaultNatPmpRequest(gw, pkt));
    this.disableNetworkDiscovery = Boolean(options.disableNetworkDiscovery);
    this.leaseDurationSeconds = options.leaseDurationSeconds ?? DEFAULT_LEASE_SECONDS;
  }

  isGlobalEnabled(): boolean {
    return Boolean(this.db.getSettings(this.config.publicHost).upnpEnabled);
  }

  isEnabledForInstance(instance: ServerInstance): boolean {
    const mode: UpnpMode = instance.upnpMode ?? 'inherit';
    if (mode === 'enabled') return true;
    if (mode === 'disabled') return false;
    return this.isGlobalEnabled();
  }

  getCachedRouter(): UpnpRouterInfo | null {
    return this.cachedRouter;
  }

  private async soapCall(
    descriptor: ParsedIgdDescriptor,
    action: string,
    bodyXml: string
  ): Promise<{ ok: boolean; status: number; xml: string }> {
    const envelope = buildSoapEnvelope(descriptor.serviceType, action, bodyXml);
    const res = await this.fetchImpl(descriptor.controlUrl, {
      method: 'POST',
      headers: {
        'Content-Type': 'text/xml; charset="utf-8"',
        SOAPAction: `"${descriptor.serviceType}#${action}"`,
      },
      body: envelope,
      signal: AbortSignal.timeout(5000),
    });
    const xml = await res.text();
    return { ok: res.ok, status: res.status, xml };
  }

  private async listRouterMappings(descriptor: ParsedIgdDescriptor, maxEntries = 40): Promise<UpnpExistingRouterMapping[]> {
    const results: UpnpExistingRouterMapping[] = [];
    for (let idx = 0; idx < maxEntries; idx++) {
      try {
        const res = await this.soapCall(
          descriptor,
          'GetGenericPortMappingEntry',
          `<NewPortMappingIndex>${idx}</NewPortMappingIndex>`
        );
        if (!res.ok) break;
        const extPort = Number.parseInt(extractXmlTag(res.xml, 'NewExternalPort') ?? '', 10);
        const intPort = Number.parseInt(extractXmlTag(res.xml, 'NewInternalPort') ?? '', 10);
        const protoRaw = (extractXmlTag(res.xml, 'NewProtocol') ?? 'TCP').toUpperCase();
        const client = extractXmlTag(res.xml, 'NewInternalClient') ?? '';
        const desc = extractXmlTag(res.xml, 'NewPortMappingDescription') ?? '';
        const enabledRaw = extractXmlTag(res.xml, 'NewEnabled') ?? '1';
        const leaseRaw = Number.parseInt(extractXmlTag(res.xml, 'NewLeaseDuration') ?? '0', 10) || 0;
        if (!Number.isInteger(extPort) || extPort <= 0) break;
        results.push({
          externalPort: extPort,
          internalPort: Number.isInteger(intPort) ? intPort : extPort,
          protocol: protoRaw === 'UDP' ? 'UDP' : 'TCP',
          internalClient: client,
          description: desc,
          enabled: enabledRaw === '1' || enabledRaw.toLowerCase() === 'true',
          leaseDuration: leaseRaw,
        });
      } catch {
        break;
      }
    }
    return results;
  }

  /**
   * Discovers the home router via UPnP IGDv2/IGDv1 (SSDP) with NAT-PMP fallback.
   */
  async discoverRouter(force = false): Promise<UpnpRouterInfo> {
    if (!force && this.cachedRouter) {
      return this.cachedRouter;
    }

    const checkedAt = new Date().toISOString();

    if (this.disableNetworkDiscovery) {
      const info: UpnpRouterInfo = {
        found: false,
        protocol: 'none',
        friendlyName: null,
        modelName: null,
        routerIp: null,
        externalIp: null,
        serviceType: null,
        existingMappings: [],
        error: 'UPnP router discovery is disabled in mock runtime mode.',
        checkedAt,
      };
      this.cachedRouter = info;
      this.cachedDescriptor = null;
      return info;
    }

    // 1. Try UPnP IGD (SSDP)
    let locations: string[] = [];
    try {
      locations = await this.ssdpDiscoverImpl();
    } catch {
      locations = [];
    }

    for (const loc of locations) {
      try {
        const res = await this.fetchImpl(loc, { signal: AbortSignal.timeout(4000) });
        if (!res.ok) continue;
        const xml = await res.text();
        const descriptor = parseIgdDeviceDescription(xml, loc);
        if (!descriptor) continue;

        let externalIp: string | null = null;
        try {
          const extRes = await this.soapCall(descriptor, 'GetExternalIPAddress', '');
          if (extRes.ok) {
            const rawIp = extractXmlTag(extRes.xml, 'NewExternalIPAddress');
            if (rawIp && net.isIP(rawIp)) externalIp = rawIp;
          }
        } catch {
          // optional
        }

        const existingMappings = await this.listRouterMappings(descriptor);
        const info: UpnpRouterInfo = {
          found: true,
          protocol: descriptor.protocol,
          friendlyName: descriptor.friendlyName,
          modelName: descriptor.modelName,
          routerIp: descriptor.routerIp,
          externalIp,
          serviceType: descriptor.serviceType,
          existingMappings,
          error: null,
          checkedAt,
        };
        this.cachedDescriptor = descriptor;
        this.cachedRouter = info;
        return info;
      } catch {
        continue;
      }
    }

    // 2. Fallback: NAT-PMP (RFC 6886, UDP port 5351 on LAN gateway)
    const lanIp = this.network.getStatusSync().lanIp;
    const gateways = guessGatewayCandidates(lanIp);
    for (const gw of gateways) {
      const req = Buffer.from([0x00, 0x00]); // version 0, opcode 0 (External Address)
      const resp = await this.natPmpRequestImpl(gw, req);
      if (resp && resp.length >= 12 && resp[0] === 0x00 && resp[1] === 0x80) {
        const resultCode = resp.readUInt16BE(2);
        if (resultCode === 0) {
          const extIp = `${resp[8]}.${resp[9]}.${resp[10]}.${resp[11]}`;
          const info: UpnpRouterInfo = {
            found: true,
            protocol: 'nat-pmp',
            friendlyName: `NAT-PMP Gateway (${gw})`,
            modelName: 'NAT-PMP',
            routerIp: gw,
            externalIp: net.isIP(extIp) ? extIp : null,
            serviceType: 'nat-pmp',
            existingMappings: [],
            error: null,
            checkedAt,
          };
          this.cachedDescriptor = null;
          this.cachedRouter = info;
          return info;
        }
      }
    }

    const notFound: UpnpRouterInfo = {
      found: false,
      protocol: 'none',
      friendlyName: null,
      modelName: null,
      routerIp: null,
      externalIp: null,
      serviceType: null,
      existingMappings: [],
      error:
        'No UPnP IGD or NAT-PMP gateway responded on your LAN. Ensure UPnP is enabled in your router settings, or configure manual port forwarding.',
      checkedAt,
    };
    this.cachedDescriptor = null;
    this.cachedRouter = notFound;
    return notFound;
  }

  private async addSinglePortMapping(
    router: UpnpRouterInfo,
    lanIp: string,
    port: number,
    protocol: 'TCP' | 'UDP',
    description: string
  ): Promise<{ ok: boolean; permanentFallback: boolean; leaseUsed: number; errorCode?: string; message: string }> {
    const validPort = validatePortNumber(port);

    if (router.protocol === 'nat-pmp' && router.routerIp) {
      const opcode = protocol === 'UDP' ? 1 : 2;
      const pkt = Buffer.alloc(12);
      pkt.writeUInt8(0, 0); // version
      pkt.writeUInt8(opcode, 1);
      pkt.writeUInt16BE(0, 2); // reserved
      pkt.writeUInt16BE(validPort, 4); // internal port
      pkt.writeUInt16BE(validPort, 6); // external port
      pkt.writeUInt32BE(this.leaseDurationSeconds, 8);
      const resp = await this.natPmpRequestImpl(router.routerIp, pkt);
      if (resp && resp.length >= 16 && resp.readUInt16BE(2) === 0) {
        const mappedExt = resp.readUInt16BE(10);
        const lifetime = resp.readUInt32BE(12);
        return {
          ok: true,
          permanentFallback: false,
          leaseUsed: lifetime,
          message: `Mapped ${mappedExt}/${protocol} via NAT-PMP (lease ${lifetime}s).`,
        };
      }
      return {
        ok: false,
        permanentFallback: false,
        leaseUsed: 0,
        errorCode: 'NAT_PMP_FAILED',
        message: `NAT-PMP gateway rejected mapping for ${validPort}/${protocol}.`,
      };
    }

    if (!this.cachedDescriptor) {
      return {
        ok: false,
        permanentFallback: false,
        leaseUsed: 0,
        errorCode: 'NO_ROUTER',
        message: 'No UPnP IGD router control URL available.',
      };
    }

    const sendAdd = async (leaseSeconds: number) => {
      const body = [
        '<NewRemoteHost></NewRemoteHost>',
        `<NewExternalPort>${validPort}</NewExternalPort>`,
        `<NewProtocol>${protocol}</NewProtocol>`,
        `<NewInternalPort>${validPort}</NewInternalPort>`,
        `<NewInternalClient>${escapeXml(lanIp)}</NewInternalClient>`,
        '<NewEnabled>1</NewEnabled>',
        `<NewPortMappingDescription>${escapeXml(description)}</NewPortMappingDescription>`,
        `<NewLeaseDuration>${leaseSeconds}</NewLeaseDuration>`,
      ].join('');
      return this.soapCall(this.cachedDescriptor!, 'AddPortMapping', body);
    };

    try {
      const first = await sendAdd(this.leaseDurationSeconds);
      if (first.ok) {
        return {
          ok: true,
          permanentFallback: false,
          leaseUsed: this.leaseDurationSeconds,
          message: `Mapped ${validPort}/${protocol} -> ${lanIp}:${validPort} via ${router.protocol} (lease ${this.leaseDurationSeconds}s).`,
        };
      }

      const parsedErr = parseUpnpSoapError(first.xml, validPort, protocol);
      if (parsedErr.code === '725') {
        const retry = await sendAdd(0);
        if (retry.ok) {
          return {
            ok: true,
            permanentFallback: true,
            leaseUsed: 0,
            message: `Mapped ${validPort}/${protocol} -> ${lanIp}:${validPort} (router required permanent lease; ServerForge will delete it automatically on stop).`,
          };
        }
        const retryErr = parseUpnpSoapError(retry.xml, validPort, protocol);
        return {
          ok: false,
          permanentFallback: true,
          leaseUsed: 0,
          errorCode: retryErr.code,
          message: retryErr.friendlyMessage,
        };
      }

      return {
        ok: false,
        permanentFallback: false,
        leaseUsed: 0,
        errorCode: parsedErr.code,
        message: parsedErr.friendlyMessage,
      };
    } catch (err) {
      return {
        ok: false,
        permanentFallback: false,
        leaseUsed: 0,
        errorCode: 'NETWORK_ERROR',
        message: err instanceof Error ? `Router SOAP request failed: ${err.message}` : 'Router SOAP request failed.',
      };
    }
  }

  private async deleteSinglePortMapping(
    router: UpnpRouterInfo,
    port: number,
    protocol: 'TCP' | 'UDP'
  ): Promise<boolean> {
    const validPort = validatePortNumber(port);

    if (router.protocol === 'nat-pmp' && router.routerIp) {
      const opcode = protocol === 'UDP' ? 1 : 2;
      const pkt = Buffer.alloc(12);
      pkt.writeUInt8(0, 0);
      pkt.writeUInt8(opcode, 1);
      pkt.writeUInt16BE(0, 2);
      pkt.writeUInt16BE(validPort, 4);
      pkt.writeUInt16BE(0, 6);
      pkt.writeUInt32BE(0, 8); // lifetime 0 = delete
      const resp = await this.natPmpRequestImpl(router.routerIp, pkt);
      return Boolean(resp && resp.length >= 16 && resp.readUInt16BE(2) === 0);
    }

    if (!this.cachedDescriptor) return false;
    try {
      const body = [
        '<NewRemoteHost></NewRemoteHost>',
        `<NewExternalPort>${validPort}</NewExternalPort>`,
        `<NewProtocol>${protocol}</NewProtocol>`,
      ].join('');
      const res = await this.soapCall(this.cachedDescriptor, 'DeletePortMapping', body);
      if (res.ok) return true;
      const err = parseUpnpSoapError(res.xml, validPort, protocol);
      return err.code === '714'; // Already gone
    } catch {
      return false;
    }
  }

  /**
   * Maps all required external (!internalOnly) ports for an instance via UPnP / NAT-PMP.
   * Respects global & per-instance opt-in toggles unless `force: true` is explicitly passed.
   */
  async mapInstancePorts(
    instance: ServerInstance,
    template: GameTemplate | null,
    options: { force?: boolean } = {}
  ): Promise<UpnpPortMapAttempt[]> {
    if (!options.force && !this.isEnabledForInstance(instance)) {
      return [];
    }

    const lanIp = this.network.getStatusSync().lanIp;
    const externalPorts = getExternalPortSpecs(instance, template);

    if (!lanIp || !isPrivateLanIpv4(lanIp)) {
      const attempts: UpnpPortMapAttempt[] = externalPorts.map((p) => ({
        portKey: p.key,
        label: p.label,
        port: p.port,
        protocol: p.protocol === 'udp' ? 'UDP' : 'TCP',
        ok: false,
        permanentFallback: false,
        errorCode: 'NO_LAN_IP',
        message: 'Could not determine a private LAN IPv4 address for this PC.',
      }));
      this.lastAttemptsByInstance.set(instance.id, attempts);
      return attempts;
    }

    const router = await this.discoverRouter(false);
    if (!router.found) {
      const attempts: UpnpPortMapAttempt[] = externalPorts.map((p) => ({
        portKey: p.key,
        label: p.label,
        port: p.port,
        protocol: p.protocol === 'udp' ? 'UDP' : 'TCP',
        ok: false,
        permanentFallback: false,
        errorCode: 'NO_ROUTER',
        message: router.error ?? 'No UPnP-capable router discovered.',
      }));
      this.lastAttemptsByInstance.set(instance.id, attempts);
      return attempts;
    }

    const attempts: UpnpPortMapAttempt[] = [];
    for (const p of externalPorts) {
      const protos: Array<'TCP' | 'UDP'> =
        p.protocol === 'both' ? ['TCP', 'UDP'] : [p.protocol === 'udp' ? 'UDP' : 'TCP'];

      for (const proto of protos) {
        const desc = `ServerForge - ${sanitizeFirewallLabel(instance.slug)} (${p.key})`.slice(0, 60);
        const res = await this.addSinglePortMapping(router, lanIp, p.port, proto, desc);
        attempts.push({
          portKey: p.key,
          label: p.label,
          port: p.port,
          protocol: proto,
          ok: res.ok,
          permanentFallback: res.permanentFallback,
          errorCode: res.errorCode,
          message: res.message,
        });
        if (res.ok) {
          this.db.upsertUpnpMapping({
            instanceId: instance.id,
            externalPort: p.port,
            internalPort: p.port,
            protocol: proto,
            internalClient: lanIp,
            description: desc,
            leaseDurationSeconds: res.leaseUsed,
            protocolUsed: router.protocol,
          });
        }
      }
    }

    this.lastAttemptsByInstance.set(instance.id, attempts);
    return attempts;
  }

  /**
   * Deletes all UPnP mappings tracked in SQLite for an instance (on stop, port change, or delete).
   */
  async unmapInstancePorts(instanceId: string): Promise<{ removed: number }> {
    const tracked = this.db.listUpnpMappings(instanceId);
    if (tracked.length === 0) return { removed: 0 };

    const router = this.cachedRouter?.found ? this.cachedRouter : await this.discoverRouter(false);
    let removed = 0;

    for (const m of tracked) {
      if (router.found) {
        await this.deleteSinglePortMapping(router, m.externalPort, m.protocol);
      }
      this.db.deleteUpnpMapping(m.id);
      removed++;
    }

    this.lastAttemptsByInstance.delete(instanceId);
    return { removed };
  }

  /**
   * Crash-recovery cleanup: removes any persisted UPnP mappings left behind in SQLite
   * from an unexpected PC crash or power outage when their instance is no longer running.
   */
  async reconcileStaleMappings(runningInstanceIds: Set<string>): Promise<number> {
    const allTracked = this.db.listUpnpMappings();
    const stale = allTracked.filter((m) => !runningInstanceIds.has(m.instanceId));
    if (stale.length === 0) return 0;

    const router = await this.discoverRouter(false);
    let cleaned = 0;
    for (const m of stale) {
      if (router.found) {
        await this.deleteSinglePortMapping(router, m.externalPort, m.protocol);
      }
      this.db.deleteUpnpMapping(m.id);
      cleaned++;
    }
    return cleaned;
  }

  async unmapAll(): Promise<number> {
    const allTracked = this.db.listUpnpMappings();
    if (allTracked.length === 0) return 0;

    const router = this.cachedRouter?.found ? this.cachedRouter : await this.discoverRouter(false);
    let cleaned = 0;
    for (const m of allTracked) {
      if (router.found) {
        await this.deleteSinglePortMapping(router, m.externalPort, m.protocol);
      }
      this.db.deleteUpnpMapping(m.id);
      cleaned++;
    }
    this.lastAttemptsByInstance.clear();
    return cleaned;
  }

  startRenewalLoop(getRunningInstances: () => ServerInstance[]): void {
    if (this.renewTimer || this.disableNetworkDiscovery) return;
    this.renewTimer = setInterval(() => {
      const running = getRunningInstances();
      for (const inst of running) {
        if (!this.isEnabledForInstance(inst)) continue;
        const tpl = this.catalog.getTemplate(inst.gameId);
        void this.mapInstancePorts(inst, tpl).catch(() => {});
      }
    }, RENEW_INTERVAL_MS);
    this.renewTimer.unref?.();
  }

  stop(): void {
    if (this.renewTimer) {
      clearInterval(this.renewTimer);
      this.renewTimer = null;
    }
  }

  getInstanceStatus(instance: ServerInstance): UpnpInstanceStatus {
    const globalEnabled = this.isGlobalEnabled();
    const instanceMode: UpnpMode = instance.upnpMode ?? 'inherit';
    return {
      globalEnabled,
      instanceMode,
      effectiveEnabled: this.isEnabledForInstance(instance),
      router: this.cachedRouter,
      activeMappings: this.db.listUpnpMappings(instance.id),
      lastAttempts: this.lastAttemptsByInstance.get(instance.id) ?? [],
    };
  }
}
