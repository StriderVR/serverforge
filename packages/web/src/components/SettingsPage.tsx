import React, { useEffect, useState } from 'react';
import {
  Bot,
  CheckCircle2,
  Download,
  Eye,
  EyeOff,
  Package,
  Power,
  RefreshCw,
  Save,
  Search,
  Shield,
  Slash,
} from 'lucide-react';
import type {
  AuditLogEntry,
  HostMetrics,
  MaintenanceStatus,
  SystemSettings,
  UpdaterStatus,
  WindowsRebootInspection,
} from '@serverforge/shared';
import { api } from '../api';

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
  const [allowedRolesText, setAllowedRolesText] = useState('');
  const [adminRolesText, setAdminRolesText] = useState('');
  const [auditLogs, setAuditLogs] = useState<AuditLogEntry[]>([]);

  const [saving, setSaving] = useState(false);
  const [checkingUpdate, setCheckingUpdate] = useState(false);
  const [applyingUpdate, setApplyingUpdate] = useState(false);
  const [resumeOnUpdate, setResumeOnUpdate] = useState(true);
  const [rebootingPc, setRebootingPc] = useState(false);

  const [showCfKey, setShowCfKey] = useState(false);
  const [testingCfKey, setTestingCfKey] = useState(false);
  const [cfTestResult, setCfTestResult] = useState<{ ok: boolean; message: string } | null>(null);
  const [updateLog, setUpdateLog] = useState<string | null>(null);
  const [showUpdateLog, setShowUpdateLog] = useState(false);

  const [inspection, setInspection] = useState<WindowsRebootInspection | null>(null);
  const [scanningReboots, setScanningReboots] = useState(false);
  const [disablingTask, setDisablingTask] = useState<string | null>(null);

  const [notice, setNotice] = useState<{ kind: 'success' | 'error'; text: string } | null>(null);

  const loadAll = async () => {
    const [s, logs, maint] = await Promise.all([
      api.getSettings(),
      api.getAuditLogs(40),
      api.getMaintenanceStatus(),
    ]);
    setSettings(s);
    setMaintenance(maint);
    setAllowedRolesText(s.discordAllowedRoleIds.join(', '));
    setAdminRolesText(s.discordAdminRoleIds.join(', '));
    setAuditLogs(logs);
  };

  useEffect(() => {
    void loadAll();
  }, []);

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
      setMaintenance(await api.getMaintenanceStatus());
      setNotice({ kind: 'success', text: 'Settings, guardrails, and schedules saved.' });
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
                <label htmlFor="set-public-host">Public / Tailscale Hostname or IP</label>
                <input
                  id="set-public-host"
                  className="input mono"
                  value={settings.publicHost}
                  onChange={(e) => setSettings({ ...settings, publicHost: e.target.value })}
                  placeholder="e.g., 100.64.0.12 or games.yourdomain.com"
                />
                <span className="field-hint">
                  Displayed in copyable join addresses and Discord embeds when friends boot a server.
                </span>
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
