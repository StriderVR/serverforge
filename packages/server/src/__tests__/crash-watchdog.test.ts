import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { CrashSummary } from '@serverforge/shared';
import { createServerForgeApp, type ServerForgeApp } from '../api/server.js';
import { buildCrashAlertEmbedData } from '../discord/bot.js';
import type { MockRuntimeAdapter } from '../runtimes/mock-runtime.js';

describe('Crash Watchdog, Auto-Restart with Backoff & Discord Crash Alerts (Issue #11)', () => {
  const cleanups: Array<() => Promise<void>> = [];

  async function makeApp(): Promise<{ sf: ServerForgeApp; mockAdapter: MockRuntimeAdapter }> {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sf-watchdog-'));
    const sf = await createServerForgeApp({
      dataDir: tmpDir,
      runtimeMode: 'mock',
      discordToken: '',
    });
    sf.telemetry.setMemoryOverrideForTesting({ totalGb: 64, usedGb: 8, freeGb: 56 });
    sf.orchestrator.configureWatchdog({
      windowMs: 60_000,
      maxRestarts: 2,
      baseBackoffMs: 40,
    });
    const mockAdapter = (await sf.runtimeManager.resolveAdapter('native')) as unknown as MockRuntimeAdapter;
    cleanups.push(async () => {
      await sf.close();
      fs.rmSync(tmpDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 150 });
    });
    return { sf, mockAdapter };
  }

  afterEach(async () => {
    while (cleanups.length) {
      await cleanups.pop()!();
    }
  });

  it('does NOT trigger crash watchdog on intentional stop', async () => {
    const { sf } = await makeApp();
    const crashes: CrashSummary[] = [];
    sf.orchestrator.on('instance:crash', ({ crash }) => crashes.push(crash));

    const inst = sf.orchestrator.createInstance({
      name: 'Clean Stop Server',
      gameId: 'minecraft',
      runtime: 'native',
      autoRestartOnCrash: true,
      config: {},
    });

    await sf.orchestrator.startInstance(inst.id);
    await sf.orchestrator.stopInstance(inst.id, 'owner', 'web', 'Manual stop');

    const after = sf.db.getInstanceById(inst.id)!;
    expect(after.status).toBe('stopped');
    expect(after.lastCrash).toBeNull();
    expect(after.lastError).toBeNull();
    expect(crashes).toHaveLength(0);
  });

  it('recovers from a single unexpected crash with backoff, captures last 50 log lines, and builds Discord alert embed', async () => {
    const { sf, mockAdapter } = await makeApp();
    const crashEvents: Array<{ name: string; crash: CrashSummary }> = [];
    sf.orchestrator.on('instance:crash', ({ instance, crash }) => {
      crashEvents.push({ name: instance.name, crash });
    });

    const inst = sf.orchestrator.createInstance({
      name: 'ATM10 Watchdog',
      gameId: 'minecraft',
      runtime: 'native',
      autoRestartOnCrash: true,
      config: {},
    });
    await sf.orchestrator.startInstance(inst.id);

    // Emit 60 lines of crash logs to verify tail cap of 50 lines
    const crashLines = Array.from({ length: 60 }, (_, i) => `[Server] crash-line-${i + 1}`);
    crashLines.push('java.lang.OutOfMemoryError: Java heap space token=super-secret-value');

    expect(mockAdapter.simulateCrash(inst.id, 137, crashLines)).toBe(true);

    // Immediately after crash: status error, 1 crash event, 50-line tail, nextRestartAt scheduled
    expect(crashEvents).toHaveLength(1);
    const firstCrash = crashEvents[0].crash;
    expect(firstCrash.exitCode).toBe(137);
    expect(firstCrash.attemptCount).toBe(1);
    expect(firstCrash.maxAttempts).toBe(2);
    expect(firstCrash.halted).toBe(false);
    expect(firstCrash.nextRestartAt).toBeTruthy();
    expect(firstCrash.logTail).toHaveLength(50);

    // Discord embed payload check (orange warning + redacted secret)
    const embed = buildCrashAlertEmbedData(inst, firstCrash);
    expect(embed.title).toContain('Server Crash Detected');
    expect(embed.color).toBe(0xf59e0b);
    expect(embed.fields.some((f) => f.name === 'Exit Code' && f.value.includes('137'))).toBe(true);
    expect(embed.fields.some((f) => f.name === 'Attempts' && f.value === '1/2')).toBe(true);
    const tailField = embed.fields.find((f) => f.name === 'Recent Console Tail')!;
    expect(tailField.value).toContain('OutOfMemoryError');
    expect(tailField.value).not.toContain('super-secret-value');

    // Wait for backoff restart (~40ms) to complete
    await new Promise((r) => setTimeout(r, 200));

    const recovered = sf.db.getInstanceById(inst.id)!;
    expect(recovered.status).toBe('running');
    expect(recovered.lastCrash?.attemptCount).toBe(1);
    expect(recovered.lastCrash?.nextRestartAt).toBeNull();
  });

  it('halts automatic restarts when crash-loop circuit breaker threshold is exceeded and sends red halt embed', async () => {
    const { sf, mockAdapter } = await makeApp();
    const crashEvents: CrashSummary[] = [];
    sf.orchestrator.on('instance:crash', ({ crash }) => crashEvents.push(crash));

    const inst = sf.orchestrator.createInstance({
      name: 'Looping Server',
      gameId: 'minecraft',
      runtime: 'native',
      autoRestartOnCrash: true,
      config: {},
    });
    await sf.orchestrator.startInstance(inst.id);

    // Crash #1 -> auto-restarts (backoff 40ms)
    mockAdapter.simulateCrash(inst.id, 1, ['Fatal mod error #1']);
    await new Promise((r) => setTimeout(r, 150));
    expect(sf.db.getInstanceById(inst.id)?.status).toBe('running');

    // Crash #2 -> auto-restarts (backoff 80ms)
    mockAdapter.simulateCrash(inst.id, 1, ['Fatal mod error #2']);
    await new Promise((r) => setTimeout(r, 200));
    expect(sf.db.getInstanceById(inst.id)?.status).toBe('running');

    // Crash #3 -> exceeds maxRestarts (2) -> circuit breaker halts!
    mockAdapter.simulateCrash(inst.id, 1, ['Fatal mod error #3']);
    await new Promise((r) => setTimeout(r, 200));

    const haltedInst = sf.db.getInstanceById(inst.id)!;
    expect(haltedInst.status).toBe('error');
    expect(haltedInst.lastCrash?.halted).toBe(true);
    expect(haltedInst.lastCrash?.attemptCount).toBe(3);
    expect(haltedInst.lastCrash?.nextRestartAt).toBeNull();
    expect(haltedInst.lastError).toMatch(/Crash-loop circuit breaker/i);

    expect(crashEvents).toHaveLength(3);
    const haltEmbed = buildCrashAlertEmbedData(haltedInst, crashEvents[2]);
    expect(haltEmbed.title).toContain('Crash-Loop Halted');
    expect(haltEmbed.color).toBe(0xef4444);
  });

  it('does not auto-restart when autoRestartOnCrash is false', async () => {
    const { sf, mockAdapter } = await makeApp();
    const inst = sf.orchestrator.createInstance({
      name: 'No Auto Restart',
      gameId: 'minecraft',
      runtime: 'native',
      autoRestartOnCrash: false,
      config: {},
    });
    await sf.orchestrator.startInstance(inst.id);

    mockAdapter.simulateCrash(inst.id, 2, ['Manual review crash']);
    await new Promise((r) => setTimeout(r, 150));

    const after = sf.db.getInstanceById(inst.id)!;
    expect(after.status).toBe('error');
    expect(after.lastCrash?.halted).toBe(true);
    expect(after.lastCrash?.nextRestartAt).toBeNull();
  });
});
