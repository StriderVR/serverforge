import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createServerForgeApp, type ServerForgeApp } from '../api/server.js';
import {
  isPrivateLanIpv4,
  parseIgdDeviceDescription,
  parseUpnpSoapError,
} from '../services/upnp-service.js';

function makeTempDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'sf-upnp-'));
}

const SAMPLE_IGD_XML = `<?xml version="1.0"?>
<root xmlns="urn:schemas-upnp-org:device-1-0">
  <device>
    <friendlyName>BT Smart Hub 2</friendlyName>
    <modelName>Smart Hub 2</modelName>
    <deviceList>
      <device>
        <serviceList>
          <service>
            <serviceType>urn:schemas-upnp-org:service:WANIPConnection:1</serviceType>
            <controlURL>/ctl/IPConn</controlURL>
          </service>
        </serviceList>
      </device>
    </deviceList>
  </device>
</root>`;

describe('Opt-In UPnP IGD / NAT-PMP Automatic Router Port Forwarding (Issue #52)', () => {
  const apps: ServerForgeApp[] = [];
  const tempDirs: string[] = [];

  afterEach(async () => {
    while (apps.length) {
      await apps.pop()!.close();
    }
    while (tempDirs.length) {
      fs.rmSync(tempDirs.pop()!, { recursive: true, force: true });
    }
  });

  it('parses IGD XML descriptors, enforces RFC1918 LAN SSRF guards, and translates 718/725 SOAP errors', () => {
    expect(isPrivateLanIpv4('192.168.1.254')).toBe(true);
    expect(isPrivateLanIpv4('10.0.0.1')).toBe(true);
    expect(isPrivateLanIpv4('172.16.5.1')).toBe(true);
    expect(isPrivateLanIpv4('8.8.8.8')).toBe(false);
    expect(isPrivateLanIpv4('127.0.0.1')).toBe(false);

    const parsed = parseIgdDeviceDescription(SAMPLE_IGD_XML, 'http://192.168.1.254:5000/rootDesc.xml');
    expect(parsed).not.toBeNull();
    expect(parsed!.friendlyName).toBe('BT Smart Hub 2');
    expect(parsed!.controlUrl).toBe('http://192.168.1.254:5000/ctl/IPConn');
    expect(parsed!.protocol).toBe('upnp-igd-v1');

    // SSRF guard: reject public IP location URLs
    expect(parseIgdDeviceDescription(SAMPLE_IGD_XML, 'http://8.8.8.8:5000/rootDesc.xml')).toBeNull();

    // SSRF guard: reject cross-host controlURL inside XML
    const evilXml = SAMPLE_IGD_XML.replace('/ctl/IPConn', 'http://169.254.169.254/latest/meta-data/');
    expect(parseIgdDeviceDescription(evilXml, 'http://192.168.1.254:5000/rootDesc.xml')).toBeNull();

    const err718 = parseUpnpSoapError(
      '<s:Fault><detail><UPnPError><errorCode>718</errorCode><errorDescription>ConflictInMappingEntry</errorDescription></UPnPError></detail></s:Fault>',
      7777,
      'TCP'
    );
    expect(err718.code).toBe('718');
    expect(err718.friendlyMessage).toContain('7777/TCP');

    const err725 = parseUpnpSoapError(
      '<s:Fault><detail><UPnPError><errorCode>725</errorCode><errorDescription>OnlyPermanentLeasesSupported</errorDescription></UPnPError></detail></s:Fault>'
    );
    expect(err725.code).toBe('725');
  });

  it('respects opt-in defaults, retries 725 permanent leases, never maps internalOnly ports, unmaps on stop, and cleans stale SQLite mappings on startup', async () => {
    const dataDir = makeTempDir();
    tempDirs.push(dataDir);

    const addCalls: Array<{ port: string; proto: string; lease: string }> = [];
    const deleteCalls: Array<{ port: string; proto: string }> = [];

    const mockFetch = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const url = String(input);
      if (url === 'http://192.168.1.254:5000/rootDesc.xml') {
        return new Response(SAMPLE_IGD_XML, { status: 200 });
      }
      if (url === 'http://192.168.1.254:5000/ctl/IPConn') {
        const headers = (init?.headers ?? {}) as Record<string, string>;
        const soapAction = headers.SOAPAction || '';
        const body = String(init?.body ?? '');

        if (soapAction.includes('#GetExternalIPAddress')) {
          return new Response(
            '<NewExternalIPAddress>86.169.37.0</NewExternalIPAddress>',
            { status: 200 }
          );
        }
        if (soapAction.includes('#GetGenericPortMappingEntry')) {
          return new Response('<errorCode>713</errorCode>', { status: 500 });
        }
        if (soapAction.includes('#AddPortMapping')) {
          const port = /<NewExternalPort>(\d+)<\/NewExternalPort>/.exec(body)?.[1] ?? '';
          const proto = /<NewProtocol>(\w+)<\/NewProtocol>/.exec(body)?.[1] ?? '';
          const lease = /<NewLeaseDuration>(\d+)<\/NewLeaseDuration>/.exec(body)?.[1] ?? '';
          addCalls.push({ port, proto, lease });

          // Simulate a router that requires permanent leases (725) on first attempt
          if (lease !== '0') {
            return new Response(
              '<UPnPError><errorCode>725</errorCode><errorDescription>OnlyPermanentLeasesSupported</errorDescription></UPnPError>',
              { status: 500 }
            );
          }
          return new Response('<u:AddPortMappingResponse/>', { status: 200 });
        }
        if (soapAction.includes('#DeletePortMapping')) {
          const port = /<NewExternalPort>(\d+)<\/NewExternalPort>/.exec(body)?.[1] ?? '';
          const proto = /<NewProtocol>(\w+)<\/NewProtocol>/.exec(body)?.[1] ?? '';
          deleteCalls.push({ port, proto });
          return new Response('<u:DeletePortMappingResponse/>', { status: 200 });
        }
      }
      return new Response('Not found', { status: 404 });
    }) as unknown as typeof fetch;

    const sf = await createServerForgeApp({
      dataDir,
      runtimeMode: 'mock',
      fetchImpl: mockFetch,
      detectDuckDnsDomainsImpl: async () => [],
      detectLanIpImpl: () => '192.168.1.96',
      ssdpDiscoverImpl: async () => ['http://192.168.1.254:5000/rootDesc.xml'],
    });
    apps.push(sf);

    sf.db.saveSettings({ hostRamReserveGb: 1, maxConcurrentServers: 4 }, '127.0.0.1');
    sf.telemetry.getMemorySnapshot = async () => ({ totalGb: 32, usedGb: 8, freeGb: 24 });

    const setupRes = await sf.app.inject({
      method: 'POST',
      url: '/api/auth/setup',
      payload: { username: 'admin', password: 'password1234' },
    });
    const headers = { cookie: setupRes.headers['set-cookie'] as string };

    // 1. Discover router via REST endpoint
    const discRes = await sf.app.inject({
      method: 'POST',
      url: '/api/network/upnp/discover',
      headers,
      payload: {},
    });
    expect(discRes.statusCode).toBe(200);
    const discBody = discRes.json();
    expect(discBody.globalEnabled).toBe(false); // Opt-in OFF by default!
    expect(discBody.router.found).toBe(true);
    expect(discBody.router.friendlyName).toBe('BT Smart Hub 2');
    expect(discBody.router.externalIp).toBe('86.169.37.0');

    // 2. Create Minecraft (has internalOnly RCON 25575) — with global UPnP OFF, starting must NOT map any ports
    const mc = sf.orchestrator.createInstance({
      name: 'Minecraft SMP',
      gameId: 'minecraft',
      ports: { game: 25565, rcon: 25575 },
      config: {},
      startImmediately: false,
    });
    await sf.orchestrator.startInstance(mc.id, { temporary: false });
    expect(addCalls).toHaveLength(0);

    // 3. Enable UPnP specifically for this server via PATCH /api/instances/:id/upnp
    const patchRes = await sf.app.inject({
      method: 'PATCH',
      url: `/api/instances/${mc.id}/upnp`,
      headers,
      payload: { upnpMode: 'enabled' },
    });
    expect(patchRes.statusCode).toBe(200);
    const upnpState = patchRes.json();
    expect(upnpState.effectiveEnabled).toBe(true);
    expect(upnpState.activeMappings).toHaveLength(1);
    expect(upnpState.activeMappings[0].externalPort).toBe(25565);
    expect(upnpState.activeMappings[0].leaseDurationSeconds).toBe(0); // 725 permanent fallback succeeded!
    // RCON (25575) must NEVER be mapped!
    expect(addCalls.some((c) => c.port === '25575')).toBe(false);

    // 4. Stop server -> UPnP mapping automatically deleted on router & SQLite
    await sf.orchestrator.stopInstance(mc.id, 'admin', 'web', 'Done');
    expect(deleteCalls).toContainEqual({ port: '25565', proto: 'TCP' });
    expect(sf.db.listUpnpMappings(mc.id)).toHaveLength(0);

    // 5. Simulate stale SQLite mapping left behind after crash -> reconcileOnStartup cleans it up!
    sf.db.upsertUpnpMapping({
      instanceId: mc.id,
      externalPort: 27777,
      internalPort: 27777,
      protocol: 'UDP',
      internalClient: '192.168.1.96',
      description: 'ServerForge - stale',
      leaseDurationSeconds: 0,
      protocolUsed: 'upnp-igd-v1',
    });
    await sf.orchestrator.reconcileOnStartup();
    expect(deleteCalls).toContainEqual({ port: '27777', proto: 'UDP' });
    expect(sf.db.listUpnpMappings()).toHaveLength(0);
  });
});
