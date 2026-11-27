import React, { useEffect, useState } from 'react';
import {
  Bot,
  Check,
  CheckCircle2,
  ChevronDown,
  ChevronUp,
  Copy,
  ExternalLink,
  Eye,
  EyeOff,
  LayoutGrid,
  Plug,
  RefreshCw,
  Send,
  Shield,
  Sparkles,
  Unplug,
} from 'lucide-react';
import type { DiscordDiscoveryStatus, HostMetrics, SystemSettings, SystemSettingsResponse } from '@serverforge/shared';
import { api } from '../../api';
import { copyTextToClipboard } from '../../utils/clipboard';
import type { PushToastFn } from '../ToastStack';

interface DiscordBotTabProps {
  metrics: HostMetrics | null;
  settings: SystemSettingsResponse;
  discordStatus: DiscordDiscoveryStatus | null;
  allowedRolesText: string;
  adminRolesText: string;
  onAllowedRolesChange: (value: string) => void;
  onAdminRolesChange: (value: string) => void;
  onChange: (patch: Partial<SystemSettings>) => void;
  onSyncSavedSetting: (patch: Partial<SystemSettingsResponse>) => void;
  onDiscordStatusUpdated: (status: DiscordDiscoveryStatus) => void;
  onToast: PushToastFn;
}

function parseIds(txt: string): string[] {
  return txt
    .split(/[,\s]+/)
    .map((s) => s.trim())
    .filter(Boolean);
}

function toggleRoleId(currentText: string, roleId: string): string {
  const list = parseIds(currentText);
  const exists = list.includes(roleId);
  const next = exists ? list.filter((id) => id !== roleId) : [...list, roleId];
  return next.join(', ');
}

const SLASH_COMMANDS: Array<{
  cmd: string;
  desc: string;
  role: 'Everyone' | 'Allowed Role' | 'Admin';
}> = [
  { cmd: '/server list', desc: 'List all Discord-enabled servers, join info & slots', role: 'Everyone' },
  { cmd: '/server status <name>', desc: 'Check live players, memory & lease timer', role: 'Everyone' },
  { cmd: '/server start <name> [hours]', desc: 'Temporarily boot a game server with idle auto-stop', role: 'Allowed Role' },
  { cmd: '/server extend <name> [minutes]', desc: 'Add extra time to an active temporary lease', role: 'Allowed Role' },
  { cmd: '/server stop <name>', desc: 'Gracefully save & stop (starter or Admin)', role: 'Allowed Role' },
  { cmd: '/server panel', desc: 'Post or refresh the live auto-updating Status Panel', role: 'Admin' },
  { cmd: '/server backup <name> [note]', desc: 'Create a world backup snapshot ZIP from Discord', role: 'Admin' },
  { cmd: '/server say <name> <message>', desc: 'Broadcast an in-game announcement via RCON', role: 'Admin' },
  { cmd: '/server whitelist <name> <action> [player]', desc: 'Add, remove, or list Minecraft whitelist players', role: 'Admin' },
];

