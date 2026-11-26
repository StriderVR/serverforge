import React, { useEffect, useState } from 'react';
import {
  Bot,
  Bug,
  Check,
  CheckCircle2,
  Copy,
  Download,
  Eye,
  EyeOff,
  Globe,
  Package,
  Power,
  RefreshCw,
  Save,
  Search,
  Shield,
  Slash,
} from 'lucide-react';
import type {
  AppDiagnosticLogEntry,
  AuditLogEntry,
  HostMetrics,
  MaintenanceStatus,
  NetworkStatus,
  PublicHostMode,
  SystemSettings,
  UpdaterStatus,
  WindowsRebootInspection,
} from '@serverforge/shared';
import { api, formatHostSourceLabel } from '../api';
import { copyTextToClipboard } from '../utils/clipboard';

interface SettingsPageProps {
  metrics: HostMetrics | null;
  updaterStatus: UpdaterStatus | null;
  updaterProgress: { stage: string; percent: number; message: string } | null;
  onSaved: () => void;
  onRefreshUpdater: (force?: boolean) => Promise<void>;
  onStartReconnecting: (label: string, expectedVersion?: string) => void;
}

export function SettingsPage({
  metrics,
  updaterStatus,
  updaterProgress,
  onSaved,
  onRefreshUpdater,
  onStartReconnecting,
}: SettingsPageProps) {
  const [settings, setSettings] = useState<SystemSettings | null>(null);
  const [maintenance, setMaintenance] = useState<MaintenanceStatus | null>(null);
  const [networkStatus, setNetworkStatus] = useState<NetworkStatus | null>(null);
  const [allowedRolesText, setAllowedRolesText] = useState('');
  const [adminRolesText, setAdminRolesText] = useState('');
  const [auditLogs, setAuditLogs] = useState<AuditLogEntry[]>([]);
  const [diagLogs, setDiagLogs] = useState<AppDiagnosticLogEntry[]>([]);
  const [diagFilter, setDiagFilter] = useState<'warn' | 'all'>('warn');
  const [loadingDiag, setLoadingDiag] = useState(false);
  const [copiedSysReport, setCopiedSysReport] = useState(false);
  const [copiedDiagLogs, setCopiedDiagLogs] = useState(false);

  const [saving, setSaving] = useState(false);
  const [checkingUpdate, setCheckingUpdate] = useState(false);
  const [applyingUpdate, setApplyingUpdate] = useState(false);
  const [resumeOnUpdate, setResumeOnUpdate] = useState(true);
  const [rebootingPc, setRebootingPc] = useState(false);

  const [detectingNetwork, setDetectingNetwork] = useState(false);
  const [showDuckToken, setShowDuckToken] = useState(false);
  const [updatingDuckDns, setUpdatingDuckDns] = useState(false);
  const [duckResult, setDuckResult] = useState<{ ok: boolean; message: string } | null>(null);

  const [showCfKey, setShowCfKey] = useState(false);
  const [testingCfKey, setTestingCfKey] = useState(false);
  const [cfTestResult, setCfTestResult] = useState<{ ok: boolean; message: string } | null>(null);
  const [updateLog, setUpdateLog] = useState<string | null>(null);
  const [showUpdateLog, setShowUpdateLog] = useState(false);

  const [inspection, setInspection] = useState<WindowsRebootInspection | null>(null);
  const [scanningReboots, setScanningReboots] = useState(false);
  const [disablingTask, setDisablingTask] = useState<string | null>(null);

  const [notice, setNotice] = useState<{ kind: 'success' | 'error'; text: string } | null>(null);

  const loadDiagnostics = async (filter: 'warn' | 'all' = diagFilter) => {
    setLoadingDiag(true);
    try {
      const entries = await api.getDiagnosticsLogs(filter, 150);
      setDiagLogs(entries);
    } catch {
      // Non-fatal
    } finally {
      setLoadingDiag(false);
    }
  };

  const loadAll = async () => {
    const [s, logs, maint, net, dLogs] = await Promise.all([
      api.getSettings(),
      api.getAuditLogs(40),
      api.getMaintenanceStatus(),
      api.getNetworkStatus().catch(() => null),
      api.getDiagnosticsLogs(diagFilter, 150).catch(() => [] as AppDiagnosticLogEntry[]),
    ]);
    setSettings(s);
    setMaintenance(maint);
    if (net) setNetworkStatus(net);
    setAllowedRolesText(s.discordAllowedRoleIds.join(', '));
    setAdminRolesText(s.discordAdminRoleIds.join(', '));
    setAuditLogs(logs);
    setDiagLogs(dLogs);
  };

  const handleCopySystemDiagnostics = async () => {
    try {
      const report = await api.getSystemDiagnosticsReport();
      const ok = await copyTextToClipboard(report.markdown);
      if (ok) {
        setCopiedSysReport(true);
        setTimeout(() => setCopiedSysReport(false), 2200);
      }
    } catch (err) {
      setNotice({ kind: 'error', text: err instanceof Error ? err.message : 'Failed to generate diagnostics report' });
    }
  };

  const handleCopyDiagLogs = async () => {
    if (diagLogs.length === 0) return;
    const text = diagLogs
      .map(
        (e) =>
          `[${e.timestamp}] [${e.level.toUpperCase()}] [${e.source}]${e.instanceId ? ` [${e.instanceId}]` : ''} ${e.message}${e.details ? ` — ${e.details}` : ''}`
      )
      .join('\n');
    const ok = await copyTextToClipboard(text);
    if (ok) {
      setCopiedDiagLogs(true);
      setTimeout(() => setCopiedDiagLogs(false), 2000);
    }
  };

  useEffect(() => {
    void loadAll();
  }, []);

  const handleDetectNetwork = async () => {
    setDetectingNetwork(true);
    setDuckResult(null);
    try {
      const detected = await api.detectNetwork();
      setNetworkStatus(detected);
      onSaved();
    } catch (err) {
      setNotice({ kind: 'error', text: err instanceof Error ? err.message : 'Network detection failed' });
    } finally {
      setDetectingNetwork(false);
    }
  };

  const handleSave = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!settings) return;
    setSaving(true);
    setNotice(null);
    try {
      const parseIds = (txt: string) =>
        txt
          .split(/[,\s]+/)
          .map((s) => s.trim())
          .filter(Boolean);

      const saved = await api.saveSettings({
        ...settings,
        discordAllowedRoleIds: parseIds(allowedRolesText),
        discordAdminRoleIds: parseIds(adminRolesText),
      });
      setSettings(saved);
      const [maint, net] = await Promise.all([
        api.getMaintenanceStatus(),
        api.getNetworkStatus().catch(() => null),
      ]);
      setMaintenance(maint);
      if (net) setNetworkStatus(net);
      setNotice({ kind: 'success', text: 'Settings, public address, guardrails, and schedules saved.' });
      onSaved();
    } catch (err) {
      setNotice({ kind: 'error', text: err instanceof Error ? err.message : 'Save failed' });
    } finally {
      setSaving(false);
    }
  };

  const handleCheckUpdate = async () => {
    setCheckingUpdate(true);
    setNotice(null);
    try {
      await onRefreshUpdater(true);
    } finally {
      setCheckingUpdate(false);
    }
  };

  const handleApplyUpdate = async () => {
    if (!updaterStatus?.latestVersion) return;
    const runningCount = updaterStatus.runningServers.length;
    const confirmMsg =
      runningCount > 0
        ? `Update ServerForge to v${updaterStatus.latestVersion}? ${runningCount} running server(s) will be gracefully saved & stopped${resumeOnUpdate ? ' and automatically rebooted once the update completes.' : ' and left stopped.'}`
        : `Download and apply ServerForge v${updaterStatus.latestVersion} and restart now?`;

    if (!window.confirm(confirmMsg)) return;

    setApplyingUpdate(true);
    setNotice(null);
    try {
      const res = await api.applyUpdate(resumeOnUpdate);
      onStartReconnecting(
        `Updating to ServerForge v${res.targetVersion} and restarting...`,
        res.targetVersion
      );
    } catch (err) {
      setNotice({ kind: 'error', text: err instanceof Error ? err.message : 'Update failed' });
      setApplyingUpdate(false);
    }
  };

  const handleManualRebootPc = async () => {
    const resume = settings?.dailyRebootResumePolicy === 'resume_running';
    if (
      !window.confirm(
        `Gracefully save & stop all running game servers and reboot the Windows server PC right now?`
      )
    ) {
      return;
    }
    setRebootingPc(true);
    setNotice(null);
    try {
      await api.triggerPcReboot(resume, 'Manual reboot requested from Web Dashboard');
      onStartReconnecting('Server PC is rebooting — waiting for ServerForge to come back online...');
    } catch (err) {
      setNotice({ kind: 'error', text: err instanceof Error ? err.message : 'Failed to reboot PC' });
      setRebootingPc(false);
    }
  };

  const handleInspectReboots = async () => {
    setScanningReboots(true);
    setNotice(null);
    try {
      const res = await api.inspectWindowsReboots();
      setInspection(res);
    } catch (err) {
      setNotice({ kind: 'error', text: err instanceof Error ? err.message : 'Inspection failed' });
    } finally {
      setScanningReboots(false);
    }
  };

  const handleDisableTask = async (taskPath: string, taskName: string) => {
    if (!window.confirm(`Disable Windows Scheduled Task "${taskPath}${taskName}"?`)) return;
    setDisablingTask(taskName);
    setNotice(null);
    try {
      await api.disableWindowsTask(taskPath, taskName);
      setNotice({ kind: 'success', text: `Disabled Scheduled Task "${taskName}".` });
      await handleInspectReboots();
    } catch (err) {
      setNotice({ kind: 'error', text: err instanceof Error ? err.message : 'Could not disable task' });
    } finally {
      setDisablingTask(null);
    }
  };

  if (!settings) {
    return <div className="panel panel-body">Loading settings...</div>;
  }

  return (
    <div>
      <header className="page-header">
        <div>
          <h1>Settings, Updates &amp; Automation</h1>
          <p className="page-subtitle">
            Manage one-click GitHub updates, daily PC maintenance reboots, CurseForge integration, and Discord guardrails.
          </p>
        </div>
      </header>

      {notice && (
        <div className={`alert ${notice.kind === 'error' ? 'alert-error' : 'alert-success'}`}>{notice.text}</div>
      )}

      {/* Top Row: One-Click Updates + Managed Daily PC Reboot */}
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(380px, 1fr))', gap: 18, marginBottom: 18 }}>
        <section className="panel">
          <div className="panel-header">
            <h2 style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
              <Download size={16} /> App Updates (GitHub Releases)
            </h2>
            <span className="badge badge-stopped mono">v{updaterStatus?.currentVersion ?? '...'}</span>
          </div>
          <div className="panel-body">
            {updaterStatus?.error && <div className="alert alert-error">{updaterStatus.error}</div>}

            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 12, flexWrap: 'wrap', marginBottom: 12 }}>
              <div>
                <div style={{ fontWeight: 600 }}>
                  {updaterStatus?.updateAvailable
                    ? `Update Ready: v${updaterStatus.latestVersion}`
                    : updaterStatus?.latestVersion
                      ? `Up to date (latest: v${updaterStatus.latestVersion})`
                      : 'Check GitHub for latest build'}
                </div>
                <div style={{ fontSize: 12, color: 'var(--text-muted)' }}>
                  Repo: <span className="mono">{updaterStatus?.githubRepo ?? settings.githubRepo}</span> • Mode:{' '}
                  <span className="mono">{updaterStatus?.installMode ?? 'exe'}</span>
                  {updaterStatus?.exeSizeBytes ? ` • ${(updaterStatus.exeSizeBytes / (1024 * 1024)).toFixed(1)} MB` : ''}
                </div>
              </div>
              <button
                type="button"
                className="btn btn-sm"
                disabled={checkingUpdate || applyingUpdate}
                onClick={handleCheckUpdate}
              >
                <RefreshCw size={13} /> {checkingUpdate ? 'Checking...' : 'Check Now'}
              </button>
            </div>

            {updaterStatus?.updateAvailable && (
              <div style={{ marginBottom: 12 }}>
                {updaterStatus.releaseNotes && (
                  <pre
                    style={{
                      margin: '0 0 10px',
                      padding: 10,
                      borderRadius: 'var(--radius-sm)',
                      background: 'var(--bg-terminal)',
                      border: '1px solid var(--border-subtle)',
                      maxHeight: 110,
                      overflowY: 'auto',
                      fontSize: 11.5,
                      whiteSpace: 'pre-wrap',
                    }}
                  >
                    {updaterStatus.releaseNotes}
                  </pre>
                )}

                <label className="checkbox-row" style={{ paddingTop: 0 }}>
                  <input
                    type="checkbox"
                    checked={resumeOnUpdate}
                    onChange={(e) => setResumeOnUpdate(e.target.checked)}
                  />
                  <span>
                    Save &amp; stop running servers before updating, then automatically reboot them afterward
                    {updaterStatus.runningServers.length > 0
                      ? ` (${updaterStatus.runningServers.length} running now)`
                      : ''}
                  </span>
                </label>

                <button
                  id="apply-update-btn"
                  type="button"
                  className="btn btn-primary"
                  disabled={applyingUpdate}
                  onClick={handleApplyUpdate}
                  style={{ marginTop: 8 }}
                >
                  <Download size={14} />
                  {applyingUpdate ? 'Updating...' : `Update to v${updaterStatus.latestVersion} & Restart`}
                </button>
              </div>
            )}

            {updaterProgress && (
              <div style={{ marginTop: 10 }}>
                <div style={{ fontSize: 12, color: 'var(--text-secondary)', marginBottom: 4 }}>
                  {updaterProgress.message}
                </div>
                <div className="progress-track">
                  <div className="progress-fill" style={{ width: `${updaterProgress.percent}%` }} />
                </div>
              </div>
            )}

            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 10, marginTop: 8, paddingTop: 10, borderTop: '1px solid var(--border-subtle)', flexWrap: 'wrap' }}>
              <label className="checkbox-row" style={{ padding: 0 }}>
                <input
                  type="checkbox"
                  checked={settings.autoUpdateOnBoot}
                  onChange={(e) => setSettings({ ...settings, autoUpdateOnBoot: e.target.checked })}
                />
                <span>Auto-apply new GitHub Releases on PC boot</span>
              </label>
              <button
                type="button"
                className="btn btn-ghost btn-sm"
                onClick={async () => {
                  if (showUpdateLog) {
                    setShowUpdateLog(false);
                    return;
                  }
                  const res = await api.getUpdaterLog().catch(() => ({ log: null }));
                  setUpdateLog(res.log);
                  setShowUpdateLog(true);
                }}
              >
                {showUpdateLog ? 'Hide Update Log' : 'View Update Log'}
              </button>
            </div>

            {showUpdateLog && (
              <pre
                style={{
                  margin: '10px 0 0',
                  padding: 10,
                  borderRadius: 'var(--radius-sm)',
                  background: 'var(--bg-terminal)',
                  border: '1px solid var(--border-subtle)',
                  maxHeight: 160,
                  overflowY: 'auto',
                  fontSize: 11,
                  whiteSpace: 'pre-wrap',
                }}
              >
                {updateLog || 'No update log recorded yet.'}
              </pre>
            )}
          </div>
        </section>

        <section className="panel">
          <div className="panel-header">
            <h2 style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
              <Power size={16} /> Managed Daily PC Reboot
            </h2>
            <span className={`badge ${settings.dailyRebootEnabled ? 'badge-running' : 'badge-stopped'}`}>
              <span className="badge-dot" />
              {settings.dailyRebootEnabled ? `DAILY ${settings.dailyRebootTime}` : 'DISABLED'}
            </span>
          </div>
          <div className="panel-body">
            <p style={{ marginTop: 0, fontSize: 12.5, color: 'var(--text-secondary)' }}>
              Let ServerForge safely save &amp; stop all game worlds before rebooting your Windows 11 PC each morning,
              instead of an external reboot cutting off world saves.
            </p>

            <div className="form-grid" style={{ gap: 12 }}>
              <div className="field">
                <label className="checkbox-row" style={{ paddingTop: 4 }}>
                  <input
                    id="set-daily-reboot"
                    type="checkbox"
                    checked={settings.dailyRebootEnabled}
                    onChange={(e) => setSettings({ ...settings, dailyRebootEnabled: e.target.checked })}
                  />
                  <span>Enable Daily Maintenance Reboot</span>
                </label>
              </div>

              <div className="field">
                <label htmlFor="set-reboot-time">Reboot Time (24h local PC time)</label>
                <input
                  id="set-reboot-time"
                  type="time"
                  className="input mono"
                  value={settings.dailyRebootTime}
                  onChange={(e) => setSettings({ ...settings, dailyRebootTime: e.target.value })}
                />
              </div>

              <div className="field">
                <label htmlFor="set-resume-policy">After Daily Reboot</label>
                <select
                  id="set-resume-policy"
                  className="select"
                  value={settings.dailyRebootResumePolicy}
                  onChange={(e) =>
                    setSettings({
                      ...settings,
                      dailyRebootResumePolicy: e.target.value as 'resume_running' | 'autostart_only',
                    })
                  }
                >
                  <option value="autostart_only">Start only servers marked Auto-Start</option>
                  <option value="resume_running">Resume all servers that were running</option>
                </select>
              </div>

              <div className="field" style={{ justifyContent: 'center' }}>
                <label className="checkbox-row">
                  <input
                    type="checkbox"
                    checked={settings.dailyRebootDelayIfPlayersOnline}
                    onChange={(e) =>
                      setSettings({ ...settings, dailyRebootDelayIfPlayersOnline: e.target.checked })
                    }
                  />
                  <span>Defer 15m if players are online</span>
                </label>
              </div>
            </div>

            {maintenance?.nextRebootAt && (
              <div style={{ fontSize: 12, color: 'var(--text-muted)', marginTop: 10 }}>
                Next scheduled reboot: <strong className="tabular">{new Date(maintenance.nextRebootAt).toLocaleString()}</strong>
              </div>
            )}

            <div className="btn-row" style={{ marginTop: 14, paddingTop: 12, borderTop: '1px solid var(--border-subtle)' }}>
              <button
                id="scan-reboots-btn"
                type="button"
                className="btn btn-sm"
                disabled={scanningReboots}
                onClick={handleInspectReboots}
              >
                <Search size={13} /> {scanningReboots ? 'Scanning Windows...' : 'Scan Existing Auto-Reboots'}
              </button>
              <button
                type="button"
                className="btn btn-danger btn-sm"
                disabled={rebootingPc}
                onClick={handleManualRebootPc}
              >
                <Power size={13} /> {rebootingPc ? 'Rebooting...' : 'Save All & Reboot PC Now'}
              </button>
            </div>

            {inspection && (
              <div
                style={{
                  marginTop: 14,
                  padding: 12,
                  borderRadius: 'var(--radius-sm)',
                  background: 'var(--bg-elevated)',
                  border: '1px solid var(--border-subtle)',
                  fontSize: 12.5,
                }}
              >
                {inspection.notes.map((n, idx) => (
                  <div key={idx} style={{ marginBottom: 8, color: 'var(--text-secondary)' }}>
                    {n}
                  </div>
                ))}

                {inspection.scheduledRebootTasks.length > 0 && (
                  <div style={{ marginBottom: 10 }}>
                    <div style={{ fontWeight: 600, marginBottom: 6 }}>Conflicting Windows Scheduled Tasks:</div>
                    {inspection.scheduledRebootTasks.map((task) => (
                      <div
                        key={`${task.taskPath}${task.taskName}`}
                        style={{
                          display: 'flex',
                          justifyContent: 'space-between',
                          alignItems: 'center',
                          gap: 8,
                          padding: '6px 8px',
                          background: 'var(--bg-surface)',
                          borderRadius: 'var(--radius-sm)',
                          marginBottom: 6,
                        }}
                      >
                        <div style={{ minWidth: 0 }}>
                          <div className="mono" style={{ fontWeight: 600 }}>
                            {task.taskPath}
                            {task.taskName}
                          </div>
                          <div className="mono" style={{ fontSize: 11, color: 'var(--text-muted)', wordBreak: 'break-all' }}>
                            {task.command}
                          </div>
                        </div>
                        <button
                          type="button"
                          className="btn btn-danger btn-sm"
                          disabled={disablingTask === task.taskName}
                          onClick={() => void handleDisableTask(task.taskPath, task.taskName)}
                        >
                          <Slash size={12} /> Disable
                        </button>
                      </div>
                    ))}
                  </div>
                )}

                {inspection.recentRestarts.length > 0 && (
                  <div>
                    <div style={{ fontWeight: 600, marginBottom: 6 }}>Recent Windows Restarts (Event ID 1074):</div>
                    {inspection.recentRestarts.slice(0, 4).map((ev, i) => (
                      <div key={i} style={{ fontSize: 11.5, color: 'var(--text-secondary)', marginBottom: 4 }}>
                        <span className="tabular">{new Date(ev.timestamp).toLocaleString()}</span> —{' '}
                        <span className="mono" style={{ color: 'var(--text-primary)' }}>
                          {ev.process}
                        </span>{' '}
                        ({ev.reason})
                      </div>
                    ))}
                  </div>
                )}
              </div>
            )}
          </div>
        </section>
      </div>

      {/* Main Settings Form + Discord Status & Audit Feed */}
      <div style={{ display: 'grid', gridTemplateColumns: 'minmax(0, 1.35fr) minmax(0, 1fr)', gap: 18 }}>
        <form className="panel" onSubmit={handleSave}>
          <div className="panel-header">
            <h2 style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
              <Shield size={16} /> Guardrails, CurseForge &amp; Discord Roles
            </h2>
          </div>
          <div className="panel-body">
            <div className="form-grid">
              <div className="field full">
                <div
                  style={{
                    padding: 12,
                    borderRadius: 'var(--radius-sm)',
                    background: 'var(--bg-elevated)',
                    border: '1px solid var(--border-subtle)',
                    display: 'flex',
                    flexDirection: 'column',
                    gap: 10,
                  }}
                >
                  <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 10, flexWrap: 'wrap' }}>
                    <div style={{ display: 'flex', alignItems: 'center', gap: 7, fontWeight: 600, fontSize: 13 }}>
                      <Globe size={14} color="var(--accent)" />
                      Public Join Address &amp; DuckDNS
                    </div>
                    <button
                      type="button"
                      className="btn btn-sm"
                      disabled={detectingNetwork}
                      onClick={() => void handleDetectNetwork()}
                    >
                      <RefreshCw size={12} /> {detectingNetwork ? 'Detecting...' : 'Re-detect Now'}
                    </button>
                  </div>

                  {networkStatus && (
                    <div style={{ fontSize: 12, color: 'var(--text-secondary)', display: 'flex', flexDirection: 'column', gap: 4 }}>
                      <div>
                        Active Join Host:{' '}
                        <strong className="mono" style={{ color: 'var(--text-primary)' }}>
                          {networkStatus.effectiveHost}
                        </strong>{' '}
                        <span className="badge badge-running" style={{ fontSize: 10, marginLeft: 4 }}>
                          {formatHostSourceLabel(networkStatus.effectiveHostSource)}
                        </span>
                      </div>
                      <div style={{ display: 'flex', gap: 14, flexWrap: 'wrap' }}>
                        <span>
                          Public IP: <span className="mono">{networkStatus.publicIp ?? 'Not detected'}</span>
                        </span>
                        <span>
                          Local LAN IP: <span className="mono">{networkStatus.lanIp ?? 'Not detected'}</span>
                        </span>
                      </div>
                      {networkStatus.detectedDuckDnsDomains.length > 0 && (
                        <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap', marginTop: 2 }}>
                          <span>Detected DuckDNS on this PC:</span>
                          {networkStatus.detectedDuckDnsDomains.map((dom) => (
                            <button
                              key={dom}
                              type="button"
                              className="btn btn-sm"
                              style={{ padding: '2px 8px', fontSize: 11.5 }}
                              onClick={() =>
                                setSettings({
                                  ...settings,
                                  publicHostMode: 'duckdns',
                                  duckdnsDomain: dom,
                                })
                              }
                            >
                              Use {dom}
                            </button>
                          ))}
                        </div>
                      )}
                    </div>
                  )}

                  <div className="form-grid" style={{ gap: 10 }}>
                    <div className="field">
                      <label htmlFor="set-public-host-mode">Public Address Mode</label>
                      <select
                        id="set-public-host-mode"
                        className="select"
                        value={settings.publicHostMode}
                        onChange={(e) =>
                          setSettings({
                            ...settings,
                            publicHostMode: e.target.value as PublicHostMode,
                          })
                        }
                      >
                        <option value="auto">Automatic (DuckDNS -&gt; Public IP)</option>
                        <option value="duckdns">DuckDNS Domain</option>
                        <option value="manual">Custom Hostname / Tailscale / IP</option>
                      </select>
                    </div>

                    <div className="field">
                      <label htmlFor="set-duckdns-domain">DuckDNS Domain (optional)</label>
                      <input
                        id="set-duckdns-domain"
                        className="input mono"
                        value={settings.duckdnsDomain}
                        onChange={(e) => {
                          setDuckResult(null);
                          setSettings({ ...settings, duckdnsDomain: e.target.value });
                        }}
                        placeholder="e.g., myserver.duckdns.org"
                      />
                    </div>

                    <div className="field full">
                      <label htmlFor="set-duckdns-token">DuckDNS Account Token (optional — for built-in DDNS updates)</label>
                      <div style={{ display: 'flex', gap: 8 }}>
                        <input
                          id="set-duckdns-token"
                          type={showDuckToken ? 'text' : 'password'}
                          className="input mono"
                          value={settings.duckdnsToken}
                          onChange={(e) => {
                            setDuckResult(null);
                            setSettings({ ...settings, duckdnsToken: e.target.value });
                          }}
                          placeholder="Paste your DuckDNS token from duckdns.org"
                        />
                        <button
                          type="button"
                          className="btn btn-sm"
                          title={showDuckToken ? 'Hide token' : 'Show token'}
                          onClick={() => setShowDuckToken((v) => !v)}
                        >
                          {showDuckToken ? <EyeOff size={14} /> : <Eye size={14} />}
                        </button>
                        <button
                          type="button"
                          className="btn btn-primary btn-sm"
                          disabled={updatingDuckDns}
                          onClick={async () => {
                            setUpdatingDuckDns(true);
                            setDuckResult(null);
                            try {
                              const res = await api.updateDuckDns({
                                domain: settings.duckdnsDomain,
                                token: settings.duckdnsToken,
                                saveOnSuccess: true,
                                autoUpdate: settings.duckdnsAutoUpdate,
                              });
                              setDuckResult({ ok: res.ok, message: res.message });
                              setNetworkStatus(res.status);
                              if (res.ok && res.saved) {
                                setSettings({
                                  ...settings,
                                  duckdnsDomain: res.domain,
                                  publicHostMode: 'duckdns',
                                });
                                onSaved();
                              }
                            } catch (err) {
                              setDuckResult({
                                ok: false,
                                message: err instanceof Error ? err.message : 'DuckDNS update failed',
                              });
                            } finally {
                              setUpdatingDuckDns(false);
                            }
                          }}
                        >
                          <CheckCircle2 size={14} /> {updatingDuckDns ? 'Updating...' : 'Update & Save DuckDNS'}
                        </button>
                      </div>
                      <label className="checkbox-row" style={{ paddingTop: 6 }}>
                        <input
                          type="checkbox"
                          checked={settings.duckdnsAutoUpdate}
                          onChange={(e) => setSettings({ ...settings, duckdnsAutoUpdate: e.target.checked })}
                        />
                        <span>Keep DuckDNS IP updated automatically from ServerForge (every 15m)</span>
                      </label>
                      {duckResult && (
                        <div
                          className={`alert ${duckResult.ok ? 'alert-success' : 'alert-error'}`}
                          style={{ marginTop: 6, marginBottom: 0 }}
                        >
                          {duckResult.message}
                        </div>
                      )}
                    </div>

                    {settings.publicHostMode !== 'duckdns' && (
                      <div className="field full">
                        <label htmlFor="set-public-host">Custom / Tailscale Hostname or IP</label>
                        <input
                          id="set-public-host"
                          className="input mono"
                          value={settings.publicHost}
                          onChange={(e) => setSettings({ ...settings, publicHost: e.target.value })}
                          placeholder="e.g., 100.64.0.12 or games.yourdomain.com (leave localhost for auto)"
                        />
                        <span className="field-hint">
                          Displayed in copyable join addresses and Discord embeds when friends boot a server.
                        </span>
                      </div>
                    )}
                  </div>
                </div>
              </div>

              <div className="field full">
                <label htmlFor="set-cf-key" style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                  <Package size={13} /> CurseForge Core API Key (for Modded Minecraft)
                </label>
                <div style={{ display: 'flex', gap: 8 }}>
                  <input
                    id="set-cf-key"
                    type={showCfKey ? 'text' : 'password'}
                    className="input mono"
                    value={settings.curseforgeApiKey}
                    onChange={(e) => {
                      setCfTestResult(null);
                      setSettings({ ...settings, curseforgeApiKey: e.target.value });
                    }}
                    placeholder="$2a$10$... (60-char Core API key from console.curseforge.com)"
                  />
                  <button
                    type="button"
                    className="btn btn-sm"
                    title={showCfKey ? 'Hide key' : 'Show key'}
                    onClick={() => setShowCfKey((v) => !v)}
                  >
                    {showCfKey ? <EyeOff size={14} /> : <Eye size={14} />}
                  </button>
                  <button
                    type="button"
                    className="btn btn-primary btn-sm"
                    disabled={testingCfKey}
                    onClick={async () => {
                      setTestingCfKey(true);
                      setCfTestResult(null);
                      try {
                        const res = await api.testCurseForgeKey(settings.curseforgeApiKey);
                        if (res.normalizedKey && res.normalizedKey !== settings.curseforgeApiKey) {
                          setSettings({ ...settings, curseforgeApiKey: res.normalizedKey });
                        }
                        setCfTestResult({ ok: res.ok, message: res.message });
                        if (res.ok && res.saved) {
                          onSaved();
                        }
                      } catch (err) {
                        setCfTestResult({
                          ok: false,
                          message: err instanceof Error ? err.message : 'Test failed',
                        });
                      } finally {
                        setTestingCfKey(false);
                      }
                    }}
                  >
                    <CheckCircle2 size={14} /> {testingCfKey ? 'Verifying...' : 'Verify & Save Key'}
                  </button>
                </div>
                {cfTestResult && (
                  <div
                    className={`alert ${cfTestResult.ok ? 'alert-success' : 'alert-error'}`}
                    style={{ marginTop: 8, marginBottom: 0 }}
                  >
                    {cfTestResult.message}
                  </div>
                )}
                <span className="field-hint">
                  Use a <strong>Core API Key</strong> starting with <code className="mono">$2a$10$...</code> from{' '}
                  <a
                    href="https://console.curseforge.com/"
                    target="_blank"
                    rel="noreferrer"
                    style={{ color: 'var(--accent)', textDecoration: 'underline' }}
                  >
                    console.curseforge.com
                  </a>{' '}
                  (API keys tab). Clicking <strong>Verify &amp; Save Key</strong> tests live modpack search and saves it automatically.
                </span>
              </div>

              <div className="field">
                <label htmlFor="set-max-concurrent">Max Concurrent Running Servers</label>
                <input
                  id="set-max-concurrent"
                  type="number"
                  min={1}
                  max={32}
                  className="input tabular"
                  value={settings.maxConcurrentServers}
                  onChange={(e) => setSettings({ ...settings, maxConcurrentServers: Number(e.target.value) })}
                />
              </div>

              <div className="field">
                <label htmlFor="set-ram-reserve">Host OS RAM Reserve (GB)</label>
                <input
                  id="set-ram-reserve"
                  type="number"
                  min={1}
                  max={64}
                  className="input tabular"
                  value={settings.hostRamReserveGb}
                  onChange={(e) => setSettings({ ...settings, hostRamReserveGb: Number(e.target.value) })}
                />
                <span className="field-hint">Always kept free so Windows 11 stays responsive.</span>
              </div>

              <div className="field">
                <label htmlFor="set-default-lease">Default Temporary Lease (minutes)</label>
                <input
                  id="set-default-lease"
                  type="number"
                  min={15}
                  max={1440}
                  className="input tabular"
                  value={settings.defaultLeaseMinutes}
                  onChange={(e) => setSettings({ ...settings, defaultLeaseMinutes: Number(e.target.value) })}
                />
              </div>

              <div className="field">
                <label htmlFor="set-max-lease">Max Temporary Lease Cap (minutes)</label>
                <input
                  id="set-max-lease"
                  type="number"
                  min={30}
                  max={2880}
                  className="input tabular"
                  value={settings.maxLeaseMinutes}
                  onChange={(e) => setSettings({ ...settings, maxLeaseMinutes: Number(e.target.value) })}
                />
              </div>

              <div className="field">
                <label htmlFor="set-idle">Idle Auto-Shutdown (minutes at 0 players)</label>
                <input
                  id="set-idle"
                  type="number"
                  min={0}
                  max={240}
                  className="input tabular"
                  value={settings.defaultIdleTimeoutMinutes}
                  onChange={(e) => setSettings({ ...settings, defaultIdleTimeoutMinutes: Number(e.target.value) })}
                />
              </div>

              <div className="field">
                <label htmlFor="set-warn">Shutdown Warning Lead Time (minutes)</label>
                <input
                  id="set-warn"
                  type="number"
                  min={1}
                  max={60}
                  className="input tabular"
                  value={settings.warningBeforeStopMinutes}
                  onChange={(e) => setSettings({ ...settings, warningBeforeStopMinutes: Number(e.target.value) })}
                />
              </div>

              <div className="field full">
                <label htmlFor="set-allowed-roles">Discord Allowed Role IDs (comma-separated)</label>
                <input
                  id="set-allowed-roles"
                  className="input mono"
                  value={allowedRolesText}
                  onChange={(e) => setAllowedRolesText(e.target.value)}
                  placeholder="123456789012345678, 987654321098765432"
                />
              </div>

              <div className="field full">
                <label htmlFor="set-admin-roles">Discord Admin Role IDs (comma-separated)</label>
                <input
                  id="set-admin-roles"
                  className="input mono"
                  value={adminRolesText}
                  onChange={(e) => setAdminRolesText(e.target.value)}
                  placeholder="Optional admin override roles"
                />
              </div>

              <div className="field full">
                <label htmlFor="set-channel">Default Discord Notification Channel ID</label>
                <input
                  id="set-channel"
                  className="input mono"
                  value={settings.discordNotifyChannelId}
                  onChange={(e) => setSettings({ ...settings, discordNotifyChannelId: e.target.value })}
                  placeholder="Channel ID for auto-shutdown and daily reboot alerts"
                />
              </div>

              <div className="field full">
                <label htmlFor="set-github-repo">GitHub Releases Repository (for Updates)</label>
                <input
                  id="set-github-repo"
                  className="input mono"
                  value={settings.githubRepo}
                  onChange={(e) => setSettings({ ...settings, githubRepo: e.target.value })}
                />
              </div>
            </div>

            <div style={{ marginTop: 18 }}>
              <button id="save-settings-btn" type="submit" className="btn btn-primary" disabled={saving}>
                <Save size={14} /> {saving ? 'Saving...' : 'Save Settings'}
              </button>
            </div>
          </div>
        </form>

        <div style={{ display: 'flex', flexDirection: 'column', gap: 18 }}>
          <section className="panel">
            <div className="panel-header">
              <h2 style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                <Bot size={16} /> Discord Bot Status
              </h2>
              <span className={`badge ${metrics?.discordConnected ? 'badge-running' : 'badge-stopped'}`}>
                <span className="badge-dot" />
                {metrics?.discordConnected ? 'CONNECTED' : 'OFFLINE'}
              </span>
            </div>
            <div className="panel-body" style={{ fontSize: 13, color: 'var(--text-secondary)' }}>
              {metrics?.discordConnected ? (
                <p style={{ marginTop: 0 }}>
                  Logged in as <strong style={{ color: 'var(--text-primary)' }}>{metrics.discordBotTag}</strong>.
                </p>
              ) : (
                <p style={{ marginTop: 0 }}>
                  Add <code className="mono">DISCORD_TOKEN</code>, <code className="mono">DISCORD_CLIENT_ID</code>, and{' '}
                  <code className="mono">DISCORD_GUILD_ID</code> to <code className="mono">.env</code> and restart
                  ServerForge to activate slash commands.
                </p>
              )}

              <div style={{ display: 'flex', flexDirection: 'column', gap: 6, marginTop: 12 }}>
                <div>
                  <code className="mono" style={{ color: 'var(--text-primary)' }}>/server list</code> — List all servers &amp; slots
                </div>
                <div>
                  <code className="mono" style={{ color: 'var(--text-primary)' }}>/server start &lt;name&gt; [hours]</code> — Temp boot
                </div>
                <div>
                  <code className="mono" style={{ color: 'var(--text-primary)' }}>/server extend &lt;name&gt; [minutes]</code> — Add time
                </div>
                <div>
                  <code className="mono" style={{ color: 'var(--text-primary)' }}>/server stop &lt;name&gt;</code> — Save &amp; shut down
                </div>
                <div>
                  <code className="mono" style={{ color: 'var(--text-primary)' }}>/server status &lt;name&gt;</code> — Live players &amp; timer
                </div>
              </div>
            </div>
          </section>

          <section className="panel">
            <div className="panel-header" style={{ flexWrap: 'wrap', gap: 8 }}>
              <h2 style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                <Bug size={16} /> Diagnostics &amp; App Logs
              </h2>
              <button
                type="button"
                className="btn btn-sm"
                onClick={() => void handleCopySystemDiagnostics()}
                title="Copy sanitized host, fleet, and backend error report"
              >
                {copiedSysReport ? <Check size={12} color="var(--status-online)" /> : <Copy size={12} />}
                {copiedSysReport ? 'Copied Report!' : 'Copy System Report'}
              </button>
            </div>
            <div className="panel-body" style={{ padding: '10px 12px' }}>
              <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 8, flexWrap: 'wrap' }}>
                <div style={{ display: 'flex', gap: 6 }}>
                  <button
                    type="button"
                    className={`terminal-filter-btn ${diagFilter === 'warn' ? 'active' : ''}`}
                    onClick={() => {
                      setDiagFilter('warn');
                      void loadDiagnostics('warn');
                    }}
                  >
                    Errors &amp; Warnings
                  </button>
                  <button
                    type="button"
                    className={`terminal-filter-btn ${diagFilter === 'all' ? 'active' : ''}`}
                    onClick={() => {
                      setDiagFilter('all');
                      void loadDiagnostics('all');
                    }}
                  >
                    All
                  </button>
                </div>
                <div style={{ display: 'flex', gap: 6 }}>
                  <button
                    type="button"
                    className="btn btn-sm"
                    disabled={diagLogs.length === 0}
                    onClick={() => void handleCopyDiagLogs()}
                  >
                    {copiedDiagLogs ? <Check size={12} color="var(--status-online)" /> : <Copy size={12} />}
                    {copiedDiagLogs ? 'Copied!' : 'Copy Logs'}
                  </button>
                  <button
                    type="button"
                    className="btn btn-sm"
                    disabled={loadingDiag}
                    onClick={() => void loadDiagnostics()}
                  >
                    <RefreshCw size={12} className={loadingDiag ? 'spin' : ''} />
                  </button>
                </div>
              </div>
            </div>
            <div className="diag-log-list">
              {diagLogs.length === 0 ? (
                <div style={{ padding: 14, color: 'var(--text-muted)' }}>
                  No {diagFilter === 'warn' ? 'errors or warnings' : 'diagnostic logs'} recorded yet.
                </div>
              ) : (
                diagLogs.map((entry) => (
                  <div key={entry.id} className="diag-log-row">
                    <div style={{ display: 'flex', alignItems: 'center', gap: 6, flexWrap: 'wrap' }}>
                      <span className={`diag-level diag-level-${entry.level}`}>{entry.level}</span>
                      <span style={{ color: 'var(--text-muted)' }}>{entry.timestamp.slice(11, 19)}</span>
                      <span style={{ color: 'var(--text-secondary)' }}>[{entry.source}]</span>
                    </div>
                    <div style={{ color: 'var(--text-primary)', wordBreak: 'break-word' }}>{entry.message}</div>
                    {entry.details && (
                      <div style={{ color: 'var(--text-muted)', wordBreak: 'break-word' }}>{entry.details}</div>
                    )}
                  </div>
                ))
              )}
            </div>
          </section>

          <section className="panel">
            <div className="panel-header">
              <h2>Recent Activity</h2>
            </div>
            <div className="panel-body" style={{ padding: 0, maxHeight: 330, overflowY: 'auto' }}>
              {auditLogs.length === 0 ? (
                <div style={{ padding: 18, color: 'var(--text-muted)' }}>No activity logged yet.</div>
              ) : (
                <table className="data-table">
                  <tbody>
                    {auditLogs.map((log) => (
                      <tr key={log.id}>
                        <td>
                          <div style={{ color: 'var(--text-primary)', fontWeight: 500 }}>{log.details || log.action}</div>
                          <div style={{ fontSize: 11.5, color: 'var(--text-muted)' }}>
                            {log.actor} ({log.source}) • {new Date(log.timestamp).toLocaleTimeString()}
                          </div>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              )}
            </div>
          </section>
        </div>
      </div>
    </div>
  );
}
