import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { createServerForgeApp } from '../api/server.js';
import {
  cleanStaleLoaderArtifacts,
  MinecraftLoaderService,
} from '../services/minecraft-loader-service.js';

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

function createMockLoaderFetch(): typeof fetch {
  return async (input) => {
    const url = new URL(typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url);
    const json = (body: unknown, status = 200) =>
      new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });

    if (url.hostname === 'piston-meta.mojang.com') {
      if (url.pathname.endsWith('version_manifest_v2.json')) {
        return json({
          latest: { release: '1.21.4' },
          versions: [
            { id: '1.21.4', type: 'release', url: 'https://piston-meta.mojang.com/v1/1.21.4.json' },
            { id: '1.20.1', type: 'release', url: 'https://piston-meta.mojang.com/v1/1.20.1.json' },
            { id: '1.16.5', type: 'release', url: 'https://piston-meta.mojang.com/v1/1.16.5.json' },
          ],
        });
      }
      if (url.pathname.endsWith('1.16.5.json')) {
        return json({
          id: '1.16.5',
          javaVersion: { majorVersion: 8 },
          downloads: { server: { url: 'https://piston-data.mojang.com/1.16.5.jar' } },
        });
      }
      return json({
        id: '1.21.4',
        javaVersion: { majorVersion: 21 },
        downloads: { server: { url: 'https://piston-data.mojang.com/1.21.4.jar' } },
      });
    }
    if (url.hostname === 'piston-data.mojang.com') {
      return new Response(Buffer.from('PK\x03\x04vanilla'), { status: 200 });
    }
    if (url.hostname === 'api.papermc.io') {
      if (url.pathname === '/v2/projects/paper') {
        return json({ versions: ['1.20.4', '1.21.4'] });
      }
      if (url.pathname.endsWith('/builds')) {
        return json({
          builds: [
            { build: 110, downloads: { application: { name: 'paper-1.21.4-110.jar' } } },
            { build: 115, downloads: { application: { name: 'paper-1.21.4-115.jar' } } },
          ],
        });
      }
      return new Response(Buffer.from('PK\x03\x04paper'), { status: 200 });
    }
    if (url.hostname === 'meta.fabricmc.net') {
      if (url.pathname === '/v2/versions/game') {
        return json([{ version: '1.21.4', stable: true }]);
      }
      if (url.pathname === '/v2/versions/loader') {
        return json([
          { version: '0.16.10', stable: true },
          { version: '0.16.9', stable: true },
        ]);
      }
      if (url.pathname === '/v2/versions/loader/1.21.4') {
        return json([{ loader: { version: '0.16.10' } }, { loader: { version: '0.16.9' } }]);
      }
      if (url.pathname === '/v2/versions/installer') {
        return json([{ version: '1.0.1', stable: true }]);
      }
      return new Response(Buffer.from('PK\x03\x04fabric'), { status: 200 });
    }
    if (url.hostname === 'files.minecraftforge.net') {
      return json({ promos: { '1.20.1-latest': '47.3.12', '1.20.1-recommended': '47.3.0' } });
    }
    if (url.hostname === 'maven.minecraftforge.net') {
      if (url.pathname.endsWith('.xml')) {
        return new Response(
          '<metadata><versioning><versions><version>1.20.1-47.3.0</version><version>1.20.1-47.3.12</version></versions></versioning></metadata>',
          { status: 200, headers: { 'Content-Type': 'application/xml' } }
        );
      }
      return new Response(Buffer.from('PK\x03\x04forge'), { status: 200 });
    }
    if (url.hostname === 'maven.neoforged.net') {
      if (url.pathname.endsWith('.xml')) {
        return new Response(
          '<metadata><versioning><versions><version>21.1.95</version><version>21.1.110</version></versions></versioning></metadata>',
          { status: 200, headers: { 'Content-Type': 'application/xml' } }
        );
      }
      return new Response(Buffer.from('PK\x03\x04neoforge'), { status: 200 });
    }
    return new Response('Not found', { status: 404 });
  };
}

