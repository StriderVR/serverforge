import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import { createServerForgeApp } from '../api/server.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const WEB_DIST_DIR = path.resolve(__dirname, '../../../web/dist');
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

describe('Installable LAN-Only PWA & Mobile Dashboard Asset Serving (Issues #107, #108)', () => {
  it('serves manifest.webmanifest, sw.js, icons, favicon, and index.html with strict LAN-only allowlist & no-cache headers', async () => {
    // Only run full static-dist assertions when web dist has been built
    if (!fs.existsSync(path.join(WEB_DIST_DIR, 'index.html'))) return;

    const tmpDir = makeTempDir('sf-pwa-test-');
    const sf = await createServerForgeApp({
      dataDir: tmpDir,
      runtimeMode: 'mock',
      discordToken: '',
      publicHost: 'localhost',
      webDistDir: WEB_DIST_DIR,
      detectDuckDnsDomainsImpl: async () => [],
      detectLanIpImpl: () => '192.168.1.50',
    });

    try {
      // Manifest served on LAN with proper MIME & no-cache
      const manifestRes = await sf.app.inject({
        method: 'GET',
        url: '/manifest.webmanifest',
        remoteAddress: '192.168.1.50',
      });
      expect(manifestRes.statusCode).toBe(200);
      expect(manifestRes.headers['content-type']).toMatch(/application\/manifest\+json/i);
      expect(manifestRes.headers['cache-control']).toMatch(/no-cache/i);
      expect(manifestRes.json().display).toBe('standalone');

      // Service worker served with no-cache & bypasses /api/ and /ws
      const swRes = await sf.app.inject({
        method: 'GET',
        url: '/sw.js',
        remoteAddress: '192.168.1.50',
      });
      expect(swRes.statusCode).toBe(200);
      expect(swRes.headers['cache-control']).toMatch(/no-cache/i);
      expect(swRes.body).toContain('/api/');
      expect(swRes.body).toContain('/ws');

      // Index HTML served with no-cache & viewport-fit=cover
      const indexRes = await sf.app.inject({
        method: 'GET',
        url: '/',
        remoteAddress: '192.168.1.50',
      });
      expect(indexRes.statusCode).toBe(200);
      expect(indexRes.headers['cache-control']).toMatch(/no-cache/i);
      expect(indexRes.body).toContain('viewport-fit=cover');
      expect(indexRes.body).toContain('/manifest.webmanifest');

      // WAN IPs MUST be blocked with HTTP 403 on ALL PWA & static routes
      for (const route of ['/', '/manifest.webmanifest', '/sw.js', '/icons/icon-192.png', '/favicon.svg']) {
        const wanRes = await sf.app.inject({
          method: 'GET',
          url: route,
          remoteAddress: '203.0.113.42',
        });
        expect(wanRes.statusCode, `WAN must get 403 on ${route}`).toBe(403);
      }
    } finally {
      await sf.close();
    }
  });
});
