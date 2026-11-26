import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type {
  AppDiagnosticLogEntry,
  AppDiagnosticLogLevel,
  GameTemplate,
  HostMetrics,
  InstanceDiagnosticsReport,
  ServerInstance,
  SystemDiagnosticsReport,
} from '@serverforge/shared';
import type { AppConfig } from '../config.js';

const SENSITIVE_KEY_RE = /(pass|passwd|password|secret|token|api[_-]?key|auth|cookie|credential)/i;
const SENSITIVE_TEXT_PATTERNS: Array<{ re: RegExp; replacement: string }> = [
  { re: /(Bearer\s+)[A-Za-z0-9._~+/=-]{8,}/gi, replacement: '$1[REDACTED]' },
  { re: /([?&](?:token|key|api_key|apikey|password|secret)=)[^&\s]+/gi, replacement: '$1[REDACTED]' },
  { re: /(\$2[aby]\$\d{2}\$[./A-Za-z0-9]{20,})/g, replacement: '[REDACTED_KEY]' },
  { re: /(x-api-key["']?\s*[:=]\s*["']?)[^\s"',}]+/gi, replacement: '$1[REDACTED]' },
];

const MAX_APP_LOG_FILE_BYTES = 2 * 1024 * 1024; // 2 MB

export function redactSensitiveText(input: string): string {
  let out = input;
  for (const { re, replacement } of SENSITIVE_TEXT_PATTERNS) {
    out = out.replace(re, replacement);
  }
  return out;
}

export function redactSensitiveConfig(
  config: Record<string, string | number | boolean>
): Record<string, string | number | boolean> {
  const sanitized: Record<string, string | number | boolean> = {};
  for (const [key, val] of Object.entries(config)) {
    if (SENSITIVE_KEY_RE.test(key) && val !== '' && val !== false) {
      sanitized[key] = '[REDACTED]';
    } else if (typeof val === 'string') {
      sanitized[key] = redactSensitiveText(val);
    } else {
      sanitized[key] = val;
    }
  }
  return sanitized;
}

export class DiagnosticsService {
  private readonly entries: AppDiagnosticLogEntry[] = [];
  private readonly maxEntries = 500;
  private readonly appLogPath: string;

  constructor(private readonly config: AppConfig) {
    fs.mkdirSync(config.logsDir, { recursive: true });
    this.appLogPath = path.join(config.logsDir, 'serverforge.log');
  }

  record(
    level: AppDiagnosticLogLevel,
    source: string,
    message: string,
    details?: string | null,
    instanceId?: string | null
  ): AppDiagnosticLogEntry {
    const entry: AppDiagnosticLogEntry = {
      id: crypto.randomUUID(),
      timestamp: new Date().toISOString(),
      level,
      source,
      message: redactSensitiveText(message),
      details: details ? redactSensitiveText(details) : null,
      instanceId: instanceId ?? null,
    };

    this.entries.push(entry);
    if (this.entries.length > this.maxEntries) {
      this.entries.splice(0, this.entries.length - this.maxEntries);
    }

    this.persistEntry(entry);
    return entry;
  }

  private persistEntry(entry: AppDiagnosticLogEntry): void {
    try {
      if (fs.existsSync(this.appLogPath)) {
        const stat = fs.statSync(this.appLogPath);
        if (stat.size >= MAX_APP_LOG_FILE_BYTES) {
          const prevPath = `${this.appLogPath}.prev`;
          try {
            fs.rmSync(prevPath, { force: true });
            fs.renameSync(this.appLogPath, prevPath);
          } catch {
            fs.writeFileSync(this.appLogPath, '', 'utf8');
          }
        }
      }
      const line = `[${entry.timestamp}] [${entry.level.toUpperCase()}] [${entry.source}]${entry.instanceId ? ` [${entry.instanceId}]` : ''} ${entry.message}${entry.details ? ` — ${entry.details.replace(/\r?\n/g, ' | ')}` : ''}\n`;
      fs.appendFileSync(this.appLogPath, line, 'utf8');
    } catch {
      // Never throw on diagnostic log write failure
    }
  }

