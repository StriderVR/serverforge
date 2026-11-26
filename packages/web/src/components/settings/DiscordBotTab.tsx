import React from 'react';
import { Bot, Shield } from 'lucide-react';
import type { HostMetrics, SystemSettings } from '@serverforge/shared';

interface DiscordBotTabProps {
  metrics: HostMetrics | null;
  settings: SystemSettings;
  allowedRolesText: string;
  adminRolesText: string;
  onAllowedRolesChange: (value: string) => void;
  onAdminRolesChange: (value: string) => void;
  onChange: (patch: Partial<SystemSettings>) => void;
}

export function DiscordBotTab({
  metrics,
  settings,
  allowedRolesText,
  adminRolesText,
  onAllowedRolesChange,
  onAdminRolesChange,
  onChange,
}: DiscordBotTabProps) {
  return (
    <div className="settings-grid-two">
      <section className="panel">
        <div className="panel-header">
          <h2 style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
            <Shield size={16} /> Discord Permissions &amp; Alerts
          </h2>
        </div>
        <div className="panel-body">
          <p className="settings-card-desc">
            Control which Discord roles can temporarily boot servers and where auto-shutdown, crash, and daily reboot alerts are posted.
          </p>
          <div className="form-grid">
            <div className="field full">
              <label htmlFor="set-allowed-roles">Allowed Role IDs (comma-separated)</label>
              <input
                id="set-allowed-roles"
                className="input mono"
                value={allowedRolesText}
                onChange={(e) => onAllowedRolesChange(e.target.value)}
                placeholder="123456789012345678, 987654321098765432"
              />
              <span className="field-hint">Members with these roles can run /server start and /server extend.</span>
            </div>

            <div className="field full">
              <label htmlFor="set-admin-roles">Admin Role IDs (comma-separated)</label>
              <input
                id="set-admin-roles"
                className="input mono"
                value={adminRolesText}
                onChange={(e) => onAdminRolesChange(e.target.value)}
                placeholder="Optional admin override roles"
              />
              <span className="field-hint">Can stop any server from Discord regardless of who booted it.</span>
            </div>

            <div className="field full">
              <label htmlFor="set-channel">Default Notification Channel ID</label>
              <input
                id="set-channel"
                className="input mono"
                value={settings.discordNotifyChannelId}
                onChange={(e) => onChange({ discordNotifyChannelId: e.target.value })}
                placeholder="Channel ID for auto-shutdown, crash, and daily reboot alerts"
              />
            </div>
          </div>
        </div>
      </section>

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

          <div
            style={{
              marginTop: 14,
              padding: 12,
              borderRadius: 'var(--radius-sm)',
              background: 'var(--bg-elevated)',
              border: '1px solid var(--border-subtle)',
              display: 'flex',
              flexDirection: 'column',
              gap: 7,
            }}
          >
            <div style={{ fontSize: 11.5, fontWeight: 600, textTransform: 'uppercase', letterSpacing: '0.04em', color: 'var(--text-muted)' }}>
              Available Slash Commands
            </div>
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
    </div>
  );
}
