import React, { useEffect, useRef, useState } from 'react';
import {
  Archive,
  ArrowLeft,
  Check,
  Clock,
  Copy,
  Play,
  RotateCw,
  Save,
  Send,
  Square,
  Timer,
  Trash2,
} from 'lucide-react';
import type { GameTemplate, HostMetrics, RuntimeKind } from '@serverforge/shared';
import { api, formatRemaining, type InstanceDetail, type InstanceWithJoin } from '../api';

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
  const [message, setMessage] = useState<{ kind: 'error' | 'success'; text: string } | null>(null);
  const logEndRef = useRef<HTMLDivElement | null>(null);
  const autoBootTriggeredRef = useRef(false);

  const loadDetail = async () => {
    try {
      const data = await api.getInstance(instanceId);
      setDetail(data);
      setEditConfig(data.config);
      setEditMemoryGb(Math.round(data.memoryLimitMb / 1024));
      setEditRuntime(data.runtime);
      setEditAutoStart(data.autoStart);
      setEditDiscord(data.discordEnabled);
      setEditLaunchScript(data.launchScript ?? '');
    } catch (err) {
      setMessage({ kind: 'error', text: err instanceof Error ? err.message : 'Failed to load server' });
    }
  };

  useEffect(() => {
    autoBootTriggeredRef.current = false;
    void loadDetail();
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
          }
        : prev
    );
  }, [
    instanceSummary?.id,
    instanceSummary?.status,
    instanceSummary?.lastError,
    instanceSummary?.activeLease?.expiresAt,
    instanceSummary?.joinAddress,
  ]);

  const combinedLogs = detail ? [...detail.logs, ...liveLogs] : liveLogs;

  useEffect(() => {
    if (tab === 'console') {
      logEndRef.current?.scrollIntoView({ behavior: 'smooth' });
    }
  }, [combinedLogs.length, tab]);

  const runAction = async (fn: () => Promise<unknown>, successMsg?: string) => {
    setMessage(null);
    setBusy(true);
    try {
      await fn();
      if (successMsg) setMessage({ kind: 'success', text: successMsg });
      await loadDetail();
      onGlobalRefresh();
    } catch (err) {
      setMessage({ kind: 'error', text: err instanceof Error ? err.message : 'Operation failed' });
      await loadDetail();
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
        <p style={{ marginTop: 14, color: 'var(--text-secondary)' }}>Loading instance details...</p>
      </div>
    );
  }

  const template = catalog.find((t) => t.id === detail.gameId);
  const isRunning = detail.status === 'running';
  const isStopped = detail.status === 'stopped' || detail.status === 'error';

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
              <span className="badge-dot" />
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
                <Play size={14} /> Start
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
                disabled={busy}
                onClick={() => runAction(() => api.stopInstance(detail.id), 'World saved & server stopped.')}
              >
                <Square size={14} /> Save & Stop
              </button>
              <button
                className="btn"
                disabled={busy}
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
        <div style={{ display: 'flex', alignItems: 'center', gap: 14, flexWrap: 'wrap' }}>
          <button
            type="button"
            className="copy-address"
            onClick={() => {
              navigator.clipboard?.writeText(detail.joinAddress).catch(() => {});
              setCopied(true);
              setTimeout(() => setCopied(false), 1800);
            }}
          >
            <span>Join: {detail.joinAddress}</span>
            {copied ? <Check size={13} color="var(--status-online)" /> : <Copy size={13} />}
          </button>
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

      {message && (
        <div className={`alert ${message.kind === 'error' ? 'alert-error' : 'alert-success'}`}>{message.text}</div>
      )}

      {detail.lastError && (!message || message.text !== detail.lastError) && (
        <div className="alert alert-error">
          <strong>Last Error:</strong> {detail.lastError}
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
          <div className="terminal-output" aria-live="polite">
            {combinedLogs.length === 0 ? (
              <div style={{ color: 'var(--text-muted)' }}>
                No console output yet. Start the server to stream real-time logs.
              </div>
            ) : (
              combinedLogs.map((entry, idx) => (
                <div key={`${entry.timestamp}-${idx}`} className="terminal-line">
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
