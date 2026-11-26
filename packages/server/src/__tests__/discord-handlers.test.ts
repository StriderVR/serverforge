import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { createServerForgeApp, type ServerForgeApp } from '../api/server.js';
import {
  buildBotInviteUrl,
  DISCORD_BOT_PERMISSIONS_BITMASK,
  normalizeDiscordToken,
  verifyDiscordBotToken,
} from '../discord/bot.js';
import { formatPlayerActivityMessage } from '../discord/discord-handlers.js';

describe('Discord Integration: Setup, Role-Gating, Live Status Panel & Admin Commands (Issues #16, #43)', () => {
  const cleanups: Array<() => Promise<void>> = [];

  async function makeApp(fetchImpl?: typeof fetch): Promise<ServerForgeApp> {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sf-disc-'));
    const sf = await createServerForgeApp({
      dataDir: tmpDir,
      runtimeMode: 'mock',
      discordToken: '',
      fetchImpl,
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

    // Running server has Extend & Stop buttons; stopped servers have Start buttons; last row has Refresh Now
    const allButtons = payload.buttonRows.flat();
    expect(allButtons.some((b) => b.customId === `sf:extend:${instances[0].id}`)).toBe(true);
    expect(allButtons.some((b) => b.customId === `sf:stop:${instances[0].id}`)).toBe(true);
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
});
