import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type {
  AppDiagnosticEvent,
  BugReportCategory,
  BugReportInput,
  BugReportPreviewResult,
  BugReportSubmitResult,
  DiagnosticLevel,
  DiagnosticSource,
  InstanceDebugReport,
  ServerInstance,
  SystemDiagnosticsReport,
} from '@serverforge/shared';
import type { AppConfig } from '../config.js';
import type { AppDatabase } from '../db/database.js';
import type { ConnectivityService } from './connectivity-service.js';
import type { ServerOrchestrator } from './orchestrator.js';
import type { TelemetryService } from './telemetry-service.js';

const SENSITIVE_KEY_RE = /(password|passwd|secret|token|api[_-]?key|auth|cookie|credential|private[_-]?key)/i;

/**
 * Redacts API keys, tokens, passwords, and Bearer headers from logs and debug reports.
 */
export function redactSecrets(input: string, extraSecrets: string[] = []): string {
  let out = input;

  for (const secret of extraSecrets) {
    const trimmed = secret.trim();
    if (trimmed.length >= 6) {
      out = out.split(trimmed).join('[REDACTED]');
    }
  }

  // Bearer / Basic auth headers
  out = out.replace(/(Authorization:\s*(?:Bearer|Basic)\s+)[^\s"']+/gi, '$1[REDACTED]');
  out = out.replace(/\b(Bearer\s+)[A-Za-z0-9._~+/=-]{12,}/g, '$1[REDACTED]');

  // CurseForge bcrypt-style API keys ($2a$10$...)
  out = out.replace(/\$2[aby]\$\d{2}\$[./A-Za-z0-9]{20,}/g, '[REDACTED_CF_KEY]');

  // Discord bot tokens (3 dot-separated base64url segments)
  out = out.replace(/\b[MN][A-Za-z\d_-]{20,}\.[A-Za-z\d_-]{6}\.[A-Za-z\d_-]{25,}\b/g, '[REDACTED_DISCORD_TOKEN]');

  // Key=value or JSON-style sensitive fields
  out = out.replace(
    /((?:password|passwd|rcon[._-]?password|api[_-]?key|cf_api_key|duckdns[_-]?token|jwt[_-]?secret|discord[_-]?token|token|secret)\s*[:=]\s*["']?)([^"'\s,&}\r\n]+)/gi,
    '$1[REDACTED]'
  );

  // DuckDNS query string tokens
  out = out.replace(/([?&]token=)[^&\s]+/gi, '$1[REDACTED]');

  return out;
}

export function redactConfigObject(
  config: Record<string, string | number | boolean>,
  extraSecrets: string[] = []
): Record<string, string | number | boolean> {
  const sanitized: Record<string, string | number | boolean> = {};
  for (const [k, v] of Object.entries(config)) {
    if (SENSITIVE_KEY_RE.test(k)) {
      sanitized[k] = v ? '[REDACTED]' : '';
    } else if (typeof v === 'string') {
      sanitized[k] = redactSecrets(v, extraSecrets);
    } else {
      sanitized[k] = v;
    }
  }
  return sanitized;
}

export class DiagnosticsService {
  private events: AppDiagnosticEvent[] = [];
  private readonly logFilePath: string;
  private readonly maxEvents: number;
  private readonly maxFileBytes: number;

  constructor(
    private readonly config: AppConfig,
    private readonly db: AppDatabase,
    private readonly telemetry: TelemetryService,
    private orchestrator?: ServerOrchestrator,
    options: { maxEvents?: number; maxFileBytes?: number } = {}
  ) {
    this.maxEvents = options.maxEvents ?? 300;
    this.maxFileBytes = options.maxFileBytes ?? 1024 * 1024;
    fs.mkdirSync(config.logsDir, { recursive: true });
    this.logFilePath = path.join(config.logsDir, 'app-diagnostics.log');
    this.hydrateFromDisk();
  }

  private connectivity?: ConnectivityService;

  attachOrchestrator(orchestrator: ServerOrchestrator): void {
    this.orchestrator = orchestrator;
  }

  attachConnectivity(connectivity: ConnectivityService): void {
    this.connectivity = connectivity;
  }

  private collectKnownSecrets(): string[] {
    const secrets: string[] = [];
    if (this.config.jwtSecret) secrets.push(this.config.jwtSecret);
    if (this.config.discordToken) secrets.push(this.config.discordToken);
    if (this.config.curseforgeApiKey) secrets.push(this.config.curseforgeApiKey);
    try {
      const settings = this.db.getSettings(this.config.publicHost);
      if (settings.curseforgeApiKey) secrets.push(settings.curseforgeApiKey);
      if (settings.duckdnsToken) secrets.push(settings.duckdnsToken);
      if (settings.discordBotToken) secrets.push(settings.discordBotToken);
      if (settings.githubIssueToken) secrets.push(settings.githubIssueToken);
    } catch {
      // Ignore if DB closed
    }
    return secrets;
  }

  private hydrateFromDisk(): void {
    if (!fs.existsSync(this.logFilePath)) return;
    try {
      const raw = fs.readFileSync(this.logFilePath, 'utf8');
      const parsed: AppDiagnosticEvent[] = [];
      for (const line of raw.split(/\r?\n/)) {
        if (!line.trim()) continue;
        try {
          const item = JSON.parse(line) as AppDiagnosticEvent;
          if (item && typeof item.message === 'string' && typeof item.timestamp === 'string') {
            parsed.push(item);
          }
        } catch {
          // skip corrupt line
        }
      }
      this.events = parsed.slice(-this.maxEvents);
    } catch {
      // ignore disk read errors
    }
  }

  private rotateIfNeeded(): void {
    try {
      if (!fs.existsSync(this.logFilePath)) return;
      if (fs.statSync(this.logFilePath).size < this.maxFileBytes) return;
      const archive = `${this.logFilePath}.1`;
      if (fs.existsSync(archive)) fs.rmSync(archive, { force: true });
      fs.renameSync(this.logFilePath, archive);
    } catch {
      // best effort
    }
  }

  record(input: {
    level: DiagnosticLevel;
    source: DiagnosticSource;
    message: string;
    statusCode?: number | null;
    method?: string | null;
    path?: string | null;
    instanceId?: string | null;
    details?: string | null;
  }): AppDiagnosticEvent {
    const secrets = this.collectKnownSecrets();
    const event: AppDiagnosticEvent = {
      id: crypto.randomUUID(),
      timestamp: new Date().toISOString(),
      level: input.level,
      source: input.source,
      message: redactSecrets(input.message, secrets),
      statusCode: input.statusCode ?? null,
      method: input.method ?? null,
      path: input.path ? redactSecrets(input.path, secrets) : null,
      instanceId: input.instanceId ?? null,
      details: input.details ? redactSecrets(input.details, secrets) : null,
    };

    this.events.push(event);
    if (this.events.length > this.maxEvents) {
      this.events.splice(0, this.events.length - this.maxEvents);
    }

    try {
      this.rotateIfNeeded();
      fs.appendFileSync(this.logFilePath, `${JSON.stringify(event)}\n`, 'utf8');
    } catch {
      // non-fatal
    }

    return event;
  }

  listLogs(options: { level?: DiagnosticLevel; limit?: number } = {}): AppDiagnosticEvent[] {
    const limit = Math.min(Math.max(options.limit ?? 100, 1), this.maxEvents);
    const filtered = options.level ? this.events.filter((e) => e.level === options.level) : this.events;
    return filtered.slice(-limit).reverse();
  }

  clearLogs(): void {
    this.events = [];
    for (const candidate of [this.logFilePath, `${this.logFilePath}.1`]) {
      try {
        if (fs.existsSync(candidate)) fs.rmSync(candidate, { force: true });
      } catch {
        // ignore
      }
    }
  }

  async buildSystemReport(): Promise<SystemDiagnosticsReport> {
    const generatedAt = new Date().toISOString();
    const secrets = this.collectKnownSecrets();
    const runningCount = this.orchestrator?.getRunningCount() ?? 0;
    const metrics = await this.telemetry.getHostMetrics(runningCount).catch(() => null);
    const settings = this.db.getSettings(this.config.publicHost);
    const instances = this.orchestrator ? this.orchestrator.listInstances() : this.db.listInstances();

    const errorCount = this.events.filter((e) => e.level === 'error').length;
    const warnCount = this.events.filter((e) => e.level === 'warn').length;
    const recentErrors = this.events.filter((e) => e.level === 'error' || e.level === 'warn').slice(-40);

    const lines: string[] = [
      `# ServerForge System Diagnostics Report`,
      ``,
      `- **Generated:** ${generatedAt}`,
      `- **ServerForge Version:** v${this.config.appVersion}`,
      `- **Runtime Mode:** ${this.config.runtimeMode}`,
      `- **Node.js:** ${process.version} (${os.platform()} ${os.arch()})`,
      `- **OS:** ${metrics?.osDistro ?? `${os.type()} ${os.release()}`}`,
    ];

    if (metrics) {
      lines.push(
        `- **CPU / RAM / Disk:** ${metrics.cpuCores} cores (${metrics.cpuLoadPercent}% load) • ${metrics.memoryUsedGb}/${metrics.memoryTotalGb} GB RAM (${metrics.memoryFreeGb} GB free) • ${metrics.diskFreeGb} GB disk free`,
        `- **Runtimes Available:** native=${metrics.runtimesAvailable.native}, docker=${metrics.runtimesAvailable.docker}, mock=${metrics.runtimesAvailable.mock}`,
        `- **Discord Bot:** ${metrics.discordConnected ? `Connected (${metrics.discordBotTag})` : 'Disconnected'}`
      );
    }

    lines.push(
      `- **Public Host Mode:** ${settings.publicHostMode} (DuckDNS configured: ${Boolean(settings.duckdnsDomain)}, CurseForge API key configured: ${Boolean(settings.curseforgeApiKey || this.config.curseforgeApiKey)})`,
      ``,
      `## Instances (${instances.length})`
    );

    if (instances.length === 0) {
      lines.push('_No instances configured._');
    } else {
      for (const inst of instances) {
        lines.push(
          `- **${inst.name}** (\`${inst.gameId}\` • \`${inst.runtime}\` • status: \`${inst.status}\` • RAM: ${inst.memoryLimitMb} MB • autoRestartOnCrash: ${inst.autoRestartOnCrash !== false})${inst.lastError ? ` — Last Error: ${redactSecrets(inst.lastError, secrets)}` : ''}`
        );
      }
    }

    lines.push('', `## Recent Backend Warnings & Errors (${recentErrors.length})`);
    if (recentErrors.length === 0) {
      lines.push('_No warnings or errors recorded._');
    } else {
      lines.push('```text');
      for (const ev of recentErrors) {
        const http = ev.method && ev.path ? ` ${ev.method} ${ev.path}${ev.statusCode ? ` -> ${ev.statusCode}` : ''}` : '';
        lines.push(`[${ev.timestamp}] [${ev.level.toUpperCase()}] [${ev.source}]${http} ${ev.message}`);
        if (ev.details) {
          lines.push(`  details: ${ev.details}`);
        }
      }
      lines.push('```');
    }

    return {
      generatedAt,
      markdown: redactSecrets(lines.join('\n'), secrets),
      errorCount,
      warnCount,
    };
  }

  async buildInstanceDebugReport(instance: ServerInstance, maxConsoleLines = 150): Promise<InstanceDebugReport> {
    const generatedAt = new Date().toISOString();
    const secrets = this.collectKnownSecrets();
    for (const [k, v] of Object.entries(instance.config)) {
      if (SENSITIVE_KEY_RE.test(k) && typeof v === 'string' && v.trim()) {
        secrets.push(v);
      }
    }

    const consoleLines = this.orchestrator ? this.orchestrator.logs.getLines(instance.id).slice(-maxConsoleLines) : [];
    const instanceErrors = this.events
      .filter((e) => e.instanceId === instance.id || (e.path && e.path.includes(instance.id)))
      .slice(-25);

    const sanitizedConfig = redactConfigObject(instance.config, secrets);
    const lines: string[] = [
      `# ServerForge Debug Report — ${instance.name}`,
      ``,
      `- **Generated:** ${generatedAt}`,
      `- **ServerForge Version:** v${this.config.appVersion}`,
      `- **Platform:** ${os.platform()} ${os.arch()} (Node ${process.version})`,
      `- **Instance ID / Slug:** \`${instance.id}\` / \`${instance.slug}\``,
      `- **Game Template:** \`${instance.gameId}\``,
      `- **Runtime:** \`${instance.runtime}\``,
      `- **Status:** \`${instance.status}\``,
      `- **RAM Limit:** ${instance.memoryLimitMb} MB`,
      `- **Ports:** \`${JSON.stringify(instance.ports)}\``,
      `- **Auto-Restart on Crash:** ${instance.autoRestartOnCrash !== false}`,
      `- **Linked External Folder:** ${instance.externalDir ? 'yes (external)' : 'no (managed)'}`,
    ];

    if (instance.lastError) {
      lines.push(`- **Last Error:** ${redactSecrets(instance.lastError, secrets)}`);
    }

    if (instance.lastCrash) {
      lines.push(
        ``,
        `## Last Crash Summary`,
        `- **Crashed At:** ${instance.lastCrash.crashedAt}`,
        `- **Exit Code:** ${instance.lastCrash.exitCode ?? 'unknown'}`,
        `- **Watchdog Attempts:** ${instance.lastCrash.attemptCount}/${instance.lastCrash.maxAttempts} (${instance.lastCrash.halted ? 'Auto-restart halted' : 'Recovery scheduled'})`,
        `- **Reason:** ${redactSecrets(instance.lastCrash.reason, secrets)}`
      );

      if (instance.lastCrash.analysis) {
        const a = instance.lastCrash.analysis;
        lines.push(
          ``,
          `### Minecraft Crash Analysis`,
          `- **Category:** \`${a.category}\``,
          `- **Headline:** ${redactSecrets(a.headline, secrets)}`,
          `- **Summary:** ${redactSecrets(a.summary, secrets)}`,
          `- **Recommended Fix:** ${redactSecrets(a.recommendedFix, secrets)}`
        );
        if (a.requiredJavaMajor) {
          lines.push(`- **Required Java Major:** Java ${a.requiredJavaMajor}`);
        }
        if (a.crashReportFile) {
          lines.push(`- **Crash Report File:** \`${redactSecrets(a.crashReportFile, secrets)}\``);
        }
        if (a.missingDependencies.length > 0) {
          const depList = a.missingDependencies
            .map((d) => {
              const parts = [`\`${redactSecrets(d.modId, secrets)}\``];
              if (d.versionRange) parts.push(`(${redactSecrets(d.versionRange, secrets)})`);
              if (d.requiredBy) parts.push(`required by \`${redactSecrets(d.requiredBy, secrets)}\``);
              return parts.join(' ');
            })
            .join(', ');
          lines.push(`- **Missing Dependencies:** ${depList}`);
        }
        if (a.suspectedMods.length > 0) {
          const modList = a.suspectedMods
            .map((m) => {
              const name = m.modName || m.modId || m.jarFile || 'unknown';
              const extra = [
                m.modId && m.modId !== name ? `id=\`${m.modId}\`` : null,
                m.jarFile && m.jarFile !== name ? `jar=\`${m.jarFile}\`` : null,
                m.reason ? m.reason : null,
              ]
                .filter(Boolean)
                .join('; ');
              return extra ? `${redactSecrets(name, secrets)} (${redactSecrets(extra, secrets)})` : redactSecrets(name, secrets);
            })
            .join(', ');
          lines.push(`- **Suspected Mods/Plugins:** ${modList}`);
        }
        if (a.evidenceLines.length > 0) {
          lines.push(`- **Evidence:**`, '```text');
          for (const ev of a.evidenceLines) {
            lines.push(redactSecrets(ev, secrets));
          }
          lines.push('```');
        }
      }
    }

    if (this.connectivity) {
      const guide = this.connectivity.buildNetworkGuide(instance);
      const externalSummary = guide.ports
        .filter((p) => !p.internalOnly)
        .map((p) => `${p.label}: ${p.port}/${p.protocol.toUpperCase()}`)
        .join(', ');
      const internalSummary = guide.ports
        .filter((p) => p.internalOnly)
        .map((p) => `${p.label}: ${p.port}/${p.protocol.toUpperCase()} (Local Only)`)
        .join(', ');
      lines.push(
        ``,
        `## Network & Port Exposure Summary`,
        `- **Local LAN IP:** ${guide.lanIp ?? 'not detected'}`,
        `- **Public Host Mode / Effective Host:** ${guide.effectiveHost}`,
        `- **Required External Ports:** ${externalSummary || 'none'}`,
        `- **Internal-Only Ports (Keep Local):** ${internalSummary || 'none'}`
      );
    }

    lines.push(
      ``,
      `## Sanitized Configuration`,
      '```json',
      JSON.stringify(sanitizedConfig, null, 2),
      '```'
    );

    if (instanceErrors.length > 0) {
      lines.push(``, `## Related Backend / API Errors (${instanceErrors.length})`, '```text');
      for (const ev of instanceErrors) {
        const http = ev.method && ev.path ? ` ${ev.method} ${ev.path}${ev.statusCode ? ` -> ${ev.statusCode}` : ''}` : '';
        lines.push(`[${ev.timestamp}] [${ev.level.toUpperCase()}] [${ev.source}]${http} ${ev.message}`);
      }
      lines.push('```');
    }

    lines.push(``, `## Recent Console Output (last ${consoleLines.length} lines)`, '```text');
    if (consoleLines.length === 0) {
      lines.push('(no console lines recorded)');
    } else {
      for (const entry of consoleLines) {
        lines.push(`[${entry.timestamp}] ${redactSecrets(entry.line, secrets)}`);
      }
    }
    lines.push('```');

    const safeSlug = instance.slug.replace(/[^a-zA-Z0-9._-]/g, '-');
    return {
      generatedAt,
      filename: `serverforge-debug-${safeSlug}.md`,
      markdown: redactSecrets(lines.join('\n'), secrets),
    };
  }

  private mapBugCategoryLabels(category: BugReportCategory): string[] {
    const labels = ['bug'];
    switch (category) {
      case 'networking':
        labels.push('area:networking');
        break;
      case 'game_template':
        labels.push('area:catalog');
        break;
      case 'updater':
        labels.push('area:updater');
        break;
      case 'web_ui':
        labels.push('area:web-ui');
        break;
      case 'discord':
        labels.push('area:discord');
        break;
      case 'security':
        labels.push('area:security');
        break;
      default:
        labels.push('area:backend');
        break;
    }
    return labels;
  }

  async buildBugReport(input: BugReportInput): Promise<BugReportPreviewResult> {
    const settings = this.db.getSettings(this.config.publicHost);
    const githubRepo = (settings.githubRepo || 'StriderVR/serverforge').trim();
    const secrets = this.collectKnownSecrets();

    const cleanTitle = input.title.trim().startsWith('[Bug]:')
      ? input.title.trim()
      : `[Bug]: ${input.title.trim()}`;
    const labels = this.mapBugCategoryLabels(input.category);
    const includeDiagnostics = input.includeDiagnostics !== false;

    const sections: string[] = [
      `## What Happened`,
      redactSecrets(input.description.trim() || '_No description provided._', secrets),
    ];

    if (input.stepsToReproduce?.trim()) {
      sections.push('', `## Steps to Reproduce`, redactSecrets(input.stepsToReproduce.trim(), secrets));
    }

    sections.push(
      '',
      `## Environment`,
      `- **ServerForge Version:** v${this.config.appVersion} (channel: \`${settings.updateChannel ?? 'stable'}\`)`,
      `- **OS / Arch:** ${os.type()} ${os.release()} (${os.platform()} ${os.arch()})`,
      `- **Node.js:** ${process.version}`,
      `- **Runtime Mode:** \`${this.config.runtimeMode}\``,
      `- **Access Mode / HTTPS:** \`${settings.dashboardAccessMode}\` / HTTPS enabled=\`${settings.httpsEnabled}\``
    );

    if (includeDiagnostics) {
      if (input.instanceId) {
        const inst =
          this.orchestrator?.getInstance(input.instanceId) ?? this.db.getInstanceById(input.instanceId);
        if (inst) {
          const instReport = await this.buildInstanceDebugReport(inst, 80);
          sections.push(
            '',
            `<details>`,
            `<summary>Selected Server Debug Report (${inst.name} — ${inst.gameId})</summary>`,
            '',
            instReport.markdown,
            '',
            `</details>`
          );
        }
      }

      const sysReport = await this.buildSystemReport();
      sections.push(
        '',
        `<details>`,
        `<summary>System Diagnostics & Recent Errors (${sysReport.errorCount} errors, ${sysReport.warnCount} warnings)</summary>`,
        '',
        sysReport.markdown,
        '',
        `</details>`
      );
    }

    const markdown = redactSecrets(sections.join('\n'), secrets);

    // Build pre-filled GitHub New Issue URL (stay comfortably under browser 8 KB URL cap)
    const MAX_URL_BODY_CHARS = 5200;
    let urlBody = markdown;
    let truncatedForUrl = false;
    if (urlBody.length > MAX_URL_BODY_CHARS) {
      truncatedForUrl = true;
      urlBody =
        urlBody.slice(0, MAX_URL_BODY_CHARS) +
        '\n\n---\n*(Diagnostic bundle truncated for URL length — paste the full copied report from ServerForge here.)*';
    }

    const qs = new URLSearchParams({
      title: cleanTitle,
      labels: labels.join(','),
      body: urlBody,
    });
    const githubNewIssueUrl = `https://github.com/${githubRepo}/issues/new?${qs.toString()}`;

    return {
      title: cleanTitle,
      labels,
      markdown,
      githubNewIssueUrl,
      truncatedForUrl,
      hasDirectToken: Boolean(settings.githubIssueToken?.trim()),
      githubRepo,
    };
  }

  async submitBugReportToGitHub(
    input: BugReportInput,
    fetchImpl: typeof fetch = fetch
  ): Promise<BugReportSubmitResult> {
    const settings = this.db.getSettings(this.config.publicHost);
    const token = (settings.githubIssueToken || '').trim();
    if (!token) {
      throw new Error(
        'No GitHub Personal Access Token is configured. Use "Open Pre-Filled GitHub Issue" or save a token in Settings -> Diagnostics & Activity.'
      );
    }

    const preview = await this.buildBugReport(input);
    const apiBase = (process.env.GITHUB_API_BASE_URL || 'https://api.github.com').replace(/\/+$/, '');
    const res = await fetchImpl(`${apiBase}/repos/${preview.githubRepo}/issues`, {
      method: 'POST',
      headers: {
        Accept: 'application/vnd.github+json',
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json',
        'User-Agent': `ServerForge/${this.config.appVersion}`,
      },
      body: JSON.stringify({
        title: preview.title,
        body: preview.markdown,
        labels: preview.labels,
      }),
      signal: AbortSignal.timeout(15_000),
    });

    const data = (await res.json().catch(() => ({}))) as {
      number?: number;
      html_url?: string;
      title?: string;
      message?: string;
    };

    if (!res.ok) {
      throw new Error(
        data.message
          ? `GitHub API rejected the issue (${res.status}): ${data.message}`
          : `GitHub API returned HTTP ${res.status} while submitting bug report.`
      );
    }

    return {
      ok: true,
      issueNumber: Number(data.number ?? 0),
      issueUrl: String(data.html_url ?? ''),
      title: String(data.title ?? preview.title),
    };
  }
}