  listLogs(options: { level?: 'all' | 'warn' | 'error'; limit?: number; instanceId?: string } = {}): AppDiagnosticLogEntry[] {
    const level = options.level ?? 'all';
    const limit = Math.min(Math.max(options.limit ?? 200, 1), this.maxEntries);

    let filtered = this.entries;
    if (options.instanceId) {
      filtered = filtered.filter((e) => e.instanceId === options.instanceId);
    }
    if (level === 'error') {
      filtered = filtered.filter((e) => e.level === 'error');
    } else if (level === 'warn') {
      filtered = filtered.filter((e) => e.level === 'error' || e.level === 'warn');
    }

    return [...filtered].reverse().slice(0, limit);
  }

  getAppLogFilePath(): string {
    return this.appLogPath;
  }

  buildInstanceReport(
    instance: ServerInstance,
    template: GameTemplate | null,
    consoleLogs: Array<{ timestamp: string; line: string }>,
    maxConsoleLines = 250
  ): InstanceDiagnosticsReport {
    const generatedAt = new Date().toISOString();
    const redactedConfig = redactSensitiveConfig(instance.config);
    const tail = consoleLogs.slice(-maxConsoleLines).map((entry) => ({
      timestamp: entry.timestamp,
      line: redactSensitiveText(entry.line),
    }));
    const recentAppErrors = this.listLogs({ level: 'warn', limit: 25, instanceId: instance.id });
    const sanitizedError = instance.lastError ? redactSensitiveText(instance.lastError) : null;

    const portsText =
      Object.entries(instance.ports)
        .map(([k, p]) => `${k}:${p}`)
        .join(', ') || 'none';

    const consoleBlock =
      tail.length > 0
        ? tail.map((e) => `[${e.timestamp}] ${e.line}`).join('\n')
        : '(no console output recorded)';

    const appErrorsSection =
      recentAppErrors.length > 0
        ? [
            '### Recent ServerForge Backend Errors (Instance)',
            '```text',
            ...recentAppErrors.map(
              (e) => `[${e.timestamp}] [${e.level.toUpperCase()}] [${e.source}] ${e.message}${e.details ? ` — ${e.details}` : ''}`
            ),
            '```',
          ].join('\n')
        : '';

    const markdown = [
      `## ServerForge Instance Debug Report`,
      '',
      `- **Generated:** ${generatedAt}`,
      `- **ServerForge Version:** v${this.config.appVersion} (${this.config.runtimeMode} mode)`,
      `- **Host OS / Node:** ${process.platform} (${os.release()}) • Node ${process.version}`,
      `- **Server:** ${instance.name} (\`${instance.slug}\`)`,
      `- **Game Template:** ${template?.name ?? instance.gameId} (\`${instance.gameId}\`)`,
      `- **Runtime / Status:** \`${instance.runtime}\` • \`${instance.status}\``,
      `- **Memory Limit:** ${instance.memoryLimitMb} MB`,
      `- **Ports:** \`${portsText}\``,
      instance.launchScript ? `- **Launch Script:** \`${instance.launchScript}\`` : null,
      instance.externalDir ? `- **Linked Folder:** \`${instance.externalDir}\`` : null,
      sanitizedError ? `- **Last Error:** \`${sanitizedError}\`` : `- **Last Error:** none`,
      '',
      '### Sanitized Configuration',
      '```json',
      JSON.stringify(redactedConfig, null, 2),
      '```',
      appErrorsSection || null,
      '',
      `<details>`,
      `<summary>Console Output (last ${tail.length} of ${consoleLogs.length} buffered lines)</summary>`,
      '',
      '```text',
      consoleBlock,
      '```',
      `</details>`,
    ]
      .filter((line) => line !== null)
      .join('\n');

    return {
      generatedAt,
      appVersion: this.config.appVersion,
      platform: `${process.platform} (${os.release()})`,
      nodeVersion: process.version,
      instance: {
        id: instance.id,
        slug: instance.slug,
        name: instance.name,
        gameId: instance.gameId,
        gameName: template?.name ?? instance.gameId,
        runtime: instance.runtime,
        status: instance.status,
        memoryLimitMb: instance.memoryLimitMb,
        ports: instance.ports,
        externalDir: instance.externalDir ?? null,
        launchScript: instance.launchScript ?? null,
        autoStart: instance.autoStart,
        discordEnabled: instance.discordEnabled,
        config: redactedConfig,
        createdAt: instance.createdAt,
        lastStartedAt: instance.lastStartedAt,
      },
      lastError: sanitizedError,
      totalBufferedLogs: consoleLogs.length,
      recentLogs: tail,
      recentAppErrors,
      markdown,
    };
  }

