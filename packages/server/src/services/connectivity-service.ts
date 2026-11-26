import { execFile } from 'node:child_process';
import net from 'node:net';
import type {
  ConsolidatedPortMapEntry,
  ConnectivityHop,
  GameTemplate,
  InstanceConnectivityReport,
  InstanceNetworkGuide,
  InstancePortGuideEntry,
  NetworkPrerequisiteItem,
  PortProtocol,
  ServerInstance,
  WanPortProbeResult,
} from '@serverforge/shared';
import type { CatalogService } from '../catalog/catalog-service.js';
import type { AppConfig } from '../config.js';
import type { AppDatabase } from '../db/database.js';
import {
  FirewallService,
  getExternalPortSpecs,
  resolveInstancePorts,
  type FirewallExecFn,
  type FirewallExecResult,
} from './firewall-service.js';
import { encodePowerShellCommand } from './import-service.js';
import { isLocalOrPrivateHost, type NetworkAddressService } from './network-service.js';

export interface SocketBindEntry {
  protocol: 'tcp' | 'udp';
  localAddress: string;
  localPort: number;
}

export interface ConnectivityServiceOptions {
  platform?: NodeJS.Platform;
  fetchImpl?: typeof fetch;
  execImpl?: FirewallExecFn;
  probePollDelayMs?: number;
  probeMaxPolls?: number;
}

/**
 * Returns true if an IPv4 address falls within RFC 6598 CGNAT space (100.64.0.0/10).
 */
export function isCgnatIp(ip: string | null): boolean {
  if (!ip) return false;
  if (net.isIP(ip) !== 4) return false;
  const parts = ip.split('.').map(Number);
  return parts[0] === 100 && parts[1] >= 64 && parts[1] <= 127;
}

function protocolsOverlap(a: PortProtocol, b: PortProtocol): boolean {
  if (a === 'both' || b === 'both') return true;
  return a === b;
}

function defaultExec(file: string, args: string[], timeoutMs = 10_000): Promise<FirewallExecResult> {
  return new Promise((resolve) => {
    execFile(
      file,
      args,
      { timeout: timeoutMs, windowsHide: true, maxBuffer: 1024 * 1024 },
      (err, stdout, stderr) => {
        const code = err ? 1 : 0;
        resolve({
          stdout: String(stdout ?? ''),
          stderr: String(stderr ?? ''),
          exitCode: code,
        });
      }
    );
  });
}

function getGameRouterNotes(gameId: string, ports: InstancePortGuideEntry[]): string[] {
  const notes: string[] = [];

  if (gameId === 'satisfactory') {
    const gamePort = ports.find((p) => p.key === 'game')?.port ?? 7777;
    const reliablePort = ports.find((p) => p.key === 'reliable')?.port ?? 8888;
    notes.push(
      `Satisfactory 1.1+ requires BOTH your Game & API port (${gamePort} TCP + UDP) AND the Reliable Messaging port (${reliablePort} TCP). External and internal port numbers must match 1:1.`
    );
    notes.push(
      `Router tip (BT / EE Smart Hub & similar ISP routers): Create SEPARATE single-protocol rules (one TCP rule and one UDP rule with unique names) instead of a combined TCP/UDP rule, and reboot your router if newly saved rules do not activate immediately.`
    );
    if (gamePort === 7777 || reliablePort === 8888) {
      notes.push(
        `If your router rejects port 7777 or 8888, stop the server, change to alternate ports (e.g., 27777 & 25578) in the Configuration tab, and forward those instead.`
      );
    }
  } else if (gameId.startsWith('minecraft')) {
    const gamePort = ports.find((p) => p.key === 'game')?.port ?? 25565;
    notes.push(
      `Minecraft Java only needs TCP ${gamePort} forwarded externally. NEVER forward the RCON port — ServerForge keeps RCON local for security.`
    );
  } else if (gameId === 'palworld') {
    notes.push(
      `Palworld requires UDP game/query ports externally. Keep REST API and RCON ports strictly local — do NOT forward them on your router.`
    );
  } else if (gameId === 'factorio') {
    notes.push(
      `Factorio only needs its UDP game port forwarded externally. Keep the RCON port strictly local.`
    );
  } else if (gameId === 'ark-survival-ascended') {
    notes.push(
      `Ark: Survival Ascended needs both the Game and Peer UDP ports forwarded. Keep RCON strictly local.`
    );
  }

  notes.push(
    `Hairpin NAT (NAT Loopback): Many home routers block connecting to your own public IP from inside your own Wi-Fi/LAN. Connect via your Local LAN IP yourself, and use the External WAN Test below (or a phone on mobile data) to verify external access.`
  );
  notes.push(
    `DHCP Reservation: Reserve a static LAN IP for this server PC in your router's DHCP settings so your LAN IP doesn't change after reboots and silently break port forwarding.`
  );
  notes.push(
    `Security Lockdown: Never forward ServerForge's dashboard port (3000) or any port marked "Local Only" on your router.`
  );

  return notes;
}

