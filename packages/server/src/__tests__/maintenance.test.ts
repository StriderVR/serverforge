import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { createServerForgeApp, type ServerForgeApp } from '../api/server.js';

describe('MaintenanceService — Managed Daily PC Reboots', () => {
  const cleanups: Array<() => Promise<void>> = [];

  async function makeApp(onReboot: (reason: string) => void): Promise<ServerForgeApp> {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sf-maint-'));
    const sf = await createServerForgeApp({
      dataDir: tmpDir,
      runtimeMode: 'mock',
      discordToken: '',
      osRebootExecutor: async (reason) => {
        onReboot(reason);
      },
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

  it('warns 10 minutes before reboot, defers when players are online, and saves & stops all servers before rebooting once empty', async () => {
    const rebootReasons: string[] = [];
    const sf = await makeApp((r) => rebootReasons.push(r));

    sf.db.saveSettings({
      dailyRebootEnabled: true,
      dailyRebootTime: '04:00',
      dailyRebootDelayIfPlayersOnline: true,
      dailyRebootResumePolicy: 'autostart_only',
    });

    const mc = sf.orchestrator.createInstance({
      name: 'Always On MC',
      gameId: 'minecraft',
      config: {},
      autoStart: true,
      discordEnabled: true,
      startImmediately: false,
    });
    const tempFac = sf.orchestrator.createInstance({
      name: 'Temp Factorio',
      gameId: 'factorio',
      config: {},
      autoStart: false,
      discordEnabled: true,
      startImmediately: false,
    });

    await sf.orchestrator.startInstance(mc.id);
    await sf.orchestrator.startInstance(tempFac.id);

    const notices: Array<{ kind: string; message: string }> = [];
    sf.maintenance.on('notice', (n) => notices.push(n));

    // 1. At 03:52 (8 mins before 04:00) -> emits 10-min warning
    const tWarn = new Date(2026, 10, 26, 3, 52, 0);
    expect(await sf.maintenance.runTick(tWarn)).toBe('warned');
    expect(notices[0].kind).toBe('warning');

    // 2. Player is online at 04:00 -> defers 15 minutes
    sf.runtimeManager.mock.setSimulatedPlayers(mc.id, ['NightOwl']);
    const tScheduled = new Date(2026, 10, 26, 4, 0, 10);
    expect(await sf.maintenance.runTick(tScheduled)).toBe('deferred');
    expect(rebootReasons).toHaveLength(0);

    // 3. Player logs off; at 04:15:30 -> gracefully saves & stops all servers and triggers OS reboot
    sf.runtimeManager.mock.setSimulatedPlayers(mc.id, []);
    const tAfterDefer = new Date(2026, 10, 26, 4, 15, 30);
    expect(await sf.maintenance.runTick(tAfterDefer)).toBe('rebooted');
    expect(rebootReasons).toHaveLength(1);
    expect(sf.orchestrator.getInstance(mc.id)?.status).toBe('stopped');
    expect(sf.orchestrator.getInstance(tempFac.id)?.status).toBe('stopped');

    // 4. Simulate PC coming back online: autostart_only starts 'Always On MC' and keeps 'Temp Factorio' stopped
    const resumed = await sf.updater.resumeServersOnStartup();
    expect(resumed.postRebootNotify).toBe(true);
    expect(resumed.resumedIds).toHaveLength(0);

    const autoStarted = await sf.orchestrator.startAutoStartInstances(new Set(resumed.resumedIds));
    expect(autoStarted).toEqual([mc.id]);
    expect(sf.orchestrator.getInstance(mc.id)?.status).toBe('running');
    expect(sf.orchestrator.getInstance(tempFac.id)?.status).toBe('stopped');
  });
});