  buildSystemReport(metrics: HostMetrics, instances: ServerInstance[]): SystemDiagnosticsReport {
    const generatedAt = new Date().toISOString();
    const recentErrors = this.listLogs({ level: 'warn', limit: 60 });
    const instancesSummary = instances.map((i) => ({
      id: i.id,
      name: i.name,
      gameId: i.gameId,
      runtime: i.runtime,
      status: i.status,
      lastError: i.lastError ? redactSensitiveText(i.lastError) : null,
    }));

    const instanceLines =
      instancesSummary.length > 0
        ? instancesSummary.map(
            (i) =>
              `- **${i.name}** (\`${i.gameId}\` / \`${i.runtime}\`): \`${i.status}\`${i.lastError ? ` — Error: \`${i.lastError}\`` : ''}`
          )
        : ['- No server instances configured.'];

    const errorLines =
      recentErrors.length > 0
        ? recentErrors.map(
            (e) =>
              `[${e.timestamp}] [${e.level.toUpperCase()}] [${e.source}]${e.instanceId ? ` [${e.instanceId}]` : ''} ${e.message}${e.details ? ` — ${e.details}` : ''}`
          )
        : ['(no recent warnings or errors recorded)'];

    const markdown = [
      `## ServerForge System Diagnostics Report`,
      '',
      `- **Generated:** ${generatedAt}`,
      `- **ServerForge Version:** v${this.config.appVersion} (${this.config.runtimeMode} mode)`,
      `- **OS:** ${metrics.osDistro} (${process.platform} ${os.release()})`,
      `- **Node.js:** ${process.version}`,
      `- **CPU / RAM:** ${metrics.cpuCores} cores (${metrics.cpuLoadPercent}% load) • ${metrics.memoryUsedGb}/${metrics.memoryTotalGb} GB RAM used (${metrics.memoryFreeGb} GB free)`,
      `- **Disk:** ${metrics.diskUsedGb}/${metrics.diskTotalGb} GB used (${metrics.diskFreeGb} GB free)`,
      `- **Runtimes Available:** Native=${metrics.runtimesAvailable.native}, Docker=${metrics.runtimesAvailable.docker}, Mock=${metrics.runtimesAvailable.mock}`,
      `- **Discord Bot:** ${metrics.discordConnected ? `Connected (${metrics.discordBotTag})` : 'Offline'}`,
      '',
      `### Server Fleet (${instancesSummary.length})`,
      ...instanceLines,
      '',
      `<details>`,
      `<summary>Recent ServerForge Backend Warnings & Errors (${recentErrors.length})</summary>`,
      '',
      '```text',
      ...errorLines,
      '```',
      `</details>`,
    ].join('\n');

    return {
      generatedAt,
      appVersion: this.config.appVersion,
      platform: `${process.platform} (${os.release()})`,
      osDistro: metrics.osDistro,
      nodeVersion: process.version,
      runtimeMode: this.config.runtimeMode,
      runtimesAvailable: metrics.runtimesAvailable,
      instancesSummary,
      recentErrors,
      markdown,
    };
  }
}
