import React, { useState } from 'react';
import { Download, Power, RefreshCw, Search, Slash } from 'lucide-react';
import type {
  MaintenanceStatus,
  SystemSettings,
  UpdaterStatus,
  WindowsRebootInspection,
} from '@serverforge/shared';
import { api } from '../../api';
import type { ConfirmDialogOptions } from '../ConfirmModal';
import type { PushToastFn } from '../ToastStack';

interface UpdatesMaintenanceTabProps {
  settings: SystemSettings;
  maintenance: MaintenanceStatus | null;
  updaterStatus: UpdaterStatus | null;
  updaterProgress: { stage: string; percent: number; message: string } | null;
  onChange: (patch: Partial<SystemSettings>) => void;
  onRefreshUpdater: (force?: boolean) => Promise<void>;
  onStartReconnecting: (label: string, expectedVersion?: string) => void;
  onConfirm: (opts: ConfirmDialogOptions) => Promise<boolean>;
  onToast: PushToastFn;
}

export function UpdatesMaintenanceTab({
  settings,
  maintenance,
  updaterStatus,
  updaterProgress,
  onChange,
  onRefreshUpdater,
  onStartReconnecting,
  onConfirm,
  onToast,
}: UpdatesMaintenanceTabProps) {
  const [checkingUpdate, setCheckingUpdate] = useState(false);
  const [applyingUpdate, setApplyingUpdate] = useState(false);
  const [resumeOnUpdate, setResumeOnUpdate] = useState(true);
  const [updateLog, setUpdateLog] = useState<string | null>(null);
  const [showUpdateLog, setShowUpdateLog] = useState(false);

  const [rebootingPc, setRebootingPc] = useState(false);
  const [inspection, setInspection] = useState<WindowsRebootInspection | null>(null);
  const [scanningReboots, setScanningReboots] = useState(false);
  const [disablingTask, setDisablingTask] = useState<string | null>(null);

  const handleCheckUpdate = async () => {
    setCheckingUpdate(true);
    try {
      await onRefreshUpdater(true);
      onToast('info', 'Checked GitHub Releases for updates.');
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

    const confirmed = await onConfirm({
      title: `Update to v${updaterStatus.latestVersion}`,
      message: confirmMsg,
      confirmLabel: 'Update & Restart',
      tone: 'primary',
    });
    if (!confirmed) return;

    setApplyingUpdate(true);
    try {
      const res = await api.applyUpdate(resumeOnUpdate);
      onStartReconnecting(
        `Updating to ServerForge v${res.targetVersion} and restarting...`,
        res.targetVersion
      );
    } catch (err) {
      onToast('error', err instanceof Error ? err.message : 'Update failed');
      setApplyingUpdate(false);
    }
  };

  const handleManualRebootPc = async () => {
    const resume = settings.dailyRebootResumePolicy === 'resume_running';
    const confirmed = await onConfirm({
      title: 'Reboot Server PC Now?',
      message:
        'ServerForge will gracefully save & stop all running game servers and immediately reboot the Windows server PC.',
      confirmLabel: 'Save All & Reboot PC',
      tone: 'danger',
    });
    if (!confirmed) return;

    setRebootingPc(true);
    try {
      await api.triggerPcReboot(resume, 'Manual reboot requested from Web Dashboard');
      onStartReconnecting('Server PC is rebooting — waiting for ServerForge to come back online...');
    } catch (err) {
      onToast('error', err instanceof Error ? err.message : 'Failed to reboot PC');
      setRebootingPc(false);
    }
  };

  const handleInspectReboots = async () => {
    setScanningReboots(true);
    try {
      const res = await api.inspectWindowsReboots();
      setInspection(res);
    } catch (err) {
      onToast('error', err instanceof Error ? err.message : 'Inspection failed');
    } finally {
      setScanningReboots(false);
    }
  };

  const handleDisableTask = async (taskPath: string, taskName: string) => {
    const confirmed = await onConfirm({
      title: 'Disable Windows Scheduled Task?',
      message: `Disable Windows Scheduled Task "${taskPath}${taskName}" so it no longer interrupts running game servers?`,
      confirmLabel: 'Disable Task',
      tone: 'danger',
    });
    if (!confirmed) return;

    setDisablingTask(taskName);
    try {
      await api.disableWindowsTask(taskPath, taskName);
      onToast('success', `Disabled Scheduled Task "${taskName}".`);
      await handleInspectReboots();
    } catch (err) {
      onToast('error', err instanceof Error ? err.message : 'Could not disable task');
    } finally {
      setDisablingTask(null);
    }
  };

  return (
    <div className="settings-grid-two">
      <section className="panel">
        <div className="panel-header">
          <h2 style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
            <Download size={16} /> App Updates (GitHub Releases)
          </h2>
          <span className={`badge ${updaterStatus?.updateAvailable ? 'badge-starting' : 'badge-stopped'} mono`}>
            v{updaterStatus?.currentVersion ?? '...'}
          </span>
        </div>
        <div className="panel-body">
          {updaterStatus?.error && <div className="alert alert-error">{updaterStatus.error}</div>}

          <div
            style={{
              display: 'flex',
              justifyContent: 'space-between',
              alignItems: 'center',
              gap: 12,
              flexWrap: 'wrap',
              marginBottom: 14,
            }}
          >
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
              onClick={() => void handleCheckUpdate()}
            >
              <RefreshCw size={13} className={checkingUpdate ? 'spin' : ''} />{' '}
              {checkingUpdate ? 'Checking...' : 'Check Now'}
            </button>
          </div>

          {updaterStatus?.updateAvailable && (
            <div style={{ marginBottom: 14 }}>
              {updaterStatus.releaseNotes && (
                <pre
                  style={{
                    margin: '0 0 10px',
                    padding: 10,
                    borderRadius: 'var(--radius-sm)',
                    background: 'var(--bg-terminal)',
                    border: '1px solid var(--border-subtle)',
                    maxHeight: 130,
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
                onClick={() => void handleApplyUpdate()}
                style={{ marginTop: 10 }}
              >
                <Download size={14} />
                {applyingUpdate ? 'Updating...' : `Update to v${updaterStatus.latestVersion} & Restart`}
              </button>
            </div>
          )}

          {updaterProgress && (
            <div style={{ marginTop: 10, marginBottom: 10 }}>
              <div style={{ fontSize: 12, color: 'var(--text-secondary)', marginBottom: 4 }}>
                {updaterProgress.message}
              </div>
              <div className="progress-track">
                <div className="progress-fill" style={{ width: `${updaterProgress.percent}%` }} />
              </div>
            </div>
          )}

          <div
            style={{
              display: 'flex',
              justifyContent: 'space-between',
              alignItems: 'center',
              gap: 10,
              marginTop: 8,
              paddingTop: 12,
              borderTop: '1px solid var(--border-subtle)',
              flexWrap: 'wrap',
            }}
          >
            <label className="checkbox-row" style={{ padding: 0 }}>
              <input
                type="checkbox"
                checked={settings.autoUpdateOnBoot}
                onChange={(e) => onChange({ autoUpdateOnBoot: e.target.checked })}
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
          <p className="settings-card-desc">
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
                  onChange={(e) => onChange({ dailyRebootEnabled: e.target.checked })}
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
                onChange={(e) => onChange({ dailyRebootTime: e.target.value })}
              />
            </div>

            <div className="field">
              <label htmlFor="set-resume-policy">After Daily Reboot</label>
              <select
                id="set-resume-policy"
                className="select"
                value={settings.dailyRebootResumePolicy}
                onChange={(e) =>
                  onChange({
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
                  onChange={(e) => onChange({ dailyRebootDelayIfPlayersOnline: e.target.checked })}
                />
                <span>Defer 15m if players are online</span>
              </label>
            </div>
          </div>

          {maintenance?.nextRebootAt && (
            <div style={{ fontSize: 12, color: 'var(--text-muted)', marginTop: 10 }}>
              Next scheduled reboot:{' '}
              <strong className="tabular">{new Date(maintenance.nextRebootAt).toLocaleString()}</strong>
            </div>
          )}

          <div className="btn-row" style={{ marginTop: 14, paddingTop: 12, borderTop: '1px solid var(--border-subtle)' }}>
            <button
              id="scan-reboots-btn"
              type="button"
              className="btn btn-sm"
              disabled={scanningReboots}
              onClick={() => void handleInspectReboots()}
            >
              <Search size={13} /> {scanningReboots ? 'Scanning Windows...' : 'Scan Existing Auto-Reboots'}
            </button>
            <button
              type="button"
              className="btn btn-danger btn-sm"
              disabled={rebootingPc}
              onClick={() => void handleManualRebootPc()}
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
  );
}
