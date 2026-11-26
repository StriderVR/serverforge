import React, { useEffect, useMemo, useRef, useState } from 'react';
import {
  AlertTriangle,
  Archive,
  ArrowDown,
  ArrowLeft,
  Bug,
  Check,
  Clock,
  Copy,
  Download,
  Loader2,
  Play,
  RotateCw,
  Save,
  Search,
  Send,
  Square,
  Timer,
  Trash2,
} from 'lucide-react';
import type { GameTemplate, HostMetrics, RuntimeKind } from '@serverforge/shared';
import { api, formatHostSourceLabel, formatRemaining, type InstanceDetail, type InstanceWithJoin } from '../api';
import { copyTextToClipboard } from '../utils/clipboard';

interface InstanceDetailPageProps {
  instanceId: string;
  instanceSummary?: InstanceWithJoin | null;
  catalog: GameTemplate[];
  metrics: HostMetrics | null;
  liveLogs: Array<{ timestamp: string; line: string }>;
  autoBoot?: boolean;
  onAutoBootConsumed?: () => void;
  onBack: () => void;
  onDeleted: () => void;
  onGlobalRefresh: () => void;
}

const PROGRESS_LINE_RE = /\[(?:Download|Java)\][^\n]*?(\d{1,3})%/;
const PHASE_AFTER_DOWNLOAD_RE = /Extracting|Launching|Starting|Prepared|installed successfully/i;
const ERROR_LINE_RE =
  /\b(ERROR|FATAL|SEVERE|CRITICAL|CRASH)\b|Exception|Caused by:|Traceback|Unrecognized VM option|Could not create the Java Virtual Machine|Failed to start|\[Error\]|exited unexpectedly/i;
const WARN_LINE_RE = /\b(WARN|WARNING)\b|\[Warning\]/i;

