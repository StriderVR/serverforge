import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import archiver from 'archiver';
import { afterEach, describe, expect, it } from 'vitest';
import { createServerForgeApp, type ServerForgeApp } from '../api/server.js';
import { applySafeModpackUpgrade } from '../runtimes/native-runtime.js';
import { FileSecurityError, MAX_EDITABLE_FILE_BYTES, resolveSandboxedPath } from '../services/file-service.js';
import { ModrinthService } from '../services/modrinth-service.js';

async function createZipBuffer(entries: Record<string, string | Buffer>): Promise<Buffer> {
  return new Promise<Buffer>((resolve, reject) => {
    const archive = archiver('zip', { zlib: { level: 6 } });
    const chunks: Buffer[] = [];
    archive.on('data', (c: Buffer) => chunks.push(c));
    archive.on('end', () => resolve(Buffer.concat(chunks)));
    archive.on('error', reject);
    for (const [name, content] of Object.entries(entries)) {
      archive.append(content, { name });
    }
    void archive.finalize();
  });
}

describe('v1.3.2 — File Manager (#12), Minecraft Properties (#36), Modrinth (#14) & Server Updates (#13)', () => {
  const apps: ServerForgeApp[] = [];
  const tempDirs: string[] = [];

  afterEach(async () => {
    for (const sf of apps.splice(0)) {
      await sf.close();
    }
    for (const dir of tempDirs.splice(0)) {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  async function bootApp(fetchImpl?: typeof fetch): Promise<{ sf: ServerForgeApp; authHeaders: Record<string, string> }> {
    const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sf-v132-'));
    tempDirs.push(dataDir);
    const sf = await createServerForgeApp({
      dataDir,
      runtimeMode: 'mock',
      publicHost: '127.0.0.1',
      fetchImpl,
    });
    apps.push(sf);

    const setup = await sf.app.inject({
      method: 'POST',
      url: '/api/auth/setup',
      payload: { username: 'admin', password: 'super-secure-password' },
    });
    expect(setup.statusCode).toBe(200);
    const cookie = setup.cookies.find((c) => c.name === 'sf_token');
    return { sf, authHeaders: { cookie: `sf_token=${cookie!.value}` } };
  }

  it('enforces FileService path-traversal/symlink sandboxing, binary/size guards, and full CRUD REST routes (Issue #12)', async () => {
    const { sf, authHeaders } = await bootApp();
    const mc = sf.orchestrator.createInstance({
      name: 'File Test MC',
      gameId: 'minecraft',
      config: {},
      discordEnabled: true,
      startImmediately: false,
    });
    const serverDir = sf.orchestrator.getServerContentDir(mc);

    // Direct path-traversal & null-byte checks
    expect(() => resolveSandboxedPath(serverDir, '../outside.txt')).toThrow(FileSecurityError);
    expect(() => resolveSandboxedPath(serverDir, '/etc/passwd')).toThrow(FileSecurityError);
    expect(() => resolveSandboxedPath(serverDir, 'bad\0name.txt')).toThrow(FileSecurityError);

    // Symlink escape guard (POSIX)
    if (process.platform !== 'win32') {
      const outsideDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sf-outside-'));
      tempDirs.push(outsideDir);
      fs.writeFileSync(path.join(outsideDir, 'secret.txt'), 'top-secret', 'utf8');
      fs.symlinkSync(outsideDir, path.join(serverDir, 'escape-link'));
      expect(() => resolveSandboxedPath(serverDir, 'escape-link/secret.txt')).toThrow(FileSecurityError);
    }

    // Traversal rejected with 403 via HTTP API
    const traversalRes = await sf.app.inject({
      method: 'GET',
      url: `/api/instances/${mc.id}/files/content?path=${encodeURIComponent('../../secret.txt')}`,
      headers: authHeaders,
    });
    expect(traversalRes.statusCode).toBe(403);

    // Write & read text config file + quickFiles detection
    const writeRes = await sf.app.inject({
      method: 'PUT',
      url: `/api/instances/${mc.id}/files/content`,
      headers: authHeaders,
      payload: { path: 'whitelist.json', content: '[{"name":"Strider"}]' },
    });
    expect(writeRes.statusCode).toBe(200);

    const listRes = await sf.app.inject({
      method: 'GET',
      url: `/api/instances/${mc.id}/files`,
      headers: authHeaders,
    });
    expect(listRes.statusCode).toBe(200);
    const listing = listRes.json() as { entries: Array<{ name: string }>; quickFiles: Array<{ label: string }> };
    expect(listing.entries.some((e) => e.name === 'whitelist.json')).toBe(true);
    expect(listing.quickFiles.some((q) => q.label === 'whitelist.json')).toBe(true);

    // Upload binary .jar and verify inline text editor blocks binary files
    const uploadRes = await sf.app.inject({
      method: 'POST',
      url: `/api/instances/${mc.id}/files/upload?dir=mods&filename=example-mod.jar`,
      headers: { ...authHeaders, 'content-type': 'application/octet-stream' },
      payload: Buffer.from([0x50, 0x4b, 0x03, 0x04, 0x00, 0x00, 0x01, 0x02]),
    });
    expect(uploadRes.statusCode).toBe(201);

    const binEditRes = await sf.app.inject({
      method: 'GET',
      url: `/api/instances/${mc.id}/files/content?path=${encodeURIComponent('mods/example-mod.jar')}`,
      headers: authHeaders,
    });
    expect(binEditRes.statusCode).toBe(400);

    // Oversized text file (> 1 MB) blocked from inline editing
    fs.writeFileSync(path.join(serverDir, 'huge.log'), 'a'.repeat(MAX_EDITABLE_FILE_BYTES + 128), 'utf8');
    const hugeRes = await sf.app.inject({
      method: 'GET',
      url: `/api/instances/${mc.id}/files/content?path=huge.log`,
      headers: authHeaders,
    });
    expect(hugeRes.statusCode).toBe(400);

    // Rename & delete file cleanly
    const renRes = await sf.app.inject({
      method: 'POST',
      url: `/api/instances/${mc.id}/files/rename`,
      headers: authHeaders,
      payload: { path: 'whitelist.json', newName: 'whitelist-backup.json' },
    });
    expect(renRes.statusCode).toBe(200);

    const delRes = await sf.app.inject({
      method: 'DELETE',
      url: `/api/instances/${mc.id}/files?path=whitelist-backup.json`,
      headers: authHeaders,
    });
    expect(delRes.statusCode).toBe(200);
    expect(fs.existsSync(path.join(serverDir, 'whitelist-backup.json'))).toBe(false);
  });

  it('preserves comments, modded keys, and locked RCON/port settings in Minecraft server.properties Editor (Issue #36)', async () => {
    const { sf, authHeaders } = await bootApp();
    const mc = sf.orchestrator.createInstance({
      name: 'Props Test MC',
      gameId: 'minecraft',
      config: {},
      discordEnabled: true,
      startImmediately: false,
    });
    const serverDir = sf.orchestrator.getServerContentDir(mc);

    // 1. Missing file initially
    const missingRes = await sf.app.inject({
      method: 'GET',
      url: `/api/instances/${mc.id}/minecraft/properties`,
      headers: authHeaders,
    });
    expect(missingRes.statusCode).toBe(200);
    expect(missingRes.json().exists).toBe(false);

    // 2. Seed a commented server.properties with custom modded key
    const initialProps = [
      '#Minecraft server properties',
      '#Custom admin note',
      'difficulty=easy',
      'pvp=true',
      'server-port=25565',
      'enable-rcon=true',
      'rcon.port=25575',
      'rcon.password=secret-rcon',
      'custom-mod-flag=keepme',
      '',
    ].join('\n');
    fs.writeFileSync(path.join(serverDir, 'server.properties'), initialProps, 'utf8');

    // 3. Update difficulty & pvp while trying to overwrite managed server-port (should stay locked!)
    const putRes = await sf.app.inject({
      method: 'PUT',
      url: `/api/instances/${mc.id}/minecraft/properties`,
      headers: authHeaders,
      payload: {
        properties: {
          difficulty: 'hard',
          pvp: 'false',
          'allow-flight': 'true',
          'server-port': '9999',
        },
      },
    });
    expect(putRes.statusCode).toBe(200);
    const updated = putRes.json() as { properties: Record<string, string>; rawContent: string };
    expect(updated.properties.difficulty).toBe('hard');
    expect(updated.properties.pvp).toBe('false');
    expect(updated.properties['allow-flight']).toBe('true');
    expect(updated.properties['custom-mod-flag']).toBe('keepme');
    expect(updated.properties['server-port']).toBe('25565'); // locked!
    expect(updated.rawContent).toContain('#Custom admin note');
  });

  it('integrates Modrinth search, dependency auto-install, jar enable/disable toggle, update checks, and .mrpack install (Issue #14)', async () => {
    const mrpackZip = await createZipBuffer({
      'modrinth.index.json': JSON.stringify({
        formatVersion: 1,
        game: 'minecraft',
        name: 'Mock Fabric Pack',
        dependencies: { minecraft: '1.21.1', 'fabric-loader': '0.16.5' },
        files: [
          {
            path: 'mods/lithium-1.0.jar',
            env: { client: 'required', server: 'required' },
            downloads: ['https://cdn.modrinth.test/lithium-1.0.jar'],
          },
          {
            path: 'mods/iris-client-only.jar',
            env: { client: 'required', server: 'unsupported' },
            downloads: ['https://cdn.modrinth.test/iris.jar'],
          },
        ],
      }),
      'overrides/config/pack-banner.txt': 'hello-from-mrpack',
    });

    let latestModVersion = 'ver-1';
    const mockFetch: typeof fetch = async (input) => {
      const url = String(input);
      if (url.includes('/v2/search')) {
        return new Response(
          JSON.stringify({
            hits: [
              {
                project_id: 'proj-lithium',
                slug: 'lithium',
                title: 'Lithium',
                description: 'Server optimization mod',
                project_type: 'mod',
                downloads: 5_000_000,
                categories: ['fabric', 'optimization'],
                versions: ['1.21.1'],
              },
            ],
          }),
          { status: 200, headers: { 'content-type': 'application/json' } }
        );
      }
      if (url.endsWith('/v2/project/proj-lithium')) {
        return new Response(
          JSON.stringify({ id: 'proj-lithium', slug: 'lithium', title: 'Lithium', project_type: 'mod' }),
          { status: 200 }
        );
      }
      if (url.endsWith('/v2/project/proj-fabric-api')) {
        return new Response(
          JSON.stringify({ id: 'proj-fabric-api', slug: 'fabric-api', title: 'Fabric API', project_type: 'mod' }),
          { status: 200 }
        );
      }
      if (url.includes('/v2/project/proj-lithium/version')) {
        return new Response(
          JSON.stringify([
            {
              id: latestModVersion,
              project_id: 'proj-lithium',
              name: latestModVersion === 'ver-1' ? 'Lithium 0.13.0' : 'Lithium 0.14.0',
              version_number: latestModVersion === 'ver-1' ? '0.13.0' : '0.14.0',
              date_published: '2026-01-01T00:00:00Z',
              game_versions: ['1.21.1'],
              loaders: ['fabric'],
              files: [{ url: 'https://cdn.modrinth.test/lithium.jar', filename: 'lithium.jar', primary: true, size: 12 }],
              dependencies: [{ project_id: 'proj-fabric-api', dependency_type: 'required' }],
            },
          ]),
          { status: 200 }
        );
      }
      if (url.includes('/v2/project/proj-fabric-api/version')) {
        return new Response(
          JSON.stringify([
            {
              id: 'fapi-1',
              project_id: 'proj-fabric-api',
              name: 'Fabric API 0.100',
              version_number: '0.100.0',
              date_published: '2026-01-01T00:00:00Z',
              game_versions: ['1.21.1'],
              loaders: ['fabric'],
              files: [{ url: 'https://cdn.modrinth.test/fabric-api.jar', filename: 'fabric-api.jar', primary: true, size: 12 }],
              dependencies: [],
            },
          ]),
          { status: 200 }
        );
      }
      if (url.endsWith('/v2/project/mock-pack/version')) {
        return new Response(
          JSON.stringify([
            {
              id: 'mrpack-v1',
              project_id: 'mock-pack',
              name: 'Mock Pack 1.0',
              version_number: '1.0.0',
              date_published: '2026-01-01T00:00:00Z',
              game_versions: ['1.21.1'],
              loaders: ['fabric'],
              files: [{ url: 'https://cdn.modrinth.test/mock-pack.mrpack', filename: 'mock-pack.mrpack', primary: true, size: mrpackZip.length }],
              dependencies: [],
            },
          ]),
          { status: 200 }
        );
      }
      if (url === 'https://cdn.modrinth.test/mock-pack.mrpack') {
        return new Response(new Uint8Array(mrpackZip), { status: 200 });
      }
      if (url.startsWith('https://cdn.modrinth.test/')) {
        return new Response(new Uint8Array(Buffer.from('PK\x03\x04mockjar')), { status: 200 });
      }
      return new Response('not found', { status: 404 });
    };

    const { sf, authHeaders } = await bootApp(mockFetch);
    const mc = sf.orchestrator.createInstance({
      name: 'Fabric Mod Test',
      gameId: 'minecraft',
      config: { SERVER_TYPE: 'FABRIC', MC_VERSION: '1.21.1' },
      discordEnabled: true,
      startImmediately: false,
    });

    // 1. Search Modrinth
    const searchRes = await sf.app.inject({
      method: 'GET',
      url: '/api/modrinth/search?q=lithium&type=mod&loader=fabric&version=1.21.1',
      headers: authHeaders,
    });
    expect(searchRes.statusCode).toBe(200);
    expect(searchRes.json().results[0].slug).toBe('lithium');

    // 2. Install Lithium -> automatically installs required dependency Fabric API
    const installRes = await sf.app.inject({
      method: 'POST',
      url: `/api/instances/${mc.id}/addons/install`,
      headers: authHeaders,
      payload: { projectId: 'proj-lithium' },
    });
    expect(installRes.statusCode).toBe(200);
    expect(installRes.json().dependenciesInstalled).toEqual(['Fabric API']);

    // 3. Toggle lithium.jar -> lithium.jar.disabled and back
    const toggleRes = await sf.app.inject({
      method: 'POST',
      url: `/api/instances/${mc.id}/addons/toggle`,
      headers: authHeaders,
      payload: { folder: 'mods', filename: 'lithium.jar' },
    });
    expect(toggleRes.statusCode).toBe(200);
    expect(toggleRes.json()).toMatchObject({ filename: 'lithium.jar.disabled', enabled: false });

    // 4. Simulate newer Modrinth version -> check updates detects it
    latestModVersion = 'ver-2';
    const updRes = await sf.app.inject({
      method: 'GET',
      url: `/api/instances/${mc.id}/addons/updates`,
      headers: authHeaders,
    });
    expect(updRes.statusCode).toBe(200);
    expect(updRes.json().updates).toHaveLength(1);
    expect(updRes.json().updates[0].latestVersionNumber).toBe('0.14.0');

    // 5. Verify .mrpack installation extracts server mods + overrides and skips client-only mods
    const mrDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sf-mrpack-'));
    tempDirs.push(mrDir);
    const modrinth = new ModrinthService(mockFetch);
    const logs: string[] = [];
    const mrRes = await modrinth.installMrpackArchive({ projectIdOrSlug: 'mock-pack' }, mrDir, (l) => logs.push(l));
    expect(mrRes.resolvedVersionId).toBe('mrpack-v1');
    expect(fs.existsSync(path.join(mrDir, 'mods', 'lithium-1.0.jar'))).toBe(true);
    expect(fs.existsSync(path.join(mrDir, 'mods', 'iris-client-only.jar'))).toBe(false);
    expect(fs.readFileSync(path.join(mrDir, 'config', 'pack-banner.txt'), 'utf8')).toBe('hello-from-mrpack');
  });

  it('orchestrates SteamCMD updates with auto-backup/restart and preserves worlds/configs during modpack upgrades (Issue #13)', async () => {
    const { sf, authHeaders } = await bootApp();
    sf.db.saveSettings({ hostRamReserveGb: 1, maxConcurrentServers: 4 }, '127.0.0.1');
    sf.telemetry.getMemorySnapshot = async () => ({ totalGb: 32, usedGb: 8, freeGb: 24 });

    // 1. SteamCMD update orchestration (Satisfactory) while running
    const sat = sf.orchestrator.createInstance({
      name: 'Satisfactory Main',
      gameId: 'satisfactory',
      config: {},
      discordEnabled: true,
      startImmediately: false,
    });
    await sf.orchestrator.startInstance(sat.id, { temporary: false, requestedBy: 'admin', source: 'web' });

    const checkRes = await sf.app.inject({
      method: 'GET',
      url: `/api/instances/${sat.id}/update-check`,
      headers: authHeaders,
    });
    expect(checkRes.statusCode).toBe(200);
    expect(checkRes.json()).toMatchObject({ supported: true, kind: 'steamcmd', appId: 1690800 });

    const updateRes = await sf.app.inject({
      method: 'POST',
      url: `/api/instances/${sat.id}/update`,
      headers: authHeaders,
      payload: { createBackup: true, restartIfRunning: true },
    });
    expect(updateRes.statusCode).toBe(200);
    const updateBody = updateRes.json() as { ok: boolean; backupCreated: string | null; restarted: boolean };
    expect(updateBody.ok).toBe(true);
    expect(updateBody.backupCreated).toBeTruthy();
    expect(updateBody.restarted).toBe(true);
    expect(sf.orchestrator.getInstance(sat.id)?.status).toBe('running');

    // 2. Safe modpack upgrade preserves custom world, server.properties, whitelist, and ops while updating mods/config
    const serverDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sf-upgrade-dst-'));
    const stagedDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sf-upgrade-src-'));
    tempDirs.push(serverDir, stagedDir);

    fs.mkdirSync(path.join(serverDir, 'my-smp-world'), { recursive: true });
    fs.writeFileSync(path.join(serverDir, 'my-smp-world', 'level.dat'), 'precious-world-data', 'utf8');
    fs.writeFileSync(path.join(serverDir, 'server.properties'), 'level-name=my-smp-world\ndifficulty=hard\n', 'utf8');
    fs.writeFileSync(path.join(serverDir, 'whitelist.json'), '["Strider"]', 'utf8');
    fs.mkdirSync(path.join(serverDir, 'mods'), { recursive: true });
    fs.writeFileSync(path.join(serverDir, 'mods', 'old-mod.jar'), 'old', 'utf8');

    // Staged new pack includes updated mods AND a dummy server.properties + world that MUST NOT overwrite user data
    fs.mkdirSync(path.join(stagedDir, 'mods'), { recursive: true });
    fs.writeFileSync(path.join(stagedDir, 'mods', 'new-mod.jar'), 'new', 'utf8');
    fs.writeFileSync(path.join(stagedDir, 'server.properties'), 'difficulty=peaceful\n', 'utf8');
    fs.mkdirSync(path.join(stagedDir, 'my-smp-world'), { recursive: true });
    fs.writeFileSync(path.join(stagedDir, 'my-smp-world', 'level.dat'), 'EMPTY', 'utf8');

    const logs: string[] = [];
    applySafeModpackUpgrade(stagedDir, serverDir, (l) => logs.push(l));

    expect(fs.existsSync(path.join(serverDir, 'mods', 'new-mod.jar'))).toBe(true);
    expect(fs.existsSync(path.join(serverDir, 'mods', 'old-mod.jar'))).toBe(false);
    expect(fs.readFileSync(path.join(serverDir, 'my-smp-world', 'level.dat'), 'utf8')).toBe('precious-world-data');
    expect(fs.readFileSync(path.join(serverDir, 'server.properties'), 'utf8')).toContain('difficulty=hard');
    expect(fs.readFileSync(path.join(serverDir, 'whitelist.json'), 'utf8')).toBe('["Strider"]');
  });
});
