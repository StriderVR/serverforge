import React, { useEffect, useMemo, useState } from 'react';
import { Bot, Bug, Download, Globe, KeyRound, RotateCcw, Save, Shield } from 'lucide-react';
import type {
  AppDiagnosticEvent,
  AuditLogEntry,
  DiagnosticLevel,
  DiscordDiscoveryStatus,
  HostMetrics,
  MaintenanceStatus,
  NetworkStatus,
  SystemSettings,
  SystemSettingsResponse,
  UpdaterStatus,
} from '@serverforge/shared';
import { api } from '../api';
import type { ConfirmDialogOptions } from './ConfirmModal';
import type { PushToastFn } from './ToastStack';
import { DiagnosticsActivityTab } from './settings/DiagnosticsActivityTab';
import { DiscordBotTab } from './settings/DiscordBotTab';
import { GeneralGuardrailsTab } from './settings/GeneralGuardrailsTab';
import { NetworkingIntegrationsTab } from './settings/NetworkingIntegrationsTab';
import { SecurityTab } from './settings/SecurityTab';
import { UpdatesMaintenanceTab } from './settings/UpdatesMaintenanceTab';

export type SettingsTabId = 'general' | 'security' | 'networking' | 'discord' | 'updates' | 'diagnostics';

interface SettingsPageProps {
  metrics: HostMetrics | null;
  updaterStatus: UpdaterStatus | null;
  updaterProgress: { stage: string; percent: number; message: string } | null;
  activeTab: SettingsTabId;
  onTabChange: (tab: SettingsTabId) => void;
  onSaved: () => void;
  onRefreshUpdater: (force?: boolean) => Promise<void>;
  onStartReconnecting: (label: string, expectedVersion?: string) => void;
  onOpenBugReporter: () => void;
  onConfirm: (opts: ConfirmDialogOptions) => Promise<boolean>;
  onToast: PushToastFn;
}

function parseRoleIds(txt: string): string[] {
  return txt
    .split(/[,\s]+/)
    .map((s) => s.trim())
    .filter(Boolean);
}