describe('Minecraft Server Loader Switcher (Issue #127)', () => {
  it('discovers versions & resolves downloads across Vanilla, Paper, Fabric, Forge, and NeoForge', async () => {
    const svc = new MinecraftLoaderService(createMockLoaderFetch());

    const paper = await svc.getLoaderVersions('PAPER', '1.21.4');
    expect(paper.mcVersions).toContain('1.21.4');
    expect(paper.loaderVersions).toEqual(['115', '110']);
    expect(paper.recommendedJavaMajor).toBe(21);

    const forge = await svc.getLoaderVersions('FORGE', '1.20.1');
    expect(forge.loaderVersions).toContain('47.3.12');
    expect(forge.recommendedJavaMajor).toBe(17);

    const neoforge = await svc.getLoaderVersions('NEOFORGE', '1.21.1');
    expect(neoforge.loaderVersions).toEqual(['21.1.110', '21.1.95']);
    expect(neoforge.recommendedJavaMajor).toBe(21);

    const forgeDl = await svc.resolveLoaderDownload('FORGE', '1.20.1', '47.3.12');
    expect(forgeDl.installerKind).toBe('modloader_installer');
    expect(forgeDl.filename).toBe('forge-1.20.1-47.3.12-installer.jar');

    const nfDl = await svc.resolveLoaderDownload('NEOFORGE', '1.21.1', '21.1.110');
    expect(nfDl.installerKind).toBe('modloader_installer');
    expect(nfDl.filename).toBe('neoforge-21.1.110-installer.jar');
  });

  it('cleanStaleLoaderArtifacts removes ONLY loader binaries while preserving worlds, configs, mods, and plugins', () => {
    const dir = makeTempDir('sf-loader-clean-');
    fs.mkdirSync(path.join(dir, 'libraries', 'net', 'minecraftforge', 'forge'), { recursive: true });
    fs.mkdirSync(path.join(dir, '.fabric'), { recursive: true });
    fs.mkdirSync(path.join(dir, 'world'), { recursive: true });
    fs.mkdirSync(path.join(dir, 'mods'), { recursive: true });
    fs.mkdirSync(path.join(dir, 'plugins'), { recursive: true });
    fs.mkdirSync(path.join(dir, 'config'), { recursive: true });

    fs.writeFileSync(path.join(dir, 'server.jar'), 'old');
    fs.writeFileSync(path.join(dir, 'run.bat'), 'old');
    fs.writeFileSync(path.join(dir, 'run.sh'), 'old');
    fs.writeFileSync(path.join(dir, '.serverforge-start.bat'), 'old');
    fs.writeFileSync(path.join(dir, 'forge-1.20.1-47.3.0-installer.jar'), 'old');
    fs.writeFileSync(path.join(dir, 'world', 'level.dat'), 'KEEP_WORLD');
    fs.writeFileSync(path.join(dir, 'server.properties'), 'motd=Keep');
    fs.writeFileSync(path.join(dir, 'whitelist.json'), '[]');
    fs.writeFileSync(path.join(dir, 'mods', 'keep.jar'), 'KEEP_MOD');
    fs.writeFileSync(path.join(dir, 'plugins', 'keep.jar'), 'KEEP_PLUGIN');
    fs.writeFileSync(path.join(dir, 'config', 'keep.toml'), 'KEEP_CFG');

    const removed = cleanStaleLoaderArtifacts(dir);
    expect(removed).toContain('server.jar');
    expect(removed).toContain('run.bat');
    expect(removed).toContain('forge-1.20.1-47.3.0-installer.jar');
    expect(fs.existsSync(path.join(dir, 'libraries', 'net', 'minecraftforge'))).toBe(false);
    expect(fs.existsSync(path.join(dir, '.fabric'))).toBe(false);

    expect(fs.readFileSync(path.join(dir, 'world', 'level.dat'), 'utf8')).toBe('KEEP_WORLD');
    expect(fs.existsSync(path.join(dir, 'server.properties'))).toBe(true);
    expect(fs.existsSync(path.join(dir, 'whitelist.json'))).toBe(true);
    expect(fs.existsSync(path.join(dir, 'mods', 'keep.jar'))).toBe(true);
    expect(fs.existsSync(path.join(dir, 'plugins', 'keep.jar'))).toBe(true);
    expect(fs.existsSync(path.join(dir, 'config', 'keep.toml'))).toBe(true);
  });

  it(
    'switches running Paper -> Fabric with pre-switch backup, downgrades to Vanilla 1.16.5 (java8), and exposes update-check',
    { timeout: 30_000 },
    async () => {
      const tmpDir = makeTempDir('sf-m4-api-');
      const sf = await createServerForgeApp({
        dataDir: tmpDir,
        runtimeMode: 'mock',
        discordToken: '',
        publicHost: 'localhost',
        detectDuckDnsDomainsImpl: async () => [],
        detectLanIpImpl: () => '192.168.1.50',
        fetchImpl: createMockLoaderFetch(),
      });
      sf.telemetry.setMemoryOverrideForTesting({ totalGb: 32, usedGb: 4, freeGb: 28 });

      try {
        const setup = await sf.app.inject({
          method: 'POST',
          url: '/api/auth/setup',
          payload: { username: 'admin', password: 'StrongPassword123!' },
        });
        const headers = { authorization: `Bearer ${(setup.json() as { token: string }).token}` };

        const createRes = await sf.app.inject({
          method: 'POST',
          url: '/api/instances',
          headers,
          payload: {
            name: 'Switcher MC',
            gameId: 'minecraft',
            runtime: 'native',
            config: { SERVER_TYPE: 'PAPER', MC_VERSION: '1.21.4' },
          },
        });
        const inst = createRes.json() as { id: string };
        const serverDir = sf.orchestrator.getServerContentDir(sf.orchestrator.getInstance(inst.id)!);
        fs.mkdirSync(path.join(serverDir, 'world'), { recursive: true });
        fs.writeFileSync(path.join(serverDir, 'world', 'level.dat'), 'WORLD_BYTES');

        // Start server first
        await sf.app.inject({
          method: 'POST',
          url: `/api/instances/${inst.id}/start`,
          headers,
          payload: { temporary: false },
        });

        // Switch Paper -> Fabric with backup
        const swRes = await sf.app.inject({
          method: 'POST',
          url: `/api/instances/${inst.id}/minecraft/loader/switch`,
          headers,
          payload: { loader: 'FABRIC', mcVersion: '1.21.4', createBackup: true },
        });
        expect(swRes.statusCode).toBe(200);
        expect(swRes.json()).toMatchObject({
          ok: true,
          loader: 'FABRIC',
          mcVersion: '1.21.4',
          requiredJavaMajor: 21,
        });
        expect(swRes.json().backupFilename).toBeTruthy();
        expect(fs.existsSync(path.join(serverDir, 'server.jar'))).toBe(true);
        expect(fs.readFileSync(path.join(serverDir, 'world', 'level.dat'), 'utf8')).toBe('WORLD_BYTES');

        // Downgrade to Vanilla 1.16.5 -> JAVA_IMAGE_TAG becomes java8
        const downRes = await sf.app.inject({
          method: 'POST',
          url: `/api/instances/${inst.id}/minecraft/loader/switch`,
          headers,
          payload: { loader: 'VANILLA', mcVersion: '1.16.5', createBackup: false },
        });
        expect(downRes.statusCode).toBe(200);
        const detail = (
          await sf.app.inject({ method: 'GET', url: `/api/instances/${inst.id}`, headers })
        ).json() as { status: string; config: Record<string, string> };
        expect(detail.status).toBe('stopped');
        expect(detail.config.SERVER_TYPE).toBe('VANILLA');
        expect(detail.config.MC_VERSION).toBe('1.16.5');
        expect(detail.config.JAVA_IMAGE_TAG).toBe('java8');

        // Update-check returns supported=true
        const updRes = await sf.app.inject({
          method: 'GET',
          url: `/api/instances/${inst.id}/update-check`,
          headers,
        });
        expect(updRes.statusCode).toBe(200);
        expect(updRes.json().supported).toBe(true);
      } finally {
        await sf.close();
      }
    }
  );
});
