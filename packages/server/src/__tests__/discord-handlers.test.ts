import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { createServerForgeApp, type ServerForgeApp } from '../api/server.js';

describe('DiscordCommandHandler Role-Gating & Temporary Boot', () => {
  const cleanups: Array<() => Promise<void>> = [];

  async function makeApp(): Promise<ServerForgeApp> {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sf-disc-'));
    const sf = await createServerForgeApp({
      dataDir: tmpDir,
      runtimeMode: 'mock',
      discordToken: '',
    });
    sf.telemetry.setMemoryOverrideForTesting({ totalGb: 64, usedGb: 8, freeGb: 56 });
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
});