export class ConnectivityService {
  private readonly platform: NodeJS.Platform;
  private readonly fetchImpl: typeof fetch;
  private readonly execImpl: FirewallExecFn;
  private readonly probePollDelayMs: number;
  private readonly probeMaxPolls: number;

  constructor(
    private readonly config: AppConfig,
    private readonly db: AppDatabase,
    private readonly catalog: CatalogService,
    private readonly network: NetworkAddressService,
    private readonly firewall: FirewallService,
    options: ConnectivityServiceOptions = {}
  ) {
    this.platform = options.platform ?? process.platform;
    this.fetchImpl = options.fetchImpl ?? fetch;
    this.execImpl = options.execImpl ?? defaultExec;
    this.probePollDelayMs = options.probePollDelayMs ?? 1100;
    this.probeMaxPolls = options.probeMaxPolls ?? 4;
  }

  /**
   * Builds the per-server Network & Port Forwarding guide (#49).
   * Strictly excludes `internalOnly` ports from copyable router forwarding instructions.
   */
  buildNetworkGuide(instance: ServerInstance): InstanceNetworkGuide {
    const template = this.catalog.getTemplate(instance.gameId);
    const netStatus = this.network.getStatusSync();
    const resolved = resolveInstancePorts(instance, template);

    const ports: InstancePortGuideEntry[] = resolved.map((p) => {
      const exposure = p.internalOnly
        ? 'internal_only'
        : p.key === 'query' || p.key === 'peer'
          ? 'optional_query'
          : 'required';
      return {
        key: p.key,
        label: p.label,
        port: p.port,
        defaultPort: p.defaultPort,
        protocol: p.protocol,
        exposure,
        internalOnly: p.internalOnly,
        primary: p.primary,
        note: p.internalOnly
          ? 'Local Only — Do NOT forward on your router or open in Windows Firewall.'
          : p.protocol === 'both'
            ? 'Requires both TCP and UDP (split into separate TCP and UDP rules if your router dislikes combined rules).'
            : undefined,
      };
    });

    const lanDisplay = netStatus.lanIp ?? '<Server PC LAN IP>';
    const externalLines: string[] = [
      `Router Port Forwarding Rules for "${instance.name}" (${template?.name ?? instance.gameId})`,
      `Target Server PC LAN IP: ${lanDisplay}`,
      ``,
    ];

    for (const p of ports.filter((entry) => !entry.internalOnly)) {
      if (p.protocol === 'both') {
        externalLines.push(
          `- ${p.label} (TCP): External ${p.port} -> Internal ${p.port} | Protocol: TCP | Target: ${lanDisplay}`
        );
        externalLines.push(
          `- ${p.label} (UDP): External ${p.port} -> Internal ${p.port} | Protocol: UDP | Target: ${lanDisplay}`
        );
      } else {
        externalLines.push(
          `- ${p.label}: External ${p.port} -> Internal ${p.port} | Protocol: ${p.protocol.toUpperCase()} | Target: ${lanDisplay}`
        );
      }
    }

    const internalPorts = ports.filter((entry) => entry.internalOnly);
    if (internalPorts.length > 0) {
      externalLines.push(
        ``,
        `DO NOT FORWARD (Local Only): ${internalPorts.map((p) => `${p.label} (${p.port}/${p.protocol.toUpperCase()})`).join(', ')}`
      );
    }

    const routerNotes = getGameRouterNotes(instance.gameId, ports);
    const prerequisites: NetworkPrerequisiteItem[] = [
      {
        id: 'server_running',
        label: 'Server Process Running',
        status: instance.status === 'running' ? 'pass' : 'warn',
        detail:
          instance.status === 'running'
            ? 'Server is running and ready to accept connections.'
            : `Server is currently "${instance.status}". Start the server before testing external reachability.`,
      },
      {
        id: 'lan_ip',
        label: 'Local LAN IP Detected',
        status: netStatus.lanIp ? 'pass' : 'warn',
        detail: netStatus.lanIp
          ? `Server PC LAN IP is ${netStatus.lanIp}. Point router port forwards here.`
          : 'Could not detect LAN IPv4 address.',
      },
      {
        id: 'public_host',
        label: 'Public Join Address',
        status: !isLocalOrPrivateHost(netStatus.effectiveHost) ? 'pass' : 'warn',
        detail: !isLocalOrPrivateHost(netStatus.effectiveHost)
          ? `Friends join via ${netStatus.effectiveHost}.`
          : 'Public host is still localhost/private. Configure DuckDNS or Re-detect Public IP in Settings -> Network.',
      },
    ];

    return {
      instanceId: instance.id,
      instanceName: instance.name,
      gameId: instance.gameId,
      lanIp: netStatus.lanIp,
      publicIp: netStatus.publicIp,
      effectiveHost: netStatus.effectiveHost,
      ports,
      routerNotes,
      copyableRouterText: externalLines.join('\n'),
      prerequisites,
    };
  }

