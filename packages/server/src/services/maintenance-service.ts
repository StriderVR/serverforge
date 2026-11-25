import { execFile } from 'node:child_process';
import EventEmitter from 'node:events';
import type {
  MaintenanceStatus,
  WindowsRebootEvent,
  WindowsRebootInspection,
  WindowsScheduledRebootTask,
} from '@serverforge/shared';
import type { AppConfig } from '../config.js';
import type { AppDatabase } from '../db/database.js';
import type { ServerOrchestrator } from './orchestrator.js';
import type { UpdaterService } from './updater-service.js';

export type OsRebootExecutor = (reason: string) => Promise<void>;

export class MaintenanceService extends EventEmitter {
  private timer: NodeJS.Timeout | null = null;
  private lastWarnedDateKey: string | null = null;
  private lastExecutedDateKey: string | null = null;
  private deferredUntilMs: number | null = null;
  private lastRebootTriggeredAt: string | null = null;
  private rebooting = false;
  private shutdownHandler: (() => Promise<void>) | null = null;

  constructor(
    private readonly config: AppConfig,
    private readonly db: AppDatabase,
    private readonly orchestrator: ServerOrchestrator,
    private readonly updater: UpdaterService,
    private readonly osRebootExecutor?: OsRebootExecutor
  ) {
    super();
  }

  setShutdownHandler(handler: () => Promise<void>): void {
    this.shutdownHandler = handler;
  }

  start(intervalMs = 60_000): void {
    if (this.timer) return;
    this.timer = setInterval(() => {
      void this.runTick();
    }, intervalMs);
    this.timer.unref?.();
  }

