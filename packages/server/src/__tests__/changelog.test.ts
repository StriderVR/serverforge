import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { getReleaseNotesForVersion, RELEASE_NOTES } from '@serverforge/shared';
import { createServerForgeApp, type ServerForgeApp } from '../api/server.js';
import { WORKSPACE_ROOT } from '../config.js';

describe("What's New Splash Changelog & Seen-Version Persistence (v1.3.3)", () => {
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

  it('includes a plain-English RELEASE_NOTES entry matching the current package.json version', () => {
    const rootPkg = JSON.parse(fs.readFileSync(path.join(WORKSPACE_ROOT, 'package.json'), 'utf8')) as {
      version: string;
    };
    const current = getReleaseNotesForVersion(rootPkg.version);
    expect(current).not.toBeNull();
    expect(current?.version).toBe(rootPkg.version);
    expect(getReleaseNotesForVersion(`v${rootPkg.version}`)).toEqual(current);
    expect(getReleaseNotesForVersion('99.99.99')).toBeNull();

    for (const entry of RELEASE_NOTES) {
      expect(entry.version).toMatch(/^\d+\.\d+\.\d+$/);
      expect(entry.title.trim().length).toBeGreaterThan(2);
      expect(entry.summary.trim().length).toBeGreaterThan(10);
      const totalBullets =
        (entry.added?.length ?? 0) + (entry.changed?.length ?? 0) + (entry.removed?.length ?? 0);
      expect(totalBullets).toBeGreaterThan(0);
    }
  });

  it('persists lastSeenReleaseVersion via PUT /api/settings so the splash popup only shows once per version', async () => {
    const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sf-whatsnew-'));
    tempDirs.push(dataDir);
    const sf = await createServerForgeApp({
      dataDir,
      runtimeMode: 'mock',
      publicHost: '127.0.0.1',
    });
    apps.push(sf);

    const setup = await sf.app.inject({
      method: 'POST',
      url: '/api/auth/setup',
      payload: { username: 'admin', password: 'super-secure-password' },
    });
    const cookie = setup.cookies.find((c) => c.name === 'sf_token');
    const authHeaders = { cookie: `sf_token=${cookie!.value}` };

    const beforeRes = await sf.app.inject({ method: 'GET', url: '/api/settings', headers: authHeaders });
    expect(beforeRes.statusCode).toBe(200);
    expect(beforeRes.json().lastSeenReleaseVersion).toBe('');

    const saveRes = await sf.app.inject({
      method: 'PUT',
      url: '/api/settings',
      headers: authHeaders,
      payload: { lastSeenReleaseVersion: '1.3.3' },
    });
    expect(saveRes.statusCode).toBe(200);
    expect(saveRes.json().lastSeenReleaseVersion).toBe('1.3.3');

    const afterRes = await sf.app.inject({ method: 'GET', url: '/api/settings', headers: authHeaders });
    expect(afterRes.json().lastSeenReleaseVersion).toBe('1.3.3');
  });
});
