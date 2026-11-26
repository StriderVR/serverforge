import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { createServerForgeApp, type ServerForgeApp } from '../api/server.js';
import { ConsoleLogBuffer } from '../runtimes/runtime-adapter.js';
import { redactConfigObject, redactSecrets } from '../services/diagnostics-service.js';

describe('Debugging & Diagnostics: Persistent Rotating Logs, Secret Redaction & Diagnostics API (Issue #24)', () => {
  const cleanups: Array<() => Promise<void>> = [];

  async function makeApp(): Promise<ServerForgeApp> {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sf-diag-'));
    const sf = await createServerForgeApp({
      dataDir: tmpDir,
      runtimeMode: 'mock',
      discordToken: '',
    });
    sf.telemetry.setMemoryOverrideForTesting({ totalGb: 64, usedGb: 8, freeGb: 56 });
    cleanups.push(async () => {
      await sf.close();
      fs.rmSync(tmpDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 150 });
    });
    return sf;
  }

  afterEach(async () => {
    while (cleanups.length) {
      await cleanups.pop()!();
    }
  });

  it('persists ConsoleLogBuffer to disk with rotation and hydrates across restarts', () => {
    const logDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sf-logbuf-'));
    cleanups.push(async () => {
      fs.rmSync(logDir, { recursive: true, force: true });
    });

    const buf1 = new ConsoleLogBuffer(100, { persistDir: logDir, maxFileBytes: 4096, maxRotations: 2 });
    for (let i = 1; i <= 80; i++) {
      buf1.append('inst-abc', `Boot log line #${i} — ${'A'.repeat(60)}`);
    }

    const activePath = buf1.getLogFilePath('inst-abc')!;
    expect(fs.existsSync(activePath)).toBe(true);
    expect(fs.existsSync(`${activePath}.1`)).toBe(true);

    // Simulate ServerForge restart with a brand-new ConsoleLogBuffer pointing at same persistDir
    const buf2 = new ConsoleLogBuffer(100, { persistDir: logDir, maxFileBytes: 4096, maxRotations: 2 });
    const hydrated = buf2.getLines('inst-abc');
    expect(hydrated.length).toBeGreaterThan(20);
    expect(hydrated[hydrated.length - 1].line).toContain('Boot log line #80');

    // Clear removes both in-memory entries and rotated files on disk
    buf2.clear('inst-abc');
    expect(buf2.getLines('inst-abc')).toEqual([]);
    expect(fs.existsSync(activePath)).toBe(false);
    expect(fs.existsSync(`${activePath}.1`)).toBe(false);
  });

  it('redacts sensitive secrets, API keys, tokens, and passwords in logs and config objects', () => {
    const cfKey = '$2a$10$' + 'x'.repeat(53);
    const raw = [
      'Authorization: Bearer eyJhbGciOiJIUzI1NiJ9.payload.sig',
      `CF_API_KEY=${cfKey}`,
      'https://www.duckdns.org/update?domains=myhome&token=secret-duck-token-999&ip=',
      'rcon.password=mySuperSecretRcon',
      'customSecretValue123',
    ].join('\n');

    const redacted = redactSecrets(raw, ['customSecretValue123']);
    expect(redacted).not.toContain('eyJhbGciOiJIUzI1NiJ9');
    expect(redacted).not.toContain(cfKey);
    expect(redacted).not.toContain('secret-duck-token-999');
    expect(redacted).not.toContain('mySuperSecretRcon');
    expect(redacted).not.toContain('customSecretValue123');
    expect(redacted).toContain('[REDACTED]');

    const sanitizedCfg = redactConfigObject({
      MOTD: 'Welcome Players',
      RCON_PASSWORD: 'do-not-leak-password',
      MAX_PLAYERS: 12,
    });
    expect(sanitizedCfg.MOTD).toBe('Welcome Players');
    expect(sanitizedCfg.RCON_PASSWORD).toBe('[REDACTED]');
    expect(sanitizedCfg.MAX_PLAYERS).toBe(12);
  });

  it('captures API errors, exposes all 4 diagnostics endpoints + .log download, and redacts secrets in reports', async () => {
    const sf = await makeApp();
    const { token } = sf.auth.setupInitialAdmin('owner', 'password1234');
    const authHeaders = { authorization: `Bearer ${token}` };

    const secretCfKey = '$2a$10$' + 'k'.repeat(53);
    const secretDuckToken = 'duck-secret-token-xyz-987';
    sf.db.saveSettings({ curseforgeApiKey: secretCfKey, duckdnsToken: secretDuckToken }, sf.config.publicHost);

    // Deploy an instance with an RCON password
    const deployRes = await sf.app.inject({
      method: 'POST',
      url: '/api/instances',
      headers: authHeaders,
      payload: {
        name: 'Diag Minecraft',
        gameId: 'minecraft',
        runtime: 'native',
        config: { RCON_PASSWORD: 'ultra-secret-rcon-pw' },
        startImmediately: true,
      },
    });
    expect(deployRes.statusCode).toBe(201);
    const inst = deployRes.json() as { id: string; slug: string };

    // Trigger a 400 validation error and verify richer Zod issue formatting + Diagnostics capture
    const badSettings = await sf.app.inject({
      method: 'PUT',
      url: '/api/settings',
      headers: authHeaders,
      payload: { dailyRebootTime: '99:99' },
    });
    expect(badSettings.statusCode).toBe(400);
    expect(badSettings.json().error).toContain('dailyRebootTime');

    // 1. GET /api/diagnostics/logs
    const diagLogsRes = await sf.app.inject({
      method: 'GET',
      url: '/api/diagnostics/logs?level=warn',
      headers: authHeaders,
    });
    expect(diagLogsRes.statusCode).toBe(200);
    const diagLogs = diagLogsRes.json() as Array<{ path: string; statusCode: number; message: string }>;
    expect(diagLogs.some((e) => e.path === '/api/settings' && e.statusCode === 400)).toBe(true);

    // 2. GET /api/diagnostics/report (sanitized system Markdown bundle)
    const sysReportRes = await sf.app.inject({
      method: 'GET',
      url: '/api/diagnostics/report',
      headers: authHeaders,
    });
    expect(sysReportRes.statusCode).toBe(200);
    const sysReport = sysReportRes.json() as { markdown: string; warnCount: number };
    expect(sysReport.markdown).toContain('# ServerForge System Diagnostics Report');
    expect(sysReport.markdown).toContain('Diag Minecraft');
    expect(sysReport.markdown).not.toContain(secretCfKey);
    expect(sysReport.markdown).not.toContain(secretDuckToken);
    expect(sysReport.warnCount).toBeGreaterThanOrEqual(1);

    // 3. GET /api/instances/:id/debug-report (sanitized per-instance Markdown bundle)
    const instReportRes = await sf.app.inject({
      method: 'GET',
      url: `/api/instances/${inst.id}/debug-report`,
      headers: authHeaders,
    });
    expect(instReportRes.statusCode).toBe(200);
    const instReport = instReportRes.json() as { filename: string; markdown: string };
    expect(instReport.filename).toContain(inst.slug);
    expect(instReport.markdown).toContain('# ServerForge Debug Report — Diag Minecraft');
    expect(instReport.markdown).toContain('[REDACTED]');
    expect(instReport.markdown).not.toContain('ultra-secret-rcon-pw');
    expect(instReport.markdown).toContain('World loaded successfully');

    // 4. GET /api/instances/:id/logs/download
    const logDlRes = await sf.app.inject({
      method: 'GET',
      url: `/api/instances/${inst.id}/logs/download`,
      headers: authHeaders,
    });
    expect(logDlRes.statusCode).toBe(200);
    expect(logDlRes.headers['content-type']).toContain('text/plain');
    expect(logDlRes.body).toContain('World loaded successfully');

    // 5. DELETE /api/diagnostics/logs
    const clearRes = await sf.app.inject({
      method: 'DELETE',
      url: '/api/diagnostics/logs',
      headers: authHeaders,
    });
    expect(clearRes.statusCode).toBe(200);
    const afterClear = await sf.app.inject({
      method: 'GET',
      url: '/api/diagnostics/logs',
      headers: authHeaders,
    });
    expect(afterClear.json()).toEqual([]);
  });
});
