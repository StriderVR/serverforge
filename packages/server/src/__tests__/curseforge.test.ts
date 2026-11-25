import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { createServerForgeApp, type ServerForgeApp } from '../api/server.js';
import { parseCurseForgeUrl, recommendJavaTag } from '../services/curseforge-service.js';

describe('CurseForge Modded Minecraft Integration', () => {
  const cleanups: Array<() => Promise<void>> = [];

  async function makeApp(): Promise<ServerForgeApp> {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sf-cf-'));
    const mockFetch = (async (url: string | URL) => {
      const u = String(url);
      if (u.includes('/mods/search')) {
        return new Response(
          JSON.stringify({
            data: [
              {
                id: 925200,
                name: 'All the Mods 10 - ATM10',
                slug: 'all-the-mods-10',
                summary: 'Kitchen-sink NeoForge modpack for Minecraft 1.21.1',
                downloadCount: 5400000,
                logo: { thumbnailUrl: 'https://example.com/atm10.png' },
                links: { websiteUrl: 'https://www.curseforge.com/minecraft/modpacks/all-the-mods-10' },
                latestFilesIndexes: [{ gameVersion: '1.21.1' }],
              },
            ],
          }),
          { status: 200, headers: { 'content-type': 'application/json' } }
        );
      }
      if (u.includes('/mods/925200/files')) {
        return new Response(
          JSON.stringify({
            data: [
              {
                id: 5900123,
                displayName: 'All the Mods 10-2.14.zip',
                fileName: 'ATM10-2.14.zip',
                fileDate: '2026-10-01T00:00:00Z',
                gameVersions: ['1.21.1', 'NeoForge'],
                isServerPack: false,
                serverPackFileId: 5900124,
              },
            ],
          }),
          { status: 200, headers: { 'content-type': 'application/json' } }
        );
      }
      return new Response('{}', { status: 404 });
    }) as unknown as typeof fetch;

    const sf = await createServerForgeApp({
      dataDir: tmpDir,
      runtimeMode: 'mock',
      discordToken: '',
      fetchImpl: mockFetch,
    });
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

  it('recommends the exact Java Docker image tag for Minecraft versions', () => {
    expect(recommendJavaTag(['1.21.1', 'NeoForge'])).toBe('java21');
    expect(recommendJavaTag(['1.20.6', 'Fabric'])).toBe('java21');
    expect(recommendJavaTag(['1.20.1', 'Forge'])).toBe('java17');
    expect(recommendJavaTag(['1.18.2', 'Forge'])).toBe('java17');
    expect(recommendJavaTag(['1.16.5', 'Forge'])).toBe('java8');
    expect(recommendJavaTag(['1.12.2', 'Forge'])).toBe('java8');
  });

  it('parses CurseForge modpack and file URLs cleanly', () => {
    expect(parseCurseForgeUrl('https://www.curseforge.com/minecraft/modpacks/all-the-mods-10')).toEqual({
      slug: 'all-the-mods-10',
      fileId: null,
    });
    expect(
      parseCurseForgeUrl('https://www.curseforge.com/minecraft/modpacks/rlcraft/files/4612990')
    ).toEqual({
      slug: 'rlcraft',
      fileId: '4612990',
    });
  });

  it('interpolates Docker image tag and injects global CF_API_KEY from Settings', async () => {
    const sf = await makeApp();
    sf.db.saveSettings({ curseforgeApiKey: '$2a$10$test-curseforge-key' });

    const template = sf.catalog.getTemplate('minecraft-curseforge')!;
    expect(template).not.toBeNull();

    const inst = sf.orchestrator.createInstance({
      name: 'ATM10 Friends',
      gameId: 'minecraft-curseforge',
      runtime: 'docker',
      config: {
        CF_SLUG: 'all-the-mods-10',
        CF_FILE_ID: '5900123',
        JAVA_IMAGE_TAG: 'java21',
      },
      autoStart: true,
      discordEnabled: true,
      startImmediately: false,
    });

    const image = sf.runtimeManager.docker.resolveImage(inst, template);
    const env = sf.runtimeManager.docker.buildContainerEnv(inst, template);

    expect(image).toBe('itzg/minecraft-server:java21');
    expect(env).toContain('TYPE=AUTO_CURSEFORGE');
    expect(env).toContain('CF_API_KEY=$2a$10$test-curseforge-key');
    expect(env).toContain('CF_SLUG=all-the-mods-10');
    expect(env).toContain('CF_FILE_ID=5900123');
  });

  it('proxies CurseForge modpack search and version files through authenticated REST API', async () => {
    const sf = await makeApp();
    const { token } = sf.auth.setupInitialAdmin('owner', 'password1234');
    const headers = { authorization: `Bearer ${token}` };

    sf.db.saveSettings({ curseforgeApiKey: 'test-cf-key' });

    const searchRes = await sf.app.inject({
      method: 'GET',
      url: '/api/curseforge/search?q=atm10',
      headers,
    });
    expect(searchRes.statusCode).toBe(200);
    const packs = searchRes.json();
    expect(packs).toHaveLength(1);
    expect(packs[0].slug).toBe('all-the-mods-10');
    expect(packs[0].recommendedJavaTag).toBe('java21');

    const filesRes = await sf.app.inject({
      method: 'GET',
      url: '/api/curseforge/mods/925200/files',
      headers,
    });
    expect(filesRes.statusCode).toBe(200);
    expect(filesRes.json()[0].id).toBe(5900123);
    expect(filesRes.json()[0].serverPackFileId).toBe(5900124);
  });
});
