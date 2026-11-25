import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { createServerForgeApp, type ServerForgeApp } from '../api/server.js';
import { buildWindowsSwapScript, compareSemver } from '../services/updater-service.js';

describe('UpdaterService — One-Click GitHub Self-Updater & Auto-Resume', () => {
  const cleanups: Array<() => Promise<void>> = [];

  async function makeApp(mockReleaseVersion = 'v1.2.0'): Promise<ServerForgeApp> {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sf-upd-'));
    const mockFetch = (async () =>
      new Response(
        JSON.stringify({
          tag_name: mockReleaseVersion,
          name: `Release ${mockReleaseVersion}`,
          body: 'Added CurseForge and One-Click Updater!',
          html_url: `https://github.com/StriderVR/serverforge/releases/tag/${mockReleaseVersion}`,
          published_at: '2026-11-25T18:00:00Z',
          assets: [
            {
              name: 'ServerForge.exe',
              browser_download_url: 'https://example.com/ServerForge.exe',
              size: 1024,
            },
          ],
        }),
        { status: 200, headers: { 'content-type': 'application/json' } }
      )) as unknown as typeof fetch;

    const sf = await createServerForgeApp({
      dataDir: tmpDir,
      runtimeMode: 'mock',
      discordToken: '',
      appVersion: '1.1.0',
      fetchImpl: mockFetch,
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

  it('compares semver versions accurately', () => {
    expect(compareSemver('1.0.0', 'v1.1.0')).toBe(-1);
    expect(compareSemver('v1.2.0', '1.10.0')).toBe(-1);
    expect(compareSemver('v1.1.0', '1.1.0')).toBe(0);
    expect(compareSemver('2.0.0', '1.9.9')).toBe(1);
  });

  it('generates a clean Windows PowerShell atomic EXE swap script', () => {
    const script = buildWindowsSwapScript({
      currentPid: 4321,
      currentExePath: 'C:\\ServerForge\\ServerForge.exe',
      newExePath: 'C:\\ServerForge\\data\\updates\\ServerForge.new.exe',
      backupExePath: 'C:\\ServerForge\\ServerForge.exe.bak',
      workingDir: 'C:\\ServerForge',
    });
    expect(script).toContain('$targetPid = 4321');
    expect(script).toContain('ServerForge.exe.bak');
    expect(script).toContain('Start-Process -FilePath $currentExe');
  });

  it('detects available GitHub release, saves & stops running servers before updating, and auto-resumes them with leases on startup', async () => {
    const sf = await makeApp('v1.2.0');
    sf.db.saveSettings({ maxConcurrentServers: 4 });

    // Start one permanent server and one temporary Discord-leased server
    const mc = sf.orchestrator.createInstance({
      name: 'Permanent MC',
      gameId: 'minecraft',
      config: {},
      autoStart: false,
      discordEnabled: true,
      startImmediately: false,
    });
    const fac = sf.orchestrator.createInstance({
      name: 'Discord Factorio',
      gameId: 'factorio',
      config: {},
      autoStart: false,
      discordEnabled: true,
      startImmediately: false,
    });

    await sf.orchestrator.startInstance(mc.id, { temporary: false, source: 'web' });
    await sf.orchestrator.startInstance(fac.id, {
      temporary: true,
      durationMinutes: 120,
      idleTimeoutMinutes: 30,
      requestedBy: 'Alex',
      requestedById: 'u-alex',
      source: 'discord',
    });

    // Check update status
    const status = await sf.updater.checkForUpdates(true);
    expect(status.currentVersion).toBe('1.1.0');
    expect(status.latestVersion).toBe('1.2.0');
    expect(status.updateAvailable).toBe(true);
    expect(status.runningServers).toHaveLength(2);

    // Apply dryRun update (saves, stops both servers, writes resume-state.json)
    const applyRes = await sf.updater.applyUpdate({
      resumeRunningServers: true,
      dryRun: true,
      actor: 'owner',
      onShutdownRequested: async () => {},
    });
    expect(applyRes.targetVersion).toBe('1.2.0');
    expect(applyRes.rememberedServers).toBe(2);
    expect(sf.orchestrator.getInstance(mc.id)?.status).toBe('stopped');
    expect(sf.orchestrator.getInstance(fac.id)?.status).toBe('stopped');
    expect(fs.existsSync(sf.updater.getResumeStatePath())).toBe(true);

    // Simulate updated ServerForge booting up -> automatically resumes both servers & restores Discord lease!
    const resumed = await sf.updater.resumeServersOnStartup();
    expect(resumed.reason).toBe('update');
    expect(resumed.resumedIds).toHaveLength(2);
    expect(sf.orchestrator.getInstance(mc.id)?.status).toBe('running');
    expect(sf.orchestrator.getInstance(fac.id)?.status).toBe('running');
    expect(sf.orchestrator.getInstance(fac.id)?.activeLease?.requestedBy).toBe('Alex');
    expect(fs.existsSync(sf.updater.getResumeStatePath())).toBe(false);
  });
});
