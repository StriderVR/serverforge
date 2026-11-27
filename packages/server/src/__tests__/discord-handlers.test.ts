import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ButtonStyle, type ButtonInteraction, type ChatInputCommandInteraction } from 'discord.js';
import { createServerForgeApp, type ServerForgeApp } from '../api/server.js';
import {
  buildBotInviteUrl,
  buildGuideActionRow,
  buildServerActionRow,
  buildServerSlashCommands,
  DISCORD_BOT_PERMISSIONS_BITMASK,
  normalizeDiscordToken,
  verifyDiscordBotToken,
} from '../discord/bot.js';
import {
  formatPlayerActivityMessage,
  hasConfiguredPublicHost,
  interpolateGuideText,
} from '../discord/discord-handlers.js';

describe('Discord Integration: Setup, Role-Gating, Live Status Panel & Admin Commands (Issues #16, #43)', () => {
  const cleanups: Array<() => Promise<void>> = [];

  async function makeApp(
    fetchImpl?: typeof fetch,
    overrides?: { publicHost?: string; detectDuckDnsDomainsImpl?: () => Promise<string[]> }
  ): Promise<ServerForgeApp> {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sf-disc-'));
    const sf = await createServerForgeApp({
      dataDir: tmpDir,
      runtimeMode: 'mock',
      discordToken: '',
      fetchImpl,
      ...(overrides?.publicHost !== undefined ? { publicHost: overrides.publicHost } : {}),
      ...(overrides?.detectDuckDnsDomainsImpl
        ? { detectDuckDnsDomainsImpl: overrides.detectDuckDnsDomainsImpl }
        : {}),
    });
    sf.telemetry.setMemoryOverrideForTesting({ totalGb: 64, usedGb: 8, freeGb: 56 });
    cleanups.push(async () => {
      await sf.close();
      fs.rmSync(tmpDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
    });
    return sf;
  }

  afterEach(async () => {
    while (cleanups.length) {
      await cleanups.pop()!();
    }
  });

  it('blocks unauthorized users and permits role-gated friends to temporarily boot, extend, and stop', async () => {
    const sf = await makeApp();
    sf.db.saveSettings({
      publicHost: '100.64.0.42',
      discordAllowedRoleIds: ['role-gamers'],
      discordAdminRoleIds: ['role-admins'],
      defaultLeaseMinutes: 120,
      maxLeaseMinutes: 300,
    });

    const pal = sf.orchestrator.createInstance({
      name: 'Palworld Friends',
      gameId: 'palworld',
      config: {},
      discordEnabled: true,
      startImmediately: false,
    });

    const stranger = { userId: 'u-stranger', username: 'Stranger', roleIds: [], isGuildAdmin: false, channelId: 'ch-1' };
    const friend = { userId: 'u-alex', username: 'Alex', roleIds: ['role-gamers'], isGuildAdmin: false, channelId: 'ch-1' };
    const otherFriend = { userId: 'u-sam', username: 'Sam', roleIds: ['role-gamers'], isGuildAdmin: false, channelId: 'ch-1' };
    const admin = { userId: 'u-admin', username: 'Owner', roleIds: ['role-admins'], isGuildAdmin: false, channelId: 'ch-1' };

    // Autocomplete finds Palworld Friends
    expect(sf.discord.handler.getAutocompleteChoices('pal')).toHaveLength(1);

    // Stranger cannot boot
    const denied = await sf.discord.handler.handleStart(stranger, pal.slug, 2);
    expect(denied.ok).toBe(false);
    expect(denied.title).toContain('Permission Denied');

    // Authorized friend boots server temporarily
    const started = await sf.discord.handler.handleStart(friend, pal.slug, 2);
    expect(started.ok).toBe(true);
    expect(started.instanceIdForButtons).toBe(pal.id);
    expect(started.fields?.some((f) => f.value.includes('100.64.0.42:8211'))).toBe(true);

    // Friend can extend lease by +60m
    const extended = sf.discord.handler.handleExtend(friend, pal.slug, 60);
    expect(extended.ok).toBe(true);

    // Another non-admin friend cannot stop Alex's session
    const stopDenied = await sf.discord.handler.handleStop(otherFriend, pal.slug);
    expect(stopDenied.ok).toBe(false);

    // Admin CAN stop any session
    const stopped = await sf.discord.handler.handleStop(admin, pal.slug);
    expect(stopped.ok).toBe(true);
    expect(sf.orchestrator.getInstance(pal.id)?.status).toBe('stopped');
  });

  it('enforces admin permissions and executes /server backup, /server say, and /server whitelist (Issue #16)', async () => {
    const sf = await makeApp();
    sf.db.saveSettings({
      discordAllowedRoleIds: ['role-gamers'],
      discordAdminRoleIds: ['role-admins'],
    });

    const mc = sf.orchestrator.createInstance({
      name: 'ATM11 Friends',
      gameId: 'minecraft-curseforge',
      config: {},
      discordEnabled: true,
      startImmediately: false,
    });
    const pal = sf.orchestrator.createInstance({
      name: 'Palworld Realm',
      gameId: 'palworld',
      config: {},
      discordEnabled: true,
      startImmediately: false,
    });

    const friend = { userId: 'u-alex', username: 'Alex', roleIds: ['role-gamers'], isGuildAdmin: false, channelId: 'ch-1' };
    const admin = { userId: 'u-admin', username: 'Owner', roleIds: ['role-admins'], isGuildAdmin: false, channelId: 'ch-1' };

    // Non-admin blocked from admin commands
    expect((await sf.discord.handler.handleBackup(friend, mc.slug)).ok).toBe(false);
    expect((await sf.discord.handler.handleSay(friend, mc.slug, 'hello')).ok).toBe(false);
    expect((await sf.discord.handler.handleWhitelist(friend, mc.slug, 'add', 'Steve')).ok).toBe(false);

    // Admin backup works even when stopped
    const backupRes = await sf.discord.handler.handleBackup(admin, mc.slug, 'Pre-boss snapshot');
    expect(backupRes.ok).toBe(true);
    expect(backupRes.title).toContain('Backup Created');
    expect(sf.db.listBackups(mc.id)).toHaveLength(1);

    // Offline server rejects /server say and /server whitelist cleanly
    const offlineSay = await sf.discord.handler.handleSay(admin, mc.slug, 'Restarting soon');
    expect(offlineSay.ok).toBe(false);
    expect(offlineSay.title).toContain('Offline');

    // Start both servers
    await sf.orchestrator.startInstance(mc.id);
    await sf.orchestrator.startInstance(pal.id);

    // /server say works for Minecraft and Palworld
    const sayMc = await sf.discord.handler.handleSay(admin, mc.slug, 'Server event starting!');
    expect(sayMc.ok).toBe(true);
    expect(sayMc.description).toContain('Server event starting!');

    const sayPal = await sf.discord.handler.handleSay(admin, pal.slug, 'Boss raid in 5m');
    expect(sayPal.ok).toBe(true);

    // /server whitelist rejects non-Minecraft servers and invalid player names
    const badGame = await sf.discord.handler.handleWhitelist(admin, pal.slug, 'add', 'Steve');
    expect(badGame.ok).toBe(false);
    expect(badGame.title).toContain('Unsupported Game');

    const badUser = await sf.discord.handler.handleWhitelist(admin, mc.slug, 'add', 'bad name!@#');
    expect(badUser.ok).toBe(false);
    expect(badUser.title).toContain('Invalid Player Name');

    // Valid whitelist add/list succeeds
    const wlAdd = await sf.discord.handler.handleWhitelist(admin, mc.slug, 'add', 'StriderVR');
    expect(wlAdd.ok).toBe(true);
    expect(wlAdd.title).toContain('Whitelist Updated');

    const wlList = await sf.discord.handler.handleWhitelist(admin, mc.slug, 'list');
    expect(wlList.ok).toBe(true);
  });

  it('builds persistent Live Status Panel payload with interactive rows capped at Discord 5-row limit (Issue #16)', async () => {
    const sf = await makeApp();
    sf.db.saveSettings({ publicHost: 'play.example.com', maxConcurrentServers: 4 });

    const instances: Array<{ id: string }> = [];
    for (let i = 1; i <= 7; i++) {
      instances.push(
        sf.orchestrator.createInstance({
          name: `Server ${i}`,
          gameId: 'minecraft',
          config: {},
          discordEnabled: true,
        })
      );
    }
    await sf.orchestrator.startInstance(instances[0].id);

    const payload = sf.discord.handler.buildStatusPanelPayload();
    expect(payload.title).toContain('1/4 Running');
    expect(payload.fields).toHaveLength(7);
    expect(payload.fields[0].value).toContain('ONLINE');
    expect(payload.fields[0].value).toContain('play.example.com');
    expect(payload.buttonRows.length).toBeLessThanOrEqual(5);

    // Running server has Extend, Stop & Guide buttons; stopped servers have Start & Guide buttons; last row has Refresh Now
    const allButtons = payload.buttonRows.flat();
    expect(allButtons.some((b) => b.customId === `sf:extend:${instances[0].id}`)).toBe(true);
    expect(allButtons.some((b) => b.customId === `sf:stop:${instances[0].id}`)).toBe(true);
    const runningGuideBtn = allButtons.find((b) => b.customId === `sf:guide:${instances[0].id}`);
    expect(runningGuideBtn).toBeDefined();
    expect(runningGuideBtn?.style).toBe('secondary');
    expect(allButtons.some((b) => b.customId.startsWith('sf:panel_start:'))).toBe(true);
    expect(payload.buttonRows[payload.buttonRows.length - 1][0].customId).toBe('sf:panel_refresh');

    // Player activity formatter
    expect(formatPlayerActivityMessage('ATM11', [], [], 0, 8)).toBeNull();
    const activity = formatPlayerActivityMessage('ATM11', ['Alex'], ['Sam'], 2, 8)!;
    expect(activity.title).toContain('2/8 online');
    expect(activity.description).toContain('Alex');
    expect(activity.description).toContain('Sam');
  });

  it('verifies Discord tokens, generates least-privilege invite URLs, exposes /api/discord/* routes, and redacts saved token (Issue #43)', async () => {
    const sampleToken = ['TEST_PART1_12345678901234', 'Part02', 'x'.repeat(30)].join('.');
    expect(normalizeDiscordToken(`  "Bot ${sampleToken}"  `)).toBe(sampleToken);
    expect(buildBotInviteUrl('123456789012345678')).toBe(
      `https://discord.com/oauth2/authorize?client_id=123456789012345678&permissions=${DISCORD_BOT_PERMISSIONS_BITMASK}&scope=bot%20applications.commands`
    );

    const mockFetch = (async (url: string | URL, init?: RequestInit) => {
      const u = String(url);
      const auth = (init?.headers as Record<string, string> | undefined)?.Authorization ?? '';
      if (auth.includes('BAD_TOKEN')) {
        return new Response('Unauthorized', { status: 401 });
      }
      if (u.includes('/users/@me')) {
        return new Response(JSON.stringify({ id: '999888777666555444', username: 'ServerForgeBot', discriminator: '0' }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        });
      }
      if (u.includes('/oauth2/applications/@me')) {
        return new Response(JSON.stringify({ id: '999888777666555444' }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        });
      }
      return new Response('{}', { status: 404 });
    }) as unknown as typeof fetch;

    const validFakeToken = ['SYNTHETIC_BOT_TEST_ID_01', 'Sec002', 'z'.repeat(32)].join('.');
    const verified = await verifyDiscordBotToken(validFakeToken, mockFetch);
    expect(verified.botTag).toBe('ServerForgeBot');
    expect(verified.applicationId).toBe('999888777666555444');
    expect(verified.inviteUrl).toContain('client_id=999888777666555444');
    expect(verified.inviteUrl).toContain(`permissions=${DISCORD_BOT_PERMISSIONS_BITMASK}`);

    await expect(verifyDiscordBotToken('BAD_TOKEN_123456789012345678901234567890', mockFetch)).rejects.toThrow(
      /HTTP 401 Unauthorized/i
    );

    // REST API integration + secret redaction check
    const sf = await makeApp(mockFetch);
    const { token: jwt } = sf.auth.setupInitialAdmin('owner', 'password1234');
    const headers = { authorization: `Bearer ${jwt}` };

    sf.db.saveSettings({ discordBotToken: validFakeToken });

    const statusRes = await sf.app.inject({ method: 'GET', url: '/api/discord/status', headers });
    expect(statusRes.statusCode).toBe(200);
    const statusBody = statusRes.json() as { hasToken: boolean; tokenSource: string; connected: boolean };
    expect(statusBody.hasToken).toBe(true);
    expect(statusBody.tokenSource).toBe('settings');
    expect(statusBody.connected).toBe(false);

    // Diagnostics service must redact SQLite-saved discordBotToken
    sf.diagnostics.record({
      level: 'info',
      source: 'system',
      message: `Testing redaction of ${validFakeToken}`,
    });
    const report = await sf.diagnostics.buildSystemReport();
    expect(report.markdown).not.toContain(validFakeToken);

    // Disconnect with clearToken clears SQLite token cleanly
    const discRes = await sf.app.inject({
      method: 'POST',
      url: '/api/discord/disconnect',
      headers,
      payload: { clearToken: true },
    });
    expect(discRes.statusCode).toBe(200);
    expect(sf.db.getSettings().discordBotToken).toBe('');
  }, 20_000);

  describe('Discord /server guide & How to Connect Buttons (Issue #109)', () => {
    it('returns live online status, players, copyable DuckDNS join address, public ports, loader info & interpolated connectSteps', async () => {
      const sf = await makeApp(undefined, {
        publicHost: 'localhost',
        detectDuckDnsDomainsImpl: async () => [],
      });
      sf.db.saveSettings({
        publicHostMode: 'auto',
        duckdnsDomain: 'myworld.duckdns.org',
      });

      const mc = sf.orchestrator.createInstance({
        name: 'Fabric SMP',
        gameId: 'minecraft',
        config: { SERVER_TYPE: 'FABRIC', MC_VERSION: '1.21.4' },
        discordEnabled: true,
        startImmediately: false,
      });

      await sf.orchestrator.startInstance(mc.id);
      await sf.orchestrator.sendCommand(mc.id, 'mock:join Alex');
      await sf.orchestrator.sendCommand(mc.id, 'mock:join Sam');

      // Lookup works by slug, ID, and case-insensitive name
      for (const query of [mc.slug, mc.id, mc.name.toUpperCase()]) {
        const res = await sf.discord.handler.handleGuide(query);
        expect(res.ok).toBe(true);
        expect(res.title).toContain('Fabric SMP');
        expect(res.instanceIdForButtons).toBeUndefined();
        expect(res.guideInstanceId).toBeUndefined();

        const fieldByName = (name: string) => res.fields?.find((f) => f.name === name);
        expect(fieldByName('Status')?.value).toContain('ONLINE');
        expect(fieldByName('Players')?.value).toContain('2/');
        expect(fieldByName('Join Address')?.value).toContain('```\nmyworld.duckdns.org:25565\n```');
        expect(fieldByName('Join Address')?.value).toContain('DuckDNS');
        expect(fieldByName('Ports')?.value).toContain('25565');
        expect(fieldByName('Ports')?.value).not.toContain('25575');
        expect(fieldByName('Loader & Version')?.value).toContain('FABRIC');
        expect(fieldByName('Loader & Version')?.value).toContain('1.21.4');

        const stepsVal = fieldByName('How to Connect')?.value ?? '';
        expect(stepsVal).toContain('myworld.duckdns.org:25565');
        expect(stepsVal).not.toMatch(/\{address\}|\{host\}|\{port\}|\{\{HOST\}\}|\{\{PORT_GAME\}\}/);
      }
    });

    it('surfaces CurseForge and Modrinth modpack metadata while filtering private CF_PAGE_URLs', async () => {
      const sf = await makeApp(undefined, {
        publicHost: 'play.example.com',
        detectDuckDnsDomainsImpl: async () => [],
      });
      sf.db.saveSettings({ publicHostMode: 'manual', publicHost: 'play.example.com' });

      const cfPublic = sf.orchestrator.createInstance({
        name: 'ATM10 Squad',
        gameId: 'minecraft-curseforge',
        config: {
          CF_SLUG: 'all-the-mods-10',
          CF_FILE_ID: '6123456',
          CF_PAGE_URL: 'https://www.curseforge.com/minecraft/modpacks/all-the-mods-10',
        },
        discordEnabled: true,
      });

      const cfPrivateUrl = sf.orchestrator.createInstance({
        name: 'ATM10 Local Link',
        gameId: 'minecraft-curseforge',
        config: {
          CF_SLUG: 'all-the-mods-10',
          CF_PAGE_URL: 'http://192.168.1.5:3000/dashboard',
        },
        discordEnabled: true,
      });

      const mr = sf.orchestrator.createInstance({
        name: 'Fabulously Optimized',
        gameId: 'minecraft-modrinth',
        config: {
          MR_PROJECT_ID: 'fabulously-optimized',
          MR_VERSION_ID: 'v5.10.0',
        },
        discordEnabled: true,
      });

      const cfRes = await sf.discord.handler.handleGuide(cfPublic.slug);
      expect(cfRes.ok).toBe(true);
      const cfModpack = cfRes.fields?.find((f) => f.name === 'Modpack')?.value ?? '';
      expect(cfModpack).toContain('CurseForge');
      expect(cfModpack).toContain('all-the-mods-10');
      expect(cfModpack).toContain('6123456');
      expect(cfModpack).toContain('https://www.curseforge.com/minecraft/modpacks/all-the-mods-10');

      const cfPrivRes = await sf.discord.handler.handleGuide(cfPrivateUrl.slug);
      expect(JSON.stringify(cfPrivRes)).not.toContain('192.168.1.5');
      expect(JSON.stringify(cfPrivRes)).not.toContain(':3000');

      const mrRes = await sf.discord.handler.handleGuide(mr.slug);
      expect(mrRes.ok).toBe(true);
      const mrModpack = mrRes.fields?.find((f) => f.name === 'Modpack')?.value ?? '';
      expect(mrModpack).toContain('Modrinth');
      expect(mrModpack).toContain('fabulously-optimized');
      expect(mrModpack).toContain('v5.10.0');
    });

    it('handles offline servers cleanly and never crashes when live stats query fails', async () => {
      const sf = await makeApp(undefined, {
        publicHost: 'play.example.com',
        detectDuckDnsDomainsImpl: async () => [],
      });
      sf.db.saveSettings({ publicHostMode: 'manual', publicHost: 'play.example.com' });

      const sat = sf.orchestrator.createInstance({
        name: 'FICSIT Factory',
        gameId: 'satisfactory',
        config: {},
        discordEnabled: true,
      });

      const offlineRes = await sf.discord.handler.handleGuide(sat.slug);
      expect(offlineRes.ok).toBe(true);
      expect(offlineRes.color).toBe(0x475569);
      expect(offlineRes.description).toContain('/server start');
      expect(offlineRes.fields?.find((f) => f.name === 'Status')?.value).toContain('OFFLINE');
      const portsVal = offlineRes.fields?.find((f) => f.name === 'Ports')?.value ?? '';
      expect(portsVal).toContain('7777');
      expect(portsVal).toContain('8888');
      const stepsVal = offlineRes.fields?.find((f) => f.name === 'How to Connect')?.value ?? '';
      expect(stepsVal).toContain('play.example.com');
      expect(stepsVal).toContain('7777');

      // Start server and force refreshInstanceStats to reject
      await sf.orchestrator.startInstance(sat.id);
      const spy = vi.spyOn(sf.orchestrator, 'refreshInstanceStats').mockRejectedValueOnce(new Error('query timeout'));
      const degradedRes = await sf.discord.handler.handleGuide(sat.slug);
      spy.mockRestore();
      expect(degradedRes.ok).toBe(true);
      expect(degradedRes.fields?.find((f) => f.name === 'Status')?.value).toContain('ONLINE');
    });

    it('safely handles unconfigured WAN/DuckDNS and private LAN manual hosts without leaking localhost or LAN IPs', async () => {
      const sf = await makeApp(undefined, {
        publicHost: 'localhost',
        detectDuckDnsDomainsImpl: async () => [],
      });

      const mc = sf.orchestrator.createInstance({
        name: 'Cozy Survival',
        gameId: 'minecraft',
        config: {},
        discordEnabled: true,
      });

      // Case A: fallback localhost
      const fallbackRes = await sf.discord.handler.handleGuide(mc.slug);
      expect(fallbackRes.ok).toBe(true);
      const fallbackJson = JSON.stringify(fallbackRes);
      expect(fallbackRes.fields?.find((f) => f.name === 'Join Address')?.value).toContain('Settings → Networking');
      expect(fallbackJson).not.toContain('localhost');
      expect(fallbackJson).not.toContain('127.0.0.1');
      expect(fallbackJson).not.toContain('undefined:');
      expect(fallbackJson).not.toContain(':3000');

      // Case B: manual private LAN IP
      sf.db.saveSettings({ publicHostMode: 'manual', publicHost: '192.168.1.42' });
      const lanRes = await sf.discord.handler.handleGuide(mc.slug);
      expect(lanRes.ok).toBe(true);
      const lanJson = JSON.stringify(lanRes);
      expect(lanRes.fields?.find((f) => f.name === 'Join Address')?.value).toContain('not configured');
      expect(lanJson).not.toContain('192.168.1.42');
      expect(lanJson).not.toContain('localhost');
      expect(lanJson).not.toContain(':3000');
    });

    it('never exposes RCON/admin/join passwords and displays safe password-required notice when SERVER_PASSWORD is set', async () => {
      const sf = await makeApp(undefined, {
        publicHost: 'play.example.com',
        detectDuckDnsDomainsImpl: async () => [],
      });
      sf.db.saveSettings({ publicHostMode: 'manual', publicHost: 'play.example.com' });

      const pal = sf.orchestrator.createInstance({
        name: 'Palworld Private',
        gameId: 'palworld',
        config: {
          SERVER_PASSWORD: 'TopSecretJoinPass99',
          ADMIN_PASSWORD: 'UltraSecretAdmin88',
          RCON_PASSWORD: 'SuperSecretRcon77',
        },
        discordEnabled: true,
      });

      const res = await sf.discord.handler.handleGuide(pal.slug);
      expect(res.ok).toBe(true);
      const serialized = JSON.stringify(res);
      expect(serialized).not.toContain('TopSecretJoinPass99');
      expect(serialized).not.toContain('UltraSecretAdmin88');
      expect(serialized).not.toContain('SuperSecretRcon77');
      expect(res.fields?.find((f) => f.name === 'Join Password')?.value).toBe('Password required — ask the host');

      // Custom template attempting to interpolate secrets in connectSteps must still redact & block
      sf.catalog.importCustomTemplate(`
id: secret-leak-test
name: Secret Leak Test
shortName: LeakTest
category: other
description: Tests secret redaction
connectSteps:
  - "Join {address} with {{SERVER_PASSWORD}} / {{RCON_PASSWORD}} / TopSecretJoinPass99"
resources:
  minRamGb: 1
  recommendedRamGb: 2
  minDiskGb: 1
ports:
  - key: game
    label: Game Port
    defaultPort: 9999
    protocol: udp
    primary: true
  - key: rcon
    label: RCON Port
    defaultPort: 9998
    protocol: tcp
    internalOnly: true
runtimes:
  preferred: docker
  docker:
    image: example/game:latest
configFields:
  - key: SERVER_PASSWORD
    label: Server Password
    type: secret
    default: ""
  - key: RCON_PASSWORD
    label: RCON Password
    type: secret
    default: ""
`);

      const leakInst = sf.orchestrator.createInstance({
        name: 'Leak Guard',
        gameId: 'secret-leak-test',
        config: {
          SERVER_PASSWORD: 'TopSecretJoinPass99',
          RCON_PASSWORD: 'SuperSecretRcon77',
        },
        discordEnabled: true,
      });

      const leakRes = await sf.discord.handler.handleGuide(leakInst.slug);
      const leakSerialized = JSON.stringify(leakRes);
      expect(leakSerialized).not.toContain('TopSecretJoinPass99');
      expect(leakSerialized).not.toContain('SuperSecretRcon77');
      expect(leakRes.fields?.find((f) => f.name === 'Ports')?.value).not.toContain('9998');
    });

    it('rejects unknown servers and enforces discordEnabled: false', async () => {
      const sf = await makeApp(undefined, {
        publicHost: 'play.example.com',
        detectDuckDnsDomainsImpl: async () => [],
      });
      sf.db.saveSettings({ publicHostMode: 'manual', publicHost: 'play.example.com' });

      const missing = await sf.discord.handler.handleGuide('does-not-exist');
      expect(missing.ok).toBe(false);
      expect(missing.ephemeral).toBe(true);
      expect(missing.title).toContain('Server Not Found');

      const privateServer = sf.orchestrator.createInstance({
        name: 'Dashboard Only Realm',
        gameId: 'minecraft',
        config: {},
        discordEnabled: false,
      });

      const disabled = await sf.discord.handler.handleGuide(privateServer.slug);
      expect(disabled.ok).toBe(false);
      expect(disabled.ephemeral).toBe(true);
      expect(disabled.title).toContain('Disabled');
      expect(JSON.stringify(disabled)).not.toContain('play.example.com');
    });

    it('falls back cleanly from connectSteps -> joinHint -> generic steps and enforces Discord embed limits', async () => {
      const sf = await makeApp(undefined, {
        publicHost: 'play.example.com',
        detectDuckDnsDomainsImpl: async () => [],
      });
      sf.db.saveSettings({ publicHostMode: 'manual', publicHost: 'play.example.com' });

      sf.catalog.importCustomTemplate(`
id: custom-hint-only
name: Hint Only Game
shortName: HintGame
category: other
description: Uses joinHint only
joinHint: "Direct Connect -> {{HOST}}:{{PORT_GAME}}"
resources:
  minRamGb: 1
  recommendedRamGb: 2
  minDiskGb: 1
ports:
  - key: game
    label: Game Port
    defaultPort: 4444
    protocol: udp
    primary: true
runtimes:
  preferred: docker
  docker:
    image: example/hint:latest
`);

      sf.catalog.importCustomTemplate(`
id: custom-no-steps
name: Bare Custom Game
shortName: BareGame
category: other
description: Has neither connectSteps nor joinHint
resources:
  minRamGb: 1
  recommendedRamGb: 2
  minDiskGb: 1
ports:
  - key: game
    label: Game Port
    defaultPort: 5555
    protocol: tcp
    primary: true
runtimes:
  preferred: docker
  docker:
    image: example/bare:latest
`);

      const longLines = Array.from({ length: 20 }, (_, i) => `  - "Step ${i + 1}: ${'x'.repeat(210)} {address}"`).join('\n');
      sf.catalog.importCustomTemplate(`
id: custom-huge-steps
name: Huge Steps Game
shortName: HugeGame
category: other
description: Very long connectSteps
connectSteps:
${longLines}
resources:
  minRamGb: 1
  recommendedRamGb: 2
  minDiskGb: 1
ports:
  - key: game
    label: Game Port
    defaultPort: 6666
    protocol: tcp
    primary: true
runtimes:
  preferred: docker
  docker:
    image: example/huge:latest
`);

      const hintInst = sf.orchestrator.createInstance({ name: 'Hint Realm', gameId: 'custom-hint-only', config: {}, discordEnabled: true });
      const bareInst = sf.orchestrator.createInstance({ name: 'Bare Realm', gameId: 'custom-no-steps', config: {}, discordEnabled: true });
      const hugeInst = sf.orchestrator.createInstance({ name: 'Huge Realm', gameId: 'custom-huge-steps', config: {}, discordEnabled: true });

      const hintRes = await sf.discord.handler.handleGuide(hintInst.slug);
      expect(hintRes.fields?.find((f) => f.name === 'How to Connect')?.value).toContain('Direct Connect -> play.example.com:4444');

      const bareRes = await sf.discord.handler.handleGuide(bareInst.slug);
      const bareSteps = bareRes.fields?.find((f) => f.name === 'How to Connect')?.value ?? '';
      expect(bareSteps).toContain('1. Launch **Bare Custom Game**');
      expect(bareSteps).toContain('play.example.com:5555');

      const hugeRes = await sf.discord.handler.handleGuide(hugeInst.slug);
      expect(hugeRes.title.length).toBeLessThanOrEqual(256);
      expect(hugeRes.description.length).toBeLessThanOrEqual(4096);
      let totalChars = hugeRes.title.length + hugeRes.description.length;
      for (const f of hugeRes.fields ?? []) {
        expect(f.name.length).toBeLessThanOrEqual(256);
        expect(f.value.length).toBeLessThanOrEqual(1024);
        totalChars += f.name.length + f.value.length;
      }
      expect(totalChars).toBeLessThanOrEqual(6000);
    });

    it('interpolates double-brace and single-brace placeholders accurately and validates public hosts', () => {
      const ctx = {
        address: 'play.example.com:7777',
        host: 'play.example.com',
        primaryPort: '7777',
        publicPorts: { game: 7777, reliable: 8888 },
        safeConfig: { SESSION_NAME: 'Dino Island' },
      };

      expect(interpolateGuideText('open {{HOST}}:{{PORT_GAME}} (or search \'{{SESSION_NAME}}\')', ctx)).toBe(
        "open play.example.com:7777 (or search 'Dino Island')"
      );
      expect(interpolateGuideText('Connect {address} on {host}:{port} (reliable {port_reliable} / {{PORT_RELIABLE}})', ctx)).toBe(
        'Connect play.example.com:7777 on play.example.com:7777 (reliable 8888 / 8888)'
      );
      // Internal/secret placeholders must resolve empty
      expect(interpolateGuideText('rcon={{PORT_RCON}} secret={{SERVER_PASSWORD}}', ctx)).toBe('rcon= secret=');

      expect(hasConfiguredPublicHost('myworld.duckdns.org', 'duckdns')).toBe(true);
      expect(hasConfiguredPublicHost('play.example.com', 'manual')).toBe(true);
      expect(hasConfiguredPublicHost('100.64.0.42', 'manual')).toBe(true);
      expect(hasConfiguredPublicHost('192.168.1.10', 'manual')).toBe(false);
      expect(hasConfiguredPublicHost('localhost', 'manual')).toBe(false);
      expect(hasConfiguredPublicHost('play.example.com', 'fallback')).toBe(false);
      expect(hasConfiguredPublicHost('192.168.1.10', 'lan')).toBe(false);
      expect(hasConfiguredPublicHost('', 'duckdns')).toBe(false);
    });

    it('packs Live Status Panel Guide buttons within Discord 5-row / 5-button limits and hides discordEnabled: false servers', async () => {
      const sf = await makeApp(undefined, {
        publicHost: 'play.example.com',
        detectDuckDnsDomainsImpl: async () => [],
      });
      sf.db.saveSettings({ publicHostMode: 'manual', publicHost: 'play.example.com', maxConcurrentServers: 5 });

      const hidden = sf.orchestrator.createInstance({
        name: 'Hidden Admin Server',
        gameId: 'minecraft',
        config: {},
        discordEnabled: false,
      });

      const created: Array<{ id: string }> = [];
      for (let i = 1; i <= 10; i++) {
        created.push(
          sf.orchestrator.createInstance({
            name: `Very Long Server Name Number ${i}`,
            gameId: 'minecraft',
            config: {},
            discordEnabled: true,
          })
        );
      }

      // Case 1: 0 running + 10 stopped -> 4 compact rows (2 servers * 2 buttons = 4 buttons/row) + Refresh row = 5 rows
      const allStopped = sf.discord.handler.buildStatusPanelPayload();
      expect(allStopped.buttonRows).toHaveLength(5);
      expect(allStopped.fields.some((f) => f.name.includes(hidden.name))).toBe(false);
      for (const row of allStopped.buttonRows) {
        expect(row.length).toBeLessThanOrEqual(5);
        for (const btn of row) {
          expect(btn.label.length).toBeLessThanOrEqual(80);
          expect(btn.customId.length).toBeLessThanOrEqual(100);
        }
      }
      const orderedStopped = sf.orchestrator.listInstances().filter((i) => i.discordEnabled);
      expect(allStopped.buttonRows[0]).toHaveLength(4);
      expect(allStopped.buttonRows[0].map((b) => b.customId)).toEqual([
        `sf:panel_start:${orderedStopped[0].id}`,
        `sf:guide:${orderedStopped[0].id}`,
        `sf:panel_start:${orderedStopped[1].id}`,
        `sf:guide:${orderedStopped[1].id}`,
      ]);
      expect(allStopped.buttonRows[4][0].customId).toBe('sf:panel_refresh');

      // Case 2: 4 running + 6 stopped -> 4 running rows ([+1h, Stop, Guide]) + Refresh row = 5 rows
      const runningIds = new Set<string>();
      for (let i = 0; i < 4; i++) {
        await sf.orchestrator.startInstance(created[i].id);
        runningIds.add(created[i].id);
      }
      const fourRunning = sf.discord.handler.buildStatusPanelPayload();
      expect(fourRunning.buttonRows).toHaveLength(5);
      const seenRunningIds = new Set<string>();
      for (let i = 0; i < 4; i++) {
        expect(fourRunning.buttonRows[i]).toHaveLength(3);
        const id = fourRunning.buttonRows[i][0].customId.replace('sf:extend:', '');
        expect(runningIds.has(id)).toBe(true);
        seenRunningIds.add(id);
        expect(fourRunning.buttonRows[i].map((b) => b.customId)).toEqual([
          `sf:extend:${id}`,
          `sf:stop:${id}`,
          `sf:guide:${id}`,
        ]);
      }
      expect(seenRunningIds.size).toBe(4);
      expect(fourRunning.buttonRows[4][0].customId).toBe('sf:panel_refresh');
    });

    it('registers /server guide slash command with autocomplete, builds How to Connect rows, and handles ephemeral sf:guide button clicks', async () => {
      // 1. Slash command registration spec
      const commands = buildServerSlashCommands();
      expect(commands).toHaveLength(1);
      expect(commands[0].name).toBe('server');
      const guideSub = commands[0].options?.find((opt) => opt.name === 'guide') as
        | { name: string; options?: Array<{ name: string; required?: boolean; autocomplete?: boolean }> }
        | undefined;
      expect(guideSub).toBeDefined();
      const nameOpt = guideSub?.options?.find((o) => o.name === 'name');
      expect(nameOpt?.required).toBe(true);
      expect(nameOpt?.autocomplete).toBe(true);

      // 2. Action row helpers
      const fullRow = buildServerActionRow('inst-1').toJSON();
      expect(fullRow.components).toHaveLength(3);
      expect(fullRow.components.map((c) => ('custom_id' in c ? c.custom_id : ''))).toEqual([
        'sf:extend:inst-1',
        'sf:stop:inst-1',
        'sf:guide:inst-1',
      ]);
      expect(fullRow.components[2]).toMatchObject({ label: 'How to Connect', style: ButtonStyle.Secondary });

      const warningRow = buildServerActionRow('inst-1', false).toJSON();
      expect(warningRow.components).toHaveLength(2);

      const guideOnlyRow = buildGuideActionRow('inst-1').toJSON();
      expect(guideOnlyRow.components).toHaveLength(1);
      expect(guideOnlyRow.components[0]).toMatchObject({
        custom_id: 'sf:guide:inst-1',
        label: 'How to Connect',
        style: ButtonStyle.Secondary,
      });

      // 3. Stopped vs running handleStatus guideInstanceId + ephemeral sf:guide:<id> button & /server guide slash dispatch
      const sf = await makeApp(undefined, {
        publicHost: 'play.example.com',
        detectDuckDnsDomainsImpl: async () => [],
      });
      sf.db.saveSettings({ publicHostMode: 'manual', publicHost: 'play.example.com' });

      const mc = sf.orchestrator.createInstance({
        name: 'Weekend Minecraft',
        gameId: 'minecraft',
        config: {},
        discordEnabled: true,
      });

      const stoppedStatus = await sf.discord.handler.handleStatus(mc.slug);
      expect(stoppedStatus.instanceIdForButtons).toBeUndefined();
      expect(stoppedStatus.guideInstanceId).toBe(mc.id);

      // Simulate clicking sf:guide:<id> button on Live Status Panel / status card
      const deferReply = vi.fn().mockResolvedValue(undefined);
      const editReply = vi.fn().mockResolvedValue(undefined);
      const deferUpdate = vi.fn().mockResolvedValue(undefined);
      const reply = vi.fn().mockResolvedValue(undefined);

      const mockButtonInteraction = {
        customId: `sf:guide:${mc.id}`,
        channelId: 'ch-1',
        user: { id: 'u-friend', username: 'Friend', tag: 'Friend' },
        member: { roles: { cache: new Map() } },
        memberPermissions: { has: () => false },
        deferReply,
        editReply,
        deferUpdate,
        reply,
      } as unknown as ButtonInteraction;

      await sf.discord.handleButtonInteraction(mockButtonInteraction);

      expect(deferReply).toHaveBeenCalledTimes(1);
      expect(deferReply).toHaveBeenCalledWith({ ephemeral: true });
      expect(deferUpdate).not.toHaveBeenCalled();
      expect(reply).not.toHaveBeenCalled();
      expect(editReply).toHaveBeenCalledTimes(1);
      const buttonPayload = editReply.mock.calls[0][0] as { embeds: Array<{ toJSON(): { title?: string } }>; components?: unknown };
      expect(buttonPayload.embeds).toHaveLength(1);
      expect(buttonPayload.embeds[0].toJSON().title).toContain('Weekend Minecraft');
      expect(buttonPayload.components).toBeUndefined();

      // Simulate /server guide <name> slash command
      const slashDefer = vi.fn().mockResolvedValue(undefined);
      const slashEdit = vi.fn().mockResolvedValue(undefined);
      const mockSlashInteraction = {
        channelId: 'ch-1',
        user: { id: 'u-friend', username: 'Friend', tag: 'Friend' },
        member: { roles: { cache: new Map() } },
        memberPermissions: { has: () => false },
        options: {
          getSubcommand: () => 'guide',
          getString: (optName: string) => (optName === 'name' ? mc.slug : null),
        },
        deferReply: slashDefer,
        editReply: slashEdit,
      } as unknown as ChatInputCommandInteraction;

      await sf.discord.handleSlashCommand(mockSlashInteraction);
      expect(slashDefer).toHaveBeenCalledTimes(1);
      expect(slashEdit).toHaveBeenCalledTimes(1);
      const slashPayload = slashEdit.mock.calls[0][0] as { embeds: Array<{ toJSON(): { title?: string } }>; components?: unknown };
      expect(slashPayload.embeds[0].toJSON().title).toContain('Weekend Minecraft');
      expect(slashPayload.components).toBeUndefined();

      // Running handleStatus exposes both instanceIdForButtons and guideInstanceId
      await sf.orchestrator.startInstance(mc.id);
      const runningStatus = await sf.discord.handler.handleStatus(mc.slug);
      expect(runningStatus.instanceIdForButtons).toBe(mc.id);
      expect(runningStatus.guideInstanceId).toBe(mc.id);
    });
  });
});
