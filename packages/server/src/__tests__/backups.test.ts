import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import archiver from 'archiver';
import { afterEach, describe, expect, it } from 'vitest';
import { createServerForgeApp, type ServerForgeApp } from '../api/server.js';
import { extractZipSafely, isScheduledBackupDue } from '../services/backup-scheduler.js';

describe('Full Backup Lifecycle: Download, Restore, Delete, Schedule & Retention (Issue #10)', () => {
  const cleanups: Array<() => Promise<void>> = [];

  async function makeApp(): Promise<ServerForgeApp> {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sf-backup-test-'));
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

  it('downloads, restores (with automatic stop + pre-restore safety snapshot), and deletes backups via API', async () => {
    const sf = await makeApp();
    const { token } = sf.auth.setupInitialAdmin('owner', 'password1234');
    const authHeaders = { authorization: `Bearer ${token}` };

    // Deploy & start mock server
    const deployRes = await sf.app.inject({
      method: 'POST',
      url: '/api/instances',
      headers: authHeaders,
      payload: {
        name: 'Survival World',
        gameId: 'minecraft',
        runtime: 'native',
        startImmediately: true,
      },
    });
    expect(deployRes.statusCode).toBe(201);
    const inst = deployRes.json() as { id: string };

    // Write known world marker v1
    const instDir = sf.orchestrator.getInstanceDir(inst.id);
    const markerFile = path.join(instDir, 'data', 'world-version.txt');
    fs.mkdirSync(path.dirname(markerFile), { recursive: true });
    fs.writeFileSync(markerFile, 'world-state-v1', 'utf8');

    // 1. Create backup v1
    const createRes = await sf.app.inject({
      method: 'POST',
      url: `/api/instances/${inst.id}/backups`,
      headers: authHeaders,
      payload: { note: 'Clean v1' },
    });
    expect(createRes.statusCode).toBe(201);
    const backupV1 = createRes.json() as { id: string; filename: string; sizeBytes: number };
    expect(backupV1.sizeBytes).toBeGreaterThan(0);

    // 2. Download backup ZIP
    const dlRes = await sf.app.inject({
      method: 'GET',
      url: `/api/instances/${inst.id}/backups/${backupV1.id}/download`,
      headers: authHeaders,
    });
    expect(dlRes.statusCode).toBe(200);
    expect(dlRes.headers['content-type']).toBe('application/zip');
    expect(String(dlRes.headers['content-disposition'])).toContain(backupV1.filename);
    // ZIP magic bytes: PK\x03\x04
    expect(dlRes.rawPayload.subarray(0, 2).toString('utf8')).toBe('PK');

    // Corrupt/modify world file to v2 while server is still running
    fs.writeFileSync(markerFile, 'corrupted-world-v2', 'utf8');
    fs.writeFileSync(path.join(instDir, 'data', 'extra-garbage.txt'), 'delete-me', 'utf8');

    // 3. Restore backup v1 (must gracefully stop running server, create safety snapshot, and restore v1)
    const restoreRes = await sf.app.inject({
      method: 'POST',
      url: `/api/instances/${inst.id}/backups/${backupV1.id}/restore`,
      headers: authHeaders,
    });
    expect(restoreRes.statusCode).toBe(200);
    const restoreBody = restoreRes.json() as {
      ok: boolean;
      restoredBackup: { id: string };
      safetyBackup: { id: string; note: string };
      extractedFiles: number;
    };
    expect(restoreBody.ok).toBe(true);
    expect(restoreBody.safetyBackup.note).toContain('Auto safety backup');
    expect(restoreBody.extractedFiles).toBeGreaterThanOrEqual(2);

    // Server should now be stopped and world files restored to v1 (and extra file gone)
    expect(sf.db.getInstanceById(inst.id)?.status).toBe('stopped');
    expect(fs.readFileSync(markerFile, 'utf8')).toBe('world-state-v1');
    expect(fs.existsSync(path.join(instDir, 'data', 'extra-garbage.txt'))).toBe(false);

    // Both v1 and the safety backup should be listed
    const listRes = await sf.app.inject({
      method: 'GET',
      url: `/api/instances/${inst.id}/backups`,
      headers: authHeaders,
    });
    expect(listRes.statusCode).toBe(200);
    expect(listRes.json().backups).toHaveLength(2);

    // 4. Delete the safety backup and verify removed from disk and DB
    const safetyPath = path.join(sf.config.backupsDir, inst.id, sf.db.getBackupById(restoreBody.safetyBackup.id)!.filename);
    expect(fs.existsSync(safetyPath)).toBe(true);

    const delRes = await sf.app.inject({
      method: 'DELETE',
      url: `/api/instances/${inst.id}/backups/${restoreBody.safetyBackup.id}`,
      headers: authHeaders,
    });
    expect(delRes.statusCode).toBe(200);
    expect(delRes.json().ok).toBe(true);
    expect(fs.existsSync(safetyPath)).toBe(false);
    expect(sf.db.listBackups(inst.id)).toHaveLength(1);
  });

  it('prunes old backups by maxCount and maxTotalBytes retention limits', async () => {
    const sf = await makeApp();
    const inst = sf.orchestrator.createInstance({
      name: 'Retention Test',
      gameId: 'minecraft',
      runtime: 'native',
      config: {},
    });
    const instDir = sf.orchestrator.getInstanceDir(inst.id);
    fs.writeFileSync(path.join(instDir, 'world.dat'), 'x'.repeat(4096), 'utf8');

    // Create 4 backups sequentially
    const b1 = await sf.orchestrator.createBackup(inst.id, 'b1');
    await new Promise((r) => setTimeout(r, 10));
    const b2 = await sf.orchestrator.createBackup(inst.id, 'b2');
    await new Promise((r) => setTimeout(r, 10));
    const b3 = await sf.orchestrator.createBackup(inst.id, 'b3');
    await new Promise((r) => setTimeout(r, 10));
    const b4 = await sf.orchestrator.createBackup(inst.id, 'b4');

    expect(sf.db.listBackups(inst.id)).toHaveLength(4);

    // Prune to maxCount = 2 -> keeps b4 and b3, deletes b2 and b1
    const prunedByCount = sf.orchestrator.pruneBackups(inst.id, 'Scheduler', 'system', { maxCount: 2 });
    expect(prunedByCount.map((b) => b.id).sort()).toEqual([b1.id, b2.id].sort());
    expect(sf.db.listBackups(inst.id).map((b) => b.id)).toEqual([b4.id, b3.id]);
    expect(fs.existsSync(path.join(sf.config.backupsDir, inst.id, b1.filename))).toBe(false);

    // Prune with tiny maxTotalBytes = 1 byte -> always keeps at least newest (b4), removes b3
    const prunedBySize = sf.orchestrator.pruneBackups(inst.id, 'Scheduler', 'system', {
      maxCount: 10,
      maxTotalBytes: 1,
    });
    expect(prunedBySize.map((b) => b.id)).toEqual([b3.id]);
    expect(sf.db.listBackups(inst.id).map((b) => b.id)).toEqual([b4.id]);
  });

  it('schedules automatic backups on interval & daily cadences and updates policy via API', async () => {
    const sf = await makeApp();
    const { token } = sf.auth.setupInitialAdmin('owner', 'password1234');
    const authHeaders = { authorization: `Bearer ${token}` };

    const inst = sf.orchestrator.createInstance({
      name: 'Scheduled World',
      gameId: 'minecraft',
      runtime: 'native',
      config: {},
    });

    // Save policy via PUT /api/instances/:id/backups/policy
    const policyRes = await sf.app.inject({
      method: 'PUT',
      url: `/api/instances/${inst.id}/backups/policy`,
      headers: authHeaders,
      payload: {
        enabled: true,
        scheduleMode: 'interval',
        intervalHours: 2,
        onlyWhenRunning: true,
        maxCount: 3,
        maxTotalGb: 5,
      },
    });
    expect(policyRes.statusCode).toBe(200);
    expect(policyRes.json().policy.enabled).toBe(true);
    expect(policyRes.json().policy.maxCount).toBe(3);

    // Server is stopped + onlyWhenRunning=true -> scheduler skips
    const skipped = await sf.backupScheduler.tick(new Date('2026-11-26T10:00:00Z'));
    expect(skipped).toEqual([]);

    // Start server -> scheduler triggers backup immediately
    await sf.orchestrator.startInstance(inst.id);
    const ran = await sf.backupScheduler.tick(new Date('2026-11-26T10:00:00Z'));
    expect(ran).toEqual([inst.id]);
    expect(sf.db.listBackups(inst.id)).toHaveLength(1);

    // 1 hour later (< 2h interval) -> does not run again yet
    const tooEarly = await sf.backupScheduler.tick(new Date('2026-11-26T11:00:00Z'));
    expect(tooEarly).toEqual([]);

    // 2.5 hours later -> runs again
    const dueAgain = await sf.backupScheduler.tick(new Date('2026-11-26T12:30:00Z'));
    expect(dueAgain).toEqual([inst.id]);
    expect(sf.db.listBackups(inst.id)).toHaveLength(2);

    // Daily policy helper checks
    const dailyPolicy = {
      enabled: true,
      scheduleMode: 'daily' as const,
      intervalHours: 6,
      dailyTime: '03:00',
      onlyWhenRunning: false,
      maxCount: 5,
      maxTotalGb: 0,
      lastAutoBackupAt: null as string | null,
    };
    const before = new Date(2026, 10, 26, 2, 30, 0);
    const after = new Date(2026, 10, 26, 3, 15, 0);
    expect(isScheduledBackupDue(dailyPolicy, before)).toBe(false);
    expect(isScheduledBackupDue(dailyPolicy, after)).toBe(true);
    expect(
      isScheduledBackupDue({ ...dailyPolicy, lastAutoBackupAt: new Date(2026, 10, 26, 3, 1, 0).toISOString() }, after)
    ).toBe(false);
  });

  it('rejects Zip-Slip path traversal entries in extractZipSafely', async () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sf-zipslip-'));
    cleanups.push(async () => {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    });

    const badZip = path.join(tmpDir, 'malicious.zip');
    await new Promise<void>((resolve, reject) => {
      const out = fs.createWriteStream(badZip);
      const archive = archiver('zip');
      out.on('close', () => resolve());
      archive.on('error', reject);
      archive.pipe(out);
      archive.append('evil', { name: 'xx/escaped.txt' });
      void archive.finalize();
    });
    // Patch entry filename bytes directly (archiver strips ../ when writing) to simulate a real malicious Zip-Slip archive
    const rawZip = fs.readFileSync(badZip);
    let idx = rawZip.indexOf(Buffer.from('xx/escaped.txt', 'utf8'));
    expect(idx).toBeGreaterThan(-1);
    while (idx !== -1) {
      rawZip.write('../escaped.txt', idx, 'utf8');
      idx = rawZip.indexOf(Buffer.from('xx/escaped.txt', 'utf8'), idx + 14);
    }
    fs.writeFileSync(badZip, rawZip);

    const dest = path.join(tmpDir, 'extract-here');
    expect(() => extractZipSafely(badZip, dest)).toThrow(/unsafe archive path/i);
    expect(fs.existsSync(path.join(tmpDir, 'escaped.txt'))).toBe(false);
  });
});
