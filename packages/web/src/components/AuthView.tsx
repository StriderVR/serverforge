import React, { useState } from 'react';
import { KeyRound, Server, ShieldCheck } from 'lucide-react';
import { api } from '../api';

interface AuthViewProps {
  needsSetup: boolean;
  onAuthenticated: () => void;
}

export function AuthView({ needsSetup, onAuthenticated }: AuthViewProps) {
  const [username, setUsername] = useState('admin');
  const [password, setPassword] = useState('');
  const [confirmPassword, setConfirmPassword] = useState('');
  const [requiresTotp, setRequiresTotp] = useState(false);
  const [totpCode, setTotpCode] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError(null);

    if (needsSetup && password !== confirmPassword) {
      setError('Passwords do not match.');
      return;
    }

    setSubmitting(true);
    try {
      if (needsSetup) {
        await api.setupAdmin(username, password);
        onAuthenticated();
      } else {
        const res = await api.login(username, password, requiresTotp ? totpCode : undefined);
        if (res.requiresTotp) {
          setRequiresTotp(true);
          return;
        }
        onAuthenticated();
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Authentication failed');
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <div className="auth-wrapper">
      <div className="auth-card">
        <div className="brand" style={{ borderBottom: 'none', padding: 0, marginBottom: 20 }}>
          <div className="brand-mark">
            <Server size={18} />
          </div>
          <div>
            <div className="brand-title">ServerForge</div>
            <span className="brand-sub">Game Server Control Plane</span>
          </div>
        </div>

        <h1 style={{ margin: '0 0 6px', fontSize: 19, fontWeight: 700 }}>
          {needsSetup
            ? 'Create Admin Account'
            : requiresTotp
              ? 'Two-Factor Verification'
              : 'Sign in to ServerForge'}
        </h1>
        <p style={{ margin: '0 0 20px', fontSize: 13, color: 'var(--text-secondary)' }}>
          {needsSetup
            ? 'Set up your administrator credentials to secure access to this server PC.'
            : requiresTotp
              ? 'Enter the 6-digit code from your authenticator app or a single-use recovery code.'
              : 'Authenticate to manage your game servers and Discord automation.'}
        </p>

        {error && <div className="alert alert-error">{error}</div>}

        <form onSubmit={handleSubmit} style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
          {!requiresTotp ? (
            <>
              <div className="field">
                <label htmlFor="auth-username">Username</label>
                <input
                  id="auth-username"
                  className="input"
                  value={username}
                  onChange={(e) => setUsername(e.target.value)}
                  autoComplete="username"
                  required
                />
              </div>

              <div className="field">
                <label htmlFor="auth-password">Password</label>
                <input
                  id="auth-password"
                  type="password"
                  className="input"
                  value={password}
                  onChange={(e) => setPassword(e.target.value)}
                  autoComplete={needsSetup ? 'new-password' : 'current-password'}
                  placeholder={needsSetup ? 'At least 8 characters' : 'Enter password'}
                  required
                />
              </div>

              {needsSetup && (
                <div className="field">
                  <label htmlFor="auth-confirm">Confirm Password</label>
                  <input
                    id="auth-confirm"
                    type="password"
                    className="input"
                    value={confirmPassword}
                    onChange={(e) => setConfirmPassword(e.target.value)}
                    autoComplete="new-password"
                    required
                  />
                </div>
              )}
            </>
          ) : (
            <div className="field">
              <label htmlFor="auth-totp">Authenticator or Recovery Code</label>
              <input
                id="auth-totp"
                className="input"
                value={totpCode}
                onChange={(e) => setTotpCode(e.target.value)}
                autoComplete="one-time-code"
                placeholder="123456 or ABCD-1234"
                autoFocus
                required
              />
            </div>
          )}

          <button
            id="auth-submit-btn"
            type="submit"
            className="btn btn-primary"
            disabled={submitting}
            style={{ marginTop: 6, width: '100%', padding: '10px 16px' }}
          >
            {requiresTotp ? <KeyRound size={16} /> : <ShieldCheck size={16} />}
            {submitting
              ? 'Authenticating...'
              : needsSetup
                ? 'Initialize ServerForge'
                : requiresTotp
                  ? 'Verify & Sign In'
                  : 'Sign In'}
          </button>

          {requiresTotp && (
            <button
              type="button"
              className="btn"
              style={{ width: '100%' }}
              onClick={() => {
                setRequiresTotp(false);
                setTotpCode('');
                setError(null);
              }}
            >
              Back to password
            </button>
          )}
        </form>
      </div>
    </div>
  );
}
