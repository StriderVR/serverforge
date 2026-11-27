import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { createServerForgeApp } from '../api/server.js';
import {
  analyzeMinecraftCrashDir,
  analyzeMinecraftCrashText,
  readBoundedTail,
} from '../services/minecraft-crash-analyzer.js';

const tempDirs: string[] = [];

function makeTempDir(prefix: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}

afterEach(() => {
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop()!;
    fs.rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  }
});

describe('Minecraft Crash Report & latest.log Culprit Analyzer (Issue #129)', () => {
  it('detects Forge missing dependency, Fabric missing dependency, NeoForge client-only mod, Java mismatch, OOM, port conflict, and Paper plugin errors', () => {
    const forge = analyzeMinecraftCrashText({
      crashReportFile: 'crash-reports/crash-forge.txt',
      crashReportText: `---- Minecraft Crash Report ----
Description: Mod loading error has occurred
Caused by: net.minecraftforge.fml.ModLoadingException: Create (create) encountered an error during the common_setup event phase
\tMod File: create-1.20.1-0.5.1.f.jar
\tFailure message: Mod create requires flywheel 0.6.10 or above
\t\tCurrently, flywheel is not installed`,
    });
    expect(forge?.category).toBe('missing_dependency');
    expect(forge?.missingDependencies.some((d) => d.modId === 'flywheel')).toBe(true);
    expect(forge?.suspectedMods.some((m) => m.modId === 'create' || m.jarFile?.includes('create'))).toBe(true);

    const fabric = analyzeMinecraftCrashText({
      latestLogText: `[12:01:03] [main/ERROR]: Incompatible mods found!
A potential solution has been determined, this may resolve your problem:
\t - Install fabric-api, any version.
More details:
\t - Mod 'Lithium' (lithium) 0.14.2 requires any version of fabric-api, which is missing!`,
    });
    expect(fabric?.category).toBe('missing_dependency');
    expect(fabric?.missingDependencies.some((d) => d.modId === 'fabric-api')).toBe(true);

    const neoforgeClient = analyzeMinecraftCrashText({
      crashReportText: `net.neoforged.fml.loading.EarlyLoadingException: Attempted to load class net/minecraft/client/gui/screens/Screen for invalid dist DEDICATED_SERVER
\tMod File: sodium-neoforge-0.6.0.jar
Caused by: net.neoforged.api.distmarker.InvalidDistException: Invalid dist DEDICATED_SERVER in mod sodium (sodium-neoforge-0.6.0.jar)`,
    });
    expect(neoforgeClient?.category).toBe('client_only_mod');
    expect(neoforgeClient?.suspectedMods.some((m) => m.modId === 'sodium')).toBe(true);

    const java25 = analyzeMinecraftCrashText({
      latestLogText:
        'java.lang.UnsupportedClassVersionError: net/minecraft/server/Main has been compiled by a more recent version of the Java Runtime (class file version 69.0), this version of the Java Runtime only recognizes class file versions up to 65.0',
    });
    expect(java25?.category).toBe('java_version_mismatch');
    expect(java25?.requiredJavaMajor).toBe(25);

    const paperPlugin = analyzeMinecraftCrashText({
      latestLogText: `[12:12:02] [Server thread/ERROR]: Error occurred while enabling Essentials v2.20.1 (Is it up to date?)
[12:12:02] [Server thread/ERROR]: Could not load 'plugins/BrokenPlugin.jar' in folder 'plugins'
org.bukkit.plugin.UnknownDependencyException: Unknown/missing dependency plugins: [Vault]. Please download and install these plugins to run 'BrokenPlugin'.`,
    });
    expect(paperPlugin?.category).toBe('missing_dependency');
    expect(paperPlugin?.missingDependencies.some((d) => d.modId === 'Vault')).toBe(true);

    const oom = analyzeMinecraftCrashText({
      latestLogText: 'java.lang.OutOfMemoryError: Java heap space',
    });
    expect(oom?.category).toBe('out_of_memory');

    const portInUse = analyzeMinecraftCrashText({
      latestLogText: '**** FAILED TO BIND TO PORT!\njava.net.BindException: Address already in use: bind',
    });
    expect(portInUse?.category).toBe('port_in_use');
  });

  it('reads newest crash report by mtime, enforces <=64KB bounded tail reading, and redacts secrets', () => {
    const dir = makeTempDir('sf-mc-crash-');
    fs.mkdirSync(path.join(dir, 'crash-reports'), { recursive: true });
    fs.mkdirSync(path.join(dir, 'logs'), { recursive: true });

    const oldPath = path.join(dir, 'crash-reports', 'crash-2026-01-01-server.txt');
    const newPath = path.join(dir, 'crash-reports', 'crash-2026-11-27-server.txt');
    fs.writeFileSync(oldPath, 'java.lang.OutOfMemoryError: Java heap space\n', 'utf8');
    fs.writeFileSync(
      newPath,
      'InvalidDistException: Attempted to load class net/minecraft/client/Minecraft for invalid dist DEDICATED_SERVER\nMod File: oculus-1.20.1.jar\nrcon.password=UltraSecretRcon123\n',
      'utf8'
    );
    fs.utimesSync(oldPath, new Date('2026-01-01T00:00:00Z'), new Date('2026-01-01T00:00:00Z'));
    fs.utimesSync(newPath, new Date('2026-11-27T12:00:00Z'), new Date('2026-11-27T12:00:00Z'));

    const bigLogPath = path.join(dir, 'logs', 'latest.log');
    const filler = '[10:00:00] [Server thread/INFO]: Preparing spawn area...\n'.repeat(4000);
    fs.writeFileSync(bigLogPath, `${filler}token=MySecretToken999\n`, 'utf8');

    const tail = readBoundedTail(bigLogPath, 64 * 1024);
    expect(Buffer.byteLength(tail, 'utf8')).toBeLessThanOrEqual(64 * 1024);
    expect(tail).toContain('MySecretToken999');

    const result = analyzeMinecraftCrashDir(dir, { extraSecrets: ['UltraSecretRcon123'] });
    expect(result?.category).toBe('client_only_mod');
    expect(result?.crashReportFile).toBe('crash-reports/crash-2026-11-27-server.txt');
    expect(JSON.stringify(result)).not.toContain('UltraSecretRcon123');
  });

  it('attaches lastCrash.analysis on unexpected MC exit, exposes GET /minecraft/crash-analysis, and includes it in debug/bug reports', async () => {
    const tmpDir = makeTempDir('sf-mc-crash-api-');
    const sf = await createServerForgeApp({
      dataDir: tmpDir,
      runtimeMode: 'mock',
      discordToken: '',
      publicHost: 'localhost',
      detectDuckDnsDomainsImpl: async () => [],
      detectLanIpImpl: () => '192.168.1.50',
    });
    sf.telemetry.setMemoryOverrideForTesting({ totalGb: 32, usedGb: 4, freeGb: 28 });

    try {
      const setupRes = await sf.app.inject({
        method: 'POST',
        url: '/api/auth/setup',
        payload: { username: 'admin', password: 'CrashTestPassword123!' },
      });
      const { token } = setupRes.json() as { token: string };
      const headers = { authorization: `Bearer ${token}` };

      const createRes = await sf.app.inject({
        method: 'POST',
        url: '/api/instances',
        headers,
        payload: {
          name: 'Crash Analyzer MC',
          gameId: 'minecraft',
          runtime: 'native',
          autoRestartOnCrash: false,
          config: { SERVER_TYPE: 'FORGE', MC_VERSION: '1.20.1', RCON_PASSWORD: 'SecretRconValue99' },
        },
      });
      expect(createRes.statusCode).toBe(201);
      const inst = createRes.json() as { id: string };

      const serverDir = sf.orchestrator.getServerContentDir(sf.orchestrator.getInstance(inst.id)!);
      fs.mkdirSync(path.join(serverDir, 'crash-reports'), { recursive: true });
      fs.writeFileSync(
        path.join(serverDir, 'crash-reports', 'crash-2026-11-27_12.00.00-server.txt'),
        `---- Minecraft Crash Report ----
Mod File: create-1.20.1.jar
Failure message: Mod create requires flywheel 0.6.10 or above
Currently, flywheel is not installed
rcon.password=SecretRconValue99`,
        'utf8'
      );

      // On-demand endpoint
      const analysisRes = await sf.app.inject({
        method: 'GET',
        url: `/api/instances/${inst.id}/minecraft/crash-analysis`,
        headers,
      });
      expect(analysisRes.statusCode).toBe(200);
      expect(analysisRes.body).not.toContain('SecretRconValue99');
      const onDemand = analysisRes.json() as { analysis: { category: string; missingDependencies: Array<{ modId: string }> } };
      expect(onDemand.analysis.category).toBe('missing_dependency');
      expect(onDemand.analysis.missingDependencies.some((d) => d.modId === 'flywheel')).toBe(true);

      // Start & crash via mock runtime
      await sf.app.inject({
        method: 'POST',
        url: `/api/instances/${inst.id}/start`,
        headers,
        payload: { temporary: false },
      });
      sf.runtimeManager.mock.simulateCrash(inst.id, 1, ['Mod create requires flywheel']);

      const detailRes = await sf.app.inject({
        method: 'GET',
        url: `/api/instances/${inst.id}`,
        headers,
      });
      const detail = detailRes.json() as { lastCrash?: { analysis?: { category: string } } };
      expect(detail.lastCrash?.analysis?.category).toBe('missing_dependency');

      // Debug report & Bug Report preview
      const debugRes = await sf.app.inject({
        method: 'GET',
        url: `/api/instances/${inst.id}/debug-report`,
        headers,
      });
      expect(debugRes.statusCode).toBe(200);
      expect((debugRes.json() as { markdown: string }).markdown).toContain('### Minecraft Crash Analysis');

      const previewRes = await sf.app.inject({
        method: 'POST',
        url: '/api/diagnostics/bug-report/preview',
        headers,
        payload: {
          title: 'Crash on startup',
          category: 'game_template',
          description: 'Forge server crashed on boot',
          instanceId: inst.id,
          includeDiagnostics: true,
        },
      });
      expect(previewRes.statusCode).toBe(200);
      const preview = previewRes.json() as { markdown: string };
      expect(preview.markdown).toContain('### Minecraft Crash Analysis');
      expect(preview.markdown).not.toContain('SecretRconValue99');
    } finally {
      await sf.close();
    }
  });
});
