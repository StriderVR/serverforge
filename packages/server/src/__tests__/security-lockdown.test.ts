import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { createServerForgeApp, type ServerForgeApp } from '../api/server.js';
import { buildDockerPortBindings } from '../runtimes/docker-runtime.js';

const tmpDirs: string[] = [];
const apps: ServerForgeApp[] = [];

function makeTmpDir(prefix = 'sf-lockdown-'): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  tmpDirs.push(dir);
  return dir;
}

afterEach(async () => {
  while (apps.length > 0) {
    await apps.pop()!.close();
  }
  while (tmpDirs.length > 0) {
    fs.rmSync(tmpDirs.pop()!, { recursive: true, force: true });
  }
});

describe('Security & Audit Tab, Health Checklist, Host Lockdown & Loopback RCON (#64)', () => {
  it('binds Docker internalOnly ports strictly to 127.0.0.1 while leaving game ports open', () => {
    const { exposedPorts, portBindings } = buildDockerPortBindings(
      { ports: { game: 25565, rcon: 25575, rest: 8212 } },
      {
        ports: [
          { key: 'game', label: 'Game', defaultPort: 25565, protocol: 'tcp', primary: true, internalOnly: false },
          {
            key: 'rcon',
            label: 'RCON',
            defaultPort: 25575,
            protocol: 'tcp',
            primary: false,
            internalOnly: true,
          },
          {
            key: 'rest',
            label: 'REST API',
            defaultPort: 8212,
            protocol: 'tcp',
            primary: false,
            internalOnly: true,
          },
        ],
      }
    );

    expect(exposedPorts['25565/tcp']).toEqual({});
    expect(portBindings['25565/tcp']).toEqual([{ HostPort: '25565' }]);
    expect(portBindings['25575/tcp']).toEqual([{ HostIp: '127.0.0.1', HostPort: '25575' }]);
    expect(portBindings['8212/tcp']).toEqual([{ HostIp: '127.0.0.1', HostPort: '8212' }]);
  });

  it('reports Windows Administrator elevation warning in GET /api/security/health', async () => {
    const dir = makeTmpDir();
    const sf = await createServerForgeApp({
      dataDir: dir,
      runtimeMode: 'mock',
      publicHost: '127.0.0.1',
      platformOverride: 'win32',
      elevatedAdminOverride: true,
    });
    apps.push(sf);

    const { token } = sf.auth.setupInitialAdmin('admin', 'admin-password-123');
    const res = await sf.app.inject({
      method: 'GET',
      url: '/api/security/health',
      headers: { authorization: `Bearer ${token}` },
    });
    expect(res.statusCode).toBe(200);
    const report = res.json() as {
      isElevatedAdmin: boolean;
      checks: Array<{ id: string; status: string; detail: string }>;
    };
    expect(report.isElevatedAdmin).toBe(true);
    const adminCheck = report.checks.find((c) => c.id === 'non_admin_process');
    expect(adminCheck?.status).toBe('warn');
    expect(adminCheck?.detail).toContain('Windows Administrator');
  });

  it('requires password confirmation for Host Lockdown switches and enforces both locks + audit filtering', async () => {
    const dir = makeTmpDir('sf-lockdown-data-');
    const outsideDir = makeTmpDir('sf-lockdown-outside-');

    const sf = await createServerForgeApp({
      dataDir: dir,
      runtimeMode: 'mock',
      publicHost: '127.0.0.1',
      elevatedAdminOverride: false,
    });
    apps.push(sf);

    const { token } = sf.auth.setupInitialAdmin('admin', 'admin-password-123');
    const headers = { authorization: `Bearer ${token}` };

    // Plain PUT /api/settings cannot toggle Host Lockdown switches
    const bypassPut = await sf.app.inject({
      method: 'PUT',
      url: '/api/settings',
      headers,
      payload: { lockHostFsBrowsing: true },
    });
    expect(bypassPut.statusCode).toBe(403);

    // Wrong password rejected by /api/security/lockdown
    const badPw = await sf.app.inject({
      method: 'POST',
      url: '/api/security/lockdown',
      headers,
      payload: { currentPassword: 'wrong', lockHostFsBrowsing: true, blockExecutableUploads: true },
    });
    expect(badPw.statusCode).toBe(401);

    // Valid password enables both lockdown switches
    const okLock = await sf.app.inject({
      method: 'POST',
      url: '/api/security/lockdown',
      headers,
      payload: {
        currentPassword: 'admin-password-123',
        lockHostFsBrowsing: true,
        blockExecutableUploads: true,
      },
    });
    expect(okLock.statusCode).toBe(200);
    expect(okLock.json().lockHostFsBrowsing).toBe(true);
    expect(okLock.json().blockExecutableUploads).toBe(true);

    // Host FS browsing & inspect blocked outside dataDir
    const blockedBrowse = await sf.app.inject({
      method: 'GET',
      url: `/api/import/browse?dir=${encodeURIComponent(outsideDir)}`,
      headers,
    });
    expect(blockedBrowse.statusCode).toBe(403);

    const blockedInspect = await sf.app.inject({
      method: 'POST',
      url: '/api/import/inspect',
      headers,
      payload: { folderPath: outsideDir },
    });
    expect(blockedInspect.statusCode).toBe(403);

    // Inside dataDir still permitted
    const insideBrowse = await sf.app.inject({
      method: 'GET',
      url: `/api/import/browse?dir=${encodeURIComponent(dir)}`,
      headers,
    });
    expect(insideBrowse.statusCode).toBe(200);

    // Create a server instance and test executable upload blocking
    const createRes = await sf.app.inject({
      method: 'POST',
      url: '/api/instances',
      headers,
      payload: {
        gameId: 'minecraft',
        name: 'Lockdown MC',
        runtime: 'native',
      },
    });
    expect(createRes.statusCode).toBe(201);
    const instId = (createRes.json() as { id: string }).id;

    // Executable/script uploads (.exe, .ps1, .bat, .sh) are rejected with 403
    for (const filename of ['malware.exe', 'payload.ps1', 'run.bat', 'exploit.sh']) {
      const res = await sf.app.inject({
        method: 'POST',
        url: `/api/instances/${instId}/files/upload?dir=&filename=${encodeURIComponent(filename)}`,
        headers: { ...headers, 'content-type': 'application/octet-stream' },
        payload: Buffer.from('test-bytes'),
      });
      expect(res.statusCode).toBe(403);
    }

    // Legitimate mod/config uploads (.jar, .txt) succeed
    const okUpload = await sf.app.inject({
      method: 'POST',
      url: `/api/instances/${instId}/files/upload?dir=mods&filename=my-mod.jar`,
      headers: { ...headers, 'content-type': 'application/octet-stream' },
      payload: Buffer.from('PK\x03\x04fakejar'),
    });
    expect(okUpload.statusCode).toBe(201);

    // Filterable paginated GET /api/audit-logs
    const filtered = await sf.app.inject({
      method: 'GET',
      url: '/api/audit-logs?source=web&q=lockdown&limit=10&offset=0',
      headers,
    });
    expect(filtered.statusCode).toBe(200);
    const auditResult = filtered.json() as {
      items: Array<{ action: string; source: string }>;
      total: number;
    };
    expect(auditResult.total).toBeGreaterThanOrEqual(3); // lockdown_updated + 2x lockdown_blocked
    expect(auditResult.items.every((i) => i.source === 'web')).toBe(true);
    expect(auditResult.items.some((i) => i.action === 'security:lockdown_updated')).toBe(true);
    expect(auditResult.items.some((i) => i.action === 'security:lockdown_blocked')).toBe(true);
  });
});
