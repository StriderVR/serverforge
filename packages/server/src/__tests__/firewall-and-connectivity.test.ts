import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { ServerInstance } from '@serverforge/shared';
import { createServerForgeApp, type ServerForgeApp } from '../api/server.js';
import { CatalogService } from '../catalog/catalog-service.js';
import { WORKSPACE_ROOT } from '../config.js';
import {
  buildLinuxUfwScript,
  buildWindowsFirewallScript,
  FirewallService,
  parseWindowsFirewallProbeOutput,
  sanitizeFirewallLabel,
} from '../services/firewall-service.js';
import { isCgnatIp } from '../services/connectivity-service.js';

function makeTempDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'sf-net-v140-'));
}

function makeTestInstance(overrides: Partial<ServerInstance> = {}): ServerInstance {
  return {
    id: 'inst-sat-1',
    slug: 'satisfactory-main',
    name: 'Satisfactory Main',
    gameId: 'satisfactory',
    runtime: 'native',
    status: 'running',
    ports: { game: 27777, reliable: 25578 },
    memoryLimitMb: 8192,
    autoStart: false,
    autoRestartOnCrash: true,
    discordEnabled: true,
    config: {},
    containerId: null,
    externalDir: null,
    launchScript: null,
    lastError: null,
    lastCrash: null,
    lastStartedAt: null,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    ...overrides,
  };
}

