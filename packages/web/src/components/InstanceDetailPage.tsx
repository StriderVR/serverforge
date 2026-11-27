import React, { useEffect, useMemo, useRef, useState } from 'react';
import {
  AlertTriangle,
  Archive,
  ArrowLeft,
  ArrowUpCircle,
  Bug,
  Check,
  ChevronDown,
  ChevronUp,
  Clock,
  Copy,
  Download,
  Filter,
  Loader2,
  Pause,
  Play,
  RotateCcw,
  RotateCw,
  Save,
  Send,
  Square,
  Timer,
  Trash2,
} from 'lucide-react';
import type {
  BackupPolicy,
  GameTemplate,
  HostMetrics,
  InstanceUpdateCheckResult,
  RuntimeKind,
} from '@serverforge/shared';
import { api, formatHostSourceLabel, formatRemaining, type InstanceDetail, type InstanceWithJoin } from '../api';
import { copyTextToClipboard } from '../utils/clipboard';
import type { ConfirmDialogOptions } from './ConfirmModal';
import { FilesTab } from './instance/FilesTab';
import { MinecraftPropertiesTab } from './instance/MinecraftPropertiesTab';
import { ModsPluginsTab } from './instance/ModsPluginsTab';
import { NetworkTab } from './instance/NetworkTab';
import type { PushToastFn } from './ToastStack';

export type InstanceTabId = 'console' | 'network' | 'config' | 'files' | 'properties' | 'mods' | 'backups';

interface InstanceDetailPageProps {
  instanceId: string;
  instanceSummary?: InstanceWithJoin | null;
  catalog: GameTemplate[];
  metrics: HostMetrics | null;
  liveLogs: Array<{ timestamp: string; line: string }>;
  activeTab?: InstanceTabId;
  onTabChange?: (tab: InstanceTabId) => void;
  autoBoot?: boolean;
  onAutoBootConsumed?: () => void;
  onBack: () => void;
  onDeleted: () => void;
  onGlobalRefresh: () => void;
  onReportBug?: (ctx: { instanceId: string; title: string; description: string }) => void;
  onConfirm?: (opts: ConfirmDialogOptions) => Promise<boolean>;
  onToast?: PushToastFn;
}

const PROGRESS_LINE_RE = /\[(?:Download|Java)\][^\n]*?(\d{1,3})%/;
const PHASE_AFTER_DOWNLOAD_RE = /Extracting|Launching|Starting|Prepared|installed successfully/i;
const CONSOLE_ERROR_RE =
  /(\[error\]|\/error\]|fatal|exception|unrecognized vm option|could not create the java virtual machine|crash|failed to |err_|segfault|outofmemoryerror|exited unexpectedly)/i;
const CONSOLE_WARN_RE = /(\[warn(?:ing)?\]|\/warn\]|warning:|deprecated|retrying|watchdog)/i;

function classifyConsoleLine(line: string): 'error' | 'warn' | 'normal' {
  if (CONSOLE_ERROR_RE.test(line)) return 'error';
  if (CONSOLE_WARN_RE.test(line)) return 'warn';
  return 'normal';
}

function extractActiveDownloadPercent(logs: Array<{ timestamp: string; line: string }>): number | null {
  for (let i = logs.length - 1; i >= 0; i--) {
    const line = logs[i].line;
    const match = line.match(PROGRESS_LINE_RE);
    if (match) {
      const pct = Number(match[1]);
      if (Number.isFinite(pct) && pct >= 0 && pct <= 100) {
        return pct;
      }
    }
    // If extraction or launch has already started after a download, switch back to indeterminate bar
    if (PHASE_AFTER_DOWNLOAD_RE.test(line)) {
      return null;
    }
  }
  return null;
}

const DEFAULT_BACKUP_POLICY: BackupPolicy = {
  enabled: false,
  scheduleMode: 'daily',
  intervalHours: 6,
  dailyTime: '03:00',
  onlyWhenRunning: true,
  maxCount: 10,
  maxTotalGb: 0,
  lastAutoBackupAt: null,
};