  /**
   * Builds a consolidated port map across all instances in ServerForge, flagging overlapping ports.
   */
  buildConsolidatedPortMap(instances: ServerInstance[]): ConsolidatedPortMapEntry[] {
    const entries: ConsolidatedPortMapEntry[] = [];

    for (const inst of instances) {
      const template = this.catalog.getTemplate(inst.gameId);
      const resolved = resolveInstancePorts(inst, template);
      for (const p of resolved) {
        entries.push({
          instanceId: inst.id,
          instanceName: inst.name,
          gameId: inst.gameId,
          instanceStatus: inst.status,
          portKey: p.key,
          label: p.label,
          port: p.port,
          protocol: p.protocol,
          internalOnly: p.internalOnly,
          primary: p.primary,
          conflictWith: [],
        });
      }
    }

    for (let i = 0; i < entries.length; i++) {
      for (let j = i + 1; j < entries.length; j++) {
        const a = entries[i];
        const b = entries[j];
        if (a.instanceId === b.instanceId) continue;
        if (a.port === b.port && protocolsOverlap(a.protocol, b.protocol)) {
          a.conflictWith.push(`${b.instanceName} (${b.label})`);
          b.conflictWith.push(`${a.instanceName} (${a.label})`);
        }
      }
    }

    return entries.sort((a, b) => Number(a.internalOnly) - Number(b.internalOnly) || a.port - b.port);
  }

  /**
   * Inspects active local TCP/UDP listening sockets on the host OS.
   */
  async inspectListeningSockets(targetPorts: number[]): Promise<SocketBindEntry[]> {
    if (targetPorts.length === 0) return [];

    if (this.platform === 'win32') {
      const portList = targetPorts.join(',');
      const script = `
$ErrorActionPreference = 'SilentlyContinue'
$ports = @(${portList})
$tcp = Get-NetTCPConnection -State Listen | Where-Object { $ports -contains $_.LocalPort } | ForEach-Object {
  [PSCustomObject]@{ protocol = 'tcp'; localAddress = [string]$_.LocalAddress; localPort = [int]$_.LocalPort }
}
$udp = Get-NetUDPEndpoint | Where-Object { $ports -contains $_.LocalPort } | ForEach-Object {
  [PSCustomObject]@{ protocol = 'udp'; localAddress = [string]$_.LocalAddress; localPort = [int]$_.LocalPort }
}
@($tcp) + @($udp) | ConvertTo-Json -Compress
`;
      const encoded = encodePowerShellCommand(script);
      const res = await this.execImpl(
        'powershell.exe',
        ['-NoProfile', '-NonInteractive', '-EncodedCommand', encoded],
        10_000
      );
      return this.parseWindowsSocketsJson(res.stdout);
    }

    // Linux/macOS fallback via `ss -tuln`
    const res = await this.execImpl('ss', ['-tuln'], 5000);
    return this.parseLinuxSsOutput(res.stdout, new Set(targetPorts));
  }