function classifyLogLine(line: string): 'error' | 'warn' | 'normal' {
  if (ERROR_LINE_RE.test(line)) return 'error';
  if (WARN_LINE_RE.test(line)) return 'warn';
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

export function InstanceDetailPage({
  instanceId,
  instanceSummary,
  catalog,
  metrics,
  liveLogs,
  autoBoot = false,
  onAutoBootConsumed,
  onBack,
  onDeleted,
  onGlobalRefresh,
}: InstanceDetailPageProps) {
  const [detail, setDetail] = useState<InstanceDetail | null>(null);
  const [tab, setTab] = useState<'console' | 'config' | 'backups'>('console');
  const [command, setCommand] = useState('');
  const [backupNote, setBackupNote] = useState('');
  const [editConfig, setEditConfig] = useState<Record<string, string | number | boolean>>({});
  const [editMemoryGb, setEditMemoryGb] = useState(4);
  const [editRuntime, setEditRuntime] = useState<RuntimeKind>('native');
  const [editAutoStart, setEditAutoStart] = useState(false);
  const [editDiscord, setEditDiscord] = useState(true);
  const [editLaunchScript, setEditLaunchScript] = useState('');
  const [busy, setBusy] = useState(false);
  const [copied, setCopied] = useState(false);
  const [copiedLan, setCopiedLan] = useState(false);
  const [consoleFilter, setConsoleFilter] = useState<'all' | 'issues'>('all');
  const [consoleSearch, setConsoleSearch] = useState('');
  const [autoScroll, setAutoScroll] = useState(true);
  const [copiedConsole, setCopiedConsole] = useState(false);
  const [copiedReport, setCopiedReport] = useState(false);
  const [copyingReport, setCopyingReport] = useState(false);
  const [copiedErrorKey, setCopiedErrorKey] = useState<string | null>(null);
  const [message, setMessage] = useState<{ kind: 'error' | 'success'; text: string } | null>(null);
  const terminalRef = useRef<HTMLDivElement | null>(null);
  const logEndRef = useRef<HTMLDivElement | null>(null);
  const autoBootTriggeredRef = useRef(false);

  const loadDetail = async (syncForm = true) => {
    try {
      const data = await api.getInstance(instanceId);
      setDetail(data);
      if (syncForm) {
        setEditConfig(data.config);
        setEditMemoryGb(Math.round(data.memoryLimitMb / 1024));
        setEditRuntime(data.runtime);
        setEditAutoStart(data.autoStart);
        setEditDiscord(data.discordEnabled);
        setEditLaunchScript(data.launchScript ?? '');
      }
    } catch (err) {
      if (syncForm) {
        setMessage({ kind: 'error', text: err instanceof Error ? err.message : 'Failed to load server' });
      }
    }
  };

  useEffect(() => {
    autoBootTriggeredRef.current = false;
    setConsoleFilter('all');
    setConsoleSearch('');
    setAutoScroll(true);
    void loadDetail(true);
  }, [instanceId]);

  // Keep status, lastError, activeLease, and stats live as WebSocket broadcasts instance updates
  useEffect(() => {
    if (!instanceSummary) return;
    setDetail((prev) =>
      prev && prev.id === instanceSummary.id
        ? {
            ...prev,
            status: instanceSummary.status,
            lastError: instanceSummary.lastError,
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

  const classifiedLogs = useMemo(
    () =>
      combinedLogs.map((entry) => ({
        ...entry,
        severity: classifyLogLine(entry.line),
      })),
    [combinedLogs]
  );

  const issueLogCount = useMemo(
    () => classifiedLogs.filter((entry) => entry.severity !== 'normal').length,
    [classifiedLogs]
  );

  const filteredLogs = useMemo(() => {
    const q = consoleSearch.trim().toLowerCase();
    return classifiedLogs.filter((entry) => {
      if (consoleFilter === 'issues' && entry.severity === 'normal') return false;
      if (q && !entry.line.toLowerCase().includes(q)) return false;
      return true;
    });
  }, [classifiedLogs, consoleFilter, consoleSearch]);

  const activeDownloadPercent = useMemo(
    () => (isActiveTransition ? extractActiveDownloadPercent(combinedLogs) : null),
    [isActiveTransition, combinedLogs]
  );

  const latestLogLine = combinedLogs.length > 0 ? combinedLogs[combinedLogs.length - 1].line : null;

  useEffect(() => {
    if (tab === 'console' && autoScroll) {
      logEndRef.current?.scrollIntoView({ behavior: 'smooth' });
    }
  }, [filteredLogs.length, tab, autoScroll]);

  const handleTerminalScroll = () => {
    const el = terminalRef.current;
    if (!el) return;
    const distanceFromBottom = el.scrollHeight - el.scrollTop - el.clientHeight;
    if (distanceFromBottom > 48 && autoScroll) {
      setAutoScroll(false);
    } else if (distanceFromBottom <= 16 && !autoScroll) {
      setAutoScroll(true);
    }
  };

  const handleCopyConsole = async () => {
    const source = filteredLogs.length > 0 ? filteredLogs : classifiedLogs;
    if (source.length === 0) return;
    const text = source.map((entry) => `[${entry.timestamp}] ${entry.line}`).join('\n');
    const ok = await copyTextToClipboard(text);
    if (ok) {
      setCopiedConsole(true);
      setTimeout(() => setCopiedConsole(false), 2000);
    }
  };

  const handleCopyDebugReport = async () => {
    if (!detail) return;
    setCopyingReport(true);
    try {
      let markdown: string;
      try {
        const report = await api.getInstanceDiagnostics(detail.id);
        markdown = report.markdown;
      } catch {
        const tail = combinedLogs
          .slice(-200)
          .map((e) => `[${e.timestamp}] ${e.line}`)
          .join('\n');
        markdown = [
          `## ServerForge Instance Debug Report (Client Fallback)`,
          `- **Server:** ${detail.name} (\`${detail.slug}\`)`,
          `- **Game / Runtime / Status:** \`${detail.gameId}\` • \`${detail.runtime}\` • \`${detail.status}\``,
          `- **Last Error:** ${detail.lastError ?? 'none'}`,
          '',
          '```text',
          tail || '(no console output)',
          '```',
        ].join('\n');
      }
      const ok = await copyTextToClipboard(markdown);
      if (ok) {
        setCopiedReport(true);
        setTimeout(() => setCopiedReport(false), 2200);
      }
    } finally {
      setCopyingReport(false);
    }
  };

  const handleCopyErrorText = async (key: string, text: string) => {
    const ok = await copyTextToClipboard(text);
    if (ok) {
      setCopiedErrorKey(key);
      setTimeout(() => setCopiedErrorKey((prev) => (prev === key ? null : prev)), 2000);
    }
  };

  const runAction = async (fn: () => Promise<unknown>, successMsg?: string) => {
    setMessage(null);
    setBusy(true);
    try {
      await fn();
      if (successMsg) setMessage({ kind: 'success', text: successMsg });
      await loadDetail(true);
      onGlobalRefresh();
    } catch (err) {
      setMessage({ kind: 'error', text: err instanceof Error ? err.message : 'Operation failed' });
      await loadDetail(true);
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
    if (!window.confirm(prompt)) return;
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
        </div>
      </header>

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
            onClick={() => {
              void copyTextToClipboard(detail.joinAddress);
              setCopied(true);
              setTimeout(() => setCopied(false), 1800);
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
              onClick={() => {
                void copyTextToClipboard(detail.localJoinAddress!);
                setCopiedLan(true);
                setTimeout(() => setCopiedLan(false), 1800);
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

      {message && (
        <div
          className={`alert ${message.kind === 'error' ? 'alert-error alert-with-actions' : 'alert-success'}`}
        >
          <span>{message.text}</span>
          {message.kind === 'error' && (
            <div className="alert-actions">
              <button
                type="button"
                className="btn btn-sm"
                onClick={() => void handleCopyErrorText('msg', message.text)}
              >
                {copiedErrorKey === 'msg' ? <Check size={12} color="var(--status-online)" /> : <Copy size={12} />}
                {copiedErrorKey === 'msg' ? 'Copied' : 'Copy Error'}
              </button>
              <button
                type="button"
                className="btn btn-sm"
                disabled={copyingReport}
                onClick={() => void handleCopyDebugReport()}
              >
                {copiedReport ? <Check size={12} color="var(--status-online)" /> : <Bug size={12} />}
                {copiedReport ? 'Report Copied' : 'Copy Debug Report'}
              </button>
            </div>
          )}
        </div>
      )}

      {detail.lastError && (!message || message.text !== detail.lastError) && (
        <div className="alert alert-error alert-with-actions">
          <span>
            <strong>Last Error:</strong> {detail.lastError}
          </span>
          <div className="alert-actions">
            <button
              type="button"
              className="btn btn-sm"
              onClick={() => void handleCopyErrorText('last', detail.lastError!)}
            >
              {copiedErrorKey === 'last' ? <Check size={12} color="var(--status-online)" /> : <Copy size={12} />}
              {copiedErrorKey === 'last' ? 'Copied' : 'Copy Error'}
            </button>
            <button
              type="button"
              className="btn btn-sm"
              disabled={copyingReport}
              onClick={() => void handleCopyDebugReport()}
            >
              {copiedReport ? <Check size={12} color="var(--status-online)" /> : <Bug size={12} />}
              {copiedReport ? 'Report Copied' : 'Copy Debug Report'}
            </button>
          </div>
        </div>
      )}

      <div className="tabs">
        <button className={`tab-btn ${tab === 'console' ? 'active' : ''}`} onClick={() => setTab('console')}>
          Live Console
        </button>
        <button className={`tab-btn ${tab === 'config' ? 'active' : ''}`} onClick={() => setTab('config')}>
          Configuration
        </button>
        <button className={`tab-btn ${tab === 'backups' ? 'active' : ''}`} onClick={() => setTab('backups')}>
          World Backups ({detail.backups.length})
        </button>
      </div>

      {tab === 'console' && (
        <div className="terminal-box">
          <div className="terminal-toolbar">
            <div className="terminal-toolbar-group">
              <button
                type="button"
                className={`terminal-filter-btn ${consoleFilter === 'all' ? 'active' : ''}`}
                onClick={() => setConsoleFilter('all')}
              >
                All ({combinedLogs.length})
              </button>
              <button
                type="button"
                className={`terminal-filter-btn ${consoleFilter === 'issues' ? 'active' : ''} ${issueLogCount > 0 ? 'has-errors' : ''}`}
                onClick={() => setConsoleFilter(consoleFilter === 'issues' ? 'all' : 'issues')}
              >
                <AlertTriangle size={12} />
                Errors &amp; Warnings ({issueLogCount})
              </button>
              <div className="terminal-search">
                <Search size={12} />
                <input
                  type="text"
                  aria-label="Filter console output"
                  placeholder="Filter logs..."
                  value={consoleSearch}
                  onChange={(e) => setConsoleSearch(e.target.value)}
                />
              </div>
            </div>

            <div className="terminal-toolbar-group">
              {!autoScroll && (
                <button
                  type="button"
                  className="btn btn-sm"
                  onClick={() => {
                    setAutoScroll(true);
                    logEndRef.current?.scrollIntoView({ behavior: 'smooth' });
                  }}
                >
                  <ArrowDown size={12} /> Jump to Bottom
                </button>
              )}
              <button
                type="button"
                className="btn btn-sm"
                disabled={combinedLogs.length === 0}
                title="Copy visible console lines to clipboard"
                onClick={() => void handleCopyConsole()}
              >
                {copiedConsole ? <Check size={12} color="var(--status-online)" /> : <Copy size={12} />}
                {copiedConsole ? 'Copied Console!' : 'Copy Console'}
              </button>
              <button
                type="button"
                className="btn btn-sm"
                disabled={copyingReport}
                title="Copy sanitized Markdown debug bundle (config, version, errors, console tail)"
                onClick={() => void handleCopyDebugReport()}
              >
                {copiedReport ? <Check size={12} color="var(--status-online)" /> : <Bug size={12} />}
                {copiedReport ? 'Copied Report!' : 'Copy Debug Report'}
              </button>
              <a
                className="btn btn-sm"
                href={api.getInstanceLogsDownloadUrl(detail.id)}
                download={`${detail.slug}-console.log`}
                title="Download full persisted console log file"
              >
                <Download size={12} /> .log
              </a>
            </div>
          </div>

          <div
            ref={terminalRef}
            className="terminal-output"
            aria-live="polite"
            onScroll={handleTerminalScroll}
          >
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
            ) : filteredLogs.length === 0 ? (
              <div style={{ color: 'var(--text-muted)' }}>
                No log lines match the current filter.{' '}
                <button
                  type="button"
                  className="btn btn-ghost btn-sm"
                  style={{ display: 'inline-flex', padding: '2px 8px', marginLeft: 4 }}
                  onClick={() => {
                    setConsoleFilter('all');
                    setConsoleSearch('');
                  }}
                >
                  Clear Filter
                </button>
              </div>
            ) : (
              filteredLogs.map((entry, idx) => (
                <div
                  key={`${entry.timestamp}-${idx}`}
                  className={`terminal-line ${
                    entry.severity === 'error'
                      ? 'terminal-line-error'
                      : entry.severity === 'warn'
                        ? 'terminal-line-warn'
                        : ''
                  }`}
                >
                  <span className="terminal-ts tabular">{entry.timestamp.slice(11, 19)}</span>
                  <span>{entry.line}</span>
                </div>
              ))
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
                      autoStart: editAutoStart,
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
                </tr>
              </thead>
              <tbody>
                {detail.backups.map((b) => (
                  <tr key={b.id}>
                    <td className="mono">{b.filename}</td>
                    <td>{b.note || '—'}</td>
                    <td className="tabular">{(b.sizeBytes / 1024).toFixed(1)} KB</td>
                    <td className="tabular">{new Date(b.createdAt).toLocaleString()}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>
      )}
    </div>
  );
}
