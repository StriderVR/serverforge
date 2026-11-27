import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { createServerForgeApp, type ServerForgeApp } from '../api/server.js';
import { compareSemver } from '../services/updater-service.js';

const tmpDirs: string[] = [];
const apps: ServerForgeApp[] = [];

function makeTmpDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sf-v147-qa-'));
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

describe('Milestone #11 — EXE Asset Guard (#69), Version Selector & Rollback (#80), and Hybrid Bug Reporter (#81)', () => {
  it('orders prereleases below matching stable releases in compareSemver', () => {
    expect(compareSemver('1.4.6', '1.4.7-rc.1')).toBe(-1);
    expect(compareSemver('1.4.7-rc.1', '1.4.7-rc.2')).toBe(-1);
    expect(compareSemver('1.4.7-rc.2', '1.4.7')).toBe(-1);
    expect(compareSemver('1.4.7', '1.4.7-rc.1')).toBe(1);
  });

  it('does not advertise an update before ServerForge.exe is attached (#69), supports Experimental channel & Rollback (#80)', async () => {
    const dir = makeTmpDir();

    const fakeExeBuf = Buffer.from('MZfake-exe-binary');
    const mockReleases = [
      {
        tag_name: 'v1.4.9',
        name: 'ServerForge v1.4.9 (CI still building EXE)',
        body: 'Brand new release without exe yet',
        html_url: 'https://github.com/StriderVR/serverforge/releases/tag/v1.4.9',
        published_at: '2026-11-27T02:00:00Z',
        draft: false,
        prerelease: false,
        assets: [], // Missing ServerForge.exe! (#69)
      },
      {
        tag_name: 'v1.4.8-rc.1',
        name: 'ServerForge v1.4.8-rc.1 (Experimental)',
        body: 'Experimental pre-release',
        html_url: 'https://github.com/StriderVR/serverforge/releases/tag/v1.4.8-rc.1',
        published_at: '2026-11-27T01:00:00Z',
        draft: false,
        prerelease: true,
        assets: [
          {
            name: 'ServerForge.exe',
            browser_download_url: 'https://example.com/v1.4.8-rc.1/ServerForge.exe',
            size: fakeExeBuf.byteLength,
          },
        ],
      },
      {
        tag_name: 'v1.4.7',
        name: 'ServerForge v1.4.7',
        body: 'Current installed stable release',
        html_url: 'https://github.com/StriderVR/serverforge/releases/tag/v1.4.7',
        published_at: '2026-11-26T22:00:00Z',
        draft: false,
        prerelease: false,
        assets: [
          {
            name: 'ServerForge.exe',
            browser_download_url: 'https://example.com/v1.4.7/ServerForge.exe',
            size: fakeExeBuf.byteLength,
          },
        ],
      },
      {
        tag_name: 'v1.4.6',
        name: 'ServerForge v1.4.6',
        body: 'Previous stable release for rollback',
        html_url: 'https://github.com/StriderVR/serverforge/releases/tag/v1.4.6',
        published_at: '2026-11-26T20:00:00Z',
        draft: false,
        prerelease: false,
        assets: [
          {
            name: 'ServerForge.exe',
            browser_download_url: 'https://example.com/v1.4.6/ServerForge.exe',
            size: fakeExeBuf.byteLength,
          },
        ],
      },
    ];

    const mockFetch = (async (url: string | URL) => {
      const s = String(url);
      if (s.includes('/releases')) {
        return new Response(JSON.stringify(mockReleases), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        });
      }
      if (s.endsWith('ServerForge.exe')) {
        return new Response(fakeExeBuf, {
          status: 200,
          headers: { 'content-length': String(fakeExeBuf.byteLength) },
        });
      }
      return new Response('not found', { status: 404 });
    }) as unknown as typeof fetch;

    const sf = await createServerForgeApp({
      dataDir: dir,
      runtimeMode: 'mock',
      appVersion: '1.4.7',
      fetchImpl: mockFetch,
      updaterInstallModeOverride: 'exe',
    });
    apps.push(sf);

    const { token } = sf.auth.setupInitialAdmin('admin', 'strong-password-123');
    const headers = { authorization: `Bearer ${token}` };

    // 1. On Stable channel, v1.4.9 has NO ServerForge.exe yet -> updateAvailable MUST be false, pendingExeBuild=true (#69)
    const stableStatusRes = await sf.app.inject({
      method: 'GET',
      url: '/api/updater/status?refresh=1',
      headers,
    });
    expect(stableStatusRes.statusCode).toBe(200);
    const stableStatus = stableStatusRes.json();
    expect(stableStatus.updateAvailable).toBe(false);
    expect(stableStatus.pendingExeBuild).toBe(true);
    expect(stableStatus.pendingVersion).toBe('1.4.9');
    expect(stableStatus.latestVersion).toBe('1.4.7');

    // 2. Switching to Experimental channel advertises v1.4.8-rc.1 (which DOES have ServerForge.exe!)
    await sf.app.inject({
      method: 'PUT',
      url: '/api/settings',
      headers,
      payload: { updateChannel: 'experimental' },
    });
    const expStatusRes = await sf.app.inject({
      method: 'GET',
      url: '/api/updater/status?refresh=1',
      headers,
    });
    const expStatus = expStatusRes.json();
    expect(expStatus.channel).toBe('experimental');
    expect(expStatus.updateAvailable).toBe(true);
    expect(expStatus.latestVersion).toBe('1.4.8-rc.1');
    expect(expStatus.isPrerelease).toBe(true);

    // 3. GET /api/updater/releases returns all versions with hasExeAsset flags
    const relsRes = await sf.app.inject({ method: 'GET', url: '/api/updater/releases?refresh=1', headers });
    expect(relsRes.statusCode).toBe(200);
    const rels = relsRes.json() as Array<{ tag: string; hasExeAsset: boolean; isCurrent: boolean }>;
    expect(rels.find((r) => r.tag === 'v1.4.9')?.hasExeAsset).toBe(false);
    expect(rels.find((r) => r.tag === 'v1.4.7')?.isCurrent).toBe(true);
    expect(rels.find((r) => r.tag === 'v1.4.6')?.hasExeAsset).toBe(true);

    // 4. Rejects applying a release without ServerForge.exe attached
    const badApply = await sf.app.inject({
      method: 'POST',
      url: '/api/updater/apply',
      headers,
      payload: { targetTag: 'v1.4.9', dryRun: true },
    });
    expect(badApply.statusCode).toBe(400);
    expect(badApply.json().error).toContain('ServerForge.exe');

    // 5. Rollback to v1.4.6 succeeds cleanly in dryRun mode
    const rollbackApply = await sf.app.inject({
      method: 'POST',
      url: '/api/updater/apply',
      headers,
      payload: { targetTag: 'v1.4.6', dryRun: true },
    });
    expect(rollbackApply.statusCode).toBe(200);
    expect(rollbackApply.json().targetVersion).toBe('1.4.6');
  });

  it('builds secret-redacted bug reports with pre-filled GitHub URL and submits directly when encrypted PAT is configured (#81)', async () => {
    const dir = makeTmpDir();
    const captured: {
      auth: string;
      body: { title?: string; body?: string; labels?: string[] } | null;
    } = { auth: '', body: null };

    const mockFetch = (async (url: string | URL, init?: RequestInit) => {
      if (String(url).includes('/issues')) {
        const hdrs = init?.headers as Record<string, string> | undefined;
        captured.auth = hdrs?.Authorization || '';
        captured.body = JSON.parse(String(init?.body || '{}'));
        return new Response(
          JSON.stringify({
            number: 99,
            html_url: 'https://github.com/StriderVR/serverforge/issues/99',
            title: captured.body?.title,
          }),
          { status: 201, headers: { 'content-type': 'application/json' } }
        );
      }
      return new Response('{}', { status: 200 });
    }) as unknown as typeof fetch;

    const sf = await createServerForgeApp({
      dataDir: dir,
      runtimeMode: 'mock',
      appVersion: '1.4.7',
      fetchImpl: mockFetch,
    });
    apps.push(sf);

    const { token } = sf.auth.setupInitialAdmin('admin', 'strong-password-123');
    const headers = { authorization: `Bearer ${token}` };

    // Save secrets (including optional GitHub Issue PAT) via PUT /api/settings -> encrypted & masked
    const putSettings = await sf.app.inject({
      method: 'PUT',
      url: '/api/settings',
      headers,
      payload: {
        discordBotToken: 'secret-discord-token-xyz99',
        githubIssueToken: 'github_pat_supersecret_abc1234',
      },
    });
    expect(putSettings.statusCode).toBe(200);
    expect(putSettings.json().githubIssueToken).toBe('');
    expect(putSettings.json().hasGithubIssueToken).toBe(true);
    expect(putSettings.json().githubIssueTokenPreview).toBe('••••••••1234');

    // Create a server instance with a sensitive RCON_PASSWORD
    const createInst = await sf.app.inject({
      method: 'POST',
      url: '/api/instances',
      headers,
      payload: {
        gameId: 'minecraft',
        name: 'Buggy MC',
        runtime: 'native',
        config: { RCON_PASSWORD: 'ultra-secret-rcon-999' },
      },
    });
    const instId = (createInst.json() as { id: string }).id;

    // 1. Preview bug report -> redacts ALL secrets and produces pre-filled GitHub New Issue URL
    const previewRes = await sf.app.inject({
      method: 'POST',
      url: '/api/diagnostics/bug-report/preview',
      headers,
      payload: {
        title: 'Friend timed out connecting',
        category: 'networking',
        description: 'Happened with token secret-discord-token-xyz99 and github_pat_supersecret_abc1234',
        stepsToReproduce: '1. Start server\n2. Join over WAN',
        instanceId: instId,
        includeDiagnostics: true,
      },
    });
    expect(previewRes.statusCode).toBe(200);
    const preview = previewRes.json() as {
      title: string;
      labels: string[];
      markdown: string;
      githubNewIssueUrl: string;
      hasDirectToken: boolean;
    };
    expect(preview.title).toBe('[Bug]: Friend timed out connecting');
    expect(preview.labels).toEqual(['bug', 'area:networking']);
    expect(preview.hasDirectToken).toBe(true);
    expect(preview.githubNewIssueUrl).toContain('https://github.com/StriderVR/serverforge/issues/new?');
    expect(preview.markdown).not.toContain('secret-discord-token-xyz99');
    expect(preview.markdown).not.toContain('github_pat_supersecret_abc1234');
    expect(preview.markdown).not.toContain('ultra-secret-rcon-999');
    expect(preview.markdown).toContain('[REDACTED]');

    // 2. Direct in-app submission posts to GitHub Issues API with decrypted PAT
    const submitRes = await sf.app.inject({
      method: 'POST',
      url: '/api/diagnostics/bug-report/submit',
      headers,
      payload: {
        title: 'Friend timed out connecting',
        category: 'networking',
        description: 'Testing direct submission',
        instanceId: instId,
        includeDiagnostics: true,
      },
    });
    expect(submitRes.statusCode).toBe(200);
    expect(submitRes.json()).toMatchObject({
      ok: true,
      issueNumber: 99,
      issueUrl: 'https://github.com/StriderVR/serverforge/issues/99',
    });
    expect(captured.auth).toBe('Bearer github_pat_supersecret_abc1234');
    expect(captured.body?.labels).toEqual(['bug', 'area:networking']);
    expect(captured.body?.body).not.toContain('ultra-secret-rcon-999');
  });
});