export function DiscordBotTab({
  metrics,
  settings,
  discordStatus,
  allowedRolesText,
  adminRolesText,
  onAllowedRolesChange,
  onAdminRolesChange,
  onChange,
  onSyncSavedSetting,
  onDiscordStatusUpdated,
  onToast,
}: DiscordBotTabProps) {
  const isConnected = Boolean(discordStatus?.connected ?? metrics?.discordConnected);
  const hasGuilds = (discordStatus?.guilds.length ?? 0) > 0;

  const [tokenInput, setTokenInput] = useState(settings.discordBotToken ?? '');
  const [showToken, setShowToken] = useState(false);
  const [showWizard, setShowWizard] = useState(!isConnected || !hasGuilds);
  const [connecting, setConnecting] = useState(false);
  const [disconnecting, setDisconnecting] = useState(false);
  const [refreshing, setRefreshing] = useState(false);
  const [syncingCommands, setSyncingCommands] = useState(false);
  const [sendingTest, setSendingTest] = useState(false);
  const [postingPanel, setPostingPanel] = useState(false);
  const [copiedInvite, setCopiedInvite] = useState(false);
  const [actionError, setActionError] = useState<string | null>(null);

  useEffect(() => {
    setTokenInput(settings.discordBotToken ?? '');
  }, [settings.discordBotToken]);

  // Keep wizard open while user still needs to connect or invite the bot
  useEffect(() => {
    if (!isConnected || !hasGuilds) {
      setShowWizard(true);
    }
  }, [isConnected, hasGuilds]);

  const allowedSet = new Set(parseIds(allowedRolesText));
  const adminSet = new Set(parseIds(adminRolesText));
  const botTag = discordStatus?.botTag ?? metrics?.discordBotTag ?? null;
  const channels = discordStatus?.channels ?? [];
  const roles = discordStatus?.roles ?? [];
  const guilds = discordStatus?.guilds ?? [];
  const effectiveGuildId = settings.discordGuildId || discordStatus?.selectedGuildId || '';

  const refreshStatus = async (silent = false) => {
    setRefreshing(true);
    try {
      const st = await api.getDiscordStatus();
      onDiscordStatusUpdated(st);
      if (st.selectedGuildId && !settings.discordGuildId) {
        onChange({ discordGuildId: st.selectedGuildId });
      }
      if (!silent) {
        onToast(
          'info',
          st.connected
            ? `Refreshed: ${st.guilds.length} server(s), ${st.channels.length} channel(s), ${st.roles.length} role(s).`
            : 'Discord bot is currently offline.'
        );
      }
    } catch (err) {
      if (!silent) onToast('error', err instanceof Error ? err.message : 'Failed to refresh Discord status');
    } finally {
      setRefreshing(false);
    }
  };

  const handleConnect = async () => {
    setConnecting(true);
    setActionError(null);
    try {
      const trimmed = tokenInput.trim();
      const st = await api.connectDiscord(trimmed ? trimmed : undefined);
      onDiscordStatusUpdated(st);
      const patch: Partial<SystemSettingsResponse> = {};
      if (trimmed) {
        setTokenInput('');
        patch.discordBotToken = '';
        patch.hasDiscordBotToken = true;
      }
      if (st.selectedGuildId && !settings.discordGuildId) {
        patch.discordGuildId = st.selectedGuildId;
      }
      if (Object.keys(patch).length > 0) {
        onSyncSavedSetting(patch);
      }
      onToast('success', `Connected to Discord as ${st.botTag ?? 'bot'}!`);
    } catch (err) {
      const msg = err instanceof Error ? err.message : 'Failed to connect Discord bot';
      setActionError(msg);
      onToast('error', msg);
    } finally {
      setConnecting(false);
    }
  };

  const handleDisconnect = async (clearToken: boolean) => {
    setDisconnecting(true);
    setActionError(null);
    try {
      const st = await api.disconnectDiscord(clearToken);
      onDiscordStatusUpdated(st);
      if (clearToken) {
        setTokenInput('');
        onSyncSavedSetting({
          discordBotToken: '',
          hasDiscordBotToken: false,
          discordBotTokenPreview: '',
        });
      }
      onToast('info', clearToken ? 'Disconnected Discord bot and cleared saved token.' : 'Disconnected Discord bot.');
    } catch (err) {
      onToast('error', err instanceof Error ? err.message : 'Disconnect failed');
    } finally {
      setDisconnecting(false);
    }
  };

  const handleSyncCommands = async () => {
    setSyncingCommands(true);
    try {
      const res = await api.syncDiscordCommands();
      onToast('success', `Slash commands synced (${res.scope}). They should appear in Discord immediately!`);
    } catch (err) {
      onToast('error', err instanceof Error ? err.message : 'Failed to sync slash commands');
    } finally {
      setSyncingCommands(false);
    }
  };

  const handleSendTest = async () => {
    setSendingTest(true);
    try {
      const res = await api.sendDiscordTestMessage(settings.discordNotifyChannelId || undefined);
      onToast('success', `Test alert sent to ${res.channelName}!`);
    } catch (err) {
      onToast('error', err instanceof Error ? err.message : 'Failed to send test alert');
    } finally {
      setSendingTest(false);
    }
  };

  const handlePostPanel = async (repost = false) => {
    setPostingPanel(true);
    try {
      const res = await api.postDiscordStatusPanel(settings.discordStatusPanelChannelId || undefined, repost);
      onSyncSavedSetting({
        discordStatusPanelChannelId: res.channelId,
        discordStatusPanelMessageId: res.messageId,
      });
      await refreshStatus(true);
      onToast(
        'success',
        res.updatedExisting ? 'Live Discord Status Panel refreshed!' : 'Live Discord Status Panel posted!'
      );
    } catch (err) {
      onToast('error', err instanceof Error ? err.message : 'Failed to post status panel');
    } finally {
      setPostingPanel(false);
    }
  };

  const handleCopyInvite = async () => {
    if (!discordStatus?.inviteUrl) return;
    const ok = await copyTextToClipboard(discordStatus.inviteUrl);
    if (ok) {
      setCopiedInvite(true);
      onToast('success', 'Bot invite URL copied to clipboard.');
      setTimeout(() => setCopiedInvite(false), 2000);
    }
  };

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 18 }}>
      {/* Panel 1: Bot Connection & Guided 3-Step Setup Wizard */}
      <section className="panel">
        <div className="panel-header" style={{ flexWrap: 'wrap', gap: 10 }}>
          <h2 style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
            <Bot size={16} /> Discord Bot Connection &amp; Guided Setup
          </h2>
          <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
            <span className={`badge ${isConnected ? 'badge-running' : 'badge-stopped'}`}>
              <span className="badge-dot" />
              {isConnected ? `CONNECTED${botTag ? `: ${botTag}` : ''}` : 'OFFLINE'}
            </span>
            <button
              type="button"
              className="btn btn-sm"
              disabled={refreshing}
              onClick={() => void refreshStatus(false)}
            >
              <RefreshCw size={12} className={refreshing ? 'spin' : ''} /> Refresh
            </button>
            <button
              type="button"
              className="btn btn-sm"
              onClick={() => setShowWizard((v) => !v)}
            >
              {showWizard ? <ChevronUp size={13} /> : <ChevronDown size={13} />}
              {showWizard ? 'Hide Setup Guide' : 'Show Setup Guide'}
            </button>
          </div>
        </div>

        <div className="panel-body" style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
          {(actionError || discordStatus?.lastError) && (
            <div
              style={{
                padding: '10px 12px',
                borderRadius: 'var(--radius-sm)',
                background: 'rgba(239, 68, 68, 0.12)',
                border: '1px solid rgba(239, 68, 68, 0.35)',
                color: '#fca5a5',
                fontSize: 13,
              }}
            >
              <strong>Discord Connection Error:</strong> {actionError ?? discordStatus?.lastError}
            </div>
          )}

          {showWizard && (
            <div
              style={{
                display: 'grid',
                gridTemplateColumns: 'repeat(auto-fit, minmax(240px, 1fr))',
                gap: 12,
                padding: 14,
                borderRadius: 'var(--radius-sm)',
                background: 'var(--bg-elevated)',
                border: '1px solid var(--border-subtle)',
              }}
            >
              {/* Step 1 */}
              <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
                <div style={{ display: 'flex', alignItems: 'center', gap: 8, fontWeight: 600, fontSize: 13 }}>
                  <span
                    style={{
                      width: 22,
                      height: 22,
                      borderRadius: '50%',
                      background: isConnected ? 'rgba(16, 185, 129, 0.2)' : 'rgba(99, 102, 241, 0.2)',
                      color: isConnected ? '#34d399' : '#a5b4fc',
                      display: 'inline-flex',
                      alignItems: 'center',
                      justifyContent: 'center',
                      fontSize: 11.5,
                    }}
                  >
                    {isConnected ? <Check size={12} /> : '1'}
                  </span>
                  Create Bot in Discord Portal
                </div>
                <ol style={{ margin: 0, paddingLeft: 18, fontSize: 12.5, color: 'var(--text-secondary)', lineHeight: 1.55 }}>
                  <li>Click <strong>New Application</strong> (name it <code className="mono">ServerForge</code>).</li>
                  <li>Open the <strong>Bot</strong> tab on the left sidebar.</li>
                  <li>Click <strong>Reset Token</strong> and copy your Bot Token.</li>
                  <li>No privileged intents needed — leave defaults as-is.</li>
                </ol>
                <a
                  href="https://discord.com/developers/applications"
                  target="_blank"
                  rel="noreferrer"
                  className="btn btn-sm"
                  style={{ alignSelf: 'flex-start', marginTop: 'auto', textDecoration: 'none' }}
                >
                  <ExternalLink size={12} /> Open Discord Developer Portal
                </a>
              </div>

              {/* Step 2 */}
              <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
                <div style={{ display: 'flex', alignItems: 'center', gap: 8, fontWeight: 600, fontSize: 13 }}>
                  <span
                    style={{
                      width: 22,
                      height: 22,
                      borderRadius: '50%',
                      background: isConnected ? 'rgba(16, 185, 129, 0.2)' : 'rgba(99, 102, 241, 0.2)',
                      color: isConnected ? '#34d399' : '#a5b4fc',
                      display: 'inline-flex',
                      alignItems: 'center',
                      justifyContent: 'center',
                      fontSize: 11.5,
                    }}
                  >
                    {isConnected ? <Check size={12} /> : '2'}
                  </span>
                  Paste Token &amp; Connect Live
                </div>
                <p style={{ margin: 0, fontSize: 12.5, color: 'var(--text-secondary)', lineHeight: 1.55 }}>
                  Paste your Bot Token below and click <strong>Connect Bot</strong>. ServerForge stores it securely in
                  SQLite, logs in immediately (no <code className="mono">.env</code> edit or restart), and generates your
                  1-click server invite link.
                </p>
                {isConnected && (
                  <div style={{ fontSize: 12.5, color: '#34d399', display: 'flex', alignItems: 'center', gap: 6, marginTop: 'auto' }}>
                    <CheckCircle2 size={14} /> Connected as <strong>{botTag}</strong>
                  </div>
                )}
              </div>

              {/* Step 3 */}
              <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
                <div style={{ display: 'flex', alignItems: 'center', gap: 8, fontWeight: 600, fontSize: 13 }}>
                  <span
                    style={{
                      width: 22,
                      height: 22,
                      borderRadius: '50%',
                      background: hasGuilds ? 'rgba(16, 185, 129, 0.2)' : 'rgba(99, 102, 241, 0.2)',
                      color: hasGuilds ? '#34d399' : '#a5b4fc',
                      display: 'inline-flex',
                      alignItems: 'center',
                      justifyContent: 'center',
                      fontSize: 11.5,
                    }}
                  >
                    {hasGuilds ? <Check size={12} /> : '3'}
                  </span>
                  Invite Bot to Your Server
                </div>
                <p style={{ margin: 0, fontSize: 12.5, color: 'var(--text-secondary)', lineHeight: 1.55 }}>
                  {discordStatus?.inviteUrl
                    ? 'Click below to invite your bot with least-privilege permissions, then click Refresh to auto-load your channels & roles.'
                    : 'Connect your bot in Step 2 first — your personalized 1-click Invite URL will appear right here.'}
                </p>
                {discordStatus?.inviteUrl && (
                  <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', marginTop: 'auto' }}>
                    <a
                      href={discordStatus.inviteUrl}
                      target="_blank"
                      rel="noreferrer"
                      className="btn btn-primary btn-sm"
                      style={{ textDecoration: 'none' }}
                    >
                      <ExternalLink size={12} /> Invite Bot to Discord
                    </a>
                    <button type="button" className="btn btn-sm" onClick={() => void handleCopyInvite()}>
                      {copiedInvite ? <Check size={12} /> : <Copy size={12} />}
                      {copiedInvite ? 'Copied' : 'Copy Link'}
                    </button>
                  </div>
                )}
              </div>
            </div>
          )}

          {/* Token Input & Live Controls */}
          <div className="field full" style={{ marginBottom: 0 }}>
            <label htmlFor="set-discord-token">
              Discord Bot Token{' '}
              {discordStatus?.tokenSource === 'env' ? (
                <span style={{ color: 'var(--text-muted)', fontWeight: 400 }}>(currently loaded from .env)</span>
              ) : settings.hasDiscordBotToken ? (
                <span style={{ color: 'var(--text-muted)', fontWeight: 400 }}>
                  (encrypted &amp; saved {settings.discordBotTokenPreview || '••••••••'})
                </span>
              ) : null}
            </label>
            <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
              <input
                id="set-discord-token"
                type={showToken ? 'text' : 'password'}
                className="input mono"
                style={{ flex: 1, minWidth: 240 }}
                value={tokenInput}
                onChange={(e) => {
                  setActionError(null);
                  setTokenInput(e.target.value);
                  onChange({ discordBotToken: e.target.value });
                }}
                placeholder={
                  discordStatus?.tokenSource === 'env'
                    ? 'Using DISCORD_TOKEN from .env (paste here to override)'
                    : settings.hasDiscordBotToken
                      ? `Saved (${settings.discordBotTokenPreview || '••••••••'}) — paste a new token to replace`
                      : 'Paste your Discord Bot Token from Discord Developer Portal'
                }
              />
              <button
                type="button"
                className="btn btn-sm"
                title={showToken ? 'Hide token' : 'Show token'}
                onClick={() => setShowToken((v) => !v)}
              >
                {showToken ? <EyeOff size={14} /> : <Eye size={14} />}
              </button>
              <button
                type="button"
                className="btn btn-primary btn-sm"
                disabled={connecting || (!tokenInput.trim() && !discordStatus?.hasToken)}
                onClick={() => void handleConnect()}
              >
                <Plug size={13} /> {connecting ? 'Connecting...' : isConnected ? 'Reconnect' : 'Connect Bot'}
              </button>
              {isConnected && (
                <>
                  <button
                    type="button"
                    className="btn btn-sm"
                    disabled={syncingCommands}
                    onClick={() => void handleSyncCommands()}
                  >
                    <Sparkles size={13} /> {syncingCommands ? 'Syncing...' : 'Re-Sync Slash Commands'}
                  </button>
                  <button
                    type="button"
                    className="btn btn-sm"
                    disabled={disconnecting}
                    onClick={() => void handleDisconnect(false)}
                  >
                    <Unplug size={13} /> {disconnecting ? 'Stopping...' : 'Disconnect'}
                  </button>
                </>
              )}
            </div>
            <span className="field-hint">
              Stored locally in ServerForge&apos;s SQLite database and automatically redacted from all diagnostic &amp; debug reports.
            </span>
          </div>
        </div>
      </section>

      {/* Panel 2 & 3: Channels/Panel + Role Permissions */}
      <div className="settings-grid-two">
        {/* Left: Server, Channels, Live Status Panel & Activity Toggle */}
        <section className="panel">
          <div className="panel-header">
            <h2 style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
              <LayoutGrid size={16} /> Server, Channels &amp; Live Status Panel
            </h2>
            {discordStatus?.statusPanelActive && (
              <span className="badge badge-running">
                <span className="badge-dot" /> PANEL ACTIVE
              </span>
            )}
          </div>
          <div className="panel-body">
            {isConnected && guilds.length === 0 && (
              <div
                style={{
                  marginBottom: 14,
                  padding: '10px 12px',
                  borderRadius: 'var(--radius-sm)',
                  background: 'rgba(245, 158, 11, 0.12)',
                  border: '1px solid rgba(245, 158, 11, 0.35)',
                  color: '#fcd34d',
                  fontSize: 12.5,
                }}
              >
                Your bot is online, but hasn&apos;t joined a Discord server yet. Click{' '}
                <strong>Invite Bot to Discord</strong> above, authorize your server, then click <strong>Refresh</strong>.
              </div>
            )}

            <div className="form-grid">
              {/* Discord Server (Guild) Picker */}
              <div className="field full">
                <label htmlFor="set-discord-guild">Discord Server (Guild)</label>
                {guilds.length > 0 ? (
                  <select
                    id="set-discord-guild"
                    className="select"
                    value={effectiveGuildId}
                    onChange={(e) => onChange({ discordGuildId: e.target.value })}
                  >
                    <option value="">All servers (global slash commands)</option>
                    {guilds.map((g) => (
                      <option key={g.id} value={g.id}>
                        {g.name}
                        {g.memberCount ? ` (${g.memberCount} members)` : ''}
                      </option>
                    ))}
                  </select>
                ) : (
                  <input
                    id="set-discord-guild"
                    className="input mono"
                    value={settings.discordGuildId}
                    onChange={(e) => onChange({ discordGuildId: e.target.value })}
                    placeholder="Auto-filled once bot joins your Discord server"
                  />
                )}
                <span className="field-hint">
                  Selecting your server makes <code className="mono">/server</code> slash commands appear instantly.
                </span>
              </div>

              {/* Alerts / Notifications Channel Picker */}
              <div className="field full">
                <label htmlFor="set-channel">Alerts &amp; Notifications Channel</label>
                <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
                  {channels.length > 0 ? (
                    <select
                      id="set-channel"
                      className="select"
                      style={{ flex: 1, minWidth: 200 }}
                      value={settings.discordNotifyChannelId}
                      onChange={(e) => onChange({ discordNotifyChannelId: e.target.value })}
                    >
                      <option value="">— Select a text channel —</option>
                      {channels.map((ch) => (
                        <option key={ch.id} value={ch.id} disabled={!ch.canSend}>
                          #{ch.name}
                          {ch.categoryName ? ` (${ch.categoryName})` : ''}
                          {!ch.canSend ? ' [no Send permission]' : ''}
                        </option>
                      ))}
                    </select>
                  ) : (
                    <input
                      id="set-channel"
                      className="input mono"
                      style={{ flex: 1, minWidth: 200 }}
                      value={settings.discordNotifyChannelId}
                      onChange={(e) => onChange({ discordNotifyChannelId: e.target.value })}
                      placeholder="Channel ID for crash, auto-stop & reboot alerts"
                    />
                  )}
                  <button
                    type="button"
                    className="btn btn-sm"
                    disabled={!isConnected || sendingTest || !settings.discordNotifyChannelId}
                    onClick={() => void handleSendTest()}
                  >
                    <Send size={12} /> {sendingTest ? 'Sending...' : 'Send Test Alert'}
                  </button>
                </div>
                <span className="field-hint">
                  Receives crash alerts, auto-shutdown warnings, daily reboot notices, and optional player activity.
                </span>
              </div>

              {/* Live Auto-Updating Status Panel Channel Picker */}
              <div className="field full">
                <label htmlFor="set-panel-channel">Live Auto-Updating Status Panel Channel</label>
                <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
                  {channels.length > 0 ? (
                    <select
                      id="set-panel-channel"
                      className="select"
                      style={{ flex: 1, minWidth: 200 }}
                      value={settings.discordStatusPanelChannelId}
                      onChange={(e) => onChange({ discordStatusPanelChannelId: e.target.value })}
                    >
                      <option value="">— Disabled (optional) —</option>
                      {channels.map((ch) => (
                        <option key={ch.id} value={ch.id} disabled={!ch.canSend}>
                          #{ch.name}
                          {ch.categoryName ? ` (${ch.categoryName})` : ''}
                          {!ch.canSend ? ' [no Send permission]' : ''}
                        </option>
                      ))}
                    </select>
                  ) : (
                    <input
                      id="set-panel-channel"
                      className="input mono"
                      style={{ flex: 1, minWidth: 200 }}
                      value={settings.discordStatusPanelChannelId}
                      onChange={(e) => onChange({ discordStatusPanelChannelId: e.target.value })}
                      placeholder="Optional channel ID for persistent live status board"
                    />
                  )}
                  <button
                    type="button"
                    className="btn btn-primary btn-sm"
                    disabled={!isConnected || postingPanel || !settings.discordStatusPanelChannelId}
                    onClick={() => void handlePostPanel(false)}
                  >
                    <LayoutGrid size={12} />{' '}
                    {postingPanel
                      ? 'Posting...'
                      : discordStatus?.statusPanelActive
                        ? 'Refresh Panel'
                        : 'Post Live Panel'}
                  </button>
                  {discordStatus?.statusPanelActive && (
                    <button
                      type="button"
                      className="btn btn-sm"
                      disabled={!isConnected || postingPanel}
                      onClick={() => void handlePostPanel(true)}
                      title="Post a brand-new status panel message in this channel"
                    >
                      Repost New
                    </button>
                  )}
                </div>
                <span className="field-hint">
                  Posts a persistent embed with live player counts, join addresses &amp; Start/Extend/Stop buttons that
                  auto-updates whenever servers change or every 60s.
                </span>
              </div>

              {/* Player Join/Leave Activity Toggle */}
              <div className="field full" style={{ marginTop: 4 }}>
                <label style={{ display: 'flex', alignItems: 'center', gap: 10, cursor: 'pointer' }}>
                  <input
                    type="checkbox"
                    checked={settings.discordPlayerActivityEnabled}
                    onChange={(e) => onChange({ discordPlayerActivityEnabled: e.target.checked })}
                  />
                  <span>Post Player Join / Leave Notifications</span>
                </label>
                <span className="field-hint">
                  Monitors online player lists every 30s and posts join/leave notices in your Alerts channel.
                </span>
              </div>
            </div>
          </div>
        </section>

        {/* Right: Role Permissions Picker */}
        <section className="panel">
          <div className="panel-header">
            <h2 style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
              <Shield size={16} /> Discord Role Permissions
            </h2>
          </div>
          <div className="panel-body">
            <p className="settings-card-desc">
              Pick which Discord roles can boot servers or run admin commands. Discord Server Administrators always have
              full access automatically.
            </p>

            {roles.length > 0 ? (
              <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
                <div>
                  <div style={{ fontSize: 12.5, fontWeight: 600, marginBottom: 8 }}>
                    Allowed Roles <span style={{ color: 'var(--text-muted)', fontWeight: 400 }}>(Can Boot &amp; Extend)</span>
                  </div>
                  <div style={{ display: 'flex', flexWrap: 'wrap', gap: 7 }}>
                    {roles.map((role) => {
                      const active = allowedSet.has(role.id);
                      return (
                        <button
                          key={`allow-${role.id}`}
                          type="button"
                          onClick={() => onAllowedRolesChange(toggleRoleId(allowedRolesText, role.id))}
                          style={{
                            display: 'inline-flex',
                            alignItems: 'center',
                            gap: 6,
                            padding: '5px 10px',
                            borderRadius: 999,
                            fontSize: 12.5,
                            cursor: 'pointer',
                            border: active ? '1px solid var(--accent)' : '1px solid var(--border-subtle)',
                            background: active ? 'rgba(99, 102, 241, 0.2)' : 'var(--bg-elevated)',
                            color: active ? 'var(--text-primary)' : 'var(--text-secondary)',
                          }}
                        >
                          <span
                            style={{
                              width: 8,
                              height: 8,
                              borderRadius: '50%',
                              background: role.colorHex,
                              display: 'inline-block',
                            }}
                          />
                          @{role.name}
                          {active && <Check size={12} />}
                        </button>
                      );
                    })}
                  </div>
                </div>

                <div>
                  <div style={{ fontSize: 12.5, fontWeight: 600, marginBottom: 8 }}>
                    Admin Roles{' '}
                    <span style={{ color: 'var(--text-muted)', fontWeight: 400 }}>
                      (Can Stop Any, Backup, Say, Whitelist &amp; Panel)
                    </span>
                  </div>
                  <div style={{ display: 'flex', flexWrap: 'wrap', gap: 7 }}>
                    {roles.map((role) => {
                      const active = adminSet.has(role.id);
                      return (
                        <button
                          key={`admin-${role.id}`}
                          type="button"
                          onClick={() => onAdminRolesChange(toggleRoleId(adminRolesText, role.id))}
                          style={{
                            display: 'inline-flex',
                            alignItems: 'center',
                            gap: 6,
                            padding: '5px 10px',
                            borderRadius: 999,
                            fontSize: 12.5,
                            cursor: 'pointer',
                            border: active ? '1px solid #f59e0b' : '1px solid var(--border-subtle)',
                            background: active ? 'rgba(245, 158, 11, 0.18)' : 'var(--bg-elevated)',
                            color: active ? '#fde68a' : 'var(--text-secondary)',
                          }}
                        >
                          <span
                            style={{
                              width: 8,
                              height: 8,
                              borderRadius: '50%',
                              background: role.colorHex,
                              display: 'inline-block',
                            }}
                          />
                          @{role.name}
                          {active && <Check size={12} />}
                        </button>
                      );
                    })}
                  </div>
                </div>
              </div>
            ) : (
              <div className="form-grid">
                <div className="field full">
                  <label htmlFor="set-allowed-roles">Allowed Role IDs (comma-separated)</label>
                  <input
                    id="set-allowed-roles"
                    className="input mono"
                    value={allowedRolesText}
                    onChange={(e) => onAllowedRolesChange(e.target.value)}
                    placeholder="Connect & invite bot to pick roles visually, or paste IDs"
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
                    placeholder="Optional admin override role IDs"
                  />
                  <span className="field-hint">
                    Can stop any server and run /server backup, /server say, /server whitelist, and /server panel.
                  </span>
                </div>
              </div>
            )}

            {roles.length > 0 && (
              <details style={{ marginTop: 16, fontSize: 12.5, color: 'var(--text-secondary)' }}>
                <summary style={{ cursor: 'pointer', color: 'var(--text-muted)' }}>
                  Edit raw Role IDs manually
                </summary>
                <div className="form-grid" style={{ marginTop: 10 }}>
                  <div className="field full">
                    <label htmlFor="set-allowed-roles">Allowed Role IDs</label>
                    <input
                      id="set-allowed-roles"
                      className="input mono"
                      value={allowedRolesText}
                      onChange={(e) => onAllowedRolesChange(e.target.value)}
                      placeholder="123456789012345678, 987654321098765432"
                    />
                  </div>
                  <div className="field full">
                    <label htmlFor="set-admin-roles">Admin Role IDs</label>
                    <input
                      id="set-admin-roles"
                      className="input mono"
                      value={adminRolesText}
                      onChange={(e) => onAdminRolesChange(e.target.value)}
                      placeholder="Optional admin override role IDs"
                    />
                  </div>
                </div>
              </details>
            )}
          </div>
        </section>
      </div>

      {/* Panel 4: Expanded Slash Commands Reference */}
      <section className="panel">
        <div className="panel-header">
          <h2 style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
            <Sparkles size={16} /> Available Slash Commands
          </h2>
          <span style={{ fontSize: 12, color: 'var(--text-muted)' }}>{SLASH_COMMANDS.length} commands</span>
        </div>
        <div className="panel-body">
          <div
            style={{
              display: 'grid',
              gridTemplateColumns: 'repeat(auto-fit, minmax(290px, 1fr))',
              gap: 10,
            }}
          >
            {SLASH_COMMANDS.map((item) => (
              <div
                key={item.cmd}
                style={{
                  padding: '10px 12px',
                  borderRadius: 'var(--radius-sm)',
                  background: 'var(--bg-elevated)',
                  border: '1px solid var(--border-subtle)',
                  display: 'flex',
                  flexDirection: 'column',
                  gap: 4,
                }}
              >
                <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 8 }}>
                  <code className="mono" style={{ fontSize: 12.5, color: 'var(--text-primary)' }}>
                    {item.cmd}
                  </code>
                  <span
                    style={{
                      fontSize: 10.5,
                      fontWeight: 600,
                      padding: '2px 7px',
                      borderRadius: 999,
                      whiteSpace: 'nowrap',
                      background:
                        item.role === 'Admin'
                          ? 'rgba(245, 158, 11, 0.16)'
                          : item.role === 'Allowed Role'
                            ? 'rgba(99, 102, 241, 0.18)'
                            : 'rgba(148, 163, 184, 0.16)',
                      color:
                        item.role === 'Admin'
                          ? '#fcd34d'
                          : item.role === 'Allowed Role'
                            ? '#a5b4fc'
                            : 'var(--text-secondary)',
                    }}
                  >
                    {item.role}
                  </span>
                </div>
                <div style={{ fontSize: 12, color: 'var(--text-secondary)' }}>{item.desc}</div>
              </div>
            ))}
          </div>
        </div>
      </section>
    </div>
  );
}
