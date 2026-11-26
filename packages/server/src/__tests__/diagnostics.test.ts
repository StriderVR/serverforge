import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type {
  AppDiagnosticLogEntry,
  InstanceDiagnosticsReport,
  SystemDiagnosticsReport,
} from '@serverforge/shared';
import { createServerForgeApp, type ServerForgeApp } from '../api/server.js';
import { ConsoleLogBuffer } from '../runtimes/runtime-adapter.js';
import { redactSensitiveConfig, redactSensitiveText } from '../services/diagnostics-service.js';

describe('Debugging & Diagnostics', () => {
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
      fs.rmSync(tmpDir, { recursive: true, force: true });
    });
    return sf;
  }

  afterEach(async () => {
    while (cleanups.length) {
      await cleanups.pop()!();
    }
  });

  it('redacts sensitive config keys and embedded tokens/keys in text', () => {
    const redactedCfg = redactSensitiveConfig({
      VERSION: '1.21.1',
      RCON_PASSWORD: 'super-secret-rcon-pass',
      ADMIN_PASSWORD: 'admin-password-123',
      CF_API_KEY: '$2a$10$abcdefghijklmnopqrstuv1234567890',
      MOTD: 'Welcome to ServerForge',
      MAX_PLAYERS: 20,
    });

    expect(redactedCfg.VERSION).toBe('1.21.1');
    expect(redactedCfg.MOTD).toBe('Welcome to ServerForge');
    expect(redactedCfg.MAX_PLAYERS).toBe(20);
    expect(redactedCfg.RCON_PASSWORD).toBe('[REDACTED]');
    expect(redactedCfg.ADMIN_PASSWORD).toBe('[REDACTED]');
    expect(redactedCfg.CF_API_KEY).toBe('[REDACTED]');

    const cleanedText = redactSensitiveText(
      'Authorization: Bearer myVerySecretJwtToken12345 url=https://duckdns.org/update?domains=foo&token=abc-123-secret key=$2a$10$abcdefghijklmnopqrstuv1234567890'
    );
    expect(cleanedText).not.toContain('myVerySecretJwtToken12345');
    expect(cleanedText).not.toContain('abc-123-secret');
    expect(cleanedText).not.toContain('abcdefghijklmnopqrstuv1234567890');
    expect(cleanedText).toContain('[REDACTED]');
  });

  it('persists ConsoleLogBuffer lines to disk, hydrates after restart, and cleans up on delete', () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sf-logbuf-'));
    cleanups.push(async () => {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    });

    const buf1 = new ConsoleLogBuffer(100, tmpDir);
    buf1.append('inst-1', '[INFO] Booting modded server');
    buf1.append('inst-1', '[ERROR] Unrecognized VM option UseCompactObjectHeaders');

    const logFile = buf1.getLogFilePath('inst-1');
    expect(logFile).toBeTruthy();
    expect(fs.existsSync(logFile!)).toBe(true);

    // Simulate a fresh process restart with a new ConsoleLogBuffer pointing at the same directory
    const buf2 = new ConsoleLogBuffer(100, tmpDir);
    const hydrated = buf2.getLines('inst-1');
    expect(hydrated).toHaveLength(2);
    expect(hydrated[0].line).toBe('[INFO] Booting modded server');
    expect(hydrated[1].line).toContain('UseCompactObjectHeaders');
    expect(buf2.readFullLogText('inst-1')).toContain('UseCompactObjectHeaders');

    // Removing persisted file deletes the log file cleanly
    buf2.clear('inst-1', true);
    expect(fs.existsSync(logFile!)).toBe(false);
    expect(buf2.getLines('inst-1')).toHaveLength(0);
  });

  it('exposes sanitized instance debug reports, console log downloads, and backend API error logs', async () => {
    const sf = await makeApp();

    const setupRes = await sf.app.inject({
      method: 'POST',
      url: '/api/auth/setup',
      payload: { username: 'owner', password: 'super-secret-password' },
    });
    const { token } = setupRes.json() as { token: string };
    const authHeaders = { authorization: `Bearer ${token}` };

    // Deploy and start a mock Minecraft server with a secret RCON password
    const deployRes = await sf.app.inject({
      method: 'POST',
      url: '/api/instances',
      headers: authHeaders,
      payload: {
        name: 'Debug Craft',
        gameId: 'minecraft',
        config: {
          RCON_PASSWORD: 'TopSecretRconPassword999',
        },
        startImmediately: true,
      },
    });
    expect(deployRes.statusCode).toBe(201);
    const instance = deployRes.json() as { id: string; slug: string };

    // Inject an error line into the instance console log
    sf.orchestrator.logs.append(instance.id, '[ERROR] Sample crash line for testing');

    // 1. Instance diagnostic report redacts secrets and includes console tail + markdown
    const diagRes = await sf.app.inject({
      method: 'GET',
      url: `/api/instances/${instance.id}/diagnostics`,
      headers: authHeaders,
    });
    expect(diagRes.statusCode).toBe(200);
    const report = diagRes.json() as InstanceDiagnosticsReport;
    expect(report.instance.name).toBe('Debug Craft');
    expect(report.instance.config.RCON_PASSWORD).toBe('[REDACTED]');
    expect(report.markdown).toContain('## ServerForge Instance Debug Report');
    expect(report.markdown).toContain('Sample crash line for testing');
    expect(report.markdown).not.toContain('TopSecretRconPassword999');

    // 2. Download console log returns attachment with persisted lines
    const dlRes = await sf.app.inject({
      method: 'GET',
      url: `/api/instances/${instance.id}/logs/download`,
      headers: authHeaders,
    });
    expect(dlRes.statusCode).toBe(200);
    expect(dlRes.headers['content-disposition']).toContain(`${instance.slug}-console.log`);
    expect(dlRes.body).toContain('Sample crash line for testing');

    // 3. Trigger a 400 validation error and verify it is captured in /api/diagnostics/logs
    const badRes = await sf.app.inject({
      method: 'POST',
      url: '/api/instances',
      headers: authHeaders,
      payload: {
        name: 'x', // too short (<2 chars) -> triggers Zod 400
        gameId: 'minecraft',
      },
    });
    expect(badRes.statusCode).toBe(400);

    const logsRes = await sf.app.inject({
      method: 'GET',
      url: '/api/diagnostics/logs?level=error',
      headers: authHeaders,
    });
    expect(logsRes.statusCode).toBe(200);
    const errorEntries = logsRes.json() as AppDiagnosticLogEntry[];
    expect(errorEntries.some((e) => e.source === 'api' && e.message.includes('POST /api/instances'))).toBe(true);

    // 4. System diagnostics report includes fleet summary & recent errors
    const sysRes = await sf.app.inject({
      method: 'GET',
      url: '/api/diagnostics/report',
      headers: authHeaders,
    });
    expect(sysRes.statusCode).toBe(200);
    const sysReport = sysRes.json() as SystemDiagnosticsReport;
    expect(sysReport.instancesSummary.some((i) => i.name === 'Debug Craft')).toBe(true);
    expect(sysReport.recentErrors.length).toBeGreaterThan(0);
    expect(sysReport.markdown).toContain('## ServerForge System Diagnostics Report');
  });
});
