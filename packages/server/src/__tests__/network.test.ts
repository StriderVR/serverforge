import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { createServerForgeApp, type ServerForgeApp } from '../api/server.js';
import {
  extractDuckDnsSubdomains,
  isLocalOrPrivateHost,
  isValidPublicIp,
  normalizeDuckDnsDomain,
  parseDuckDnsDomainsFromText,
} from '../services/network-service.js';

describe('NetworkAddressService & DuckDNS Public Join Address (Issue #2)', () => {
  const cleanups: Array<() => Promise<void>> = [];

  async function makeApp(opts: {
    publicHost?: string;
    detectedDuckDns?: string[];
    publicIp?: string | null;
    lanIp?: string | null;
    duckdnsResponse?: string;
  } = {}): Promise<ServerForgeApp> {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sf-net-'));
    const publicIp = opts.publicIp === undefined ? '73.142.88.19' : opts.publicIp;
    const duckdnsResponse = opts.duckdnsResponse ?? 'OK';

    const mockFetch = (async (url: string | URL) => {
      const u = String(url);
      if (u.includes('api.ipify.org') || u.includes('icanhazip.com')) {
        if (!publicIp) return new Response('error', { status: 503 });
        return new Response(`${publicIp}\n`, { status: 200 });
      }
      if (u.includes('duckdns.org/update')) {
        return new Response(duckdnsResponse, { status: 200 });
      }
      return new Response('not found', { status: 404 });
    }) as unknown as typeof fetch;

    const sf = await createServerForgeApp({
      dataDir: tmpDir,
      runtimeMode: 'mock',
      discordToken: '',
      publicHost: opts.publicHost ?? 'localhost',
      fetchImpl: mockFetch,
      detectDuckDnsDomainsImpl: async () => opts.detectedDuckDns ?? [],
      detectLanIpImpl: () => (opts.lanIp === undefined ? '192.168.1.44' : opts.lanIp),
    });

    cleanups.push(async () => {
      await sf.close();
      fs.rmSync(tmpDir, { recursive: true, force: true });
    });
    return sf;
  }

  afterEach(async () => {
    while (cleanups.length) {
      await cleanups.pop()!();
    }
  });

  it('normalizes DuckDNS domains and classifies local vs public/Tailscale hosts accurately', () => {
    expect(normalizeDuckDnsDomain('mycraft')).toBe('mycraft.duckdns.org');
    expect(normalizeDuckDnsDomain('https://MyCraft.duckdns.org/')).toBe('mycraft.duckdns.org');
    expect(normalizeDuckDnsDomain('box1,box2')).toBe('box1.duckdns.org');
    expect(normalizeDuckDnsDomain('www.duckdns.org')).toBe('');
    expect(extractDuckDnsSubdomains('box1.duckdns.org, box2')).toBe('box1,box2');

    expect(isLocalOrPrivateHost('localhost')).toBe(true);
    expect(isLocalOrPrivateHost('127.0.0.1')).toBe(true);
    expect(isLocalOrPrivateHost('192.168.1.50')).toBe(true);
    expect(isLocalOrPrivateHost('10.0.0.15')).toBe(true);
    expect(isLocalOrPrivateHost('172.16.5.2')).toBe(true);
    expect(isLocalOrPrivateHost('100.64.0.42')).toBe(false); // Tailscale CGNAT preserved
    expect(isLocalOrPrivateHost('73.142.88.19')).toBe(false);
    expect(isLocalOrPrivateHost('mycraft.duckdns.org')).toBe(false);

    expect(isValidPublicIp('73.142.88.19')).toBe(true);
    expect(isValidPublicIp('192.168.1.1')).toBe(false);
    expect(isValidPublicIp('not-an-ip')).toBe(false);
  });

  it('extracts DuckDNS domains from Windows GUI .NET user.config, Registry, Scheduled Tasks, and Linux duck.sh', () => {
    const netConfigXml = `
      <configuration>
        <userSettings>
          <DuckDNS.Properties.Settings>
            <setting name="Domain" serializeAs="String">
              <value>stridercraft</value>
            </setting>
            <setting name="Token" serializeAs="String">
              <value>REDACTED</value>
            </setting>
          </DuckDNS.Properties.Settings>
        </userSettings>
      </configuration>
    `;
    expect(parseDuckDnsDomainsFromText(netConfigXml)).toEqual(['stridercraft.duckdns.org']);

    const registryAndTask = `
      Domains=homebox,arkserver
      curl "https://www.duckdns.org/update?domains=valheimbox&token=REDACTED&ip="
      Visit https://www.duckdns.org for info
    `;
    expect(parseDuckDnsDomainsFromText(registryAndTask).sort()).toEqual([
      'arkserver.duckdns.org',
      'homebox.duckdns.org',
      'valheimbox.duckdns.org',
    ]);
  });

  it('automatically replaces localhost with detected Windows DuckDNS domain and exposes LAN address separately', async () => {
    const sf = await makeApp({
      publicHost: 'localhost',
      detectedDuckDns: ['stridercraft'],
      publicIp: '73.142.88.19',
      lanIp: '192.168.1.44',
    });
    const { token } = sf.auth.setupInitialAdmin('owner', 'password1234');
    const headers = { authorization: `Bearer ${token}` };

    await sf.network.refresh(true);

    const inst = sf.orchestrator.createInstance({
      name: 'Modded World',
      gameId: 'minecraft',
      config: {},
      discordEnabled: true,
      startImmediately: false,
    });

    const listRes = await sf.app.inject({ method: 'GET', url: '/api/instances', headers });
    expect(listRes.statusCode).toBe(200);
    const items = listRes.json() as Array<{
      id: string;
      joinAddress: string;
      localJoinAddress: string | null;
      publicHostSource: string;
    }>;
    const item = items.find((i) => i.id === inst.id)!;
    expect(item.joinAddress).toBe('stridercraft.duckdns.org:25565');
    expect(item.localJoinAddress).toBe('192.168.1.44:25565');
    expect(item.publicHostSource).toBe('detected_duckdns');

    // Discord / orchestrator helper returns the exact same public DuckDNS address
    expect(sf.orchestrator.getJoinAddress(inst)).toBe('stridercraft.duckdns.org:25565');
  });

  it('falls back to detected Public WAN IP when no DuckDNS installation is present and respects manual overrides', async () => {
    const sf = await makeApp({
      publicHost: 'localhost',
      detectedDuckDns: [],
      publicIp: '73.142.88.19',
      lanIp: '192.168.1.44',
    });
    const { token } = sf.auth.setupInitialAdmin('owner', 'password1234');
    const headers = { authorization: `Bearer ${token}` };

    const detectRes = await sf.app.inject({ method: 'POST', url: '/api/network/detect', headers });
    expect(detectRes.statusCode).toBe(200);
    const netStatus = detectRes.json();
    expect(netStatus.effectiveHost).toBe('73.142.88.19');
    expect(netStatus.effectiveHostSource).toBe('public_ip');
    expect(netStatus.lanIp).toBe('192.168.1.44');

    // Switching to manual mode with a custom hostname overrides auto detection
    await sf.app.inject({
      method: 'PUT',
      url: '/api/settings',
      headers,
      payload: { publicHostMode: 'manual', publicHost: 'play.example.com' },
    });

    const statusAfterManual = (
      await sf.app.inject({ method: 'GET', url: '/api/network/status', headers })
    ).json();
    expect(statusAfterManual.effectiveHost).toBe('play.example.com');
    expect(statusAfterManual.effectiveHostSource).toBe('manual');
  });

  it('allows non-local .env PUBLIC_HOST to take effect even after other settings were saved with default localhost', async () => {
    const sf = await makeApp({
      publicHost: 'localhost',
      detectedDuckDns: [],
      publicIp: null,
    });
    // Simulate saving unrelated settings while PUBLIC_HOST was still default 'localhost'
    sf.db.saveSettings({ maxConcurrentServers: 4 }, 'localhost');

    // Now simulate restart after user configured PUBLIC_HOST=myhost.duckdns.org in .env
    const loaded = sf.db.getSettings('myhost.duckdns.org');
    expect(loaded.publicHost).toBe('myhost.duckdns.org');
  });

  it('verifies and saves DuckDNS credentials on OK and reports errors cleanly on KO', async () => {
    const sfOk = await makeApp({ duckdnsResponse: 'OK', publicIp: '73.142.88.19' });
    const { token: authOk } = sfOk.auth.setupInitialAdmin('owner', 'password1234');

    const okRes = await sfOk.app.inject({
      method: 'POST',
      url: '/api/network/duckdns/update',
      headers: { authorization: `Bearer ${authOk}` },
      payload: {
        domain: 'striderbox',
        token: '11111111-2222-3333-4444-555555555555',
        saveOnSuccess: true,
        autoUpdate: true,
      },
    });
    expect(okRes.statusCode).toBe(200);
    const okJson = okRes.json();
    expect(okJson.ok).toBe(true);
    expect(okJson.saved).toBe(true);
    expect(okJson.domain).toBe('striderbox.duckdns.org');
    expect(okJson.status.effectiveHost).toBe('striderbox.duckdns.org');
    expect(okJson.status.effectiveHostSource).toBe('duckdns');

    const savedSettings = sfOk.db.getSettings('localhost');
    expect(savedSettings.duckdnsDomain).toBe('striderbox.duckdns.org');
    expect(savedSettings.duckdnsAutoUpdate).toBe(true);
    expect(savedSettings.publicHostMode).toBe('duckdns');

    const sfKo = await makeApp({ duckdnsResponse: 'KO' });
    const { token: authKo } = sfKo.auth.setupInitialAdmin('owner', 'password1234');
    const koRes = await sfKo.app.inject({
      method: 'POST',
      url: '/api/network/duckdns/update',
      headers: { authorization: `Bearer ${authKo}` },
      payload: { domain: 'wrongdomain', token: 'bad-token' },
    });
    expect(koRes.statusCode).toBe(200);
    expect(koRes.json().ok).toBe(false);
    expect(koRes.json().saved).toBe(false);
    expect(koRes.json().message).toMatch(/rejected/i);
  });
});