export function SettingsPage({
  metrics,
  updaterStatus,
  updaterProgress,
  activeTab,
  onTabChange,
  onSaved,
  onRefreshUpdater,
  onStartReconnecting,
  onOpenBugReporter,
  onConfirm,
  onToast,
}: SettingsPageProps) {
  const [settings, setSettings] = useState<SystemSettingsResponse | null>(null);
  const [savedSnapshot, setSavedSnapshot] = useState<SystemSettingsResponse | null>(null);
  const [maintenance, setMaintenance] = useState<MaintenanceStatus | null>(null);
  const [networkStatus, setNetworkStatus] = useState<NetworkStatus | null>(null);
  const [discordStatus, setDiscordStatus] = useState<DiscordDiscoveryStatus | null>(null);
  const [allowedRolesText, setAllowedRolesText] = useState('');
  const [adminRolesText, setAdminRolesText] = useState('');
  const [auditLogs, setAuditLogs] = useState<AuditLogEntry[]>([]);

  const [diagLogs, setDiagLogs] = useState<AppDiagnosticEvent[]>([]);
  const [diagFilter, setDiagFilter] = useState<'all' | DiagnosticLevel>('all');
  const [loadingDiag, setLoadingDiag] = useState(false);

  const [saving, setSaving] = useState(false);

  const loadDiagnostics = async (level: 'all' | DiagnosticLevel = diagFilter) => {
    setLoadingDiag(true);
    try {
      const items = await api.getDiagnosticLogs(level === 'all' ? undefined : level, 120);
      setDiagLogs(items);
    } catch {
      // non-fatal
    } finally {
      setLoadingDiag(false);
    }
  };

  const loadAll = async () => {
    const [s, logs, maint, net, diag, disc] = await Promise.all([
      api.getSettings(),
      api.getAuditLogs(40),
      api.getMaintenanceStatus(),
      api.getNetworkStatus().catch(() => null),
      api.getDiagnosticLogs(undefined, 120).catch(() => []),
      api.getDiscordStatus().catch(() => null),
    ]);
    setSettings(s);
    setSavedSnapshot(s);
    setMaintenance(maint);
    if (net) setNetworkStatus(net);
    if (disc) setDiscordStatus(disc);
    setAllowedRolesText(s.discordAllowedRoleIds.join(', '));
    setAdminRolesText(s.discordAdminRoleIds.join(', '));
    setAuditLogs(logs);
    setDiagLogs(diag);
  };

  useEffect(() => {
    void loadAll();
  }, []);

  const hasUnsavedChanges = useMemo(() => {
    if (!settings || !savedSnapshot) return false;
    const currentNormalized: SystemSettingsResponse = {
      ...settings,
      discordAllowedRoleIds: parseRoleIds(allowedRolesText),
      discordAdminRoleIds: parseRoleIds(adminRolesText),
    };
    return JSON.stringify(currentNormalized) !== JSON.stringify(savedSnapshot);
  }, [settings, savedSnapshot, allowedRolesText, adminRolesText]);

  const diagErrorCount = useMemo(
    () => diagLogs.filter((ev) => ev.level === 'error').length,
    [diagLogs]
  );

  const patchSettings = (patch: Partial<SystemSettings>) => {
    setSettings((prev) => (prev ? { ...prev, ...patch } : prev));
  };

  const syncSavedSetting = (patch: Partial<SystemSettingsResponse>) => {
    setSettings((prev) => (prev ? { ...prev, ...patch } : prev));
    setSavedSnapshot((prev) => (prev ? { ...prev, ...patch } : prev));
    onSaved();
  };

  const handleDiscard = () => {
    if (!savedSnapshot) return;
    setSettings(savedSnapshot);
    setAllowedRolesText(savedSnapshot.discordAllowedRoleIds.join(', '));
    setAdminRolesText(savedSnapshot.discordAdminRoleIds.join(', '));
    onToast('info', 'Unsaved changes discarded.');
  };

  const handleSave = async () => {
    if (!settings) return;
    setSaving(true);
    try {
      const saved = await api.saveSettings({
        ...settings,
        discordAllowedRoleIds: parseRoleIds(allowedRolesText),
        discordAdminRoleIds: parseRoleIds(adminRolesText),
      });
      setSettings(saved);
      setSavedSnapshot(saved);
      setAllowedRolesText(saved.discordAllowedRoleIds.join(', '));
      setAdminRolesText(saved.discordAdminRoleIds.join(', '));
      const [maint, net, disc] = await Promise.all([
        api.getMaintenanceStatus(),
        api.getNetworkStatus().catch(() => null),
        api.getDiscordStatus().catch(() => null),
      ]);
      setMaintenance(maint);
      if (net) setNetworkStatus(net);
      if (disc) setDiscordStatus(disc);
      onToast('success', 'Settings saved.');
      onSaved();
    } catch (err) {
      onToast('error', err instanceof Error ? err.message : 'Save failed');
    } finally {
      setSaving(false);
    }
  };

  if (!settings) {
    return <div className="panel panel-body">Loading settings...</div>;
  }

  const undecryptableFields = settings.secretVaultStatus?.undecryptableFields ?? [];

  return (
    <div style={{ paddingBottom: hasUnsavedChanges ? 78 : 12 }}>
      <header className="page-header">
        <div>
          <h1>Settings, Updates &amp; Automation</h1>
          <p className="page-subtitle">
            Organize host guardrails, DuckDNS &amp; CurseForge integrations, Discord permissions, updates, and diagnostics.
          </p>
        </div>
        <button
          id="save-settings-btn"
          type="button"
          className={`btn ${hasUnsavedChanges ? 'btn-primary' : ''}`}
          disabled={saving || !hasUnsavedChanges}
          onClick={() => void handleSave()}
        >
          <Save size={14} /> {saving ? 'Saving...' : hasUnsavedChanges ? 'Save Changes' : 'All Saved'}
        </button>
      </header>

      {undecryptableFields.length > 0 && (
        <div className="alert alert-error" style={{ marginBottom: 14 }}>
          <strong>Secret Vault Recovery Needed:</strong> Some encrypted credentials could not be decrypted with this machine&apos;s key ({undecryptableFields.join(', ')}). If you moved <code>serverforge.sqlite</code> from another PC, please re-enter those tokens or passwords and save.
        </div>
      )}

      <div className="tabs settings-tabs" role="tablist" aria-label="Settings sections">
        <button
          type="button"
          role="tab"
          aria-selected={activeTab === 'general'}
          className={`tab-btn ${activeTab === 'general' ? 'active' : ''}`}
          onClick={() => onTabChange('general')}
        >
          <Shield size={14} />
          <span>General &amp; Guardrails</span>
        </button>

        <button
          type="button"
          role="tab"
          aria-selected={activeTab === 'security'}
          className={`tab-btn ${activeTab === 'security' ? 'active' : ''}`}
          onClick={() => onTabChange('security')}
        >
          <KeyRound size={14} />
          <span>Security &amp; Audit</span>
        </button>

        <button
          type="button"
          role="tab"
          aria-selected={activeTab === 'networking'}
          className={`tab-btn ${activeTab === 'networking' ? 'active' : ''}`}
          onClick={() => onTabChange('networking')}
        >
          <Globe size={14} />
          <span>Networking &amp; Integrations</span>
        </button>

        <button
          type="button"
          role="tab"
          aria-selected={activeTab === 'discord'}
          className={`tab-btn ${activeTab === 'discord' ? 'active' : ''}`}
          onClick={() => onTabChange('discord')}
        >
          <Bot size={14} />
          <span>Discord Bot</span>
          <span
            className={`tab-dot ${(discordStatus?.connected ?? metrics?.discordConnected) ? 'tab-dot-online' : 'tab-dot-muted'}`}
            title={(discordStatus?.connected ?? metrics?.discordConnected) ? 'Discord bot connected' : 'Discord bot offline'}
          />
        </button>

        <button
          type="button"
          role="tab"
          aria-selected={activeTab === 'updates'}
          className={`tab-btn ${activeTab === 'updates' ? 'active' : ''}`}
          onClick={() => onTabChange('updates')}
        >
          <Download size={14} />
          <span>Updates &amp; Maintenance</span>
          {updaterStatus?.updateAvailable && (
            <span className="tab-pill tab-pill-warn">v{updaterStatus.latestVersion}</span>
          )}
        </button>

        <button
          type="button"
          role="tab"
          aria-selected={activeTab === 'diagnostics'}
          className={`tab-btn ${activeTab === 'diagnostics' ? 'active' : ''}`}
          onClick={() => onTabChange('diagnostics')}
        >
          <Bug size={14} />
          <span>Diagnostics &amp; Activity</span>
          {diagErrorCount > 0 && <span className="tab-pill tab-pill-danger">{diagErrorCount}</span>}
        </button>
      </div>

      {activeTab === 'general' && <GeneralGuardrailsTab settings={settings} onChange={patchSettings} />}

      {activeTab === 'security' && (
        <SecurityTab
          settings={settings}
          onChange={patchSettings}
          onSyncSavedSetting={syncSavedSetting}
          onConfirm={onConfirm}
          onToast={onToast}
        />
      )}

      {activeTab === 'networking' && (
        <NetworkingIntegrationsTab
          settings={settings}
          networkStatus={networkStatus}
          onChange={patchSettings}
          onNetworkUpdated={(status) => {
            setNetworkStatus(status);
            onSaved();
          }}
          onSyncSavedSetting={syncSavedSetting}
          onToast={onToast}
        />
      )}

      {activeTab === 'discord' && (
        <DiscordBotTab
          metrics={metrics}
          settings={settings}
          discordStatus={discordStatus}
          allowedRolesText={allowedRolesText}
          adminRolesText={adminRolesText}
          onAllowedRolesChange={setAllowedRolesText}
          onAdminRolesChange={setAdminRolesText}
          onChange={patchSettings}
          onSyncSavedSetting={syncSavedSetting}
          onDiscordStatusUpdated={(status) => {
            setDiscordStatus(status);
            onSaved();
          }}
          onToast={onToast}
        />
      )}

      {activeTab === 'updates' && (
        <UpdatesMaintenanceTab
          settings={settings}
          maintenance={maintenance}
          updaterStatus={updaterStatus}
          updaterProgress={updaterProgress}
          onChange={patchSettings}
          onSyncSavedSetting={syncSavedSetting}
          onRefreshUpdater={onRefreshUpdater}
          onStartReconnecting={onStartReconnecting}
          onConfirm={onConfirm}
          onToast={onToast}
        />
      )}

      {activeTab === 'diagnostics' && (
        <DiagnosticsActivityTab
          settings={settings}
          diagLogs={diagLogs}
          diagFilter={diagFilter}
          loadingDiag={loadingDiag}
          auditLogs={auditLogs}
          onChange={patchSettings}
          onSyncSavedSetting={syncSavedSetting}
          onOpenBugReporter={onOpenBugReporter}
          onFilterChange={(level) => {
            setDiagFilter(level);
            void loadDiagnostics(level);
          }}
          onRefreshDiagnostics={() => void loadDiagnostics(diagFilter)}
          onClearedDiagnostics={() => setDiagLogs([])}
          onConfirm={onConfirm}
          onToast={onToast}
        />
      )}

      {hasUnsavedChanges && (
        <div className="sticky-save-bar" role="status" aria-live="polite">
          <span>You have unsaved settings changes.</span>
          <div className="btn-row">
            <button type="button" className="btn btn-sm" disabled={saving} onClick={handleDiscard}>
              <RotateCcw size={13} /> Discard
            </button>
            <button
              type="button"
              className="btn btn-primary btn-sm"
              disabled={saving}
              onClick={() => void handleSave()}
            >
              <Save size={13} /> {saving ? 'Saving...' : 'Save Changes'}
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
