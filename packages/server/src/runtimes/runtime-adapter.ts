import fs from 'node:fs';
import path from 'node:path';
import type { GameTemplate, InstanceRuntimeStats, InstanceStatus, RuntimeKind, ServerInstance } from '@serverforge/shared';

export type LogListener = (instanceId: string, line: string) => void;
export type StatusListener = (instanceId: string, status: InstanceStatus, error?: string | null) => void;

export interface RuntimeStartResult {
  externalId: string;
}

export interface RuntimeAdapter {
  readonly kind: RuntimeKind | 'mock';
  isAvailable(): Promise<boolean>;
  start(
    instance: ServerInstance,
    template: GameTemplate,
    instanceDir: string,
    onLog: (line: string) => void,
    onExit: (code: number | null) => void,
    onStatus?: (status: 'installing' | 'starting') => void
  ): Promise<RuntimeStartResult>;
  stop(instance: ServerInstance, template: GameTemplate, onLog: (line: string) => void): Promise<void>;
  sendCommand(instance: ServerInstance, template: GameTemplate, command: string): Promise<string | null>;
  getStats(instance: ServerInstance, template: GameTemplate): Promise<InstanceRuntimeStats | null>;
  remove(instance: ServerInstance): Promise<void>;
  isRunning(instance: ServerInstance): Promise<boolean>;
}

/**
 * Splits a shell-style argument string while respecting quoted segments.
 */
export function splitArgs(argsStr: string): string[] {
  const args: string[] = [];
  let current = '';
  let inQuotes: '"' | "'" | null = null;

  for (let i = 0; i < argsStr.length; i++) {
    const ch = argsStr[i];
    if (inQuotes) {
      if (ch === inQuotes) {
        inQuotes = null;
      } else {
        current += ch;
      }
    } else if (ch === '"' || ch === "'") {
      inQuotes = ch;
    } else if (/\s/.test(ch)) {
      if (current.length > 0) {
        args.push(current);
        current = '';
      }
    } else {
      current += ch;
    }
  }
  if (current.length > 0) {
    args.push(current);
  }
  return args;
}

export interface ConsoleLogEntry {
  timestamp: string;
  line: string;
}

export interface ConsoleLogBufferOptions {
  /** Optional directory where per-instance rotating log files are persisted (e.g., data/logs/instances). */
  persistDir?: string;
  /** Maximum size of each log file before rotation (default: 2 MB). */
  maxFileBytes?: number;
  /** Number of rotated archive files (.1, .2) to keep (default: 2). */
  maxRotations?: number;
}

/**
 * Ring buffer storing recent console log lines per instance, with optional
 * disk-backed rotating log persistence hydrated automatically across restarts.
 */
export class ConsoleLogBuffer {
  private readonly buffers = new Map<string, ConsoleLogEntry[]>();
  private readonly hydrated = new Set<string>();
  private readonly persistDir: string | null;
  private readonly maxFileBytes: number;
  private readonly maxRotations: number;

  constructor(private readonly maxLines = 500, options: ConsoleLogBufferOptions = {}) {
    this.persistDir = options.persistDir ? path.resolve(options.persistDir) : null;
    this.maxFileBytes = Math.max(4096, options.maxFileBytes ?? 2 * 1024 * 1024);
    this.maxRotations = Math.max(1, options.maxRotations ?? 2);
    if (this.persistDir) {
      fs.mkdirSync(this.persistDir, { recursive: true });
    }
  }

  private safeFileName(instanceId: string): string {
    return instanceId.replace(/[^a-zA-Z0-9._-]/g, '_');
  }

  getLogFilePath(instanceId: string): string | null {
    if (!this.persistDir) return null;
    return path.join(this.persistDir, `${this.safeFileName(instanceId)}.log`);
  }

