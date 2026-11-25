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
    onExit: (code: number | null) => void
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

/**
 * In-memory ring buffer storing recent console log lines per instance.
 */
export class ConsoleLogBuffer {
  private readonly buffers = new Map<string, Array<{ timestamp: string; line: string }>>();

  constructor(private readonly maxLines = 500) {}

  append(instanceId: string, line: string): { timestamp: string; line: string } {
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
    return entry;
  }

  getLines(instanceId: string): Array<{ timestamp: string; line: string }> {
    return this.buffers.get(instanceId) ?? [];
  }

  clear(instanceId: string): void {
    this.buffers.delete(instanceId);
  }
}
