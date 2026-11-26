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

const LOG_LINE_PREFIX_RE = /^\[(\d{4}-\d{2}-\d{2}T[^\]]+)\]\s?(.*)$/;
const MAX_PERSISTED_LOG_BYTES = 2 * 1024 * 1024; // 2 MB per instance log before rotation

function sanitizeLogId(instanceId: string): string {
  return instanceId.replace(/[^a-zA-Z0-9._-]/g, '_');
}

/**
 * In-memory ring buffer storing recent console log lines per instance,
 * optionally persisted to rotating disk files so crash output survives restarts.
 */
export class ConsoleLogBuffer {
  private readonly buffers = new Map<string, Array<{ timestamp: string; line: string }>>();
  private readonly hydrated = new Set<string>();

  constructor(
    private readonly maxLines = 1000,
    private readonly logDir?: string
  ) {
    if (this.logDir) {
      try {
        fs.mkdirSync(this.logDir, { recursive: true });
      } catch {
        // Non-fatal: continue with in-memory buffering
      }
    }
  }

  getLogFilePath(instanceId: string): string | null {
    if (!this.logDir) return null;
    return path.join(this.logDir, `${sanitizeLogId(instanceId)}.log`);
  }

  private hydrateIfNeeded(instanceId: string): void {
    if (!this.logDir || this.hydrated.has(instanceId)) return;
    this.hydrated.add(instanceId);

    const filePath = this.getLogFilePath(instanceId);
    if (!filePath || !fs.existsSync(filePath)) return;

    try {
      const content = fs.readFileSync(filePath, 'utf8');
      const rawLines = content.split(/\r?\n/).filter((l) => l.length > 0);
      const tail = rawLines.slice(-this.maxLines);
      const parsed = tail.map((raw) => {
        const match = raw.match(LOG_LINE_PREFIX_RE);
        if (match) {
          return { timestamp: match[1], line: match[2] };
        }
        return { timestamp: new Date(0).toISOString(), line: raw };
      });
      if (parsed.length > 0) {
        const existing = this.buffers.get(instanceId) ?? [];
        const merged = [...parsed, ...existing].slice(-this.maxLines);
        this.buffers.set(instanceId, merged);
      }
    } catch {
      // Ignore unreadable historical log file
    }
  }

  private persistLine(instanceId: string, entry: { timestamp: string; line: string }): void {
    const filePath = this.getLogFilePath(instanceId);
    if (!filePath) return;

    try {
      if (fs.existsSync(filePath)) {
        const stat = fs.statSync(filePath);
        if (stat.size >= MAX_PERSISTED_LOG_BYTES) {
          const prevPath = `${filePath}.prev`;
          try {
            fs.rmSync(prevPath, { force: true });
            fs.renameSync(filePath, prevPath);
          } catch {
            // If rename fails (e.g. Windows lock), truncate instead
            fs.writeFileSync(filePath, '', 'utf8');
          }
        }
      }
      const cleanLine = entry.line.replace(/\r?\n/g, ' ');
      fs.appendFileSync(filePath, `[${entry.timestamp}] ${cleanLine}\n`, 'utf8');
    } catch {
      // Never block server output if disk logging fails
    }
  }

  append(instanceId: string, line: string): { timestamp: string; line: string } {
    this.hydrateIfNeeded(instanceId);
    const entry = { timestamp: new Date().toISOString(), line };
    let arr = this.buffers.get(instanceId);
    if (!arr) {
      arr = [];
      this.buffers.set(instanceId, arr);
    }
    arr.push(entry);
    if (arr.length > this.maxLines) {
      arr.splice(0, arr.length - this.maxLines);
    }
    this.persistLine(instanceId, entry);
    return entry;
  }

  getLines(instanceId: string): Array<{ timestamp: string; line: string }> {
    this.hydrateIfNeeded(instanceId);
    return this.buffers.get(instanceId) ?? [];
  }

  readFullLogText(instanceId: string): string {
    const filePath = this.getLogFilePath(instanceId);
    if (filePath && fs.existsSync(filePath)) {
      try {
        return fs.readFileSync(filePath, 'utf8');
      } catch {
        // Fall back to in-memory buffer
      }
    }
    return this.getLines(instanceId)
      .map((entry) => `[${entry.timestamp}] ${entry.line}`)
      .join('\n');
  }

  clear(instanceId: string, removePersistedFile = false): void {
    this.buffers.delete(instanceId);
    this.hydrated.delete(instanceId);
    if (removePersistedFile) {
      const filePath = this.getLogFilePath(instanceId);
      if (filePath) {
        try {
          fs.rmSync(filePath, { force: true });
          fs.rmSync(`${filePath}.prev`, { force: true });
        } catch {
          // ignore
        }
      }
    }
  }
}