export function InstanceDetailPage({
  instanceId,
  instanceSummary,
  catalog,
  metrics,
  liveLogs,
  activeTab,
  onTabChange,
  autoBoot = false,
  onAutoBootConsumed,
  onBack,
  onDeleted,
  onGlobalRefresh,
  onReportBug,
  onConfirm,
  onToast,
}: InstanceDetailPageProps) {
  const [detail, setDetail] = useState<InstanceDetail | null>(null);
  const [internalTab, setInternalTab] = useState<InstanceTabId>(activeTab ?? 'console');
  const tab = activeTab ?? internalTab;
  const setTab = (next: InstanceTabId) => {
    setInternalTab(next);
    onTabChange?.(next);
  };
  const [command, setCommand] = useState('');
  const [backupNote, setBackupNote] = useState('');
  const [editConfig, setEditConfig] = useState<Record<string, string | number | boolean>>({});
  const [editPorts, setEditPorts] = useState<Record<string, number>>({});
  const [editMemoryGb, setEditMemoryGb] = useState(4);
  const [editRuntime, setEditRuntime] = useState<RuntimeKind>('native');
  const [editAutoStart, setEditAutoStart] = useState(false);
  const [editAutoRestartOnCrash, setEditAutoRestartOnCrash] = useState(true);
  const [editDiscord, setEditDiscord] = useState(true);
  const [editLaunchScript, setEditLaunchScript] = useState('');
  const [editBackupPolicy, setEditBackupPolicy] = useState<BackupPolicy>(DEFAULT_BACKUP_POLICY);
  const [busy, setBusy] = useState(false);
  const [copied, setCopied] = useState(false);
  const [copiedLan, setCopiedLan] = useState(false);
  const [copiedConsole, setCopiedConsole] = useState(false);
  const [copiedDebugReport, setCopiedDebugReport] = useState(false);
  const [copiedErrorText, setCopiedErrorText] = useState(false);
  const [consoleSearch, setConsoleSearch] = useState('');
  const [consoleErrorsOnly, setConsoleErrorsOnly] = useState(false);
  const [autoScroll, setAutoScroll] = useState(true);
  const [showCrashTail, setShowCrashTail] = useState(false);
  const [message, setMessage] = useState<{ kind: 'error' | 'success'; text: string } | null>(null);
  const [updateCheck, setUpdateCheck] = useState<InstanceUpdateCheckResult | null>(null);
  const [showUpdatePanel, setShowUpdatePanel] = useState(false);
  const [updateBackup, setUpdateBackup] = useState(true);
  const [updateRestart, setUpdateRestart] = useState(true);
  const [updateTargetVersion, setUpdateTargetVersion] = useState('');
  const [updatingServer, setUpdatingServer] = useState(false);
  const logEndRef = useRef<HTMLDivElement | null>(null);
  const autoBootTriggeredRef = useRef(false);

  const loadDetail = async (syncForm = true) => {
    try {
      const data = await api.getInstance(instanceId);
      setDetail(data);
      if (syncForm) {
        setEditConfig(data.config);
        const mergedPorts: Record<string, number> = {};
        const tpl = catalog.find((t) => t.id === data.gameId);
        for (const p of tpl?.ports ?? []) {
          mergedPorts[p.key] = data.ports[p.key] ?? p.defaultPort;
        }
        for (const [k, v] of Object.entries(data.ports)) {
          mergedPorts[k] = v;
        }
        setEditPorts(mergedPorts);
        setEditMemoryGb(Math.round(data.memoryLimitMb / 1024));
        setEditRuntime(data.runtime);
        setEditAutoStart(data.autoStart);
        setEditAutoRestartOnCrash(data.autoRestartOnCrash !== false);
        setEditDiscord(data.discordEnabled);
        setEditLaunchScript(data.launchScript ?? '');
        setEditBackupPolicy(data.backupPolicy ?? DEFAULT_BACKUP_POLICY);
      }
    } catch (err) {
      if (syncForm) {
        setMessage({ kind: 'error', text: err instanceof Error ? err.message : 'Failed to load server' });
      }
    }
  };

  useEffect(() => {
    autoBootTriggeredRef.current = false;
    setShowUpdatePanel(false);
    setUpdateCheck(null);
    void api
      .checkInstanceUpdate(instanceId)
      .then((res) => {
        setUpdateCheck(res);
        if (res.latestVersionId) setUpdateTargetVersion(res.latestVersionId);
      })
      .catch(() => {});
    setShowCrashTail(false);
    void loadDetail(true);
  }, [instanceId]);

  // Keep status, lastError, lastCrash, activeLease, and stats live as WebSocket broadcasts instance updates
  useEffect(() => {
    if (!instanceSummary) return;
    setDetail((prev) =>
      prev && prev.id === instanceSummary.id
        ? {
            ...prev,
            status: instanceSummary.status,
            lastError: instanceSummary.lastError,
            lastCrash: instanceSummary.lastCrash ?? null,
            activeLease: instanceSummary.activeLease,
            stats: instanceSummary.stats,
            joinAddress: instanceSummary.joinAddress,
            localJoinAddress: instanceSummary.localJoinAddress,
            publicHostSource: instanceSummary.publicHostSource,
          }
        : prev
    );
  }, [
    instanceSummary?.id,
    instanceSummary?.status,
    instanceSummary?.lastError,
    instanceSummary?.lastCrash?.crashedAt,
    instanceSummary?.lastCrash?.attemptCount,
    instanceSummary?.lastCrash?.halted,
    instanceSummary?.lastCrash?.nextRestartAt,
    instanceSummary?.activeLease?.expiresAt,
    instanceSummary?.joinAddress,
    instanceSummary?.localJoinAddress,
    instanceSummary?.publicHostSource,
  ]);

  const isStatusTransition =
    detail?.status === 'installing' || detail?.status === 'starting' || detail?.status === 'stopping';
  const isActiveTransition = busy || isStatusTransition;

  // Poll server details & persisted logs during active installs/starts/stops as a fallback if WS stalls
  useEffect(() => {
    if (!isActiveTransition) return;
    const timer = setInterval(() => {
      void loadDetail(false);
    }, 2500);
    return () => clearInterval(timer);
  }, [isActiveTransition, instanceId]);

  const combinedLogs = useMemo(() => {
    if (!detail) return liveLogs;
    if (liveLogs.length === 0) return detail.logs;
    const seenCounts = new Map<string, number>();
    for (const entry of detail.logs) {
      const key = `${entry.timestamp}\0${entry.line}`;
      seenCounts.set(key, (seenCounts.get(key) ?? 0) + 1);
    }
    const merged = [...detail.logs];
    for (const entry of liveLogs) {
      const key = `${entry.timestamp}\0${entry.line}`;
      const remaining = seenCounts.get(key) ?? 0;
      if (remaining > 0) {
        seenCounts.set(key, remaining - 1);
      } else {
        merged.push(entry);
      }
    }
    return merged;
  }, [detail?.logs, liveLogs]);

  const errorWarnCount = useMemo(
    () => combinedLogs.filter((entry) => classifyConsoleLine(entry.line) !== 'normal').length,
    [combinedLogs]
  );

  const visibleLogs = useMemo(() => {
    const q = consoleSearch.trim().toLowerCase();
    return combinedLogs.filter((entry) => {
      if (consoleErrorsOnly && classifyConsoleLine(entry.line) === 'normal') return false;
      if (q && !entry.line.toLowerCase().includes(q)) return false;
      return true;
    });
  }, [combinedLogs, consoleErrorsOnly, consoleSearch]);

  const activeDownloadPercent = useMemo(
    () => (isActiveTransition ? extractActiveDownloadPercent(combinedLogs) : null),
    [isActiveTransition, combinedLogs]
  );

  const latestLogLine = combinedLogs.length > 0 ? combinedLogs[combinedLogs.length - 1].line : null;

  useEffect(() => {
    if (tab === 'console' && autoScroll) {
      logEndRef.current?.scrollIntoView({ behavior: 'smooth' });
    }
  }, [visibleLogs.length, tab, autoScroll]);

  const handleCopyDebugReport = async () => {
    if (!detail) return;
    try {
      const report = await api.getInstanceDebugReport(detail.id);
      const ok = await copyTextToClipboard(report.markdown);
      if (ok) {
        setCopiedDebugReport(true);
        setTimeout(() => setCopiedDebugReport(false), 2000);
      }
    } catch (err) {
      setMessage({ kind: 'error', text: err instanceof Error ? err.message : 'Failed to generate debug report' });
    }
  };

  const handleCopyConsole = async () => {
    const source = visibleLogs.length > 0 ? visibleLogs : combinedLogs;
    const text = source.map((e) => `[${e.timestamp}] ${e.line}`).join('\n');
    if (!text) return;
    const ok = await copyTextToClipboard(text);
    if (ok) {
      setCopiedConsole(true);
      setTimeout(() => setCopiedConsole(false), 2000);
    }
  };

  const handleCopyErrorText = async (text: string) => {
    const ok = await copyTextToClipboard(text);
    if (ok) {
      setCopiedErrorText(true);
      setTimeout(() => setCopiedErrorText(false), 1800);
    }
  };

  const runAction = async (fn: () => Promise<unknown>, successMsg?: string): Promise<boolean> => {
    setMessage(null);
    setBusy(true);
    try {
      await fn();
      if (successMsg) setMessage({ kind: 'success', text: successMsg });
      await loadDetail(true);
      onGlobalRefresh();
      return true;
    } catch (err) {
      setMessage({ kind: 'error', text: err instanceof Error ? err.message : 'Operation failed' });
      await loadDetail(true);
      return false;
    } finally {
      setBusy(false);
    }
  };

  useEffect(() => {
    if (!autoBoot || autoBootTriggeredRef.current || !detail) return;
    if (detail.status === 'stopped') {
      autoBootTriggeredRef.current = true;
      onAutoBootConsumed?.();
      void runAction(() => api.startInstance(detail.id, { temporary: false }), 'Server started.');
    }
  }, [autoBoot, detail?.id, detail?.status]);

  if (!detail) {
    return (
      <div className="panel panel-body">
        <button className="btn btn-ghost btn-sm" onClick={onBack}>
          <ArrowLeft size={14} /> Back to Fleet
        </button>
        <p style={{ marginTop: 14, color: 'var(--text-secondary)', display: 'flex', alignItems: 'center', gap: 8 }}>
          <Loader2 size={15} className="spin" /> Loading instance details...
        </p>
      </div>
    );
  }

  const template = catalog.find((t) => t.id === detail.gameId);
  const isRunning = detail.status === 'running';
  const isStopped = detail.status === 'stopped' || detail.status === 'error';

  const activityTitle =
    detail.status === 'stopping'
      ? 'Saving world & stopping server...'
      : detail.status === 'starting'
        ? 'Starting game server process...'
        : detail.status === 'installing'
          ? 'Installing server & downloading files...'
          : 'Preparing server setup...';

  const handleSendCommand = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!command.trim()) return;
    const cmd = command.trim();
    setCommand('');
    await runAction(() => api.sendCommand(detail.id, cmd));
  };

  const handleDelete = async () => {
    const prompt = detail.externalDir
      ? `Unlink "${detail.name}" from ServerForge? Your original server files in ${detail.externalDir} will NOT be deleted.`
      : `Permanently delete "${detail.name}" and its ServerForge-managed server files?`;
    const confirmed = onConfirm
      ? await onConfirm({
          title: detail.externalDir ? 'Unlink Server?' : 'Delete Server?',
          message: prompt,
          confirmLabel: detail.externalDir ? 'Unlink Server' : 'Delete Permanently',
          tone: 'danger',
        })
      : window.confirm(prompt);
    if (!confirmed) return;
    setBusy(true);
    try {
      await api.deleteInstance(detail.id);
      onGlobalRefresh();
      onDeleted();
    } catch (err) {
      setMessage({ kind: 'error', text: err instanceof Error ? err.message : 'Delete failed' });
      setBusy(false);
    }
  };

  return (
    <div>
      <div style={{ marginBottom: 14 }}>
        <button className="btn btn-ghost btn-sm" onClick={onBack}>
          <ArrowLeft size={14} /> Back to Fleet
        </button>
      </div>

      <header className="page-header">
        <div>
          <div style={{ display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap' }}>
            <h1>{detail.name}</h1>
            <span className={`badge badge-${detail.status}`}>
              {isStatusTransition ? <Loader2 size={11} className="spin" /> : <span className="badge-dot" />}
              {detail.status.toUpperCase()}
            </span>
            {detail.activeLease && (
              <span className="badge badge-lease tabular">
                <Clock size={11} />
                Temp lease: {formatRemaining(detail.activeLease.expiresAt)} left (by {detail.activeLease.requestedBy})
              </span>
            )}
          </div>
          <p className="page-subtitle">
            {template?.name ?? detail.gameId} • Runtime: <span className="mono">{detail.runtime}</span> • Slug:{' '}
            <span className="mono">{detail.slug}</span>
            {detail.externalDir && (
              <>
                {' '}
                • Linked Folder: <span className="mono">{detail.externalDir}</span>
              </>
            )}
          </p>
        </div>

        <div className="btn-row">
          {isStopped ? (
            <>
              <button
                className="btn btn-success"
                disabled={busy}
                onClick={() => runAction(() => api.startInstance(detail.id, { temporary: false }), 'Server started.')}
              >
                {busy ? <Loader2 size={14} className="spin" /> : <Play size={14} />}
                {busy ? 'Starting...' : 'Start'}
              </button>
              <button
                className="btn"
                disabled={busy}
                onClick={() =>
                  runAction(
                    () => api.startInstance(detail.id, { temporary: true, durationMinutes: 180 }),
                    'Temporary 3h session started.'
                  )
                }
              >
                <Timer size={14} /> Temp Boot (3h)
              </button>
            </>
          ) : (
            <>
              <button
                className="btn btn-danger"
                disabled={busy || isStatusTransition}
                onClick={() => runAction(() => api.stopInstance(detail.id), 'World saved & server stopped.')}
              >
                {isActiveTransition ? <Loader2 size={14} className="spin" /> : <Square size={14} />}
                {detail.status === 'installing'
                  ? 'Installing...'
                  : detail.status === 'starting'
                    ? 'Starting...'
                    : detail.status === 'stopping'
                      ? 'Stopping...'
                      : 'Save & Stop'}
              </button>
              <button
                className="btn"
                disabled={busy || isStatusTransition}
                onClick={() => runAction(() => api.restartInstance(detail.id), 'Server restarted.')}
              >
                <RotateCw size={14} /> Restart
              </button>
            </>
          )}
          {updateCheck?.supported && (
            <button
              type="button"
              className={`btn ${updateCheck.updateAvailable ? 'btn-primary' : ''}`}
              disabled={busy || updatingServer || isStatusTransition}
              onClick={() => setShowUpdatePanel((v) => !v)}
            >
              <ArrowUpCircle size={14} />
              {updatingServer
                ? 'Updating...'
                : updateCheck.updateAvailable
                  ? 'Update Available'
                  : 'Update Server'}
            </button>
          )}
        </div>
      </header>

      {showUpdatePanel && updateCheck?.supported && (
        <section className="panel" style={{ marginBottom: 18 }}>
          <div className="panel-header">
            <h2 style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
              <ArrowUpCircle size={16} />
              {updateCheck.kind === 'steamcmd'
                ? 'Update Game Server via SteamCMD'
                : updateCheck.kind === 'curseforge'
                  ? 'Upgrade CurseForge Modpack'
                  : 'Upgrade Modrinth Modpack'}
            </h2>
            <button type="button" className="btn btn-sm" onClick={() => setShowUpdatePanel(false)}>
              Close
            </button>
          </div>
          <div className="panel-body">
            <p style={{ marginTop: 0, fontSize: 13, color: 'var(--text-secondary)' }}>{updateCheck.message}</p>

            {updateCheck.availableVersions.length > 0 && (
              <div className="field" style={{ marginBottom: 12, maxWidth: 440 }}>
                <label htmlFor="update-target-version">Target Version</label>
                <select
                  id="update-target-version"
                  className="select"
                  value={updateTargetVersion}
                  onChange={(e) => setUpdateTargetVersion(e.target.value)}
                >
                  {updateCheck.availableVersions.map((ver) => (
                    <option key={ver.id} value={ver.id}>
                      {ver.label} {ver.gameVersions[0] ? `(${ver.gameVersions[0]})` : ''}
                      {ver.id === updateCheck.currentVersionId ? ' — Current' : ''}
                    </option>
                  ))}
                </select>
              </div>
            )}

            <div style={{ display: 'flex', flexDirection: 'column', gap: 8, marginBottom: 14 }}>
              <label className="checkbox-row">
                <input
                  type="checkbox"
                  checked={updateBackup}
                  onChange={(e) => setUpdateBackup(e.target.checked)}
                />
                <span>Create automatic pre-update safety backup before modifying server files (Recommended)</span>
              </label>
              {!isStopped && (
                <label className="checkbox-row">
                  <input
                    type="checkbox"
                    checked={updateRestart}
                    onChange={(e) => setUpdateRestart(e.target.checked)}
                  />
                  <span>Restart server automatically after update completes</span>
                </label>
              )}
            </div>

            <div className="btn-row">
              <button
                type="button"
                className="btn btn-primary"
                disabled={updatingServer}
                onClick={async () => {
                  setUpdatingServer(true);
                  setTab('console');
                  setMessage(null);
                  try {
                    const res = await api.updateInstance(detail.id, {
                      createBackup: updateBackup,
                      targetVersionId: updateTargetVersion || undefined,
                      restartIfRunning: updateRestart,
                    });
                    setShowUpdatePanel(false);
                    setMessage({ kind: 'success', text: res.summary });
                    onToast?.('success', res.summary);
                    await loadDetail(true);
                    onGlobalRefresh();
                    const refreshedCheck = await api.checkInstanceUpdate(detail.id).catch(() => null);
                    if (refreshedCheck) setUpdateCheck(refreshedCheck);
                  } catch (err) {
                    const msg = err instanceof Error ? err.message : 'Update failed';
                    setMessage({ kind: 'error', text: msg });
                    onToast?.('error', msg);
                  } finally {
                    setUpdatingServer(false);
                  }
                }}
              >
                <ArrowUpCircle size={14} /> {updatingServer ? 'Updating...' : 'Run Update Now'}
              </button>
            </div>
          </div>
        </section>
      )}

      {/* Connection + Lease Banner */}
      <div
        className="panel panel-body"
        style={{
          marginBottom: 18,
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'space-between',
          gap: 14,
          flexWrap: 'wrap',
        }}
      >
        <div style={{ display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap' }}>
          <button
            type="button"
            className="copy-address"
            onClick={async () => {
              const ok = await copyTextToClipboard(detail.joinAddress);
              if (ok) {
                setCopied(true);
                setTimeout(() => setCopied(false), 1800);
              }
            }}
          >
            <span>
              Join ({formatHostSourceLabel(detail.publicHostSource)}): {detail.joinAddress}
            </span>
            {copied ? <Check size={13} color="var(--status-online)" /> : <Copy size={13} />}
          </button>
          {detail.localJoinAddress && (
            <button
              type="button"
              className="copy-address"
              style={{ fontSize: 12, opacity: 0.85 }}
              title="Copy local LAN address for computers on the same home network"
              onClick={async () => {
                const ok = await copyTextToClipboard(detail.localJoinAddress!);
                if (ok) {
                  setCopiedLan(true);
                  setTimeout(() => setCopiedLan(false), 1800);
                }
              }}
            >
              <span>LAN: {detail.localJoinAddress}</span>
              {copiedLan ? <Check size={12} color="var(--status-online)" /> : <Copy size={12} />}
            </button>
          )}
          <span style={{ fontSize: 12.5, color: 'var(--text-secondary)' }}>
            Ports:{' '}
            <span className="mono">
              {Object.entries(detail.ports)
                .map(([k, p]) => `${k}:${p}`)
                .join('  ')}
            </span>
          </span>
        </div>

        {detail.activeLease && (
          <div className="btn-row">
            <button
              className="btn btn-sm"
              disabled={busy}
              onClick={() => runAction(() => api.extendLease(detail.id, 60), 'Extended temporary lease by +1 hour.')}
            >
              <Clock size={13} /> Extend +1h
            </button>
            <button
              className="btn btn-sm"
              disabled={busy}
              onClick={() => runAction(() => api.promoteLease(detail.id), 'Removed temporary timer (now permanent).')}
            >
              Keep Permanent
            </button>
          </div>
        )}
      </div>

      {detail.runtime === 'docker' && template?.runtimes.native && (
        <div
          className="alert alert-info"
          style={{
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'space-between',
            gap: 12,
            flexWrap: 'wrap',
          }}
        >
          <span>
            This server is currently set to <strong>Docker</strong>
            {metrics && !metrics.runtimesAvailable.docker ? ' (Docker is not running on this PC)' : ''}. Switch it to{' '}
            <strong>Local Native</strong> to run directly on this server machine without Docker.
          </span>
          <button
            type="button"
            className="btn btn-primary btn-sm"
            disabled={!isStopped || busy}
            onClick={() =>
              runAction(
                () => api.updateInstanceConfig(detail.id, { runtime: 'native' }),
                'Switched server to Local Native runtime.'
              )
            }
          >
            Switch to Local Native
          </button>
        </div>
      )}

      {isActiveTransition && (
        <div className="activity-banner" role="status" aria-live="polite">
          <div className="activity-banner-head">
            <span className="activity-banner-title">
              <Loader2 size={15} className="spin" />
              {activityTitle}
            </span>
            {activeDownloadPercent !== null && (
              <span className="mono tabular" style={{ fontSize: 12.5, fontWeight: 600, color: 'hsl(38, 95%, 72%)' }}>
                {activeDownloadPercent}%
              </span>
            )}
          </div>
          <div className="progress-track">
            {activeDownloadPercent !== null ? (
              <div className="progress-fill warn" style={{ width: `${activeDownloadPercent}%` }} />
            ) : (
              <div className="progress-fill warn indeterminate" />
            )}
          </div>
          <div className="activity-banner-line" title={latestLogLine ?? undefined}>
            {latestLogLine ??
              'Resolving pack download, verifying Java runtime, and preparing server files — live logs will appear below...'}
          </div>
        </div>
      )}

      {/* Crash Watchdog Banner (Issue #11) */}
      {detail.lastCrash && (
        <div className={`crash-banner ${isRunning ? 'recovered' : ''}`} role="alert">
          <div className="alert-with-actions">
            <div>
              <div style={{ display: 'flex', alignItems: 'center', gap: 8, fontWeight: 600, fontSize: 13.5 }}>
                <AlertTriangle size={15} />
                {detail.lastCrash.halted
                  ? `Crash-Loop Watchdog Halted (Attempt ${detail.lastCrash.attemptCount}/${detail.lastCrash.maxAttempts})`
                  : isRunning
                    ? `Recovered from Unexpected Crash (Attempt ${detail.lastCrash.attemptCount}/${detail.lastCrash.maxAttempts})`
                    : `Unexpected Crash Detected — Auto-Restart Scheduled (Attempt ${detail.lastCrash.attemptCount}/${detail.lastCrash.maxAttempts})`}
              </div>
              <div style={{ fontSize: 12.5, marginTop: 4, color: 'var(--text-primary)' }}>
                {detail.lastCrash.reason}
              </div>
              <div style={{ fontSize: 11.5, marginTop: 4, color: 'var(--text-secondary)' }}>
                Exit code: <span className="mono">{detail.lastCrash.exitCode ?? 'unknown'}</span> •{' '}
                {new Date(detail.lastCrash.crashedAt).toLocaleString()}
                {detail.lastCrash.nextRestartAt && !detail.lastCrash.halted && !isRunning && (
                  <> • Next restart at {new Date(detail.lastCrash.nextRestartAt).toLocaleTimeString()}</>
                )}
              </div>
            </div>
            <div className="btn-row">
              {detail.lastCrash.logTail.length > 0 && (
                <button
                  type="button"
                  className="btn btn-sm"
                  onClick={() => setShowCrashTail((v) => !v)}
                >
                  {showCrashTail ? <ChevronUp size={13} /> : <ChevronDown size={13} />}
                  {showCrashTail ? 'Hide Crash Tail' : `Crash Tail (${detail.lastCrash.logTail.length} lines)`}
                </button>
              )}
              <button
                type="button"
                className="btn btn-sm"
                onClick={() => void handleCopyErrorText(detail.lastCrash!.reason)}
              >
                {copiedErrorText ? <Check size={13} color="var(--status-online)" /> : <Copy size={13} />}
                Copy Error
              </button>
              <button type="button" className="btn btn-sm" onClick={() => void handleCopyDebugReport()}>
                {copiedDebugReport ? <Check size={13} color="var(--status-online)" /> : <Bug size={13} />}
                {copiedDebugReport ? 'Copied!' : 'Copy Debug Report'}
              </button>
              {onReportBug && (
                <button
                  type="button"
                  className="btn btn-sm btn-primary"
                  onClick={() => {
                    const analysis = detail.lastCrash?.analysis;
                    const analysisLines = analysis
                      ? [
                          `Minecraft Crash Analysis (${analysis.category}): ${analysis.headline}`,
                          analysis.suspectedMods.length > 0
                            ? `Suspected mods/plugins: ${analysis.suspectedMods
                                .map((m) => m.jarFile || m.modName || m.modId)
                                .filter(Boolean)
                                .join(', ')}`
                            : null,
                          analysis.missingDependencies.length > 0
                            ? `Missing dependencies: ${analysis.missingDependencies.map((d) => d.modId).join(', ')}`
                            : null,
                          `Recommended fix: ${analysis.recommendedFix}`,
                        ]
                          .filter(Boolean)
                          .join('\n')
                      : null;
                    onReportBug({
                      instanceId: detail.id,
                      title: analysis
                        ? `${detail.name}: ${analysis.headline}`
                        : `${detail.name} (${detail.gameId}) crashed unexpectedly`,
                      description: analysisLines
                        ? `Crash reason: ${detail.lastCrash!.reason}\n\n${analysisLines}`
                        : `Crash reason: ${detail.lastCrash!.reason}`,
                    });
                  }}
                >
                  <Bug size={13} /> Report Issue
                </button>
              )}
            </div>
          </div>
          {detail.lastCrash.analysis && (
            <div className="crash-analysis-box">
              <div className="crash-analysis-head">
                <span className="badge badge-error" style={{ textTransform: 'uppercase', fontSize: 10.5 }}>
                  {detail.lastCrash.analysis.category.replace(/_/g, ' ')}
                </span>
                <strong>{detail.lastCrash.analysis.headline}</strong>
                {detail.lastCrash.analysis.crashReportFile && (
                  <span className="mono" style={{ fontSize: 11, color: 'var(--text-secondary)', marginLeft: 'auto' }}>
                    {detail.lastCrash.analysis.crashReportFile}
                  </span>
                )}
              </div>
              <div style={{ fontSize: 12.5, color: 'var(--text-secondary)' }}>
                {detail.lastCrash.analysis.summary}
              </div>
              {detail.lastCrash.analysis.suspectedMods.length > 0 && (
                <div className="crash-analysis-chips">
                  <span className="crash-analysis-label">Suspected:</span>
                  {detail.lastCrash.analysis.suspectedMods.map((mod, idx) => (
                    <span key={idx} className="crash-culprit-chip mono">
                      {mod.jarFile || mod.modName || mod.modId}
                    </span>
                  ))}
                </div>
              )}
              {detail.lastCrash.analysis.missingDependencies.length > 0 && (
                <div className="crash-analysis-chips">
                  <span className="crash-analysis-label">Missing Dependencies:</span>
                  {detail.lastCrash.analysis.missingDependencies.map((dep, idx) => (
                    <span key={idx} className="crash-culprit-chip mono">
                      {dep.modId}
                      {dep.versionRange ? ` (${dep.versionRange})` : ''}
                    </span>
                  ))}
                </div>
              )}
              {detail.lastCrash.analysis.requiredJavaMajor && (
                <div style={{ fontSize: 12, color: 'hsl(38, 95%, 76%)' }}>
                  Required Java runtime: <strong className="mono">Java {detail.lastCrash.analysis.requiredJavaMajor}</strong>
                </div>
              )}
              <div className="crash-analysis-fix">
                <strong>Recommended fix:</strong> {detail.lastCrash.analysis.recommendedFix}
              </div>
            </div>
          )}
          {showCrashTail && detail.lastCrash.logTail.length > 0 && (
            <pre className="crash-tail-pre">{detail.lastCrash.logTail.join('\n')}</pre>
          )}
        </div>
      )}

      {message && (
        <div
          className={`alert ${message.kind === 'error' ? 'alert-error alert-with-actions' : 'alert-success'}`}
        >
          <span>{message.text}</span>
          {message.kind === 'error' && (
            <div className="btn-row">
              <button
                type="button"
                className="btn btn-sm"
                onClick={() => void handleCopyErrorText(message.text)}
              >
                {copiedErrorText ? <Check size={12} color="var(--status-online)" /> : <Copy size={12} />}
                Copy Error
              </button>
              <button type="button" className="btn btn-sm" onClick={() => void handleCopyDebugReport()}>
                {copiedDebugReport ? <Check size={12} color="var(--status-online)" /> : <Bug size={12} />}
                Copy Debug Report
              </button>
              {onReportBug && (
                <button
                  type="button"
                  className="btn btn-sm btn-primary"
                  onClick={() =>
                    onReportBug({
                      instanceId: detail.id,
                      title: `Error on ${detail.name} (${detail.gameId})`,
                      description: message.text,
                    })
                  }
                >
                  <Bug size={12} /> Report Issue
                </button>
              )}
            </div>
          )}
        </div>
      )}

      {detail.lastError &&
        (!message || message.text !== detail.lastError) &&
        (!detail.lastCrash || detail.lastCrash.reason !== detail.lastError) && (
          <div className="alert alert-error alert-with-actions">
            <span>
              <strong>Last Error:</strong> {detail.lastError}
            </span>
            <div className="btn-row">
              <button
                type="button"
                className="btn btn-sm"
                onClick={() => void handleCopyErrorText(detail.lastError!)}
              >
                {copiedErrorText ? <Check size={12} color="var(--status-online)" /> : <Copy size={12} />}
                Copy Error
              </button>
              <button type="button" className="btn btn-sm" onClick={() => void handleCopyDebugReport()}>
                {copiedDebugReport ? <Check size={12} color="var(--status-online)" /> : <Bug size={12} />}
                Copy Debug Report
              </button>
              {onReportBug && (
                <button
                  type="button"
                  className="btn btn-sm btn-primary"
                  onClick={() =>
                    onReportBug({
                      instanceId: detail.id,
                      title: `Error on ${detail.name} (${detail.gameId})`,
                      description: detail.lastError!,
                    })
                  }
                >
                  <Bug size={12} /> Report Issue
                </button>
              )}
            </div>
          </div>
        )}

      <div className="tabs">
        <button className={`tab-btn ${tab === 'console' ? 'active' : ''}`} onClick={() => setTab('console')}>
          Live Console
        </button>
        <button className={`tab-btn ${tab === 'network' ? 'active' : ''}`} onClick={() => setTab('network')}>
          Network &amp; Firewall
        </button>
        <button className={`tab-btn ${tab === 'config' ? 'active' : ''}`} onClick={() => setTab('config')}>
          Configuration
        </button>
        <button className={`tab-btn ${tab === 'files' ? 'active' : ''}`} onClick={() => setTab('files')}>
          Files
        </button>
        {(detail.gameId === 'minecraft' ||
          detail.gameId === 'minecraft-curseforge' ||
          detail.gameId === 'minecraft-modrinth') && (
          <>
            <button
              className={`tab-btn ${tab === 'properties' ? 'active' : ''}`}
              onClick={() => setTab('properties')}
            >
              Server Properties
            </button>
            <button className={`tab-btn ${tab === 'mods' ? 'active' : ''}`} onClick={() => setTab('mods')}>
              Mods / Plugins / Datapacks
            </button>
          </>
        )}
        <button className={`tab-btn ${tab === 'backups' ? 'active' : ''}`} onClick={() => setTab('backups')}>
          World Backups ({detail.backups.length})
        </button>
      </div>

      {tab === 'console' && (
        <div className="terminal-box">
          {/* Console Toolbar (Issue #24) */}
          <div className="console-toolbar">
            <div className="console-toolbar-group">
              <input
                type="search"
                className="console-search"
                placeholder="Filter console logs..."
                aria-label="Filter console logs"
                value={consoleSearch}
                onChange={(e) => setConsoleSearch(e.target.value)}
              />
              <button
                type="button"
                className={`btn btn-sm ${consoleErrorsOnly ? 'btn-danger' : ''}`}
                onClick={() => setConsoleErrorsOnly((v) => !v)}
                title="Show only error and warning lines"
              >
                <Filter size={12} />
                Errors &amp; Warnings ({errorWarnCount})
              </button>
              <button
                type="button"
                className={`btn btn-sm ${!autoScroll ? 'btn-primary' : ''}`}
                onClick={() => setAutoScroll((v) => !v)}
                title={autoScroll ? 'Pause auto-scroll while reading or selecting text' : 'Resume auto-scroll'}
              >
                {autoScroll ? <Pause size={12} /> : <Play size={12} />}
                {autoScroll ? 'Auto-scroll' : 'Paused'}
              </button>
            </div>
            <div className="console-toolbar-group">
              <button
                type="button"
                className="btn btn-sm"
                disabled={combinedLogs.length === 0}
                onClick={() => void handleCopyConsole()}
              >
                {copiedConsole ? <Check size={12} color="var(--status-online)" /> : <Copy size={12} />}
                {copiedConsole ? 'Copied!' : 'Copy Console'}
              </button>
              <button type="button" className="btn btn-sm" onClick={() => void handleCopyDebugReport()}>
                {copiedDebugReport ? <Check size={12} color="var(--status-online)" /> : <Bug size={12} />}
                {copiedDebugReport ? 'Copied Report!' : 'Copy Debug Report'}
              </button>
              <a
                className="btn btn-sm"
                href={api.getInstanceLogDownloadUrl(detail.id)}
                download={`${detail.slug}-console.log`}
                style={{ textDecoration: 'none' }}
              >
                <Download size={12} /> Download .log
              </a>
            </div>
          </div>

          <div className="terminal-output" aria-live="polite">
            {combinedLogs.length === 0 ? (
              <div style={{ color: 'var(--text-muted)', display: 'flex', alignItems: 'center', gap: 8 }}>
                {isActiveTransition ? (
                  <>
                    <Loader2 size={14} className="spin" />
                    <span>
                      Initializing server setup — live installation and boot logs will stream here momentarily...
                    </span>
                  </>
                ) : (
                  <span>No console output yet. Start the server to stream real-time logs.</span>
                )}
              </div>
            ) : visibleLogs.length === 0 ? (
              <div style={{ color: 'var(--text-muted)' }}>
                No console lines match the current filter ({combinedLogs.length} total line(s)).
              </div>
            ) : (
              visibleLogs.map((entry, idx) => {
                const severity = classifyConsoleLine(entry.line);
                const severityClass =
                  severity === 'error'
                    ? ' terminal-line-error'
                    : severity === 'warn'
                      ? ' terminal-line-warn'
                      : '';
                return (
                  <div key={`${entry.timestamp}-${idx}`} className={`terminal-line${severityClass}`}>
                    <span className="terminal-ts tabular">{entry.timestamp.slice(11, 19)}</span>
                    <span>{entry.line}</span>
                  </div>
                );
              })
            )}
            <div ref={logEndRef} />
          </div>
          <form className="terminal-input-bar" onSubmit={handleSendCommand}>
            <input
              id="console-command-input"
              placeholder={
                isRunning
                  ? 'Send RCON / console command (e.g., list, save-all, mock:join Alex)...'
                  : 'Start the server to send console commands'
              }
              value={command}
              onChange={(e) => setCommand(e.target.value)}
              disabled={!isRunning || busy}
            />
            <button type="submit" className="btn btn-ghost" disabled={!isRunning || busy || !command.trim()}>
              <Send size={14} /> Send
            </button>
          </form>
        </div>
      )}

      {tab === 'config' && (
        <div className="panel panel-body">
          {!isStopped && (
            <div className="alert alert-info">Stop the server before editing configuration values.</div>
          )}

          <div className="form-grid">
            <div className="field">
              <label htmlFor="edit-runtime">Execution Runtime</label>
              <select
                id="edit-runtime"
                className="select"
                disabled={!isStopped}
                value={editRuntime}
                onChange={(e) => setEditRuntime(e.target.value as RuntimeKind)}
              >
                {template?.runtimes.native && (
                  <option value="native">Local Native Process (runs directly on this PC)</option>
                )}
                {template?.runtimes.docker && (metrics?.runtimesAvailable.docker || editRuntime === 'docker') && (
                  <option value="docker">Docker Container</option>
                )}
              </select>
            </div>

            <div className="field">
              <label htmlFor="edit-ram">RAM Cap (GB)</label>
              <input
                id="edit-ram"
                type="number"
                className="input tabular"
                min={1}
                max={128}
                disabled={!isStopped}
                value={editMemoryGb}
                onChange={(e) => setEditMemoryGb(Number(e.target.value))}
              />
            </div>

            {editRuntime === 'native' && (
              <div className="field">
                <label htmlFor="edit-launch-script">Custom Startup Script (optional)</label>
                <input
                  id="edit-launch-script"
                  className="input mono"
                  disabled={!isStopped}
                  placeholder="e.g., startserver.bat or run.bat"
                  value={editLaunchScript}
                  onChange={(e) => setEditLaunchScript(e.target.value)}
                />
              </div>
            )}

            <div className="field" style={{ justifyContent: 'center' }}>
              <label className="checkbox-row">
                <input
                  type="checkbox"
                  disabled={!isStopped}
                  checked={editDiscord}
                  onChange={(e) => setEditDiscord(e.target.checked)}
                />
                <span>Allow temporary Discord boot via /server start</span>
              </label>
              <label className="checkbox-row" style={{ paddingTop: 2 }}>
                <input
                  type="checkbox"
                  disabled={!isStopped}
                  checked={editAutoStart}
                  onChange={(e) => setEditAutoStart(e.target.checked)}
                />
                <span>Auto-start when server PC boots</span>
              </label>
              <label className="checkbox-row" style={{ paddingTop: 2 }}>
                <input
                  type="checkbox"
                  disabled={!isStopped}
                  checked={editAutoRestartOnCrash}
                  onChange={(e) => setEditAutoRestartOnCrash(e.target.checked)}
                />
                <span>Auto-restart on unexpected crash (backoff + 3x/15m loop protection)</span>
              </label>
            </div>

            {(template?.configFields ?? []).map((field) => (
              <div key={field.key} className="field">
                <label htmlFor={`edit-${field.key}`}>{field.label}</label>
                {field.type === 'select' && field.options ? (
                  <select
                    id={`edit-${field.key}`}
                    className="select"
                    disabled={!isStopped}
                    value={String(editConfig[field.key] ?? '')}
                    onChange={(e) => setEditConfig((p) => ({ ...p, [field.key]: e.target.value }))}
                  >
                    {field.options.map((opt) => (
                      <option key={opt} value={opt}>
                        {opt}
                      </option>
                    ))}
                  </select>
                ) : field.type === 'boolean' ? (
                  <label className="checkbox-row">
                    <input
                      type="checkbox"
                      disabled={!isStopped}
                      checked={Boolean(editConfig[field.key])}
                      onChange={(e) => setEditConfig((p) => ({ ...p, [field.key]: e.target.checked }))}
                    />
                    <span>Enabled</span>
                  </label>
                ) : (
                  <input
                    id={`edit-${field.key}`}
                    type={field.type === 'number' ? 'number' : 'text'}
                    className="input"
                    disabled={!isStopped}
                    value={String(editConfig[field.key] ?? '')}
                    onChange={(e) =>
                      setEditConfig((p) => ({
                        ...p,
                        [field.key]: field.type === 'number' ? Number(e.target.value) : e.target.value,
                      }))
                    }
                  />
                )}
              </div>
            ))}

            {(template?.ports ?? []).map((portSpec) => (
              <div className="field" key={`edit-port-${portSpec.key}`}>
                <label htmlFor={`edit-port-${portSpec.key}`}>
                  {portSpec.label} ({portSpec.protocol.toUpperCase()})
                </label>
                <input
                  id={`edit-port-${portSpec.key}`}
                  type="number"
                  min={1024}
                  max={65535}
                  step={1}
                  className="input tabular"
                  disabled={!isStopped}
                  value={editPorts[portSpec.key] ?? portSpec.defaultPort}
                  onChange={(e) =>
                    setEditPorts((prev) => ({
                      ...prev,
                      [portSpec.key]: Number(e.target.value),
                    }))
                  }
                />
                <span className="field-hint">
                  Default {portSpec.defaultPort}/{portSpec.protocol}
                </span>
              </div>
            ))}
          </div>

          <div
            className="btn-row"
            style={{
              marginTop: 22,
              paddingTop: 16,
              borderTop: '1px solid var(--border-subtle)',
              justifyContent: 'space-between',
            }}
          >
            <button
              className="btn btn-primary"
              disabled={!isStopped || busy}
              onClick={() =>
                runAction(
                  () =>
                    api.updateInstanceConfig(detail.id, {
                      runtime: editRuntime,
                      memoryLimitMb: editMemoryGb * 1024,
                      ports: editPorts,
                      autoStart: editAutoStart,
                      autoRestartOnCrash: editAutoRestartOnCrash,
                      discordEnabled: editDiscord,
                      launchScript: editLaunchScript.trim() || null,
                      config: editConfig,
                    }),
                  'Configuration saved.'
                )
              }
            >
              <Save size={14} /> Save Changes
            </button>

            <button className="btn btn-danger" disabled={busy} onClick={handleDelete}>
              <Trash2 size={14} /> {detail.externalDir ? 'Unlink Server (Keep Files)' : 'Delete Server'}
            </button>
          </div>
        </div>
      )}

      {tab === 'backups' && (
        <div className="panel panel-body">
          <div style={{ display: 'flex', gap: 10, marginBottom: 18, flexWrap: 'wrap' }}>
            <input
              className="input"
              style={{ maxWidth: 340 }}
              placeholder="Optional snapshot note (e.g., Before boss fight)"
              value={backupNote}
              onChange={(e) => setBackupNote(e.target.value)}
            />
            <button
              className="btn btn-primary"
              disabled={busy}
              onClick={() => {
                const note = backupNote;
                setBackupNote('');
                void runAction(() => api.createBackup(detail.id, note), 'World backup archive created.');
              }}
            >
              <Archive size={14} /> Create Snapshot (.zip)
            </button>
          </div>

          {detail.backups.length === 0 ? (
            <p style={{ color: 'var(--text-secondary)', margin: 0 }}>
              No backups created yet. Backups are saved under <code className="mono">data/backups/{detail.id}</code>.
            </p>
          ) : (
            <table className="data-table">
              <thead>
                <tr>
                  <th>Archive</th>
                  <th>Note</th>
                  <th>Size</th>
                  <th>Created</th>
                  <th style={{ textAlign: 'right' }}>Actions</th>
                </tr>
              </thead>
              <tbody>
                {detail.backups.map((b) => (
                  <tr key={b.id}>
                    <td className="mono">{b.filename}</td>
                    <td>{b.note || '—'}</td>
                    <td className="tabular">
                      {b.sizeBytes >= 1024 * 1024
                        ? `${(b.sizeBytes / (1024 * 1024)).toFixed(2)} MB`
                        : `${(b.sizeBytes / 1024).toFixed(1)} KB`}
                    </td>
                    <td className="tabular">{new Date(b.createdAt).toLocaleString()}</td>
                    <td>
                      <div className="btn-row" style={{ justifyContent: 'flex-end' }}>
                        <a
                          className="btn btn-sm"
                          href={api.getBackupDownloadUrl(detail.id, b.id)}
                          download={b.filename}
                          style={{ textDecoration: 'none' }}
                          title="Download backup ZIP to your PC"
                        >
                          <Download size={12} /> Download
                        </a>
                        <button
                          type="button"
                          className="btn btn-sm"
                          disabled={busy}
                          title="Restore this snapshot (auto-creates a safety backup first)"
                          onClick={async () => {
                            const confirmMsg = `Restore "${detail.name}" from backup "${b.filename}"?\n\n${
                              !isStopped ? 'The running server will be saved & stopped first. ' : ''
                            }ServerForge will automatically create a pre-restore safety snapshot before replacing world files.`;
                            const confirmed = onConfirm
                              ? await onConfirm({
                                  title: 'Restore World Backup?',
                                  message: confirmMsg,
                                  confirmLabel: 'Restore Snapshot',
                                  tone: 'primary',
                                })
                              : window.confirm(confirmMsg);
                            if (!confirmed) return;
                            const ok = await runAction(
                              () => api.restoreBackup(detail.id, b.id),
                              `Restored "${b.filename}" (safety snapshot created before restore).`
                            );
                            if (ok) onToast?.('success', `Restored backup "${b.filename}".`);
                          }}
                        >
                          <RotateCcw size={12} /> Restore
                        </button>
                        <button
                          type="button"
                          className="btn btn-sm btn-danger"
                          disabled={busy}
                          title="Delete backup from disk"
                          onClick={async () => {
                            const confirmed = onConfirm
                              ? await onConfirm({
                                  title: 'Delete Backup Archive?',
                                  message: `Permanently delete backup "${b.filename}" from disk?`,
                                  confirmLabel: 'Delete Backup',
                                  tone: 'danger',
                                })
                              : window.confirm(`Permanently delete backup "${b.filename}"?`);
                            if (!confirmed) return;
                            const ok = await runAction(
                              () => api.deleteBackup(detail.id, b.id),
                              `Deleted backup "${b.filename}".`
                            );
                            if (ok) onToast?.('info', `Deleted backup "${b.filename}".`);
                          }}
                        >
                          <Trash2 size={12} /> Delete
                        </button>
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}

          {/* Scheduled Backups & Retention Policy (Issue #10) */}
          <div className="backup-policy-card">
            <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 12, flexWrap: 'wrap', gap: 10 }}>
              <div>
                <h3 style={{ margin: 0, fontSize: 15 }}>Scheduled Auto-Backups &amp; Retention</h3>
                <p style={{ margin: '4px 0 0', fontSize: 12.5, color: 'var(--text-secondary)' }}>
                  Automatically snapshot this server on a schedule and prune older archives to keep disk usage bounded.
                  {editBackupPolicy.lastAutoBackupAt && (
                    <> Last auto-backup: {new Date(editBackupPolicy.lastAutoBackupAt).toLocaleString()}</>
                  )}
                </p>
              </div>
              <label className="checkbox-row">
                <input
                  type="checkbox"
                  checked={editBackupPolicy.enabled}
                  onChange={(e) => setEditBackupPolicy((p) => ({ ...p, enabled: e.target.checked }))}
                />
                <strong>Enable Scheduled Backups</strong>
              </label>
            </div>

            <div className="form-grid">
              <div className="field">
                <label htmlFor="bp-mode">Schedule Cadence</label>
                <select
                  id="bp-mode"
                  className="select"
                  value={editBackupPolicy.scheduleMode}
                  onChange={(e) =>
                    setEditBackupPolicy((p) => ({ ...p, scheduleMode: e.target.value as 'daily' | 'interval' }))
                  }
                >
                  <option value="daily">Daily at specific time</option>
                  <option value="interval">Every N hours</option>
                </select>
              </div>

              {editBackupPolicy.scheduleMode === 'daily' ? (
                <div className="field">
                  <label htmlFor="bp-time">Daily Backup Time (24h HH:MM)</label>
                  <input
                    id="bp-time"
                    type="time"
                    className="input mono"
                    value={editBackupPolicy.dailyTime}
                    onChange={(e) => setEditBackupPolicy((p) => ({ ...p, dailyTime: e.target.value }))}
                  />
                </div>
              ) : (
                <div className="field">
                  <label htmlFor="bp-hours">Interval (Hours)</label>
                  <input
                    id="bp-hours"
                    type="number"
                    className="input tabular"
                    min={1}
                    max={168}
                    value={editBackupPolicy.intervalHours}
                    onChange={(e) => setEditBackupPolicy((p) => ({ ...p, intervalHours: Number(e.target.value) || 1 }))}
                  />
                </div>
              )}

              <div className="field">
                <label htmlFor="bp-max-count">Retention: Keep Last N Backups</label>
                <input
                  id="bp-max-count"
                  type="number"
                  className="input tabular"
                  min={1}
                  max={200}
                  value={editBackupPolicy.maxCount}
                  onChange={(e) => setEditBackupPolicy((p) => ({ ...p, maxCount: Number(e.target.value) || 1 }))}
                />
              </div>

              <div className="field">
                <label htmlFor="bp-max-gb">Retention: Max Total Size (GB, 0 = unlimited)</label>
                <input
                  id="bp-max-gb"
                  type="number"
                  className="input tabular"
                  min={0}
                  max={500}
                  step={0.5}
                  value={editBackupPolicy.maxTotalGb}
                  onChange={(e) => setEditBackupPolicy((p) => ({ ...p, maxTotalGb: Number(e.target.value) || 0 }))}
                />
              </div>

              <div className="field" style={{ justifyContent: 'center' }}>
                <label className="checkbox-row">
                  <input
                    type="checkbox"
                    checked={editBackupPolicy.onlyWhenRunning}
                    onChange={(e) => setEditBackupPolicy((p) => ({ ...p, onlyWhenRunning: e.target.checked }))}
                  />
                  <span>Only run scheduled backups while server is online</span>
                </label>
              </div>
            </div>

            <div style={{ marginTop: 14 }}>
              <button
                type="button"
                className="btn btn-primary"
                disabled={busy}
                onClick={() =>
                  runAction(
                    () => api.updateBackupPolicy(detail.id, editBackupPolicy),
                    'Backup schedule & retention policy saved.'
                  )
                }
              >
                <Save size={14} /> Save Backup Policy
              </button>
            </div>
          </div>
        </div>
      )}

      {tab === 'files' && (
        <FilesTab instanceId={detail.id} onConfirm={onConfirm} onToast={onToast} />
      )}

      {tab === 'properties' && (
        <MinecraftPropertiesTab
          instanceId={detail.id}
          isRunning={detail.status === 'running'}
          onSaved={() => {
            void loadDetail(false);
            onGlobalRefresh();
          }}
          onToast={onToast}
        />
      )}

      {tab === 'network' && (
        <NetworkTab
          instanceId={detail.id}
          isRunning={detail.status === 'running'}
          onStartServer={() =>
            void runAction(() => api.startInstance(detail.id, { temporary: false }), 'Server started.')
          }
          onGoToConfig={() => setTab('config')}
          onToast={onToast}
        />
      )}

      {tab === 'mods' && (
        <ModsPluginsTab instanceId={detail.id} onConfirm={onConfirm} onToast={onToast} />
      )}
    </div>
  );
}
