import React, { useEffect, useState } from 'react';
import {
  AlertTriangle,
  Bell,
  CheckCircle2,
  Copy,
  Download,
  FileSearch,
  KeyRound,
  Lock,
  LogOut,
  Monitor,
  RefreshCw,
  ShieldAlert,
  ShieldCheck,
  Trash2,
} from 'lucide-react';
import type {
  AuditLogEntry,
  AuthSessionSummary,
  SecurityHealthReport,
  SystemSettings,
  SystemSettingsResponse,
  TotpEnrollmentPayload,
  TotpStatus,
} from '@serverforge/shared';
import { api } from '../../api';
import type { ConfirmDialogOptions } from '../ConfirmModal';
import type { PushToastFn } from '../ToastStack';

interface SecurityTabProps {
  settings: SystemSettingsResponse;
  onChange: (patch: Partial<SystemSettings>) => void;
  onSyncSavedSetting: (patch: Partial<SystemSettingsResponse>) => void;
  onConfirm: (opts: ConfirmDialogOptions) => Promise<boolean>;
  onToast: PushToastFn;
}

function summarizeUserAgent(ua: string): string {
  const s = ua.trim();
  if (!s) return 'Unknown client';
  let browser = 'Browser';
  if (/Edg\//i.test(s)) browser = 'Microsoft Edge';
  else if (/Chrome\//i.test(s) && !/Chromium/i.test(s)) browser = 'Chrome';
  else if (/Firefox\//i.test(s)) browser = 'Firefox';
  else if (/Safari\//i.test(s) && !/Chrome\//i.test(s)) browser = 'Safari';
  else if (/curl|node|undici|light-my-request/i.test(s)) browser = 'API Client';

  let os = '';
  if (/Windows/i.test(s)) os = 'Windows';
  else if (/Mac OS X|Macintosh/i.test(s)) os = 'macOS';
  else if (/Android/i.test(s)) os = 'Android';
  else if (/iPhone|iPad/i.test(s)) os = 'iOS';
  else if (/Linux/i.test(s)) os = 'Linux';

  return os ? `${browser} on ${os}` : browser;
}

function downloadBlob(content: string, mimeType: string, filename: string) {
  const blob = new Blob([content], { type: mimeType });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
}

export function SecurityTab({
  settings,
  onChange,
  onSyncSavedSetting,
  onConfirm,
  onToast,
}: SecurityTabProps) {
  const [health, setHealth] = useState<SecurityHealthReport | null>(null);
  const [loadingHealth, setLoadingHealth] = useState(false);

  const [sessions, setSessions] = useState<AuthSessionSummary[]>([]);
  const [loadingSessions, setLoadingSessions] = useState(false);

  const [currentPassword, setCurrentPassword] = useState('');
  const [newPassword, setNewPassword] = useState('');
  const [confirmNewPassword, setConfirmNewPassword] = useState('');
  const [changingPassword, setChangingPassword] = useState(false);

  const [totpStatus, setTotpStatus] = useState<TotpStatus | null>(null);
  const [enrollment, setEnrollment] = useState<TotpEnrollmentPayload | null>(null);
  const [verifyCode, setVerifyCode] = useState('');
  const [disablePassword, setDisablePassword] = useState('');
  const [busyTotp, setBusyTotp] = useState(false);

  // Password-confirmed Host Lockdown state
  const [lockFsDraft, setLockFsDraft] = useState(settings.lockHostFsBrowsing);
  const [blockExeDraft, setBlockExeDraft] = useState(settings.blockExecutableUploads);
  const [lockdownPassword, setLockdownPassword] = useState('');
  const [savingLockdown, setSavingLockdown] = useState(false);

  // Searchable Audit Log viewer state
  const [auditItems, setAuditItems] = useState<AuditLogEntry[]>([]);
  const [auditTotal, setAuditTotal] = useState(0);
  const [auditSource, setAuditSource] = useState<'web' | 'discord' | 'system' | ''>('');
  const [auditSearch, setAuditSearch] = useState('');
  const [auditOffset, setAuditOffset] = useState(0);
  const [loadingAudit, setLoadingAudit] = useState(false);
  const AUDIT_PAGE_SIZE = 25;

  useEffect(() => {
    setLockFsDraft(settings.lockHostFsBrowsing);
    setBlockExeDraft(settings.blockExecutableUploads);
  }, [settings.lockHostFsBrowsing, settings.blockExecutableUploads]);

  const loadHealth = async () => {
    setLoadingHealth(true);
    try {
      const report = await api.getSecurityHealth();
      setHealth(report);
    } catch {
      // non-fatal
    } finally {
      setLoadingHealth(false);
    }
  };

  const loadSecurityData = async () => {
    setLoadingSessions(true);
    try {
      const [sess, totp, report] = await Promise.all([
        api.getAuthSessions(),
        api.getTotpStatus(),
        api.getSecurityHealth(),
      ]);
      setSessions(sess);
      setTotpStatus(totp);
      setHealth(report);
    } catch (err) {
      onToast('error', err instanceof Error ? err.message : 'Failed to load security data');
    } finally {
      setLoadingSessions(false);
    }
  };

  const loadAuditLogs = async (
    nextOffset = auditOffset,
    nextSource = auditSource,
    nextSearch = auditSearch
  ) => {
    setLoadingAudit(true);
    try {
      const res = await api.queryAuditLogs({
        source: nextSource,
        q: nextSearch.trim() || undefined,
        limit: AUDIT_PAGE_SIZE,
        offset: nextOffset,
      });
      setAuditItems(res.items);
      setAuditTotal(res.total);
      setAuditOffset(res.offset);
    } catch (err) {
      onToast('error', err instanceof Error ? err.message : 'Failed to load audit logs');
    } finally {
      setLoadingAudit(false);
    }
  };

  useEffect(() => {
    void loadSecurityData();
    void loadAuditLogs(0, '', '');
  }, []);

  const handleApplyLockdown = async (e: React.FormEvent) => {
    e.preventDefault();
    setSavingLockdown(true);
    try {
      const updated = await api.updateSecurityLockdown({
        currentPassword: lockdownPassword,
        lockHostFsBrowsing: lockFsDraft,
        blockExecutableUploads: blockExeDraft,
      });
      setLockdownPassword('');
      onSyncSavedSetting({
        lockHostFsBrowsing: updated.lockHostFsBrowsing,
        blockExecutableUploads: updated.blockExecutableUploads,
      });
      onToast('success', 'Host Lockdown settings updated.');
      await Promise.all([loadHealth(), loadAuditLogs(0, auditSource, auditSearch)]);
    } catch (err) {
      onToast('error', err instanceof Error ? err.message : 'Failed to update Host Lockdown');
    } finally {
      setSavingLockdown(false);
    }
  };

  const handleChangePassword = async (e: React.FormEvent) => {
    e.preventDefault();
    if (newPassword !== confirmNewPassword) {
      onToast('error', 'New passwords do not match.');
      return;
    }
    setChangingPassword(true);
    try {
      const res = await api.changePassword(currentPassword, newPassword);
      setCurrentPassword('');
      setNewPassword('');
      setConfirmNewPassword('');
      onToast(
        'success',
        `Password updated.${res.revokedOtherSessions > 0 ? ` Signed out ${res.revokedOtherSessions} other session(s).` : ''}`
      );
      await Promise.all([loadSecurityData(), loadAuditLogs(0, auditSource, auditSearch)]);
    } catch (err) {
      onToast('error', err instanceof Error ? err.message : 'Password change failed');
    } finally {
      setChangingPassword(false);
    }
  };

  const handleRevokeSession = async (session: AuthSessionSummary) => {
    if (session.isCurrent) {
      const ok = await onConfirm({
        title: 'Sign out current session?',
        message: 'Revoking your current session will sign you out immediately.',
        confirmLabel: 'Sign Out',
        tone: 'danger',
      });
      if (!ok) return;
    }
    try {
      await api.revokeAuthSession(session.id);
      if (session.isCurrent) {
        window.location.reload();
        return;
      }
      onToast('success', 'Session revoked.');
      await loadSecurityData();
    } catch (err) {
      onToast('error', err instanceof Error ? err.message : 'Failed to revoke session');
    }
  };

  const handleRevokeAll = async (keepCurrent: boolean) => {
    const ok = await onConfirm({
      title: keepCurrent ? 'Sign out all other devices?' : 'Sign out ALL devices?',
      message: keepCurrent
        ? 'Every other browser or device signed into ServerForge will be logged out immediately.'
        : 'Every active session including this browser will be revoked and you will need to sign in again.',
      confirmLabel: keepCurrent ? 'Sign Out Others' : 'Sign Out All',
      tone: 'danger',
    });
    if (!ok) return;
    try {
      const res = await api.revokeAllAuthSessions(keepCurrent);
      if (!keepCurrent) {
        window.location.reload();
        return;
      }
      onToast('success', `Revoked ${res.revokedCount} other session(s).`);
      await loadSecurityData();
    } catch (err) {
      onToast('error', err instanceof Error ? err.message : 'Failed to revoke sessions');
    }
  };

  const handleBeginTotp = async () => {
    setBusyTotp(true);
    try {
      const payload = await api.beginTotpEnrollment();
      setEnrollment(payload);
      setVerifyCode('');
    } catch (err) {
      onToast('error', err instanceof Error ? err.message : 'Failed to start 2FA setup');
    } finally {
      setBusyTotp(false);
    }
  };

  const handleEnableTotp = async (e: React.FormEvent) => {
    e.preventDefault();
    setBusyTotp(true);
    try {
      const status = await api.enableTotp(verifyCode);
      setTotpStatus(status);
      setEnrollment(null);
      setVerifyCode('');
      onToast('success', 'Two-factor authentication enabled!');
      await Promise.all([loadHealth(), loadAuditLogs(0, auditSource, auditSearch)]);
    } catch (err) {
      onToast('error', err instanceof Error ? err.message : 'Failed to enable 2FA');
    } finally {
      setBusyTotp(false);
    }
  };

  const handleDisableTotp = async (e: React.FormEvent) => {
    e.preventDefault();
    setBusyTotp(true);
    try {
      const status = await api.disableTotp(disablePassword);
      setTotpStatus(status);
      setDisablePassword('');
      onToast('info', 'Two-factor authentication disabled.');
      await Promise.all([loadHealth(), loadAuditLogs(0, auditSource, auditSearch)]);
    } catch (err) {
      onToast('error', err instanceof Error ? err.message : 'Failed to disable 2FA');
    } finally {
      setBusyTotp(false);
    }
  };

  const handleExportAudit = async (format: 'json' | 'csv') => {
    try {
      const res = await api.queryAuditLogs({
        source: auditSource,
        q: auditSearch.trim() || undefined,
        limit: 500,
        offset: 0,
      });
      const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
      if (format === 'json') {
        downloadBlob(JSON.stringify(res.items, null, 2), 'application/json', `serverforge-audit-${stamp}.json`);
      } else {
        const esc = (v: string | null) => `"${String(v ?? '').replace(/"/g, '""')}"`;
        const header = 'timestamp,source,actor,action,instanceId,details';
        const lines = res.items.map((r) =>
          [esc(r.timestamp), esc(r.source), esc(r.actor), esc(r.action), esc(r.instanceId), esc(r.details)].join(',')
        );
        downloadBlob([header, ...lines].join('\n'), 'text/csv;charset=utf-8', `serverforge-audit-${stamp}.csv`);
      }
      onToast('success', `Exported ${res.items.length} audit log entries as ${format.toUpperCase()}.`);
    } catch (err) {
      onToast('error', err instanceof Error ? err.message : 'Audit export failed');
    }
  };

  const copyText = async (text: string, label: string) => {
    try {
      await navigator.clipboard.writeText(text);
      onToast('success', `${label} copied to clipboard.`);
    } catch {
      onToast('error', 'Clipboard copy failed.');
    }
  };

  const lockdownDirty =
    lockFsDraft !== settings.lockHostFsBrowsing || blockExeDraft !== settings.blockExecutableUploads;

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
      {/* Live Security Health Checklist */}
      <section className="panel">
        <div className="panel-header">
          <div className="panel-title">
            <ShieldCheck size={15} /> Live Security Health Checklist
          </div>
          <div className="btn-row">
            {health && (
              <span className={`badge ${health.score === health.maxScore ? 'badge-running' : 'badge-starting'}`}>
                {health.score} / {health.maxScore} checks passing
              </span>
            )}
            <button type="button" className="btn btn-sm" disabled={loadingHealth} onClick={() => void loadHealth()}>
              <RefreshCw size={13} /> Refresh
            </button>
          </div>
        </div>
        <div className="panel-body" style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
          {health?.isElevatedAdmin && (
            <div className="alert alert-error" style={{ marginBottom: 4 }}>
              <strong>Elevated Privilege Warning:</strong> ServerForge is running with{' '}
              {health.platform === 'win32' ? 'Windows Administrator' : 'root'} privileges. Prefer running under a standard user account to minimize host impact.
            </div>
          )}

          {!health ? (
            <div className="muted" style={{ fontSize: 13 }}>Evaluating security posture...</div>
          ) : (
            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(280px, 1fr))', gap: 10 }}>
              {health.checks.map((item) => (
                <div
                  key={item.id}
                  style={{
                    padding: '10px 12px',
                    borderRadius: 8,
                    border: '1px solid var(--border-subtle)',
                    background: 'var(--bg-elevated)',
                    display: 'flex',
                    flexDirection: 'column',
                    gap: 4,
                  }}
                >
                  <div style={{ display: 'flex', alignItems: 'center', gap: 7, fontWeight: 600, fontSize: 13 }}>
                    {item.status === 'pass' ? (
                      <CheckCircle2 size={15} style={{ color: 'var(--accent-green, #22c55e)', flexShrink: 0 }} />
                    ) : (
                      <AlertTriangle size={15} style={{ color: 'var(--accent-amber, #f59e0b)', flexShrink: 0 }} />
                    )}
                    <span>{item.title}</span>
                  </div>
                  <div className="muted" style={{ fontSize: 12 }}>{item.detail}</div>
                  {item.recommendation && (
                    <div style={{ fontSize: 11, color: 'var(--accent-amber, #f59e0b)', marginTop: 2 }}>
                      Tip: {item.recommendation}
                    </div>
                  )}
                </div>
              ))}
            </div>
          )}
        </div>
      </section>

      {/* Host Lockdown Switches (Password-Confirmed) */}
      <section className="panel">
        <div className="panel-header">
          <div className="panel-title">
            <ShieldAlert size={15} /> Host Lockdown Switches
          </div>
          <span className="muted" style={{ fontSize: 12 }}>
            Requires admin password confirmation to change
          </span>
        </div>
        <div className="panel-body">
          <form onSubmit={handleApplyLockdown} style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
            <label style={{ display: 'flex', alignItems: 'flex-start', gap: 10, cursor: 'pointer', fontSize: 13 }}>
              <input
                type="checkbox"
                checked={lockFsDraft}
                onChange={(e) => setLockFsDraft(e.target.checked)}
                style={{ marginTop: 3 }}
              />
              <span>
                <strong>Lock Host Filesystem Browsing</strong>
                <div className="muted" style={{ fontSize: 12 }}>
                  Disables <code>/api/import/browse</code>, folder picker, and <code>/api/import/inspect</code> outside ServerForge&apos;s data directory once your existing servers are imported.
                </div>
              </span>
            </label>

            <label style={{ display: 'flex', alignItems: 'flex-start', gap: 10, cursor: 'pointer', fontSize: 13 }}>
              <input
                type="checkbox"
                checked={blockExeDraft}
                onChange={(e) => setBlockExeDraft(e.target.checked)}
                style={{ marginTop: 3 }}
              />
              <span>
                <strong>Block Executable &amp; Script Web Uploads</strong>
                <div className="muted" style={{ fontSize: 12 }}>
                  Rejects <code>.exe</code>, <code>.bat</code>, <code>.cmd</code>, <code>.ps1</code>, <code>.dll</code>, <code>.vbs</code>, <code>.msi</code>, and <code>.sh</code> uploads in the web File Manager (mods like <code>.jar</code> and configs remain allowed).
                </div>
              </span>
            </label>

            <div style={{ display: 'flex', flexWrap: 'wrap', gap: 10, alignItems: 'end', marginTop: 4 }}>
              <div className="field" style={{ minWidth: 240 }}>
                <label htmlFor="sec-lockdown-pw">Confirm Admin Password</label>
                <input
                  id="sec-lockdown-pw"
                  type="password"
                  className="input"
                  value={lockdownPassword}
                  onChange={(e) => setLockdownPassword(e.target.value)}
                  placeholder="Enter admin password to apply"
                  required
                />
              </div>
              <button
                type="submit"
                className="btn btn-primary"
                disabled={savingLockdown || !lockdownDirty || !lockdownPassword}
              >
                <Lock size={14} /> {savingLockdown ? 'Applying...' : 'Apply Lockdown Changes'}
              </button>
            </div>
          </form>
        </div>
      </section>

      {/* Change Password */}
      <section className="panel">
        <div className="panel-header">
          <div className="panel-title">
            <Lock size={15} /> Admin Password
          </div>
          <span className="muted" style={{ fontSize: 12 }}>
            Changing your password automatically signs out all other devices
          </span>
        </div>
        <div className="panel-body">
          <form
            onSubmit={handleChangePassword}
            style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(210px, 1fr))', gap: 12, alignItems: 'end' }}
          >
            <div className="field">
              <label htmlFor="sec-cur-pass">Current Password</label>
              <input
                id="sec-cur-pass"
                type="password"
                className="input"
                value={currentPassword}
                onChange={(e) => setCurrentPassword(e.target.value)}
                autoComplete="current-password"
                required
              />
            </div>
            <div className="field">
              <label htmlFor="sec-new-pass">New Password (8+ chars)</label>
              <input
                id="sec-new-pass"
                type="password"
                className="input"
                value={newPassword}
                onChange={(e) => setNewPassword(e.target.value)}
                autoComplete="new-password"
                minLength={8}
                required
              />
            </div>
            <div className="field">
              <label htmlFor="sec-confirm-pass">Confirm New Password</label>
              <input
                id="sec-confirm-pass"
                type="password"
                className="input"
                value={confirmNewPassword}
                onChange={(e) => setConfirmNewPassword(e.target.value)}
                autoComplete="new-password"
                minLength={8}
                required
              />
            </div>
            <div>
              <button type="submit" className="btn btn-primary" disabled={changingPassword}>
                <Lock size={14} /> {changingPassword ? 'Updating...' : 'Update Password'}
              </button>
            </div>
          </form>
        </div>
      </section>

      {/* Two-Factor Authentication (TOTP) */}
      <section className="panel">
        <div className="panel-header">
          <div className="panel-title">
            <KeyRound size={15} /> Two-Factor Authentication (TOTP 2FA)
          </div>
          {totpStatus?.enabled ? (
            <span className="badge badge-running">
              <ShieldCheck size={12} /> Enabled ({totpStatus.recoveryCodesRemaining} recovery codes left)
            </span>
          ) : (
            <span className="badge badge-stopped">Optional · Disabled</span>
          )}
        </div>
        <div className="panel-body" style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
          <p className="muted" style={{ margin: 0, fontSize: 13 }}>
            Protect your ServerForge admin account with an authenticator app (Google Authenticator, 1Password, Bitwarden, Authy) and 8 single-use recovery codes.
          </p>

          {!totpStatus?.enabled && !enrollment && (
            <div>
              <button type="button" className="btn btn-primary" disabled={busyTotp} onClick={() => void handleBeginTotp()}>
                <KeyRound size={14} /> Set Up 2FA
              </button>
            </div>
          )}

          {enrollment && (
            <div style={{ display: 'flex', flexDirection: 'column', gap: 14, padding: 14, borderRadius: 10, border: '1px solid var(--border-subtle)', background: 'var(--bg-elevated)' }}>
              <div>
                <div style={{ fontWeight: 600, fontSize: 13, marginBottom: 6 }}>
                  1. Add this account to your authenticator app
                </div>
                <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8, alignItems: 'center' }}>
                  <code style={{ padding: '6px 10px', borderRadius: 6, background: 'var(--bg-surface)', fontSize: 13, letterSpacing: '0.08em' }}>
                    {enrollment.secret}
                  </code>
                  <button type="button" className="btn btn-sm" onClick={() => void copyText(enrollment.secret, 'Setup key')}>
                    <Copy size={13} /> Copy Secret
                  </button>
                  <button type="button" className="btn btn-sm" onClick={() => void copyText(enrollment.otpAuthUri, 'otpauth URI')}>
                    <Copy size={13} /> Copy otpauth:// URI
                  </button>
                </div>
              </div>

              <div>
                <div style={{ fontWeight: 600, fontSize: 13, marginBottom: 6 }}>
                  2. Save your 8 single-use recovery codes somewhere safe
                </div>
                <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(120px, 1fr))', gap: 6, marginBottom: 8 }}>
                  {enrollment.recoveryCodes.map((code) => (
                    <code key={code} style={{ padding: '5px 8px', borderRadius: 6, background: 'var(--bg-surface)', textAlign: 'center', fontSize: 12 }}>
                      {code}
                    </code>
                  ))}
                </div>
                <button
                  type="button"
                  className="btn btn-sm"
                  onClick={() => void copyText(enrollment.recoveryCodes.join('\n'), 'Recovery codes')}
                >
                  <Copy size={13} /> Copy All Recovery Codes
                </button>
              </div>

              <form onSubmit={handleEnableTotp} style={{ display: 'flex', flexWrap: 'wrap', gap: 10, alignItems: 'end' }}>
                <div className="field" style={{ minWidth: 220 }}>
                  <label htmlFor="sec-totp-verify">3. Enter 6-digit code to activate</label>
                  <input
                    id="sec-totp-verify"
                    className="input"
                    value={verifyCode}
                    onChange={(e) => setVerifyCode(e.target.value)}
                    placeholder="123456"
                    autoComplete="one-time-code"
                    required
                  />
                </div>
                <button type="submit" className="btn btn-primary" disabled={busyTotp}>
                  <ShieldCheck size={14} /> Verify &amp; Enable 2FA
                </button>
                <button type="button" className="btn" onClick={() => setEnrollment(null)}>
                  Cancel
                </button>
              </form>
            </div>
          )}

          {totpStatus?.enabled && (
            <form onSubmit={handleDisableTotp} style={{ display: 'flex', flexWrap: 'wrap', gap: 10, alignItems: 'end' }}>
              <div className="field" style={{ minWidth: 240 }}>
                <label htmlFor="sec-totp-disable-pw">Current Password to Disable 2FA</label>
                <input
                  id="sec-totp-disable-pw"
                  type="password"
                  className="input"
                  value={disablePassword}
                  onChange={(e) => setDisablePassword(e.target.value)}
                  placeholder="Enter admin password"
                  required
                />
              </div>
              <button type="submit" className="btn btn-danger" disabled={busyTotp}>
                <ShieldAlert size={14} /> Disable 2FA
              </button>
            </form>
          )}
        </div>
      </section>

      {/* Active Sessions */}
      <section className="panel">
        <div className="panel-header">
          <div className="panel-title">
            <Monitor size={15} /> Active Sessions ({sessions.length})
          </div>
          <div className="btn-row">
            <button type="button" className="btn btn-sm" disabled={loadingSessions} onClick={() => void loadSecurityData()}>
              <RefreshCw size={13} /> Refresh
            </button>
            {sessions.length > 1 && (
              <button type="button" className="btn btn-sm" onClick={() => void handleRevokeAll(true)}>
                <LogOut size={13} /> Sign Out Other Devices
              </button>
            )}
            <button type="button" className="btn btn-danger btn-sm" onClick={() => void handleRevokeAll(false)}>
              <LogOut size={13} /> Sign Out All Devices
            </button>
          </div>
        </div>
        <div className="panel-body">
          {sessions.length === 0 ? (
            <div className="muted" style={{ fontSize: 13 }}>No active sessions recorded.</div>
          ) : (
            <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
              {sessions.map((s) => (
                <div
                  key={s.id}
                  style={{
                    display: 'flex',
                    flexWrap: 'wrap',
                    alignItems: 'center',
                    justifyContent: 'space-between',
                    gap: 10,
                    padding: '10px 12px',
                    borderRadius: 8,
                    border: '1px solid var(--border-subtle)',
                    background: 'var(--bg-elevated)',
                  }}
                >
                  <div>
                    <div style={{ display: 'flex', alignItems: 'center', gap: 8, fontWeight: 600, fontSize: 13 }}>
                      <span>{summarizeUserAgent(s.userAgent)}</span>
                      <code style={{ fontSize: 12, opacity: 0.85 }}>{s.ip}</code>
                      {s.isCurrent && <span className="badge badge-running">Current</span>}
                    </div>
                    <div className="muted" style={{ fontSize: 11, marginTop: 3 }}>
                      Signed in {new Date(s.createdAt).toLocaleString()} · Last active {new Date(s.lastSeenAt).toLocaleString()}
                    </div>
                  </div>
                  <button
                    type="button"
                    className="btn btn-sm btn-danger"
                    onClick={() => void handleRevokeSession(s)}
                  >
                    <Trash2 size={13} /> Revoke
                  </button>
                </div>
              ))}
            </div>
          )}
        </div>
      </section>

      {/* Discord Security Alerts & Brute-Force Protection Info */}
      <section className="panel">
        <div className="panel-header">
          <div className="panel-title">
            <Bell size={15} /> Brute-Force Protection &amp; Security Alerts
          </div>
        </div>
        <div className="panel-body" style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
          <div className="muted" style={{ fontSize: 13 }}>
            Login rate-limiting is always active: 5 failed attempts trigger a 60s lockout, 10 trigger 5 minutes, and 15+ trigger 15 minutes (returning HTTP 429).
          </div>
          <label style={{ display: 'flex', alignItems: 'center', gap: 10, cursor: 'pointer', fontSize: 13 }}>
            <input
              type="checkbox"
              checked={settings.discordSecurityAlertsEnabled}
              onChange={(e) => onChange({ discordSecurityAlertsEnabled: e.target.checked })}
            />
            <span>
              <strong>Send Discord security alerts</strong> when repeated failed logins trigger a lockout, a new IP signs into the dashboard, or the admin password is changed (uses your configured Discord notification channel).
            </span>
          </label>
        </div>
      </section>

      {/* Searchable Audit Log Viewer */}
      <section className="panel">
        <div className="panel-header">
          <div className="panel-title">
            <FileSearch size={15} /> Audit Log Viewer ({auditTotal} total)
          </div>
          <div className="btn-row">
            <button type="button" className="btn btn-sm" onClick={() => void handleExportAudit('csv')}>
              <Download size={13} /> Export CSV
            </button>
            <button type="button" className="btn btn-sm" onClick={() => void handleExportAudit('json')}>
              <Download size={13} /> Export JSON
            </button>
          </div>
        </div>
        <div className="panel-body" style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
          <form
            onSubmit={(e) => {
              e.preventDefault();
              void loadAuditLogs(0, auditSource, auditSearch);
            }}
            style={{ display: 'flex', flexWrap: 'wrap', gap: 8, alignItems: 'center' }}
          >
            <select
              className="input"
              style={{ width: 145 }}
              value={auditSource}
              onChange={(e) => {
                const next = e.target.value as 'web' | 'discord' | 'system' | '';
                setAuditSource(next);
                void loadAuditLogs(0, next, auditSearch);
              }}
            >
              <option value="">All Sources</option>
              <option value="web">Web UI</option>
              <option value="discord">Discord</option>
              <option value="system">System</option>
            </select>
            <input
              className="input"
              style={{ flex: 1, minWidth: 220 }}
              value={auditSearch}
              onChange={(e) => setAuditSearch(e.target.value)}
              placeholder="Search action, actor, or details (e.g. auth:login, lockdown, firewall)..."
            />
            <button type="submit" className="btn btn-sm btn-primary" disabled={loadingAudit}>
              <FileSearch size={13} /> Filter
            </button>
            <button
              type="button"
              className="btn btn-sm"
              disabled={loadingAudit}
              onClick={() => void loadAuditLogs(auditOffset, auditSource, auditSearch)}
            >
              <RefreshCw size={13} />
            </button>
          </form>

          {auditItems.length === 0 ? (
            <div className="muted" style={{ fontSize: 13 }}>No audit log entries match the current filter.</div>
          ) : (
            <div style={{ overflowX: 'auto' }}>
              <table className="table" style={{ width: '100%', fontSize: 12 }}>
                <thead>
                  <tr>
                    <th>Time</th>
                    <th>Source</th>
                    <th>Actor</th>
                    <th>Action</th>
                    <th>Details</th>
                  </tr>
                </thead>
                <tbody>
                  {auditItems.map((entry) => (
                    <tr key={entry.id}>
                      <td style={{ whiteSpace: 'nowrap' }}>{new Date(entry.timestamp).toLocaleString()}</td>
                      <td>
                        <span className="badge badge-stopped">{entry.source}</span>
                      </td>
                      <td><code>{entry.actor}</code></td>
                      <td><code>{entry.action}</code></td>
                      <td className="muted">{entry.details || '—'}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}

          {auditTotal > AUDIT_PAGE_SIZE && (
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', fontSize: 12 }}>
              <span className="muted">
                Showing {auditOffset + 1}–{Math.min(auditOffset + auditItems.length, auditTotal)} of {auditTotal}
              </span>
              <div className="btn-row">
                <button
                  type="button"
                  className="btn btn-sm"
                  disabled={loadingAudit || auditOffset === 0}
                  onClick={() => void loadAuditLogs(Math.max(0, auditOffset - AUDIT_PAGE_SIZE), auditSource, auditSearch)}
                >
                  Previous
                </button>
                <button
                  type="button"
                  className="btn btn-sm"
                  disabled={loadingAudit || auditOffset + AUDIT_PAGE_SIZE >= auditTotal}
                  onClick={() => void loadAuditLogs(auditOffset + AUDIT_PAGE_SIZE, auditSource, auditSearch)}
                >
                  Next
                </button>
              </div>
            </div>
          )}
        </div>
      </section>
    </div>
  );
}
