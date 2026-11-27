import React, { useEffect, useState } from 'react';
import {
  Bell,
  Copy,
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
  AuthSessionSummary,
  SystemSettings,
  TotpEnrollmentPayload,
  TotpStatus,
} from '@serverforge/shared';
import { api } from '../../api';
import type { ConfirmDialogOptions } from '../ConfirmModal';
import type { PushToastFn } from '../ToastStack';

interface SecurityTabProps {
  settings: SystemSettings;
  onChange: (patch: Partial<SystemSettings>) => void;
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

export function SecurityTab({ settings, onChange, onConfirm, onToast }: SecurityTabProps) {
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

  const loadSecurityData = async () => {
    setLoadingSessions(true);
    try {
      const [sess, totp] = await Promise.all([
        api.getAuthSessions(),
        api.getTotpStatus(),
      ]);
      setSessions(sess);
      setTotpStatus(totp);
    } catch (err) {
      onToast('error', err instanceof Error ? err.message : 'Failed to load security data');
    } finally {
      setLoadingSessions(false);
    }
  };

  useEffect(() => {
    void loadSecurityData();
  }, []);

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
      await loadSecurityData();
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
    } catch (err) {
      onToast('error', err instanceof Error ? err.message : 'Failed to disable 2FA');
    } finally {
      setBusyTotp(false);
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

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
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
          <form onSubmit={handleChangePassword} style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(210px, 1fr))', gap: 12, alignItems: 'end' }}>
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
    </div>
  );
}