describe('v1.4.0 Security-First Networking Suite (#49, #50, #51)', () => {
  const apps: ServerForgeApp[] = [];
  const tempDirs: string[] = [];

  afterEach(async () => {
    while (apps.length) {
      await apps.pop()!.close();
    }
    while (tempDirs.length) {
      const dir = tempDirs.pop()!;
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('generates least-privilege Private-profile Windows Firewall & UFW scripts excluding internalOnly ports and sanitizing labels', () => {
    const catalog = new CatalogService(path.join(WORKSPACE_ROOT, 'catalog', 'games'), makeTempDir());
    const palTpl = catalog.getTemplate('palworld')!;
    const satTpl = catalog.getTemplate('satisfactory')!;

    // Palworld has game (8211/udp), query (27015/udp), plus internalOnly rest (8212/tcp) and rcon (25575/tcp)
    const palInst = makeTestInstance({
      slug: "pal'world; rm -rf /",
      name: 'Palworld $(calc)',
      gameId: 'palworld',
      ports: { game: 8211, query: 27015, rest: 8212, rcon: 25575 },
    });

    const psScript = buildWindowsFirewallScript(palInst, palTpl, {
      switchProfileToPrivate: true,
      profileName: "Network 3'; Start-Process calc",
    });

    // Strictly Private profile — NEVER Any or Public
    expect(psScript).toContain('-Profile Private -Action Allow');
    expect(psScript).not.toContain('-Profile Any');
    expect(psScript).not.toContain('-Profile Public');
    // Required external ports included
    expect(psScript).toContain('-Protocol UDP -LocalPort 8211');
    expect(psScript).toContain('-Protocol UDP -LocalPort 27015');
    // Internal-only management ports NEVER opened
    expect(psScript).not.toContain('8212');
    expect(psScript).not.toContain('25575');
    // Command injection characters stripped from all executable lines
    const executableLines = psScript
      .split(/\r?\n/)
      .filter((line) => line.trim() && !line.trim().startsWith('#'))
      .join('\n');
    expect(executableLines).not.toContain(';');
    expect(executableLines).not.toContain('$(');
    expect(sanitizeFirewallLabel("bad;name$(x)'")).toBe('badname(x)');
    expect(psScript).toContain('Set-NetConnectionProfile -Name');

    // Satisfactory generates TCP+UDP for game port and TCP for reliable port
    const satInst = makeTestInstance();
    const satScript = buildWindowsFirewallScript(satInst, satTpl);
    expect(satScript).toContain('-Protocol TCP -LocalPort 27777 -Profile Private');
    expect(satScript).toContain('-Protocol UDP -LocalPort 27777 -Profile Private');
    expect(satScript).toContain('-Protocol TCP -LocalPort 25578 -Profile Private');

    // Linux UFW commands also exclude internalOnly ports
    const ufw = buildLinuxUfwScript(palInst, palTpl);
    expect(ufw).toContain('sudo ufw allow 8211/udp');
    expect(ufw).toContain('sudo ufw allow 27015/udp');
    expect(ufw).not.toContain('8212');
    expect(ufw).not.toContain('25575');
  });

  it('detects Public network profile, hidden executable Block rules, and exposed internalOnly ports in Windows Firewall inspection', async () => {
    const catalog = new CatalogService(path.join(WORKSPACE_ROOT, 'catalog', 'games'), makeTempDir());
    const mcTpl = catalog.getTemplate('minecraft')!;
    const mcInst = makeTestInstance({
      slug: 'mc-main',
      name: 'Minecraft Main',
      gameId: 'minecraft',
      ports: { game: 25565, rcon: 25575 },
    });

    const probeJson = JSON.stringify({
      isAdmin: true,
      profileCategory: 'Public',
      profileName: 'Network 3',
      allowRules: [
        { displayName: 'Accidental RCON Allow', protocol: 'TCP', localPort: '25575', profile: 'Any' },
      ],
      appBlockRules: [
        { displayName: 'Java Blocked Public', profile: 'Public' },
      ],
    });

    const parsed = parseWindowsFirewallProbeOutput(probeJson);
    expect(parsed.networkProfile).toBe('Public');
    expect(parsed.appBlockRules).toHaveLength(1);

    const fwService = new FirewallService({
      platform: 'win32',
      execImpl: async () => ({ stdout: probeJson, stderr: '', exitCode: 0 }),
    });

    const status = await fwService.inspectInstance(mcInst, mcTpl);
    expect(status.supported).toBe(true);
    expect(status.publicProfileWarning).toBe(true);
    expect(status.appBlockWarnings.length).toBeGreaterThan(0);
    expect(status.internalExposureWarnings.length).toBe(1);
    expect(status.internalExposureWarnings[0]).toContain('25575');

    const rconPort = status.ports.find((p) => p.key === 'rcon')!;
    expect(rconPort.internalOnly).toBe(true);
    expect(rconPort.exposedInternalWarning).toBe(true);

    const gamePort = status.ports.find((p) => p.key === 'game')!;
    expect(gamePort.tcpAllowed).toBe(false);
    expect(gamePort.blockedByAppRule).toBe(true);
  });

  it('runs full 5-hop connectivity troubleshooter, detects LAN IP drift & CGNAT, exposes REST endpoints, and cleans firewall rules on port change / delete', async () => {
    expect(isCgnatIp('100.64.12.3')).toBe(true);
    expect(isCgnatIp('100.127.255.1')).toBe(true);
    expect(isCgnatIp('86.169.37.0')).toBe(false);

    const dataDir = makeTempDir();
    tempDirs.push(dataDir);

    let currentLanIp = '192.168.1.96';
    const removedSlugs: string[] = [];

    const mockExec = vi.fn(async (_file: string, args: string[]) => {
      const joined = args.join(' ');
      if (joined.includes('IsInRole')) {
        return { stdout: 'True\r\n', stderr: '', exitCode: 0 };
      }
      // Decode -EncodedCommand UTF-16LE to inspect what PowerShell script is running
      const encIdx = args.indexOf('-EncodedCommand');
      const decoded =
        encIdx >= 0 && args[encIdx + 1]
          ? Buffer.from(args[encIdx + 1], 'base64').toString('utf16le')
          : joined;

      if (decoded.includes('Remove-NetFirewallRule') && !decoded.includes('New-NetFirewallRule')) {
        removedSlugs.push(decoded);
        return { stdout: '2\r\n', stderr: '', exitCode: 0 };
      }
      if (decoded.includes('Get-NetTCPConnection -State Listen')) {
        return {
          stdout: JSON.stringify([
            { protocol: 'tcp', localAddress: '0.0.0.0', localPort: 27777 },
            { protocol: 'udp', localAddress: '0.0.0.0', localPort: 27777 },
            { protocol: 'tcp', localAddress: '0.0.0.0', localPort: 25578 },
          ]),
          stderr: '',
          exitCode: 0,
        };
      }
      // Firewall inspection probe
      return {
        stdout: JSON.stringify({
          isAdmin: true,
          profileCategory: 'Private',
          profileName: 'HomeLAN',
          allowRules: [
            { displayName: 'ServerForge - sat (27777/TCP)', protocol: 'TCP', localPort: '27777', profile: 'Private' },
            { displayName: 'ServerForge - sat (27777/UDP)', protocol: 'UDP', localPort: '27777', profile: 'Private' },
            { displayName: 'ServerForge - sat (25578/TCP)', protocol: 'TCP', localPort: '25578', profile: 'Private' },
          ],
          appBlockRules: [],
        }),
        stderr: '',
        exitCode: 0,
      };
    });

    const mockFetch = vi.fn(async (input: string | URL | Request) => {
      const url = String(input);
      if (url.includes('ipify.org') || url.includes('icanhazip.com')) {
        return new Response('86.169.37.0', { status: 200 });
      }
      if (url.includes('check-host.net/check-tcp')) {
        return new Response(JSON.stringify({ ok: 1, request_id: 'req-123' }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        });
      }
      if (url.includes('check-host.net/check-result/req-123')) {
        return new Response(
          JSON.stringify({
            'uk1.node.check-host.net': [{ time: 0.021, address: '86.169.37.0' }],
            'de1.node.check-host.net': [{ time: 0.035, address: '86.169.37.0' }],
          }),
          { status: 200, headers: { 'content-type': 'application/json' } }
        );
      }
      return new Response('Not found', { status: 404 });
    }) as unknown as typeof fetch;

    const sf = await createServerForgeApp({
      dataDir,
      runtimeMode: 'mock',
      fetchImpl: mockFetch,
      detectDuckDnsDomainsImpl: async () => [],
      detectLanIpImpl: () => currentLanIp,
      firewallExecImpl: mockExec,
      platformOverride: 'win32',
    });
    apps.push(sf);

    // Setup admin auth
    const setupRes = await sf.app.inject({
      method: 'POST',
      url: '/api/auth/setup',
      payload: { username: 'admin', password: 'password1234' },
    });
    const cookie = setupRes.headers['set-cookie'] as string;
    const headers = { cookie };

    // Deploy Satisfactory with custom ports 27777 & 25578
    const sat = sf.orchestrator.createInstance({
      name: 'Satisfactory Main',
      gameId: 'satisfactory',
      ports: { game: 27777, reliable: 25578 },
      config: {},
      startImmediately: false,
    });
    // Deploy Minecraft (has internalOnly RCON 25575)
    sf.orchestrator.createInstance({
      name: 'Minecraft SMP',
      gameId: 'minecraft',
      ports: { game: 25565, rcon: 25575 },
      config: {},
      startImmediately: false,
    });

    sf.db.saveSettings({ hostRamReserveGb: 1, maxConcurrentServers: 4 }, '127.0.0.1');
    sf.telemetry.getMemorySnapshot = async () => ({ totalGb: 32, usedGb: 8, freeGb: 24 });

    await sf.orchestrator.startInstance(sat.id, { temporary: false });

    // 1. Network Guide (#49)
    const guideRes = await sf.app.inject({
      method: 'GET',
      url: `/api/instances/${sat.id}/network-guide`,
      headers,
    });
    expect(guideRes.statusCode).toBe(200);
    const guide = guideRes.json();
    expect(guide.lanIp).toBe('192.168.1.96');
    expect(guide.copyableRouterText).toContain('External 27777 -> Internal 27777 | Protocol: TCP');
    expect(guide.copyableRouterText).toContain('External 27777 -> Internal 27777 | Protocol: UDP');
    expect(guide.copyableRouterText).toContain('External 25578 -> Internal 25578 | Protocol: TCP');

    // 2. Consolidated Port Map (#49)
    const mapRes = await sf.app.inject({
      method: 'GET',
      url: '/api/network/port-map',
      headers,
    });
    expect(mapRes.statusCode).toBe(200);
    const mapBody = mapRes.json();
    expect(mapBody.entries.some((e: { port: number; internalOnly: boolean }) => e.port === 25575 && e.internalOnly)).toBe(true);

    // 3. Full 5-hop External Connectivity Check (#51) — all green!
    const checkRes = await sf.app.inject({
      method: 'POST',
      url: `/api/instances/${sat.id}/network-check`,
      headers,
      payload: {},
    });
    expect(checkRes.statusCode).toBe(200);
    const report = checkRes.json();
    expect(report.overallStatus).toBe('pass');
    expect(report.hops).toHaveLength(5);
    expect(report.hops.every((h: { status: string }) => h.status === 'pass')).toBe(true);
    expect(report.wanProbes.every((w: { status: string }) => w.status === 'open')).toBe(true);

    // 4. Simulate DHCP LAN IP drift (192.168.1.96 -> 192.168.1.142) and re-check
    currentLanIp = '192.168.1.142';
    await sf.network.refresh(true);
    const driftRes = await sf.app.inject({
      method: 'POST',
      url: `/api/instances/${sat.id}/network-check`,
      headers,
      payload: {},
    });
    const driftReport = driftRes.json();
    const lanHop = driftReport.hops.find((h: { id: string }) => h.id === 'lan_ip');
    expect(lanHop.status).toBe('warn');
    expect(lanHop.summary).toContain('192.168.1.96');
    expect(lanHop.summary).toContain('192.168.1.142');

    // 5. Debug report includes Network & Port Exposure Summary
    const debugRes = await sf.app.inject({
      method: 'GET',
      url: `/api/instances/${sat.id}/debug-report`,
      headers,
    });
    expect(debugRes.statusCode).toBe(200);
    expect(debugRes.json().markdown).toContain('## Network & Port Exposure Summary');
    expect(debugRes.json().markdown).toContain('27777/BOTH');

    // 6. Stop + reassign port -> triggers automatic stale firewall rule cleanup!
    await sf.orchestrator.stopInstance(sat.id, 'admin', 'web', 'Port change');
    const prevCleanups = removedSlugs.length;
    sf.orchestrator.updateInstanceConfig(sat.id, { ports: { game: 27779, reliable: 25578 } });
    // Wait a tick for async best-effort cleanup
    await new Promise((r) => setTimeout(r, 30));
    expect(removedSlugs.length).toBeGreaterThan(prevCleanups);

    // 7. Delete instance -> triggers automatic firewall rule cleanup!
    const beforeDeleteCleanups = removedSlugs.length;
    await sf.orchestrator.deleteInstance(sat.id, 'admin');
    expect(removedSlugs.length).toBeGreaterThan(beforeDeleteCleanups);
  });
});