  parseWindowsSocketsJson(stdout: string): SocketBindEntry[] {
    const trimmed = stdout.trim();
    if (!trimmed) return [];
    try {
      const parsed = JSON.parse(trimmed) as SocketBindEntry | SocketBindEntry[];
      const list = Array.isArray(parsed) ? parsed : [parsed];
      return list
        .filter((e) => e && typeof e.localPort === 'number' && (e.protocol === 'tcp' || e.protocol === 'udp'))
        .map((e) => ({
          protocol: e.protocol,
          localAddress: String(e.localAddress ?? ''),
          localPort: Number(e.localPort),
        }));
    } catch {
      return [];
    }
  }

  parseLinuxSsOutput(stdout: string, targetPorts: Set<number>): SocketBindEntry[] {
    const entries: SocketBindEntry[] = [];
    for (const line of stdout.split(/\r?\n/)) {
      const parts = line.trim().split(/\s+/);
      if (parts.length < 5) continue;
      const protoRaw = parts[0].toLowerCase();
      const protocol = protoRaw.startsWith('tcp') ? 'tcp' : protoRaw.startsWith('udp') ? 'udp' : null;
      if (!protocol) continue;
      const localCol = parts[4];
      const lastColon = localCol.lastIndexOf(':');
      if (lastColon === -1) continue;
      const port = Number.parseInt(localCol.slice(lastColon + 1), 10);
      if (!Number.isInteger(port) || !targetPorts.has(port)) continue;
      const addr = localCol.slice(0, lastColon).replace(/^\[|\]$/g, '');
      entries.push({
        protocol,
        localAddress: addr === '*' ? '0.0.0.0' : addr,
        localPort: port,
      });
    }
    return entries;
  }

