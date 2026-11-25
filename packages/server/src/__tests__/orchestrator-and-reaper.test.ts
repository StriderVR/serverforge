import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { createServerForgeApp, type ServerForgeApp } from '../api/server.js';
import { GuardrailError } from '../services/orchestrator.js';

describe('ServerOrchestrator & LeaseReaper', () => {
  const cleanups: Array<() => Promise<void>> = [];

  async function makeApp(): Promise<ServerForgeApp> {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sf-orch-'));
    const sf = await createServerForgeApp({
      dataDir: tmpDir,
      runtimeMode: 'mock',
      discordToken: '',
    });
    // Guarantee generous mock RAM by default
    sf.telemetry.setMemoryOverrideForTesting({ totalGb: 64, usedGb: 10, freeGb: 54 });
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

  it('auto-offsets ports when deploying multiple instances of the same game', async () => {
    const sf = await makeApp();
    const mc1 = sf.orchestrator.createInstance({ name: 'MC Vanilla', gameId: 'minecraft', config: {}, discordEnabled: true, startImmediately: false });
    const mc2 = sf.orchestrator.createInstance({ name: 'MC Modded', gameId: 'minecraft', config: {}, discordEnabled: true, startImmediately: false });

    expect(mc1.ports.game).toBe(25565);
    expect(mc1.ports.rcon).toBe(25575);
    expect(mc2.ports.game).toBe(25566);
    expect(mc2.ports.rcon).toBe(25576);
    expect(mc1.config.RCON_PASSWORD).toBeTruthy();
    expect(mc1.config.RCON_PASSWORD).not.toBe(mc2.config.RCON_PASSWORD);
  });

  it('enforces maxConcurrentServers and hostRamReserveGb guardrails', async () => {
    const sf = await makeApp();
    sf.db.saveSettings({ maxConcurrentServers: 1, hostRamReserveGb: 4 });

    const mc = sf.orchestrator.createInstance({ name: 'MC One', gameId: 'minecraft', config: {}, discordEnabled: true, startImmediately: false });
    const fac = sf.orchestrator.createInstance({ name: 'Factorio One', gameId: 'factorio', config: {}, discordEnabled: true, startImmediately: false });
    const asa = sf.orchestrator.createInstance({ name: 'Ark ASA', gameId: 'ark-survival-ascended', config: {}, discordEnabled: true, startImmediately: false });

    await sf.orchestrator.startInstance(mc.id);

    // Concurrency cap (1/1) blocks Factorio
    await expect(sf.orchestrator.startInstance(fac.id)).rejects.toThrow(GuardrailError);

    // Increase concurrency cap, then simulate low free RAM (only 10 GB free - 4 GB OS reserve = 6 GB usable < 12 GB ASA min)
    sf.db.saveSettings({ maxConcurrentServers: 3, hostRamReserveGb: 4 });
    sf.telemetry.setMemoryOverrideForTesting({ totalGb: 32, usedGb: 22, freeGb: 10 });

    await expect(sf.orchestrator.startInstance(asa.id)).rejects.toThrow(/Insufficient free RAM/);
  });

  it('triggers 10-min warning and graceful idle auto-shutdown when server stays empty', async () => {
    const sf = await makeApp();
    sf.db.saveSettings({ warningBeforeStopMinutes: 10, defaultIdleTimeoutMinutes: 30 });

    const mc = sf.orchestrator.createInstance({ name: 'Idle Test MC', gameId: 'minecraft', config: {}, discordEnabled: true, startImmediately: false });
    const started = await sf.orchestrator.startInstance(mc.id, {
      temporary: true,
      durationMinutes: 180,
      idleTimeoutMinutes: 30,
      requestedBy: 'friend1',
      source: 'discord',
    });

    const warnings: Array<{ reason: string; minutesRemaining: number }> = [];
    const expirations: Array<{ reason: string }> = [];
    sf.orchestrator.on('lease:warning', (w) => warnings.push({ reason: w.reason, minutesRemaining: w.minutesRemaining }));
    sf.orchestrator.on('lease:expired', (e) => expirations.push({ reason: e.reason }));

    const t0 = new Date(started.activeLease!.startedAt).getTime();

    // 1. Inside boot grace (60s < 180s): should NOT start idle timer yet
    await sf.leaseReaper.runSweep(t0 + 60_000);
    expect(sf.db.getActiveLeaseForInstance(mc.id)?.emptySince).toBeNull();

    // 2. Past boot grace (200s): 0 players -> marks emptySince
    const emptyStartMs = t0 + 200_000;
    await sf.leaseReaper.runSweep(emptyStartMs);
    expect(sf.db.getActiveLeaseForInstance(mc.id)?.emptySince).toBe(new Date(emptyStartMs).toISOString());

    // 3. Player joins -> resets emptySince!
    sf.runtimeManager.mock.setSimulatedPlayers(mc.id, ['Alex']);
    await sf.leaseReaper.runSweep(emptyStartMs + 10 * 60_000);
    expect(sf.db.getActiveLeaseForInstance(mc.id)?.emptySince).toBeNull();

    // 4. Player leaves -> emptySince restarts
    sf.runtimeManager.mock.setSimulatedPlayers(mc.id, []);
    const secondEmptyMs = emptyStartMs + 15 * 60_000;
    await sf.leaseReaper.runSweep(secondEmptyMs);
    expect(sf.db.getActiveLeaseForInstance(mc.id)?.emptySince).toBe(new Date(secondEmptyMs).toISOString());

    // 5. 22 minutes empty (8 minutes left <= 10 min warning window) -> emits warning
    await sf.leaseReaper.runSweep(secondEmptyMs + 22 * 60_000);
    expect(warnings).toHaveLength(1);
    expect(warnings[0].reason).toBe('idle');
    expect(warnings[0].minutesRemaining).toBe(8);

    // 6. 31 minutes empty -> graceful save & auto-stop!
    await sf.leaseReaper.runSweep(secondEmptyMs + 31 * 60_000);
    expect(expirations).toHaveLength(1);
    expect(expirations[0].reason).toBe('idle');
    expect(sf.orchestrator.getInstance(mc.id)?.status).toBe('stopped');
    expect(sf.orchestrator.logs.getLines(mc.id).some((l) => l.line.includes('save-all'))).toBe(true);
  });

  it('creates a valid zip backup archive of the instance directory', async () => {
    const sf = await makeApp();
    const inst = sf.orchestrator.createInstance({ name: 'Backup MC', gameId: 'minecraft', config: {}, discordEnabled: true, startImmediately: false });
    await sf.orchestrator.startInstance(inst.id);
    const backup = await sf.orchestrator.createBackup(inst.id, 'Before Ender Dragon');

    expect(backup.sizeBytes).toBeGreaterThan(0);
    expect(backup.note).toBe('Before Ender Dragon');
    expect(sf.db.listBackups(inst.id)).toHaveLength(1);
  });
});
