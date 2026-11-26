import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import type { BackupPolicy } from '@serverforge/shared';
import { BackupPolicySchema } from '@serverforge/shared';
import type { AppDatabase } from '../db/database.js';
import type { ServerOrchestrator } from './orchestrator.js';

/**
 * Pure-Node ZIP archive extractor with strict Zip-Slip path traversal protection.
 * Supports STORE (0) and DEFLATE (8) entries produced by archiver / standard zip tools
 * identically across Windows, Linux, and macOS without spawning external shells.
 */
export function extractZipSafely(zipPath: string, destDir: string): number {
  const buf = fs.readFileSync(zipPath);
  const resolvedDest = path.resolve(destDir);
  fs.mkdirSync(resolvedDest, { recursive: true });

  // Locate End of Central Directory (EOCD) signature 0x06054b50 from end of file
  const minEocdOffset = Math.max(0, buf.length - 65557);
  let eocdOffset = -1;
  for (let i = buf.length - 22; i >= minEocdOffset; i--) {
    if (buf.readUInt32LE(i) === 0x06054b50) {
      eocdOffset = i;
      break;
    }
  }
  if (eocdOffset === -1) {
    throw new Error('Invalid or corrupted backup ZIP archive (missing EOCD record).');
  }

  const totalEntries = buf.readUInt16LE(eocdOffset + 10);
  const cdOffset = buf.readUInt32LE(eocdOffset + 16);

  let offset = cdOffset;
  let extractedFiles = 0;

  for (let idx = 0; idx < totalEntries; idx++) {
    if (offset + 46 > buf.length || buf.readUInt32LE(offset) !== 0x02014b50) {
      throw new Error('Invalid or corrupted backup ZIP central directory.');
    }

    const compressionMethod = buf.readUInt16LE(offset + 10);
    const compressedSize = buf.readUInt32LE(offset + 20);
    const nameLen = buf.readUInt16LE(offset + 28);
    const extraLen = buf.readUInt16LE(offset + 30);
    const commentLen = buf.readUInt16LE(offset + 32);
    const localHeaderOffset = buf.readUInt32LE(offset + 42);

    const rawName = buf.subarray(offset + 46, offset + 46 + nameLen).toString('utf8');
    offset += 46 + nameLen + extraLen + commentLen;

    // Normalize separators and enforce strict Zip-Slip boundary check
    const normalized = rawName.replace(/\\/g, '/').replace(/^\/+/, '');
    if (!normalized) continue;

    const targetPath = path.resolve(resolvedDest, normalized);
    if (targetPath !== resolvedDest && !targetPath.startsWith(resolvedDest + path.sep)) {
      throw new Error(`Refused to extract unsafe archive path: "${rawName}"`);
    }

    if (normalized.endsWith('/')) {
      fs.mkdirSync(targetPath, { recursive: true });
      continue;
    }

    if (localHeaderOffset + 30 > buf.length || buf.readUInt32LE(localHeaderOffset) !== 0x04034b50) {
      throw new Error(`Corrupted local header for ZIP entry "${rawName}".`);
    }

    const localNameLen = buf.readUInt16LE(localHeaderOffset + 26);
    const localExtraLen = buf.readUInt16LE(localHeaderOffset + 28);
    const dataStart = localHeaderOffset + 30 + localNameLen + localExtraLen;
    const dataEnd = dataStart + compressedSize;
    if (dataEnd > buf.length) {
      throw new Error(`Truncated data for ZIP entry "${rawName}".`);
    }

    const compressedData = buf.subarray(dataStart, dataEnd);
    let fileContent: Buffer;
    if (compressionMethod === 0) {
      fileContent = compressedData;
    } else if (compressionMethod === 8) {
      fileContent = zlib.inflateRawSync(compressedData);
    } else {
      throw new Error(`Unsupported ZIP compression method (${compressionMethod}) for "${rawName}".`);
    }

    fs.mkdirSync(path.dirname(targetPath), { recursive: true });
    fs.writeFileSync(targetPath, fileContent);
    extractedFiles += 1;
  }

  return extractedFiles;
}

/**
 * Evaluates whether a scheduled backup should run at `now` for the given policy.
 */
export function isScheduledBackupDue(policy: BackupPolicy, now: Date): boolean {
  if (!policy.enabled) return false;

  const lastMs = policy.lastAutoBackupAt ? new Date(policy.lastAutoBackupAt).getTime() : 0;
  const nowMs = now.getTime();

  if (policy.scheduleMode === 'interval') {
    const intervalMs = Math.max(1, policy.intervalHours) * 60 * 60 * 1000;
    return !lastMs || nowMs - lastMs >= intervalMs;
  }

  // Daily mode: run once per calendar day once local clock passes HH:MM
  const [hh, mm] = policy.dailyTime.split(':').map(Number);
  const scheduledToday = new Date(now);
  scheduledToday.setHours(hh, mm, 0, 0);

  if (nowMs < scheduledToday.getTime()) {
    return false;
  }

  if (lastMs) {
    const lastDate = new Date(lastMs);
    const sameDay =
      lastDate.getFullYear() === now.getFullYear() &&
      lastDate.getMonth() === now.getMonth() &&
      lastDate.getDate() === now.getDate();
    if (sameDay) return false;
  }

  return true;
}

export class BackupSchedulerService {
  private timer: NodeJS.Timeout | null = null;
  private running = false;

  constructor(
    private readonly db: AppDatabase,
    private readonly orchestrator: ServerOrchestrator
  ) {}

  start(intervalMs = 60_000): void {
    this.stop();
    this.timer = setInterval(() => {
      void this.tick();
    }, intervalMs);
    this.timer.unref?.();
  }

  stop(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  async tick(now = new Date()): Promise<string[]> {
    if (this.running) return [];
    this.running = true;
    const backedUpIds: string[] = [];
    try {
      const instances = this.db.listInstances();
      for (const inst of instances) {
        const policy = BackupPolicySchema.parse(inst.backupPolicy ?? {});
        if (!policy.enabled) continue;
        if (policy.onlyWhenRunning && inst.status !== 'running') continue;
        if (!isScheduledBackupDue(policy, now)) continue;

        try {
          await this.orchestrator.createBackup(inst.id, 'Scheduled auto-backup', 'Scheduler', {
            source: 'system',
            applyRetention: true,
          });
          this.db.updateInstance(inst.id, {
            backupPolicy: {
              ...policy,
              lastAutoBackupAt: now.toISOString(),
            },
          });
          backedUpIds.push(inst.id);
        } catch (err) {
          console.error(`[BackupScheduler] Auto-backup failed for ${inst.name}:`, err);
        }
      }
    } finally {
      this.running = false;
    }
    return backedUpIds;
  }
}