  /**
   * SSRF-safe external TCP reachability probe using the public check-host.net JSON API.
   * Strictly probes ONLY the host's own detected public IP and the instance's own external TCP ports.
   */
  async probeExternalTcpPort(publicIp: string, port: number): Promise<Omit<WanPortProbeResult, 'key' | 'label' | 'protocol'>> {
    if (!publicIp || isLocalOrPrivateHost(publicIp)) {
      return {
        port,
        reachable: null,
        status: 'probe_unavailable',
        detail: 'No valid public IP detected to probe externally.',
        nodesChecked: 0,
      };
    }

    try {
      const target = encodeURIComponent(`${publicIp}:${port}`);
      const initRes = await this.fetchImpl(
        `https://check-host.net/check-tcp?host=${target}&max_nodes=2`,
        {
          headers: { Accept: 'application/json', 'User-Agent': `ServerForge/${this.config.appVersion}` },
          signal: AbortSignal.timeout(6000),
        }
      );

      if (!initRes.ok) {
        return {
          port,
          reachable: null,
          status: 'probe_unavailable',
          detail: `External probe service returned HTTP ${initRes.status}. Verify manually at canyouseeme.org.`,
          nodesChecked: 0,
        };
      }

      const initBody = (await initRes.json()) as { ok?: number; request_id?: string };
      if (!initBody.request_id) {
        return {
          port,
          reachable: null,
          status: 'probe_unavailable',
          detail: 'External probe service did not return a request ID. Verify manually at canyouseeme.org.',
          nodesChecked: 0,
        };
      }

      let lastResults: Record<string, unknown> = {};
      for (let attempt = 0; attempt < this.probeMaxPolls; attempt++) {
        if (this.probePollDelayMs > 0) {
          await new Promise((r) => setTimeout(r, this.probePollDelayMs));
        }
        const pollRes = await this.fetchImpl(
          `https://check-host.net/check-result/${encodeURIComponent(initBody.request_id)}`,
          {
            headers: { Accept: 'application/json', 'User-Agent': `ServerForge/${this.config.appVersion}` },
            signal: AbortSignal.timeout(5000),
          }
        );
        if (!pollRes.ok) continue;
        lastResults = (await pollRes.json()) as Record<string, unknown>;
        const values = Object.values(lastResults);
        if (values.length > 0 && values.every((v) => v !== null)) {
          break;
        }
      }

      let openCount = 0;
      let refusedCount = 0;
      let timeoutCount = 0;
      let nodesChecked = 0;

      for (const nodeVal of Object.values(lastResults)) {
        if (!Array.isArray(nodeVal) || nodeVal.length === 0) continue;
        const entry = nodeVal[0] as { time?: number; error?: string; address?: string } | null;
        if (!entry || typeof entry !== 'object') continue;
        nodesChecked++;
        if (typeof entry.time === 'number' && !entry.error) {
          openCount++;
        } else if (typeof entry.error === 'string' && /timed?\s*out/i.test(entry.error)) {
          timeoutCount++;
        } else {
          refusedCount++;
        }
      }

      if (nodesChecked === 0) {
        return {
          port,
          reachable: null,
          status: 'probe_unavailable',
          detail: 'External probe nodes did not respond in time. Try again or test at canyouseeme.org.',
          nodesChecked: 0,
        };
      }

      if (openCount > 0) {
        return {
          port,
          reachable: true,
          status: 'open',
          detail: `Externally reachable from ${openCount}/${nodesChecked} internet probe node(s).`,
          nodesChecked,
        };
      }

      if (timeoutCount >= refusedCount) {
        return {
          port,
          reachable: false,
          status: 'timeout',
          detail: `Connection timed out from ${nodesChecked} external node(s) — router port forwarding, router reboot, or Windows Firewall is blocking inbound TCP ${port}.`,
          nodesChecked,
        };
      }

      return {
        port,
        reachable: false,
        status: 'closed',
        detail: `Connection refused on external TCP ${port} (${nodesChecked} node(s) checked). Verify the server is running and bound to port ${port}.`,
        nodesChecked,
      };
    } catch {
      return {
        port,
        reachable: null,
        status: 'probe_unavailable',
        detail: 'Could not reach external probe service (network or timeout). Verify manually at canyouseeme.org.',
        nodesChecked: 0,
      };
    }
  }

