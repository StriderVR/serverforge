import { execFile, spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import type { UpdaterStatus } from '@serverforge/shared';
import { isSeaExecutable, WORKSPACE_ROOT, type AppConfig } from '../config.js';
import type { AppDatabase } from '../db/database.js';
import type { ServerOrchestrator } from './orchestrator.js';

export interface ResumeServerEntry {
  instanceId: string;
  name: string;
  temporary: boolean;
  remainingMinutes?: number;
  idleTimeoutMinutes?: number;
  requestedBy?: string;
  requestedById?: string | null;
  source?: 'web' | 'discord';
  channelId?: string | null;
}

export interface ResumeStateSnapshot {
  createdAt: string;
  reason: 'update' | 'reboot';
  postRebootNotify?: boolean;
  servers: ResumeServerEntry[];
}

export type UpdaterProgressCallback = (event: {
  stage: 'downloading' | 'stopping_servers' | 'installing' | 'restarting' | 'error';
  percent: number;
  message: string;
}) => void;

/**
 * Compares two semver strings (ignoring leading 'v').
 * Returns: -1 if a < b, 0 if a === b, 1 if a > b.
 */
export function compareSemver(a: string, b: string): number {
  const parse = (raw: string) => {
    const clean = raw.trim().replace(/^v/i, '').split('-')[0];
    const parts = clean.split('.').map((n) => Number.parseInt(n, 10) || 0);
    return [parts[0] ?? 0, parts[1] ?? 0, parts[2] ?? 0];
  };
  const [aMaj, aMin, aPat] = parse(a);
  const [bMaj, bMin, bPat] = parse(b);
  if (aMaj !== bMaj) return aMaj < bMaj ? -1 : 1;
  if (aMin !== bMin) return aMin < bMin ? -1 : 1;
  if (aPat !== bPat) return aPat < bPat ? -1 : 1;
  return 0;
}

export function buildWindowsSwapScript(params: {
  currentPid: number;
  currentExePath: string;
  newExePath: string;
  backupExePath: string;
  workingDir: string;
  logPath?: string;
}): string {
  const logFile = params.logPath ?? path.join(params.workingDir, 'data', 'updates', 'last-update.log');
  return [
    '@echo off',
    'setlocal enabledelayedexpansion',
    `set "TARGET_PID=${params.currentPid}"`,
    `set "CURRENT_EXE=${params.currentExePath}"`,
    `set "NEW_EXE=${params.newExePath}"`,
    `set "BACKUP_EXE=${params.backupExePath}"`,
    `set "WORK_DIR=${params.workingDir}"`,
    `set "LOG_FILE=${logFile}"`,
    '',
    'echo [%DATE% %TIME%] [swap] Starting ServerForge.exe update swap (old PID=%TARGET_PID%)>> "%LOG_FILE%"',
    '',
    'rem 1. Wait up to 10s for old ServerForge.exe to exit cleanly',
    'set /a WAIT_COUNT=0',
    ':wait_loop',
    'tasklist /FI "PID eq %TARGET_PID%" /NH 2>nul | find /I "%TARGET_PID%" >nul',
    'if errorlevel 1 goto pid_exited',
    'set /a WAIT_COUNT+=1',
    'if %WAIT_COUNT% GEQ 10 (',
    '  echo [%DATE% %TIME%] [swap] Old PID %TARGET_PID% still alive after 10s; force-stopping...>> "%LOG_FILE%"',
    '  taskkill /F /PID %TARGET_PID% >nul 2>&1',
    '  ping -n 2 127.0.0.1 >nul',
    '  goto pid_exited',
    ')',
    'ping -n 2 127.0.0.1 >nul',
    'goto wait_loop',
    '',
    ':pid_exited',
    'echo [%DATE% %TIME%] [swap] Old process exited cleanly.>> "%LOG_FILE%"',
    'if not exist "%NEW_EXE%" (',
    '  echo [%DATE% %TIME%] [swap] FATAL: Staged update missing at %NEW_EXE%>> "%LOG_FILE%"',
    '  exit 1',
    ')',
    '',
    'rem 2. Backup current exe with up to 10 retries (handles Defender / NTFS locks)',
    'set "BACKED_UP=0"',
    'if not exist "%CURRENT_EXE%" goto backup_done',
    'set /a ATTEMPT=0',
    ':backup_retry',
    'set /a ATTEMPT+=1',
    'move /Y "%CURRENT_EXE%" "%BACKUP_EXE%" >nul 2>&1',
    'if not errorlevel 1 (',
    '  set "BACKED_UP=1"',
    '  echo [%DATE% %TIME%] [swap] Backed up old binary to %BACKUP_EXE%>> "%LOG_FILE%"',
    '  goto backup_done',
    ')',
    'echo [%DATE% %TIME%] [swap] Backup move attempt !ATTEMPT! failed; retrying...>> "%LOG_FILE%"',
    'if !ATTEMPT! GEQ 10 (',
    '  echo [%DATE% %TIME%] [swap] FATAL: Could not move %CURRENT_EXE% after 10 attempts>> "%LOG_FILE%"',
    '  exit 1',
    ')',
    'ping -n 2 127.0.0.1 >nul',
    'goto backup_retry',
    ':backup_done',
    '',
    'rem 3. Swap in new exe with retries and rollback on failure',
    'set /a ATTEMPT=0',
    ':swap_retry',
    'set /a ATTEMPT+=1',
    'move /Y "%NEW_EXE%" "%CURRENT_EXE%" >nul 2>&1',
    'if not errorlevel 1 (',
    '  echo [%DATE% %TIME%] [swap] Installed new ServerForge.exe successfully.>> "%LOG_FILE%"',
    '  goto swap_done',
    ')',
    'echo [%DATE% %TIME%] [swap] Install move attempt !ATTEMPT! failed; retrying...>> "%LOG_FILE%"',
    'if !ATTEMPT! GEQ 10 (',
    '  echo [%DATE% %TIME%] [swap] FATAL: Swap failed; rolling back backup...>> "%LOG_FILE%"',
    '  if "%BACKED_UP%"=="1" move /Y "%BACKUP_EXE%" "%CURRENT_EXE%" >nul 2>&1',
    '  exit 1',
    ')',
    'ping -n 2 127.0.0.1 >nul',
    'goto swap_retry',
    ':swap_done',
    '',
    'rem 4. Clear any Mark-of-the-Web zone tag (non-fatal) and relaunch in a fresh console',
    'powershell.exe -NoProfile -Command "Unblock-File -Path \'%CURRENT_EXE%\' -ErrorAction SilentlyContinue" >nul 2>&1',
    'set "NO_OPEN_BROWSER=1"',
    'echo [%DATE% %TIME%] [swap] Launching updated ServerForge.exe...>> "%LOG_FILE%"',
    'start "ServerForge" /D "%WORK_DIR%" "%CURRENT_EXE%"',
    'echo [%DATE% %TIME%] [swap] Relaunch command dispatched.>> "%LOG_FILE%"',
    '(goto) 2>nul & del /F /Q "%~f0" & exit 0',
    '',
  ].join('\r\n');
}

interface GitHubReleaseResponse {
  tag_name?: string;
  name?: string;
  body?: string;
  html_url?: string;
  published_at?: string;
  assets?: Array<{
    name: string;
    browser_download_url: string;
    size: number;
  }>;
}

export class UpdaterService {
  private cachedStatus: { fetchedAt: number; status: UpdaterStatus } | null = null;
  private updating = false;

  constructor(
    private readonly config: AppConfig,
    private readonly db: AppDatabase,
    private readonly orchestrator: ServerOrchestrator,
    private readonly fetchImpl: typeof fetch = fetch
  ) {}

  getResumeStatePath(): string {
    return path.join(this.config.updatesDir, 'resume-state.json');
  }

  getUpdateLogPath(): string {
    return path.join(this.config.updatesDir, 'last-update.log');
  }

  getLastUpdateLog(): string | null {
    const logPath = this.getUpdateLogPath();
    if (!fs.existsSync(logPath)) return null;
    try {
      return fs.readFileSync(logPath, 'utf8');
    } catch {
      return null;
    }
  }

  isUpdating(): boolean {
    return this.updating;
  }

  /**
   * Snapshots all currently running servers (and their active temporary leases)
   * so they can be automatically rebooted after an app update or PC maintenance reboot.
   */
  saveResumeState(
    reason: 'update' | 'reboot',
    options: { includeRunning?: boolean; postRebootNotify?: boolean } = {}
  ): ResumeStateSnapshot {
    const includeRunning = options.includeRunning ?? true;
    const servers: ResumeServerEntry[] = [];

    if (includeRunning) {
      const nowMs = Date.now();
      for (const inst of this.orchestrator.listRunningInstances()) {
        const lease = inst.activeLease;
        const remainingMinutes = lease
          ? Math.max(15, Math.ceil((new Date(lease.expiresAt).getTime() - nowMs) / 60_000))
          : undefined;
        servers.push({
          instanceId: inst.id,
          name: inst.name,
          temporary: Boolean(lease),
          remainingMinutes,
          idleTimeoutMinutes: lease?.idleTimeoutMinutes,
          requestedBy: lease?.requestedBy,
          requestedById: lease?.requestedById,
          source: lease?.source,
          channelId: lease?.channelId,
        });
      }
    }

    const snapshot: ResumeStateSnapshot = {
      createdAt: new Date().toISOString(),
      reason,
      postRebootNotify: options.postRebootNotify ?? false,
      servers,
    };

    fs.mkdirSync(this.config.updatesDir, { recursive: true });
    fs.writeFileSync(this.getResumeStatePath(), JSON.stringify(snapshot, null, 2), 'utf8');
    return snapshot;
  }

  /**
   * Called once during ServerForge startup. Restores any servers remembered in
   * data/updates/resume-state.json and removes the file.
   */
  async resumeServersOnStartup(): Promise<{
    resumedIds: string[];
    postRebootNotify: boolean;
    reason: 'update' | 'reboot' | null;
  }> {
    const statePath = this.getResumeStatePath();
    if (!fs.existsSync(statePath)) {
      return { resumedIds: [], postRebootNotify: false, reason: null };
    }

    let snapshot: ResumeStateSnapshot;
    try {
      snapshot = JSON.parse(fs.readFileSync(statePath, 'utf8')) as ResumeStateSnapshot;
    } catch {
      fs.rmSync(statePath, { force: true });
      return { resumedIds: [], postRebootNotify: false, reason: null };
    }

    fs.rmSync(statePath, { force: true });

    const resumedIds: string[] = [];
    for (const entry of snapshot.servers) {
      try {
        const inst = this.orchestrator.getInstance(entry.instanceId);
        if (!inst || inst.status === 'running') continue;

        await this.orchestrator.startInstance(inst.id, {
          temporary: entry.temporary,
          durationMinutes: entry.remainingMinutes,
          idleTimeoutMinutes: entry.idleTimeoutMinutes,
          requestedBy: entry.requestedBy || 'ResumeAfterRestart',
          requestedById: entry.requestedById ?? undefined,
          source: entry.source ?? 'web',
          channelId: entry.channelId ?? undefined,
        });
        resumedIds.push(inst.id);
      } catch (err) {
        console.error(`[Updater] Failed to auto-resume server ${entry.name}:`, err);
      }
    }

    if (resumedIds.length > 0) {
      this.db.addAuditLog({
        actor: 'System',
        source: 'system',
        action: snapshot.reason === 'update' ? 'updater.resume_servers' : 'maintenance.resume_servers',
        instanceId: null,
        details: `Automatically rebooted ${resumedIds.length} server(s) after ${snapshot.reason}`,
      });
    }

    return {
      resumedIds,
      postRebootNotify: Boolean(snapshot.postRebootNotify),
      reason: snapshot.reason,
    };
  }

  async checkForUpdates(forceRefresh = false): Promise<UpdaterStatus> {
    const settings = this.db.getSettings(this.config.publicHost);
    const repo = (settings.githubRepo || 'StriderVR/serverforge').trim();
    const installMode: 'exe' | 'source' = isSeaExecutable() ? 'exe' : 'source';
    const runningServers = this.orchestrator.listRunningInstances().map((i) => ({
      id: i.id,
      name: i.name,
      runtime: i.runtime,
    }));

    if (
      !forceRefresh &&
      this.cachedStatus &&
      Date.now() - this.cachedStatus.fetchedAt < 5 * 60_000 &&
      this.cachedStatus.status.githubRepo === repo
    ) {
      return { ...this.cachedStatus.status, runningServers };
    }

    try {
      const apiBase = (process.env.UPDATER_API_BASE_URL || 'https://api.github.com').replace(/\/+$/, '');
      const res = await this.fetchImpl(`${apiBase}/repos/${repo}/releases/latest`, {
        headers: {
          Accept: 'application/vnd.github+json',
          'User-Agent': `ServerForge/${this.config.appVersion}`,
        },
        signal: AbortSignal.timeout(10_000),
      });

      if (!res.ok) {
        throw new Error(`GitHub Releases API returned HTTP ${res.status}`);
      }

      const data = (await res.json()) as GitHubReleaseResponse;
      const latestVersion = (data.tag_name || '').replace(/^v/i, '') || null;
      const exeAsset = (data.assets ?? []).find((a) => a.name.toLowerCase() === 'serverforge.exe');
      const updateAvailable = latestVersion
        ? compareSemver(this.config.appVersion, latestVersion) < 0
        : false;

      const status: UpdaterStatus = {
        currentVersion: this.config.appVersion,
        latestVersion,
        updateAvailable,
        releaseName: data.name || data.tag_name || null,
        releaseNotes: data.body || null,
        releaseUrl: data.html_url || null,
        publishedAt: data.published_at || null,
        exeDownloadUrl: exeAsset?.browser_download_url || null,
        exeSizeBytes: exeAsset?.size ?? null,
        installMode,
        githubRepo: repo,
        runningServers,
        error: null,
      };

      this.cachedStatus = { fetchedAt: Date.now(), status };
      return status;
    } catch (err) {
      return {
        currentVersion: this.config.appVersion,
        latestVersion: null,
        updateAvailable: false,
        releaseName: null,
        releaseNotes: null,
        releaseUrl: null,
        publishedAt: null,
        exeDownloadUrl: null,
        exeSizeBytes: null,
        installMode,
        githubRepo: repo,
        runningServers,
        error: err instanceof Error ? err.message : 'Failed to check GitHub for updates',
      };
    }
  }

  async applyUpdate(options: {
    resumeRunningServers?: boolean;
    actor?: string;
    onProgress?: UpdaterProgressCallback;
    onShutdownRequested: () => Promise<void>;
    dryRun?: boolean;
  }): Promise<{ targetVersion: string; rememberedServers: number; mode: 'exe' | 'source' }> {
    if (this.updating) {
      throw new Error('An update is already in progress.');
    }
    this.updating = true;

    const logPath = this.getUpdateLogPath();
    fs.mkdirSync(this.config.updatesDir, { recursive: true });
    const appendLog = (msg: string) => {
      try {
        fs.appendFileSync(logPath, `[${new Date().toISOString()}] ${msg}\n`, 'utf8');
      } catch {
        // ignore log write failures
      }
    };
    fs.writeFileSync(logPath, `[${new Date().toISOString()}] Update triggered by ${options.actor || 'admin'}\n`, 'utf8');

    const report = (
      stage: 'downloading' | 'stopping_servers' | 'installing' | 'restarting' | 'error',
      percent: number,
      message: string
    ) => {
      appendLog(`[${stage} ${percent}%] ${message}`);
      options.onProgress?.({ stage, percent, message });
    };

    try {
      const status = await this.checkForUpdates(true);
      if (status.error) {
        throw new Error(status.error);
      }
      if (!status.latestVersion) {
        throw new Error('No GitHub Release found to update to.');
      }

      const resumeRunning = options.resumeRunningServers ?? true;

      if (status.installMode === 'exe') {
        if (!status.exeDownloadUrl) {
          throw new Error(`Release v${status.latestVersion} does not include a ServerForge.exe asset.`);
        }

        // 1. Download new ServerForge.exe first (before touching any running game servers!)
        report('downloading', 5, `Downloading ServerForge v${status.latestVersion}...`);
        const newExePath = path.join(this.config.updatesDir, 'ServerForge.new.exe');
        await this.downloadFile(status.exeDownloadUrl, newExePath, status.exeSizeBytes, (pct) => {
          report('downloading', Math.min(70, Math.round(pct * 0.7)), `Downloading ServerForge.exe (${pct}%)...`);
        });

        // 2. Snapshot & gracefully save/stop all running game servers
        report('stopping_servers', 75, 'Saving worlds & stopping active game servers...');
        const snapshot = this.saveResumeState('update', { includeRunning: resumeRunning });
        await this.orchestrator.stopAllRunning(
          options.actor || 'admin',
          'system',
          `Updating ServerForge to v${status.latestVersion}`
        );

        // 3. Prepare pure CMD atomic Windows EXE swap script (independent console session)
        report('installing', 90, 'Preparing ServerForge.exe swap & relaunch...');
        const currentExePath = process.execPath;
        const backupExePath = `${currentExePath}.bak`;
        const swapScriptPath = path.join(this.config.updatesDir, 'apply-update.cmd');
        const scriptContent = buildWindowsSwapScript({
          currentPid: process.pid,
          currentExePath,
          newExePath,
          backupExePath,
          workingDir: WORKSPACE_ROOT,
          logPath,
        });
        fs.writeFileSync(swapScriptPath, scriptContent, 'utf8');

        this.db.addAuditLog({
          actor: options.actor || 'admin',
          source: 'web',
          action: 'updater.apply',
          instanceId: null,
          details: `Updating ServerForge ${this.config.appVersion} -> ${status.latestVersion} (${snapshot.servers.length} server(s) queued to auto-resume)`,
        });

        report('restarting', 100, `Restarting into ServerForge v${status.latestVersion}...`);

        if (!options.dryRun) {
          setTimeout(() => {
            // `cmd.exe /d /c start "ServerForge Updater" /min cmd.exe /d /c ""path""`
            // creates a truly independent console process tree on Windows (even when the
            // install folder contains spaces) so the swap script survives ServerForge.exe exiting.
            let shutdownTriggered = false;
            const triggerShutdown = () => {
              if (shutdownTriggered) return;
              shutdownTriggered = true;
              void options.onShutdownRequested();
            };

            try {
              const launcher = spawn(
                'cmd.exe',
                ['/d', '/c', `start "ServerForge Updater" /min cmd.exe /d /c ""${swapScriptPath}""`],
                {
                  windowsVerbatimArguments: true,
                  windowsHide: false,
                  stdio: 'ignore',
                }
              );
              launcher.once('error', (err) => {
                appendLog(`[error] Failed to launch apply-update.cmd: ${err.message}`);
                triggerShutdown();
              });
              launcher.once('close', (code) => {
                appendLog(
                  `[restarting] Launched independent updater window (exit=${code ?? 'null'}); exiting old ServerForge.exe...`
                );
                triggerShutdown();
              });
            } catch (err) {
              appendLog(
                `[error] Exception launching apply-update.cmd: ${err instanceof Error ? err.message : String(err)}`
              );
              triggerShutdown();
            }

            setTimeout(() => {
              if (!shutdownTriggered) {
                appendLog('[restarting] Launcher wait fallback reached; exiting old ServerForge.exe...');
                triggerShutdown();
              }
            }, 3000).unref?.();
          }, 300);
        }

        return {
          targetVersion: status.latestVersion,
          rememberedServers: snapshot.servers.length,
          mode: 'exe',
        };
      }

      // Source install mode: snapshot -> stop -> git pull + pnpm install + pnpm build
      report('stopping_servers', 15, 'Saving worlds & stopping active game servers...');
      const snapshot = this.saveResumeState('update', { includeRunning: resumeRunning });
      await this.orchestrator.stopAllRunning(
        options.actor || 'admin',
        'system',
        `Updating ServerForge to v${status.latestVersion}`
      );

      if (!options.dryRun) {
        report('installing', 45, 'Pulling latest changes from GitHub & rebuilding...');
        await this.runExec('git', ['fetch', '--tags'], WORKSPACE_ROOT);
        await this.runExec('git', ['pull', '--ff-only'], WORKSPACE_ROOT);
        report('installing', 70, 'Installing dependencies & compiling...');
        await this.runExec(process.platform === 'win32' ? 'pnpm.cmd' : 'pnpm', ['install'], WORKSPACE_ROOT);
        await this.runExec(process.platform === 'win32' ? 'pnpm.cmd' : 'pnpm', ['build'], WORKSPACE_ROOT);
      }

      this.db.addAuditLog({
        actor: options.actor || 'admin',
        source: 'web',
        action: 'updater.apply',
        instanceId: null,
        details: `Updated source install to v${status.latestVersion} (${snapshot.servers.length} server(s) queued to auto-resume)`,
      });

      report('restarting', 100, `Update to v${status.latestVersion} complete. Restarting...`);
      if (!options.dryRun) {
        setTimeout(() => {
          void options.onShutdownRequested();
        }, 300);
      }

      return {
        targetVersion: status.latestVersion,
        rememberedServers: snapshot.servers.length,
        mode: 'source',
      };
    } catch (err) {
      report('error', 0, err instanceof Error ? err.message : 'Update failed');
      throw err;
    } finally {
      this.updating = false;
    }
  }

  private async downloadFile(
    url: string,
    destPath: string,
    expectedSize: number | null,
    onPercent: (pct: number) => void
  ): Promise<void> {
    const res = await this.fetchImpl(url, {
      headers: { 'User-Agent': `ServerForge/${this.config.appVersion}` },
      redirect: 'follow',
      signal: AbortSignal.timeout(300_000),
    });
    if (!res.ok || !res.body) {
      throw new Error(`Failed to download update asset (HTTP ${res.status})`);
    }

    const total = expectedSize || Number(res.headers.get('content-length')) || 0;
    const out = fs.createWriteStream(destPath);
    let downloaded = 0;
    let lastPct = -1;

    try {
      const reader = res.body.getReader();
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        if (value) {
          const ok = out.write(Buffer.from(value));
          if (!ok) {
            await new Promise<void>((resolve) => out.once('drain', resolve));
          }
          downloaded += value.byteLength;
          if (total > 0) {
            const pct = Math.min(100, Math.round((downloaded / total) * 100));
            if (pct !== lastPct && pct % 5 === 0) {
              lastPct = pct;
              onPercent(pct);
            }
          }
        }
      }
      await new Promise<void>((resolve, reject) => {
        out.end(() => resolve());
        out.on('error', reject);
      });
    } catch (err) {
      out.destroy();
      fs.rmSync(destPath, { force: true });
      throw err;
    }

    if (downloaded === 0 || (expectedSize && downloaded !== expectedSize)) {
      fs.rmSync(destPath, { force: true });
      throw new Error(
        `Downloaded update file size mismatch (got ${downloaded} bytes, expected ${expectedSize ?? '>0'}).`
      );
    }
  }

  private runExec(cmd: string, args: string[], cwd: string): Promise<void> {
    return new Promise((resolve, reject) => {
      execFile(cmd, args, { cwd }, (err, _stdout, stderr) => {
        if (err) reject(new Error(`${cmd} ${args.join(' ')} failed: ${stderr || err.message}`));
        else resolve();
      });
    });
  }
}