  private rotateIfNeeded(filePath: string): void {
    try {
      if (!fs.existsSync(filePath)) return;
      const stat = fs.statSync(filePath);
      if (stat.size < this.maxFileBytes) return;

      for (let i = this.maxRotations; i >= 1; i--) {
        const src = i === 1 ? filePath : `${filePath}.${i - 1}`;
        const dst = `${filePath}.${i}`;
        if (fs.existsSync(src)) {
          try {
            if (fs.existsSync(dst)) fs.rmSync(dst, { force: true });
            fs.renameSync(src, dst);
          } catch {
            // Best-effort rotation on Windows if file is momentarily busy
          }
        }
      }
    } catch {
      // Ignore rotation failures
    }
  }

  private parseDiskLines(raw: string): ConsoleLogEntry[] {
    const entries: ConsoleLogEntry[] = [];
    for (const rawLine of raw.split(/\r?\n/)) {
      if (!rawLine) continue;
      if (rawLine.startsWith('{') && rawLine.endsWith('}')) {
        try {
          const parsed = JSON.parse(rawLine) as { t?: string; l?: string };
          if (typeof parsed.t === 'string' && typeof parsed.l === 'string') {
            entries.push({ timestamp: parsed.t, line: parsed.l });
            continue;
          }
        } catch {
          // Fall through to plain line parsing
        }
      }
      entries.push({ timestamp: new Date(0).toISOString(), line: rawLine });
    }
    return entries;
  }

  private hydrateFromDisk(instanceId: string): void {
    if (this.hydrated.has(instanceId)) return;
    this.hydrated.add(instanceId);

    const filePath = this.getLogFilePath(instanceId);
    if (!filePath) return;

    const filesToRead: string[] = [];
    const rotated = `${filePath}.1`;
    if (fs.existsSync(rotated)) filesToRead.push(rotated);
    if (fs.existsSync(filePath)) filesToRead.push(filePath);
    if (filesToRead.length === 0) return;

    const loaded: ConsoleLogEntry[] = [];
    for (const f of filesToRead) {
      try {
        const raw = fs.readFileSync(f, 'utf8');
        loaded.push(...this.parseDiskLines(raw));
      } catch {
        // Skip unreadable log file
      }
    }

    if (loaded.length > 0) {
      const existing = this.buffers.get(instanceId) ?? [];
      const combined = [...loaded, ...existing].slice(-this.maxLines);
      this.buffers.set(instanceId, combined);
    }
  }

  append(instanceId: string, line: string): ConsoleLogEntry {
    this.hydrateFromDisk(instanceId);
    const entry: ConsoleLogEntry = { timestamp: new Date().toISOString(), line };
    let arr = this.buffers.get(instanceId);
    if (!arr) {
      arr = [];
      this.buffers.set(instanceId, arr);
    }
    arr.push(entry);
    if (arr.length > this.maxLines) {
      arr.splice(0, arr.length - this.maxLines);
    }

    const filePath = this.getLogFilePath(instanceId);
    if (filePath) {
      try {
        this.rotateIfNeeded(filePath);
        fs.appendFileSync(filePath, `${JSON.stringify({ t: entry.timestamp, l: entry.line })}\n`, 'utf8');
      } catch {
        // Non-fatal if disk is temporarily unavailable
      }
    }
    return entry;
  }

  getLines(instanceId: string): ConsoleLogEntry[] {
    this.hydrateFromDisk(instanceId);
    return this.buffers.get(instanceId) ?? [];
  }

  getFormattedText(instanceId: string): string {
    return this.getLines(instanceId)
      .map((entry) => `[${entry.timestamp}] ${entry.line}`)
      .join('\n');
  }

  clear(instanceId: string): void {
    this.buffers.delete(instanceId);
    this.hydrated.delete(instanceId);
    const filePath = this.getLogFilePath(instanceId);
    if (filePath) {
      const candidates = [filePath];
      for (let i = 1; i <= this.maxRotations; i++) {
        candidates.push(`${filePath}.${i}`);
      }
      for (const f of candidates) {
        try {
          if (fs.existsSync(f)) fs.rmSync(f, { force: true });
        } catch {
          // Ignore cleanup errors
        }
      }
    }
  }
}