  /**
   * Runs the full 5-hop security-first Connectivity & External Reachability Troubleshooter (#51).
   */
  async runConnectivityCheck(instance: ServerInstance): Promise<InstanceConnectivityReport> {
    const template = this.catalog.getTemplate(instance.gameId);
    const netStatus = await this.network.refresh(false).catch(() => this.network.getStatusSync());
    const externalPorts = getExternalPortSpecs(instance, template);
    const allPorts = resolveInstancePorts(instance, template);
    const hops: ConnectivityHop[] = [];
    const wanProbes: WanPortProbeResult[] = [];

    // ── Hop 1: Process & Socket Bind Check ──
    if (instance.status !== 'running') {
      hops.push({
        id: 'process_bind',
        label: '1. Server Process & Socket Bind',
        status: 'fail',
        summary: `Server is "${instance.status}" — start it before testing external reachability.`,
        fixHint: 'Start this server and wait until it shows Online/Running, then re-run this check.',
        actionId: 'start_server',
      });
    } else {
      const sockets = await this.inspectListeningSockets(allPorts.map((p) => p.port));
      const missingPorts: string[] = [];
      const loopbackOnlyPorts: string[] = [];
      const boundSummary: string[] = [];

      for (const p of externalPorts) {
        const needTcp = p.protocol === 'tcp' || p.protocol === 'both';
        const needUdp = p.protocol === 'udp' || p.protocol === 'both';

        const checkProto = (proto: 'tcp' | 'udp') => {
          const matches = sockets.filter((s) => s.protocol === proto && s.localPort === p.port);
          if (matches.length === 0) {
            missingPorts.push(`${p.label} (${p.port}/${proto.toUpperCase()})`);
            return;
          }
          const anyWildcard = matches.some(
            (m) => m.localAddress === '0.0.0.0' || m.localAddress === '::' || m.localAddress === netStatus.lanIp
          );
          if (!anyWildcard) {
            loopbackOnlyPorts.push(`${p.port}/${proto.toUpperCase()} (${matches[0].localAddress})`);
          } else {
            boundSummary.push(`${p.port}/${proto.toUpperCase()}`);
          }
        };

        if (needTcp) checkProto('tcp');
        if (needUdp) checkProto('udp');
      }

      if (loopbackOnlyPorts.length > 0) {
        hops.push({
          id: 'process_bind',
          label: '1. Server Process & Socket Bind',
          status: 'fail',
          summary: `Port(s) bound only to localhost: ${loopbackOnlyPorts.join(', ')}.`,
          fixHint: 'External friends cannot reach a server bound to 127.0.0.1. Ensure the server binds to 0.0.0.0.',
        });
      } else if (missingPorts.length > 0) {
        hops.push({
          id: 'process_bind',
          label: '1. Server Process & Socket Bind',
          status: 'warn',
          summary: `Expected port(s) not yet listening: ${missingPorts.join(', ')}.`,
          detail: boundSummary.length > 0 ? `Listening: ${boundSummary.join(', ')}` : undefined,
          fixHint:
            instance.gameId === 'satisfactory'
              ? 'If Satisfactory shifted its Reliable Messaging port (e.g. +1 because another app used it), check the live console or update the port in Configuration.'
              : 'Wait a few seconds if the server is still finishing startup, or check the Live Console for bind errors.',
        });
      } else {
        hops.push({
          id: 'process_bind',
          label: '1. Server Process & Socket Bind',
          status: 'pass',
          summary: `All required external ports are actively listening on 0.0.0.0 (${boundSummary.join(', ')}).`,
        });
      }
    }

    // ── Hop 2: Windows Firewall & Security Exposure Audit ──
    const fwStatus = await this.firewall.inspectInstance(instance, template);
    if (!fwStatus.supported) {
      hops.push({
        id: 'firewall',
        label: '2. Firewall & Security Exposure Audit',
        status: 'skip',
        summary: `Automatic Windows Firewall inspection is skipped on ${fwStatus.platform}.`,
        fixHint: 'Verify your host firewall (ufw/iptables) allows only the required external ports.',
      });
    } else {
      const missingFw = fwStatus.ports
        .filter((p) => !p.internalOnly)
        .filter(
          (p) =>
            ((p.protocol === 'tcp' || p.protocol === 'both') && !p.tcpAllowed) ||
            ((p.protocol === 'udp' || p.protocol === 'both') && !p.udpAllowed)
        );

      if (fwStatus.appBlockWarnings.length > 0) {
        hops.push({
          id: 'firewall',
          label: '2. Firewall & Security Exposure Audit',
          status: 'fail',
          summary: fwStatus.appBlockWarnings[0],
          detail: fwStatus.appBlockWarnings.join(' '),
          fixHint: 'Remove the Inbound Block rule in Windows Defender Firewall with Advanced Security (Block rules override Allow rules).',
        });
      } else if (fwStatus.publicProfileWarning) {
        hops.push({
          id: 'firewall',
          label: '2. Firewall & Security Exposure Audit',
          status: 'fail',
          summary: `Windows network "${fwStatus.profileName ?? 'Active Adapter'}" is set to Public profile.`,
          fixHint:
            'ServerForge keeps firewall rules locked strictly to the Private profile for security. Switch your home network to Private and apply Private-profile rules below.',
          actionId: 'switch_private',
        });
      } else if (missingFw.length > 0) {
        hops.push({
          id: 'firewall',
          label: '2. Firewall & Security Exposure Audit',
          status: 'fail',
          summary: `Missing Private-profile Windows Firewall Allow rule(s) for: ${missingFw.map((p) => `${p.port}/${p.protocol.toUpperCase()}`).join(', ')}.`,
          fixHint: 'Click "Open Required Ports (Private Profile)" below to allow only the needed external game ports.',
          actionId: 'open_firewall',
        });
      } else if (fwStatus.internalExposureWarnings.length > 0) {
        hops.push({
          id: 'firewall',
          label: '2. Firewall & Security Exposure Audit',
          status: 'warn',
          summary: fwStatus.internalExposureWarnings[0],
          fixHint: 'Remove inbound Windows Firewall rules for RCON / REST management ports so they remain strictly local.',
        });
      } else {
        hops.push({
          id: 'firewall',
          label: '2. Firewall & Security Exposure Audit',
          status: 'pass',
          summary: `Network is Private, required external ports are allowed, and all internal-only ports remain locked down.`,
        });
      }
    }

    // ── Hop 3: LAN IP Stability / DHCP Drift Check ──
    const settings = this.db.getSettings(this.config.publicHost);
    const currentLanIp = netStatus.lanIp;
    if (!currentLanIp) {
      hops.push({
        id: 'lan_ip',
        label: '3. Local LAN IP Stability',
        status: 'warn',
        summary: 'Could not detect a non-virtual IPv4 LAN address for this PC.',
        fixHint: 'Check your Ethernet/Wi-Fi connection and ensure this PC has a stable private IPv4 address.',
      });
    } else if (settings.lastKnownLanIp && settings.lastKnownLanIp !== currentLanIp) {
      hops.push({
        id: 'lan_ip',
        label: '3. Local LAN IP Stability',
        status: 'warn',
        summary: `LAN IP changed from ${settings.lastKnownLanIp} to ${currentLanIp} (DHCP drift detected).`,
        fixHint: `Update your router's port forwarding rules to point to ${currentLanIp} and create a DHCP reservation so it stops changing.`,
      });
      this.db.saveSettings({ lastKnownLanIp: currentLanIp }, this.config.publicHost);
    } else {
      if (!settings.lastKnownLanIp) {
        this.db.saveSettings({ lastKnownLanIp: currentLanIp }, this.config.publicHost);
      }
      hops.push({
        id: 'lan_ip',
        label: '3. Local LAN IP Stability',
        status: 'pass',
        summary: `Server PC LAN IP is steady at ${currentLanIp}.`,
        detail: 'Make sure every router port-forwarding rule targets this exact IP.',
      });
    }

    // ── Hop 4: NAT / CGNAT & Public Host Check ──
    const publicIp = netStatus.publicIp;
    if (!publicIp) {
      hops.push({
        id: 'nat_cgnat',
        label: '4. Public IP & NAT / CGNAT Check',
        status: 'fail',
        summary: 'Could not detect an external public IP address.',
        fixHint: 'Check internet connectivity or click Re-detect Now in Settings -> Network.',
        actionId: 'configure_public_host',
      });
    } else if (isCgnatIp(publicIp)) {
      hops.push({
        id: 'nat_cgnat',
        label: '4. Public IP & NAT / CGNAT Check',
        status: 'fail',
        summary: `Detected Carrier-Grade NAT (CGNAT) IP ${publicIp} (100.64.0.0/10).`,
        fixHint: 'ISPs using CGNAT block inbound router port forwarding. Ask your ISP for a public IPv4 address or use a private mesh VPN.',
      });
    } else if (isLocalOrPrivateHost(netStatus.effectiveHost)) {
      hops.push({
        id: 'nat_cgnat',
        label: '4. Public IP & NAT / CGNAT Check',
        status: 'warn',
        summary: `Public IP is ${publicIp}, but join address is still "${netStatus.effectiveHost}".`,
        fixHint: 'Open Settings -> Network and switch Public Address Mode to Automatic or DuckDNS.',
        actionId: 'configure_public_host',
      });
    } else {
      hops.push({
        id: 'nat_cgnat',
        label: '4. Public IP & NAT / CGNAT Check',
        status: 'pass',
        summary: `Public IPv4 ${publicIp} detected (no CGNAT); join address is ${netStatus.effectiveHost}.`,
      });
    }

    // ── Hop 5: Opt-In External WAN Reachability Probe ──
    if (instance.status !== 'running' || !publicIp) {
      hops.push({
        id: 'wan_probe',
        label: '5. External Internet (WAN) Reachability',
        status: 'skip',
        summary: 'Skipped external WAN probe until the server is running and a public IP is detected.',
      });
    } else {
      for (const p of externalPorts) {
        if (p.protocol === 'udp') {
          wanProbes.push({
            key: p.key,
            label: p.label,
            port: p.port,
            protocol: p.protocol,
            reachable: null,
            status: 'udp_unverifiable',
            detail: `UDP ${p.port} cannot be verified by a generic TCP probe — confirm UDP ${p.port} is forwarded to ${currentLanIp ?? 'this PC'} on your router.`,
            nodesChecked: 0,
          });
        } else {
          const probe = await this.probeExternalTcpPort(publicIp, p.port);
          wanProbes.push({
            key: p.key,
            label: p.label,
            protocol: p.protocol,
            ...probe,
          });
        }
      }

      const tcpProbes = wanProbes.filter((w) => w.status !== 'udp_unverifiable');
      const anyFailed = tcpProbes.some((w) => w.reachable === false);
      const anyOpen = tcpProbes.some((w) => w.reachable === true);
      const allUnavailable = tcpProbes.length > 0 && tcpProbes.every((w) => w.status === 'probe_unavailable');

      if (tcpProbes.length === 0) {
        hops.push({
          id: 'wan_probe',
          label: '5. External Internet (WAN) Reachability',
          status: 'warn',
          summary: 'This game uses UDP-only ports, which generic TCP probes cannot verify automatically.',
          fixHint: `Verify UDP port forwarding to ${currentLanIp ?? 'this PC'} in your router and have a friend test joining.`,
        });
      } else if (anyFailed) {
        const failedList = tcpProbes
          .filter((w) => w.reachable === false)
          .map((w) => `${w.label} (${w.port}/TCP)`)
          .join(', ');
        hops.push({
          id: 'wan_probe',
          label: '5. External Internet (WAN) Reachability',
          status: 'fail',
          summary: `External internet could NOT reach: ${failedList}.`,
          fixHint:
            `Double-check router port forwarding targets ${currentLanIp ?? 'this PC'} with separate TCP/UDP rules (not combined TCP/UDP), click Save, and reboot your router if rules were just added. If a default port is blocked by your router, change to an alternate port in Configuration.`,
        });
      } else if (allUnavailable) {
        hops.push({
          id: 'wan_probe',
          label: '5. External Internet (WAN) Reachability',
          status: 'warn',
          summary: 'External probe service was temporarily unavailable.',
          fixHint: `Test TCP port(s) manually from mobile data (Wi-Fi OFF) or at canyouseeme.org for IP ${publicIp}.`,
        });
      } else if (anyOpen) {
        const openList = tcpProbes
          .filter((w) => w.reachable === true)
          .map((w) => `${w.port}/TCP`)
          .join(', ');
        hops.push({
          id: 'wan_probe',
          label: '5. External Internet (WAN) Reachability',
          status: 'pass',
          summary: `Verified externally reachable from the internet: ${openList}!`,
          detail: wanProbes.some((w) => w.protocol === 'both')
            ? 'Remember to keep the matching UDP rule forwarded alongside TCP for gameplay traffic.'
            : undefined,
        });
      }
    }

    const overallStatus: 'pass' | 'warn' | 'fail' = hops.some((h) => h.status === 'fail')
      ? 'fail'
      : hops.some((h) => h.status === 'warn')
        ? 'warn'
        : 'pass';

    return {
      instanceId: instance.id,
      checkedAt: new Date().toISOString(),
      overallStatus,
      publicIp,
      lanIp: currentLanIp,
      effectiveHost: netStatus.effectiveHost,
      hops,
      wanProbes,
    };
  }
}
