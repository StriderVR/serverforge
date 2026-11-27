import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { createServerForgeApp } from '../api/server.js';
import { resolveWorldDatapacksDir } from '../services/modrinth-service.js';

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

describe('Minecraft Plugin & Datapack Manager (Issue #128)', () => {
  it('resolves custom level-name from server.properties and sandboxes path traversal to default world', () => {
    const dir = makeTempDir('sf-dp-level-');
    expect(resolveWorldDatapacksDir(dir)).toEqual({
      worldName: 'world',
      datapacksRelDir: 'world/datapacks',
    });

    fs.writeFileSync(path.join(dir, 'server.properties'), 'level-name=my_smp_world\nmotd=Hello\n', 'utf8');
    expect(resolveWorldDatapacksDir(dir)).toEqual({
      worldName: 'my_smp_world',
      datapacksRelDir: 'my_smp_world/datapacks',
    });

    fs.writeFileSync(path.join(dir, 'server.properties'), 'level-name=../../outside\n', 'utf8');
    expect(resolveWorldDatapacksDir(dir)).toEqual({
      worldName: 'world',
      datapacksRelDir: 'world/datapacks',
    });
  });

  it('detects Paper/Purpur/Spigot environments, installs plugins + datapacks, toggles .zip/.jar, uploads .zip, and checks updates', async () => {
    const tmpDir = makeTempDir('sf-m3-api-');
    let bumpDatapack = false;

    const mockFetch: typeof fetch = async (input) => {
      const url = new URL(typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url);
      if (url.hostname === 'api.modrinth.com') {
        if (url.pathname === '/v2/search') {
          const facets = url.searchParams.get('facets') ?? '';
          if (facets.includes('project_type:datapack')) {
            return new Response(
              JSON.stringify({
                hits: [
                  {
                    project_id: 'dp-terralith',
                    slug: 'terralith',
                    title: 'Terralith',
                    description: 'Overworld biome datapack',
                    project_type: 'datapack',
                    categories: ['datapack'],
                    versions: ['1.21.4'],
                    downloads: 500000,
                  },
                ],
              }),
              { status: 200, headers: { 'Content-Type': 'application/json' } }
            );
          }
          return new Response(
            JSON.stringify({
              hits: [
                {
                  project_id: 'pl-luckperms',
                  slug: 'luckperms',
                  title: 'LuckPerms',
                  description: 'Permissions plugin',
                  project_type: 'mod',
                  categories: ['paper', 'spigot', 'purpur'],
                  versions: ['1.21.4'],
                  downloads: 1000000,
                },
              ],
            }),
            { status: 200, headers: { 'Content-Type': 'application/json' } }
          );
        }

        if (url.pathname === '/v2/project/dp-terralith') {
          return new Response(
            JSON.stringify({ id: 'dp-terralith', slug: 'terralith', title: 'Terralith', project_type: 'datapack' }),
            { status: 200, headers: { 'Content-Type': 'application/json' } }
          );
        }
        if (url.pathname === '/v2/project/dp-terralith/version') {
          const versions = bumpDatapack
            ? [
                {
                  id: 'ver-dp-2',
                  project_id: 'dp-terralith',
                  name: 'Terralith 2.6.0',
                  version_number: '2.6.0',
                  date_published: '2026-11-01T00:00:00Z',
                  game_versions: ['1.21.4'],
                  loaders: ['datapack'],
                  files: [{ url: 'https://cdn.test/Terralith-2.6.0.zip', filename: 'Terralith-2.6.0.zip', primary: true, size: 12 }],
                  dependencies: [],
                },
              ]
            : [
                {
                  id: 'ver-dp-1',
                  project_id: 'dp-terralith',
                  name: 'Terralith 2.5.4',
                  version_number: '2.5.4',
                  date_published: '2026-10-01T00:00:00Z',
                  game_versions: ['1.21.4'],
                  loaders: ['datapack'],
                  files: [{ url: 'https://cdn.test/Terralith-2.5.4.zip', filename: 'Terralith-2.5.4.zip', primary: true, size: 12 }],
                  dependencies: [],
                },
              ];
          return new Response(JSON.stringify(versions), { status: 200, headers: { 'Content-Type': 'application/json' } });
        }
      }

      if (url.hostname === 'cdn.test') {
        return new Response(Buffer.from('PK\x03\x04mockzip'), { status: 200 });
      }

      return new Response('not found', { status: 404 });
    };

    const sf = await createServerForgeApp({
      dataDir: tmpDir,
      runtimeMode: 'mock',
      discordToken: '',
      publicHost: 'localhost',
      detectDuckDnsDomainsImpl: async () => [],
      detectLanIpImpl: () => '192.168.1.50',
      fetchImpl: mockFetch,
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
          name: 'Purpur + Datapacks',
          gameId: 'minecraft',
          runtime: 'native',
          config: { SERVER_TYPE: 'VANILLA', MC_VERSION: '1.21.4' },
        },
      });
      const inst = createRes.json() as { id: string };
      const serverDir = sf.orchestrator.getServerContentDir(sf.orchestrator.getInstance(inst.id)!);
      fs.mkdirSync(serverDir, { recursive: true });
      fs.writeFileSync(path.join(serverDir, 'purpur-1.21.4-2300.jar'), Buffer.from('PK\x03\x04'));
      fs.writeFileSync(path.join(serverDir, 'server.properties'), 'level-name=season3\n', 'utf8');

      // Detection
      const listRes = await sf.app.inject({ method: 'GET', url: `/api/instances/${inst.id}/addons`, headers });
      expect(listRes.statusCode).toBe(200);
      expect(listRes.json()).toMatchObject({
        defaultFolder: 'plugins',
        detectedLoader: 'purpur',
        worldName: 'season3',
        datapacksRelDir: 'season3/datapacks',
      });
      expect(listRes.json().availableFolders).toContain('datapacks');

      // Search & install datapack
      const searchRes = await sf.app.inject({
        method: 'GET',
        url: '/api/modrinth/search?type=datapack&q=terralith&version=1.21.4',
        headers,
      });
      expect(searchRes.statusCode).toBe(200);
      expect(searchRes.json().results[0].projectId).toBe('dp-terralith');

      const installRes = await sf.app.inject({
        method: 'POST',
        url: `/api/instances/${inst.id}/addons/install`,
        headers,
        payload: { projectId: 'dp-terralith', folder: 'datapacks' },
      });
      expect(installRes.statusCode).toBe(200);
      expect(fs.existsSync(path.join(serverDir, 'season3', 'datapacks', 'Terralith-2.5.4.zip'))).toBe(true);

      // Upload custom .zip datapack via dedicated endpoint
      const uploadRes = await sf.app.inject({
        method: 'POST',
        url: `/api/instances/${inst.id}/addons/datapacks/upload?filename=custom.zip`,
        headers: { ...headers, 'content-type': 'application/octet-stream' },
        payload: Buffer.from('PK\x03\x04custom'),
      });
      expect(uploadRes.statusCode).toBe(201);
      expect(fs.existsSync(path.join(serverDir, 'season3', 'datapacks', 'custom.zip'))).toBe(true);

      // Toggle datapack off & on
      const offRes = await sf.app.inject({
        method: 'POST',
        url: `/api/instances/${inst.id}/addons/toggle`,
        headers,
        payload: { folder: 'datapacks', filename: 'Terralith-2.5.4.zip' },
      });
      expect(offRes.statusCode).toBe(200);
      expect(offRes.json()).toMatchObject({ ok: true, enabled: false, filename: 'Terralith-2.5.4.zip.disabled' });

      const onRes = await sf.app.inject({
        method: 'POST',
        url: `/api/instances/${inst.id}/addons/toggle`,
        headers,
        payload: { folder: 'datapacks', filename: 'Terralith-2.5.4.zip.disabled' },
      });
      expect(onRes.statusCode).toBe(200);
      expect(onRes.json()).toMatchObject({ ok: true, enabled: true, filename: 'Terralith-2.5.4.zip' });

      // Update check for datapack
      bumpDatapack = true;
      const updRes = await sf.app.inject({ method: 'GET', url: `/api/instances/${inst.id}/addons/updates`, headers });
      expect(updRes.statusCode).toBe(200);
      expect(updRes.json().updates).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ projectId: 'dp-terralith', folder: 'datapacks', latestVersionId: 'ver-dp-2' }),
        ])
      );

      // Delete datapack
      const delRes = await sf.app.inject({
        method: 'DELETE',
        url: `/api/instances/${inst.id}/addons?folder=datapacks&filename=custom.zip`,
        headers,
      });
      expect(delRes.statusCode).toBe(200);
      expect(fs.existsSync(path.join(serverDir, 'season3', 'datapacks', 'custom.zip'))).toBe(false);
    } finally {
      await sf.close();
    }
  });
});