  stop(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  private getDateKey(date: Date): string {
    const y = date.getFullYear();
    const m = String(date.getMonth() + 1).padStart(2, '0');
    const d = String(date.getDate()).padStart(2, '0');
    return `${y}-${m}-${d}`;
  }

  computeNextRebootAt(now = new Date(), dailyRebootTime = '04:00'): Date {
    const [hh, mm] = dailyRebootTime.split(':').map((n) => Number.parseInt(n, 10) || 0);
    const target = new Date(now);
    target.setHours(hh, mm, 0, 0);
    if (target.getTime() <= now.getTime()) {
      target.setDate(target.getDate() + 1);
    }
    return target;
  }

  getStatus(now = new Date()): MaintenanceStatus {
    const settings = this.db.getSettings(this.config.publicHost);
    const nextReboot = settings.dailyRebootEnabled
      ? this.deferredUntilMs && this.deferredUntilMs > now.getTime()
        ? new Date(this.deferredUntilMs)
        : this.computeNextRebootAt(now, settings.dailyRebootTime)
      : null;

    return {
      enabled: settings.dailyRebootEnabled,
      dailyRebootTime: settings.dailyRebootTime,
      nextRebootAt: nextReboot ? nextReboot.toISOString() : null,
      delayIfPlayersOnline: settings.dailyRebootDelayIfPlayersOnline,
      resumePolicy: settings.dailyRebootResumePolicy,
      deferredUntil: this.deferredUntilMs ? new Date(this.deferredUntilMs).toISOString() : null,
      lastRebootTriggeredAt: this.lastRebootTriggeredAt,
    };
  }

  /**
   * Evaluates whether a 10-minute reboot warning or the daily reboot itself should fire.
   * Exposed publicly so tests can drive exact local times deterministically.
   */
  async runTick(now = new Date()): Promise<'idle' | 'warned' | 'deferred' | 'rebooted'> {
    if (this.rebooting) return 'idle';

    const settings = this.db.getSettings(this.config.publicHost);
    if (!settings.dailyRebootEnabled) {
      this.deferredUntilMs = null;
      return 'idle';
    }

    const todayKey = this.getDateKey(now);
    if (this.lastExecutedDateKey === todayKey) {
      return 'idle';
    }

    const [hh, mm] = settings.dailyRebootTime.split(':').map((n) => Number.parseInt(n, 10) || 0);
    const scheduledToday = new Date(now);
    scheduledToday.setHours(hh, mm, 0, 0);

    const effectiveTargetMs = this.deferredUntilMs ?? scheduledToday.getTime();
    const msUntilTarget = effectiveTargetMs - now.getTime();

    // 1. Emit 10-minute heads-up warning once per day
    if (msUntilTarget > 0 && msUntilTarget <= 10 * 60_000 && this.lastWarnedDateKey !== todayKey) {
      this.lastWarnedDateKey = todayKey;
      const mins = Math.max(1, Math.ceil(msUntilTarget / 60_000));
      const msg = `Scheduled daily server PC maintenance reboot in ${mins} minute(s). All active worlds will be saved cleanly before restarting.`;
      this.emit('notice', { kind: 'warning', message: msg });
      return 'warned';
    }

    // 2. Execute within a 15-minute window once the scheduled/deferred time arrives
    if (msUntilTarget <= 0 && msUntilTarget >= -15 * 60_000) {
      if (settings.dailyRebootDelayIfPlayersOnline) {
        const activePlayers = await this.countTotalOnlinePlayers();
        if (activePlayers > 0) {
          this.deferredUntilMs = now.getTime() + 15 * 60_000;
          const msg = `Deferred scheduled daily PC reboot by 15 minutes because ${activePlayers} player(s) are currently online.`;
          this.emit('notice', { kind: 'deferred', message: msg });
          this.db.addAuditLog({
            actor: 'MaintenanceScheduler',
            source: 'system',
            action: 'maintenance.reboot_deferred',
            instanceId: null,
            details: msg,
          });
          return 'deferred';
        }
      }

      this.lastExecutedDateKey = todayKey;
      this.deferredUntilMs = null;
      await this.triggerRebootNow({
        resumeRunningServers: settings.dailyRebootResumePolicy === 'resume_running',
        actor: 'MaintenanceScheduler',
        source: 'system',
        reason: 'Scheduled daily maintenance reboot',
      });
      return 'rebooted';
    }

    return 'idle';
  }

  async countTotalOnlinePlayers(): Promise<number> {
    let total = 0;
    for (const inst of this.orchestrator.listRunningInstances()) {
      const stats = await this.orchestrator.refreshInstanceStats(inst.id);
      if (stats?.playerCount && stats.playerCount > 0) {
        total += stats.playerCount;
      }
    }
    return total;
  }

  async triggerRebootNow(options: {
    resumeRunningServers: boolean;
    actor: string;
    source: 'web' | 'discord' | 'system';
    reason: string;
  }): Promise<{ stoppedServers: number; rememberedServers: number }> {
    if (this.rebooting) {
      throw new Error('A server PC reboot is already in progress.');
    }
    this.rebooting = true;

    try {
      const msg = `Saving all active game servers and rebooting host PC (${options.reason})...`;
      this.emit('notice', { kind: 'rebooting', message: msg });

      const snapshot = this.updater.saveResumeState('reboot', {
        includeRunning: options.resumeRunningServers,
        postRebootNotify: true,
      });

      const stoppedIds = await this.orchestrator.stopAllRunning(options.actor, options.source, options.reason);

      this.lastRebootTriggeredAt = new Date().toISOString();
      this.db.addAuditLog({
        actor: options.actor,
        source: options.source,
        action: 'maintenance.reboot_pc',
        instanceId: null,
        details: `${options.reason} — saved & stopped ${stoppedIds.length} server(s), ${snapshot.servers.length} queued to resume`,
      });

      if (this.osRebootExecutor) {
        await this.osRebootExecutor(options.reason);
      } else {
        setTimeout(() => {
          void this.executeSystemReboot(options.reason);
        }, 500);
      }

      return {
        stoppedServers: stoppedIds.length,
        rememberedServers: snapshot.servers.length,
      };
    } finally {
      this.rebooting = false;
    }
  }

  private async executeSystemReboot(reason: string): Promise<void> {
    try {
      if (this.shutdownHandler) {
        await this.shutdownHandler();
      }
    } catch {
      // Proceed to OS reboot even if close warns
    }

    if (process.platform === 'win32') {
      execFile('shutdown.exe', ['/r', '/t', '5', '/c', `ServerForge: ${reason}`], () => {
        process.exit(0);
      });
    } else {
      execFile('shutdown', ['-r', '+0', `ServerForge: ${reason}`], () => {
        process.exit(0);
      });
    }
  }

  /**
   * Read-only diagnostic inspecting Windows Event Log (Event ID 1074) and
   * Windows Task Scheduler to discover what is currently auto-restarting the PC.
   */
  async inspectWindowsAutoReboots(): Promise<WindowsRebootInspection> {
    if (process.platform !== 'win32') {
      return {
        platform: process.platform,
        supported: false,
        recentRestarts: [],
        scheduledRebootTasks: [],
        notes: [
          'Automatic Windows Event Log & Task Scheduler scanning runs directly on your Windows 11 server PC.',
        ],
      };
    }

    const psScript = `
$events = @()
try {
  $rawEvents = Get-WinEvent -FilterHashtable @{ LogName='System'; Id=1074 } -MaxEvents 6 -ErrorAction SilentlyContinue
  foreach ($e in $rawEvents) {
    $props = $e.Properties
    $events += [PSCustomObject]@{
      timestamp = $e.TimeCreated.ToString('o')
      process = if ($props.Count -gt 0) { [string]$props[0].Value } else { 'Unknown' }
      reason = if ($props.Count -gt 2) { [string]$props[2].Value } else { 'Unknown' }
      message = ($e.Message -replace '\\r?\\n', ' ').Substring(0, [Math]::Min(240, $e.Message.Length))
    }
  }
} catch {}

$tasks = @()
try {
  $allTasks = Get-ScheduledTask -ErrorAction SilentlyContinue | Where-Object { $_.State -ne 'Disabled' }
  foreach ($t in $allTasks) {
    if ($t.TaskName -eq 'ServerForge') { continue }
    $cmdText = ($t.Actions | ForEach-Object { ($_.Execute + ' ' + $_.Arguments).Trim() }) -join ' | '
    if ($cmdText -match '(?i)(shutdown(\\.exe)?\\b.*(/r|-r)|Restart-Computer|\\breboot\\b)') {
      $info = Get-ScheduledTaskInfo -TaskName $t.TaskName -TaskPath $t.TaskPath -ErrorAction SilentlyContinue
      $tasks += [PSCustomObject]@{
        taskPath = $t.TaskPath
        taskName = $t.TaskName
        state = [string]$t.State
        command = $cmdText
        nextRunTime = if ($info -and $info.NextRunTime -and $info.NextRunTime.Year -gt 2000) { $info.NextRunTime.ToString('o') } else { $null }
      }
    }
  }
} catch {}

[PSCustomObject]@{
  recentRestarts = $events
  scheduledRebootTasks = $tasks
} | ConvertTo-Json -Depth 5 -Compress
`;

    return new Promise((resolve) => {
      execFile(
        'powershell.exe',
        ['-NoProfile', '-NonInteractive', '-Command', psScript],
        { timeout: 15_000, windowsHide: true },
        (err, stdout) => {
          if (err || !stdout.trim()) {
            resolve({
              platform: 'win32',
              supported: true,
              recentRestarts: [],
              scheduledRebootTasks: [],
              notes: [
                `Could not query Windows Event Log / Task Scheduler: ${err?.message || 'empty output'}. Try running ServerForge.exe as Administrator.`,
              ],
            });
            return;
          }

          try {
            const parsed = JSON.parse(stdout.trim()) as {
              recentRestarts?: WindowsRebootEvent | WindowsRebootEvent[];
              scheduledRebootTasks?: WindowsScheduledRebootTask | WindowsScheduledRebootTask[];
            };

            const recentRestarts = Array.isArray(parsed.recentRestarts)
              ? parsed.recentRestarts
              : parsed.recentRestarts
                ? [parsed.recentRestarts]
                : [];
            const scheduledRebootTasks = Array.isArray(parsed.scheduledRebootTasks)
              ? parsed.scheduledRebootTasks
              : parsed.scheduledRebootTasks
                ? [parsed.scheduledRebootTasks]
                : [];

            const notes: string[] = [];
            if (scheduledRebootTasks.length > 0) {
              notes.push(
                `Found ${scheduledRebootTasks.length} enabled Windows Scheduled Task(s) that trigger a reboot. You can disable them below before enabling ServerForge's managed daily reboot.`
              );
            } else if (recentRestarts.some((r) => /MoUsoCoreWorker|UsoClient|Windows Update/i.test(`${r.process} ${r.reason} ${r.message}`))) {
              notes.push(
                'Recent restarts appear to come from Windows Update automatic maintenance. Adjust Active Hours or pause auto-restarts in Windows Settings -> Windows Update -> Advanced Options.'
              );
            } else if (recentRestarts.length === 0) {
              notes.push(
                'No clean OS restart events (Event ID 1074) were found. If the PC restarts every morning without a 1074 event, check BIOS/UEFI power schedule or a smart plug.'
              );
            }

            resolve({
              platform: 'win32',
              supported: true,
              recentRestarts,
              scheduledRebootTasks,
              notes,
            });
          } catch (parseErr) {
            resolve({
              platform: 'win32',
              supported: true,
              recentRestarts: [],
              scheduledRebootTasks: [],
              notes: [`Failed to parse Windows inspection output: ${parseErr instanceof Error ? parseErr.message : String(parseErr)}`],
            });
          }
        }
      );
    });
  }

  async disableWindowsScheduledTask(taskPath: string, taskName: string, actor = 'admin'): Promise<void> {
    if (process.platform !== 'win32') {
      throw new Error('Disabling Windows Scheduled Tasks is only supported on Windows.');
    }
    if (!taskName.trim() || taskName.trim().toLowerCase() === 'serverforge') {
      throw new Error('Refusing to disable the ServerForge startup task.');
    }
    const safeName = taskName.replace(/'/g, "''");
    const safePath = (taskPath || '\\').replace(/'/g, "''");

    await new Promise<void>((resolve, reject) => {
      execFile(
        'powershell.exe',
        [
          '-NoProfile',
          '-NonInteractive',
          '-Command',
          `Disable-ScheduledTask -TaskPath '${safePath}' -TaskName '${safeName}' -ErrorAction Stop | Out-Null`,
        ],
        { timeout: 10_000, windowsHide: true },
        (err, _stdout, stderr) => {
          if (err) {
            reject(
              new Error(
                `Failed to disable "${taskName}". Make sure ServerForge.exe is running as Administrator. (${stderr.trim() || err.message})`
              )
            );
          } else {
            resolve();
          }
        }
      );
    });

    this.db.addAuditLog({
      actor,
      source: 'web',
      action: 'maintenance.disable_task',
      instanceId: null,
      details: `Disabled conflicting Windows Scheduled Task ${taskPath}${taskName}`,
    });
  }
}
