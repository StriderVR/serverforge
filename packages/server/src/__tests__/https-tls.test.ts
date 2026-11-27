import crypto from 'node:crypto';
import fs from 'node:fs';
import https from 'node:https';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { createServerForgeApp, type ServerForgeApp } from '../api/server.js';
import { AppDatabase } from '../db/database.js';
import { generateSelfSignedCertificate } from '../security/tls-service.js';

const tmpDirs: string[] = [];
const apps: ServerForgeApp[] = [];

function makeTmpDir(prefix = 'sf-https-tls-'): string {
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

describe('Opt-In Built-In HTTPS / TLS (#65)', () => {
  it('generates valid pure-Node X.509 v3 self-signed certificates with LAN IP & hostname SANs', () => {
    const gen = generateSelfSignedCertificate({
      dnsNames: ['localhost', 'smol.local'],
      ipAddresses: ['127.0.0.1', '192.168.1.96'],
    });

    const x509 = new crypto.X509Certificate(gen.certPem);
    const priv = crypto.createPrivateKey(gen.keyPem);
    expect(x509.checkPrivateKey(priv)).toBe(true);
    expect(x509.ca).toBe(true);
    expect(x509.subjectAltName).toContain('DNS:localhost');
    expect(x509.subjectAltName).toContain('DNS:smol.local');
    expect(x509.subjectAltName).toContain('IP Address:127.0.0.1');
    expect(x509.subjectAltName).toContain('IP Address:192.168.1.96');
  });

  it('starts Fastify over HTTPS, serves TLS requests, sets Secure auth cookies, and exposes cert download', async () => {
    const dir = makeTmpDir();
    const dbPath = path.join(dir, 'serverforge.sqlite');

    // Pre-enable opt-in HTTPS in SQLite before startup
    const seedDb = new AppDatabase(dbPath);
    seedDb.saveSettings({ httpsEnabled: true, httpsCertMode: 'self_signed' });
    seedDb.close();

    const sf = await createServerForgeApp({
      dataDir: dir,
      dbPath,
      runtimeMode: 'mock',
      publicHost: '127.0.0.1',
      detectLanIpImpl: () => '192.168.1.96',
    });
    apps.push(sf);

    expect(sf.httpsActive).toBe(true);
    expect(fs.existsSync(sf.tls.localCertPath)).toBe(true);
    expect(fs.existsSync(sf.tls.localKeyPath)).toBe(true);

    // Setup admin -> sf_token Set-Cookie header must include Secure when HTTPS is active
    const setupRes = await sf.app.inject({
      method: 'POST',
      url: '/api/auth/setup',
      payload: { username: 'admin', password: 'https-password-123' },
    });
    expect(setupRes.statusCode).toBe(200);
    const setCookieHeader = String(setupRes.headers['set-cookie'] ?? '');
    expect(setCookieHeader).toContain('sf_token=');
    expect(setCookieHeader).toContain('HttpOnly');
    expect(setCookieHeader).toContain('Secure');

    const { token } = setupRes.json() as { token: string };
    const headers = { authorization: `Bearer ${token}` };

    // TLS status reports active + SANs including LAN IP
    const tlsRes = await sf.app.inject({ method: 'GET', url: '/api/security/tls/status', headers });
    expect(tlsRes.statusCode).toBe(200);
    const tlsStatus = tlsRes.json() as { active: boolean; sans: string[]; fallbackReason: string | null };
    expect(tlsStatus.active).toBe(true);
    expect(tlsStatus.fallbackReason).toBeNull();
    expect(tlsStatus.sans.some((s) => s.includes('192.168.1.96'))).toBe(true);

    // Security health checklist reports HTTPS passing
    const healthRes = await sf.app.inject({ method: 'GET', url: '/api/security/health', headers });
    const httpsCheck = (healthRes.json() as { checks: Array<{ id: string; status: string }> }).checks.find(
      (c) => c.id === 'https_tls'
    );
    expect(httpsCheck?.status).toBe('pass');

    // Download local cert endpoint returns PEM
    const certRes = await sf.app.inject({ method: 'GET', url: '/api/security/tls/cert', headers });
    expect(certRes.statusCode).toBe(200);
    expect(certRes.body).toContain('-----BEGIN CERTIFICATE-----');

    // Listen on an ephemeral HTTPS port and verify a real TLS handshake succeeds trusting the generated cert
    const address = await sf.app.listen({ host: '127.0.0.1', port: 0 });
    expect(address.startsWith('https://')).toBe(true);

    const httpsBody = await new Promise<string>((resolve, reject) => {
      const req = https.get(
        `${address}/api/health`,
        { ca: certRes.body, rejectUnauthorized: true },
        (res) => {
          let data = '';
          res.on('data', (chunk) => {
            data += chunk.toString();
          });
          res.on('end', () => resolve(data));
        }
      );
      req.on('error', reject);
    });
    expect(JSON.parse(httpsBody)).toMatchObject({ status: 'ok' });
  });

  it('safely falls back to HTTP with diagnostic warning when custom cert files are unreadable', async () => {
    const dir = makeTmpDir();
    const dbPath = path.join(dir, 'serverforge.sqlite');

    const seedDb = new AppDatabase(dbPath);
    seedDb.saveSettings({
      httpsEnabled: true,
      httpsCertMode: 'custom',
      httpsCertPath: path.join(dir, 'missing.crt'),
      httpsKeyPath: path.join(dir, 'missing.key'),
    });
    seedDb.close();

    const sf = await createServerForgeApp({
      dataDir: dir,
      dbPath,
      runtimeMode: 'mock',
      publicHost: '127.0.0.1',
    });
    apps.push(sf);

    expect(sf.httpsActive).toBe(false);
    const { token } = sf.auth.setupInitialAdmin('admin', 'fallback-password-123');
    const headers = { authorization: `Bearer ${token}` };

    const tlsRes = await sf.app.inject({ method: 'GET', url: '/api/security/tls/status', headers });
    expect(tlsRes.statusCode).toBe(200);
    const tlsStatus = tlsRes.json() as { active: boolean; fallbackReason: string | null };
    expect(tlsStatus.active).toBe(false);
    expect(tlsStatus.fallbackReason).toContain('Safely fell back to HTTP');

    const diagEvents = sf.diagnostics.listLogs({ level: 'warn', limit: 20 });
    expect(diagEvents.some((ev) => ev.message.includes('Safely fell back to HTTP'))).toBe(true);
  });
});
