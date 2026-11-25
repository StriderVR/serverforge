import React, { useEffect, useState } from 'react';
import { Bot, Save, Shield } from 'lucide-react';
import type { AuditLogEntry, HostMetrics, SystemSettings } from '@serverforge/shared';
import { api } from '../api';

interface SettingsPageProps {
  metrics: HostMetrics | null;
  onSaved: () => void;
}

export function SettingsPage({ metrics, onSaved }: SettingsPageProps) {
  const [settings, setSettings] = useState<SystemSettings | null>(null);
  const [allowedRolesText, setAllowedRolesText] = useState('');
  const [adminRolesText, setAdminRolesText] = useState('');
  const [auditLogs, setAuditLogs] = useState<AuditLogEntry[]>([]);
  const [saving, setSaving] = useState(false);
  const [notice, setNotice] = useState<{ kind: 'success' | 'error'; text: string } | null>(null);

  useEffect(() => {
    void (async () => {
      const [s, logs] = await Promise.all([api.getSettings(), api.getAuditLogs(40)]);
      setSettings(s);
      setAllowedRolesText(s.discordAllowedRoleIds.join(', '));
      setAdminRolesText(s.discordAdminRoleIds.join(', '));
      setAuditLogs(logs);
    })();
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
      setNotice({ kind: 'success', text: 'Settings and Discord guardrails saved.' });
      onSaved();
    } catch (err) {
      setNotice({ kind: 'error', text: err instanceof Error ? err.message : 'Save failed' });
    } finally {
      setSaving(false);
    }
  };

  if (!settings) {
    return <div className="panel panel-body">Loading settings...</div>;
  }

  return (
    <div>
      <header className="page-header">
        <div>
          <h1>Discord & Guardrails</h1>
          <p className="page-subtitle">
            Control server concurrency limits, Windows OS RAM reserves, temporary lease timers, and Discord permissions.
          </p>
        </div>
      </header>

      {notice && (
        <div className={`alert ${notice.kind === 'error' ? 'alert-error' : 'alert-success'}`}>{notice.text}</div>
      )}

      <div style={{ display: 'grid', gridTemplateColumns: 'minmax(0, 1.35fr) minmax(0, 1fr)', gap: 18 }}>
        <form className="panel" onSubmit={handleSave}>
          <div className="panel-header">
            <h2 style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
              <Shield size={16} /> Resource Guardrails & Discord Roles
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
                <span className="field-hint">Set 0 to disable idle detection and use max lease timer only.</span>
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
                <span className="field-hint">
                  Members with these roles can run /server start and /server extend. Leave blank to restrict to Discord Admins.
                </span>
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
                  placeholder="Channel ID for 10-minute auto-shutdown warnings"
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
