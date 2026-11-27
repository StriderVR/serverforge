import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { createServerForgeApp, type ServerForgeApp } from '../api/server.js';
import {
  ipMatchesCidr,
  isCsrfOriginValid,
  isIpAllowedByPolicy,
  isLanOrTailscaleIp,
  isOriginAllowedForHost,
  normalizeRemoteIp,
} from '../security/http-security.js';

function makeTempDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'sf-sec61-'));
}

describe('Issue #61 — Strict Same-Origin CORS, CSRF Guard, Security Headers & IP Allowlist', () => {
  const apps: ServerForgeApp[] = [];
  const tempDirs: string[] = [];

  afterEach(async () => {
    while (apps.length) {
      await apps.pop()!.close();
    }
    while (tempDirs.length) {
      fs.rmSync(tempDirs.pop()!, { recursive: true, force: true });
    }
  });

  it('evaluates IP/CIDR allowlist policies, LAN/Tailscale ranges, and same-origin/CSRF checks accurately', () => {
    expect(normalizeRemoteIp('::ffff:192.168.1.96')).toBe('192.168.1.96');
    expect(isLanOrTailscaleIp('127.0.0.1')).toBe(true);
    expect(isLanOrTailscaleIp('::1')).toBe(true);
    expect(isLanOrTailscaleIp('192.168.1.96')).toBe(true);
    expect(isLanOrTailscaleIp('10.0.0.5')).toBe(true);
    expect(isLanOrTailscaleIp('172.16.10.2')).toBe(true);
    expect(isLanOrTailscaleIp('100.88.14.22')).toBe(true); // Tailscale CGNAT
    expect(isLanOrTailscaleIp('86.169.37.0')).toBe(false);
    expect(isLanOrTailscaleIp('8.8.8.8')).toBe(false);

    expect(ipMatchesCidr('203.0.113.42', '203.0.113.0/24')).toBe(true);
    expect(ipMatchesCidr('203.0.114.42', '203.0.113.0/24')).toBe(false);

    // Policy modes
    expect(isIpAllowedByPolicy('8.8.8.8', 'lan_and_tailscale', [])).toBe(false);
    expect(isIpAllowedByPolicy('192.168.1.50', 'lan_and_tailscale', [])).toBe(true);
    expect(isIpAllowedByPolicy('100.88.1.2', 'lan_and_tailscale', [])).toBe(true);
    expect(isIpAllowedByPolicy('192.168.1.50', 'localhost_only', [])).toBe(false);
    expect(isIpAllowedByPolicy('127.0.0.1', 'localhost_only', [])).toBe(true);
    expect(isIpAllowedByPolicy('203.0.113.42', 'custom', ['203.0.113.0/24'])).toBe(true);
    expect(isIpAllowedByPolicy('192.168.1.50', 'custom', ['203.0.113.0/24'])).toBe(false);

    // Same-origin & CSRF checks
    expect(isOriginAllowedForHost('http://localhost:3000', 'localhost:3000', false)).toBe(true);
    expect(isOriginAllowedForHost('http://192.168.1.96:3000', '192.168.1.96:3000', false)).toBe(true);
    expect(isOriginAllowedForHost('https://evil.example', 'localhost:3000', false)).toBe(false);
    expect(isOriginAllowedForHost('null', 'localhost:3000', false)).toBe(false);
    expect(isOriginAllowedForHost('http://localhost:5173', 'localhost:3000', false)).toBe(false);
    expect(isOriginAllowedForHost('http://localhost:5173', 'localhost:3000', true)).toBe(true);

    expect(isCsrfOriginValid('POST', 'https://evil.example', undefined, 'localhost:3000', false)).toBe(false);
    expect(isCsrfOriginValid('DELETE', undefined, 'https://evil.example/page', 'localhost:3000', false)).toBe(false);
    expect(isCsrfOriginValid('POST', 'http://localhost:3000', undefined, 'localhost:3000', false)).toBe(true);
    expect(isCsrfOriginValid('GET', 'https://evil.example', undefined, 'localhost:3000', false)).toBe(true);
  });

  it('enforces security headers, blocks cross-origin CSRF/CORS requests, and enforces IP allowlist on Fastify routes', async () => {
    const dataDir = makeTempDir();
    tempDirs.push(dataDir);

    const sf = await createServerForgeApp({
      dataDir,
      runtimeMode: 'mock',
      detectDuckDnsDomainsImpl: async () => [],
      detectLanIpImpl: () => '192.168.1.96',
    });
    apps.push(sf);

    // 1. Setup auth (same-origin) + verify security response headers
    const setupRes = await sf.app.inject({
      method: 'POST',
      url: '/api/auth/setup',
      headers: {
        host: 'localhost:3000',
        origin: 'http://localhost:3000',
      },
      payload: { username: 'admin', password: 'password1234' },
    });
    expect(setupRes.statusCode).toBe(200);
    expect(setupRes.headers['x-frame-options']).toBe('DENY');
    expect(setupRes.headers['x-content-type-options']).toBe('nosniff');
    expect(setupRes.headers['referrer-policy']).toBe('no-referrer');
    expect(setupRes.headers['permissions-policy']).toContain('camera=()');
    expect(setupRes.headers['content-security-policy']).toContain("default-src 'self'");
    expect(setupRes.headers['access-control-allow-origin']).toBe('http://localhost:3000');

    const cookie = setupRes.headers['set-cookie'] as string;

    // 2. Cross-origin POST with cookie -> 403 CSRF rejected & no ACAO reflection!
    const evilPost = await sf.app.inject({
      method: 'POST',
      url: '/api/instances',
      headers: {
        host: 'localhost:3000',
        origin: 'https://evil-site.example',
        cookie,
      },
      payload: { name: 'Hacked', gameId: 'minecraft' },
    });
    expect(evilPost.statusCode).toBe(403);
    expect(evilPost.headers['access-control-allow-origin']).toBeUndefined();

    // 3. Cross-origin GET does NOT reflect Access-Control-Allow-Origin
    const evilGet = await sf.app.inject({
      method: 'GET',
      url: '/api/settings',
      headers: {
        host: 'localhost:3000',
        origin: 'https://evil-site.example',
        cookie,
      },
    });
    expect(evilGet.statusCode).toBe(200);
    expect(evilGet.headers['access-control-allow-origin']).toBeUndefined();

    // 4. Cross-origin Referer on state-changing request -> 403
    const evilReferer = await sf.app.inject({
      method: 'PUT',
      url: '/api/settings',
      headers: {
        host: 'localhost:3000',
        referer: 'https://phishing.example/click',
        cookie,
      },
      payload: { maxConcurrentServers: 8 },
    });
    expect(evilReferer.statusCode).toBe(403);

    // 5. Public WAN remoteAddress -> 403 blocked by default LAN + Tailscale allowlist
    const wanReq = await sf.app.inject({
      method: 'GET',
      url: '/api/health',
      remoteAddress: '86.169.37.99',
    });
    expect(wanReq.statusCode).toBe(403);

    // 6. Private LAN & Tailscale remoteAddress -> 200 allowed by default
    const lanReq = await sf.app.inject({
      method: 'GET',
      url: '/api/health',
      remoteAddress: '192.168.1.42',
    });
    expect(lanReq.statusCode).toBe(200);

    const tsReq = await sf.app.inject({
      method: 'GET',
      url: '/api/health',
      remoteAddress: '100.88.12.34',
    });
    expect(tsReq.statusCode).toBe(200);

    // 7. Switch to localhost_only mode -> LAN IP now blocked (403), loopback still allowed (200)
    sf.db.saveSettings({ dashboardAccessMode: 'localhost_only' }, '127.0.0.1');
    const blockedLan = await sf.app.inject({
      method: 'GET',
      url: '/api/health',
      remoteAddress: '192.168.1.42',
    });
    expect(blockedLan.statusCode).toBe(403);

    const allowedLocal = await sf.app.inject({
      method: 'GET',
      url: '/api/health',
      remoteAddress: '127.0.0.1',
    });
    expect(allowedLocal.statusCode).toBe(200);

    // 8. Custom CIDR allows matching IP
    sf.db.saveSettings({ dashboardAccessMode: 'custom', trustedCidrs: ['203.0.113.0/24'] }, '127.0.0.1');
    const customAllowed = await sf.app.inject({
      method: 'GET',
      url: '/api/health',
      remoteAddress: '203.0.113.77',
    });
    expect(customAllowed.statusCode).toBe(200);
  });
});
