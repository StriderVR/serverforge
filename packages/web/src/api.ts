import type {
  AppDiagnosticEvent,
  AuditLogEntry,
  BackupPolicy,
  BackupRecord,
  CreateInstanceInput,
  CurseForgeModpackFile,
  CurseForgeModpackSummary,
  DiagnosticLevel,
  DiscoveredProcess,
  FolderBrowseResult,
  FolderPickResult,
  GameTemplate,
  HostMetrics,
  ImportInspectionResult,
  ImportServerInput,
  InstanceDebugReport,
  MaintenanceStatus,
  NetworkStatus,
  PublicHostSource,
  ServerInstance,
  ServerLease,
  StartInstanceInput,
  SystemDiagnosticsReport,
  SystemSettings,
  UpdateInstanceConfigInput,
  UpdaterStatus,
  WindowsRebootInspection,
} from '@serverforge/shared';

export interface InstanceWithJoin extends ServerInstance {
  joinAddress: string;
  localJoinAddress?: string | null;
  publicHost?: string;
  publicHostSource?: PublicHostSource;
}

export interface InstanceDetail extends InstanceWithJoin {
  logs: Array<{ timestamp: string; line: string }>;
  backups: BackupRecord[];
}

export interface AuthState {
  needsSetup: boolean;
  authenticated: boolean;
  user: { id: string; username: string; role: string } | null;
}

async function request<T>(url: string, init?: RequestInit): Promise<T> {
  const headers: Record<string, string> = {};
  if (init?.body !== undefined) {
    headers['Content-Type'] = 'application/json';
  }
  const res = await fetch(url, {
    credentials: 'include',
    ...init,
    headers: {
      ...headers,
      ...(init?.headers as Record<string, string> | undefined),
    },
  });

  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    const parsed = data as { error?: string; message?: string; issues?: Array<{ path?: (string | number)[]; message?: string }> };
    let msg = parsed.error || parsed.message || `Request failed (${res.status})`;
    if (Array.isArray(parsed.issues) && parsed.issues.length > 0 && !msg.includes(':')) {
      const details = parsed.issues
        .slice(0, 3)
        .map((i) => (i.path && i.path.length > 0 ? `${i.path.join('.')}: ${i.message}` : i.message))
        .filter(Boolean)
        .join('; ');
      if (details) msg = `${msg}: ${details}`;
    }
    throw new Error(msg);
  }
  return data as T;
}

export const api = {
  getHealth: () => request<{ status: string; version: string; runtimeMode: string; needsSetup: boolean }>('/api/health'),
  getAuthMe: () => request<AuthState>('/api/auth/me'),
  setupAdmin: (username: string, password: string) =>
    request<{ user: { id: string; username: string } }>('/api/auth/setup', {
      method: 'POST',
      body: JSON.stringify({ username, password }),
    }),
  login: (username: string, password: string) =>
    request<{ user: { id: string; username: string } }>('/api/auth/login', {
      method: 'POST',
      body: JSON.stringify({ username, password }),
    }),
  logout: () => request<{ ok: boolean }>('/api/auth/logout', { method: 'POST' }),

  getHostMetrics: () => request<HostMetrics>('/api/host/metrics'),
  getSettings: () => request<SystemSettings>('/api/settings'),
  saveSettings: (patch: Partial<SystemSettings>) =>
    request<SystemSettings>('/api/settings', {
      method: 'PUT',
      body: JSON.stringify(patch),
    }),
  getNetworkStatus: (refresh = false) =>
    request<NetworkStatus>(`/api/network/status${refresh ? '?refresh=1' : ''}`),
  detectNetwork: () =>
    request<NetworkStatus>('/api/network/detect', {
      method: 'POST',
      body: '{}',
    }),
  updateDuckDns: (payload: {
    domain?: string;
    token?: string;
    saveOnSuccess?: boolean;
    autoUpdate?: boolean;
  } = {}) =>
    request<{
      ok: boolean;
      saved: boolean;
      message: string;
      domain: string;
      ip: string | null;
      status: NetworkStatus;
    }>('/api/network/duckdns/update', {
      method: 'POST',
      body: JSON.stringify(payload),
    }),
  getAuditLogs: (limit = 60) => request<AuditLogEntry[]>(`/api/audit?limit=${limit}`),

  // Updater
  getUpdaterStatus: (refresh = false) =>
    request<UpdaterStatus>(`/api/updater/status${refresh ? '?refresh=1' : ''}`),
  getUpdaterLog: () => request<{ log: string | null }>('/api/updater/log'),
  applyUpdate: (resumeRunningServers = true) =>
    request<{ ok: boolean; accepted?: boolean; restarting: boolean; targetVersion: string; rememberedServers: number }>(
      '/api/updater/apply',
      {
        method: 'POST',
        body: JSON.stringify({ resumeRunningServers }),
      }
    ),

  // Maintenance & Daily Reboot
  getMaintenanceStatus: () => request<MaintenanceStatus>('/api/maintenance/status'),
  triggerPcReboot: (resumeRunningServers = true, reason?: string) =>
    request<{ ok: boolean; rebooting: boolean; stoppedServers: number; rememberedServers: number }>(
      '/api/maintenance/reboot',
      {
        method: 'POST',
        body: JSON.stringify({ resumeRunningServers, reason }),
      }
    ),
  inspectWindowsReboots: () => request<WindowsRebootInspection>('/api/maintenance/inspect-reboots'),
  disableWindowsTask: (taskPath: string, taskName: string) =>
    request<{ ok: boolean }>('/api/maintenance/disable-task', {
      method: 'POST',
      body: JSON.stringify({ taskPath, taskName }),
    }),

  // CurseForge
  getCurseForgeStatus: () => request<{ configured: boolean }>('/api/curseforge/status'),
  testCurseForgeKey: (apiKey?: string) =>
    request<{ ok: boolean; saved?: boolean; message: string; normalizedKey: string }>('/api/curseforge/test', {
      method: 'POST',
      body: JSON.stringify(apiKey !== undefined ? { apiKey, saveOnSuccess: true } : { saveOnSuccess: true }),
    }),
  searchCurseForge: (q: string) =>
    request<CurseForgeModpackSummary[]>(`/api/curseforge/search?q=${encodeURIComponent(q)}`),
  getCurseForgeFiles: (modId: number) =>
    request<CurseForgeModpackFile[]>(`/api/curseforge/mods/${modId}/files`),
  getCurseForgeServerPackUrl: (modId: number, fileId: number) =>
    request<{ url: string | null }>(`/api/curseforge/mods/${modId}/files/${fileId}/download-url`),

  // Smart Server Import
  discoverRunningServers: () => request<DiscoveredProcess[]>('/api/import/discover'),
  pickImportFolder: (initialDir?: string) =>
    request<FolderPickResult>('/api/import/pick-folder', {
      method: 'POST',
      body: JSON.stringify({ initialDir }),
    }),
  browseFolders: (dir?: string) =>
    request<FolderBrowseResult>(`/api/import/browse${dir !== undefined ? `?dir=${encodeURIComponent(dir)}` : ''}`),
  inspectImportFolder: (folderPath: string) =>
    request<ImportInspectionResult>('/api/import/inspect', {
      method: 'POST',
      body: JSON.stringify({ folderPath }),
    }),
  executeImport: (input: ImportServerInput) =>
    request<InstanceWithJoin>('/api/import/execute', {
      method: 'POST',
      body: JSON.stringify(input),
    }),

  getCatalog: () => request<GameTemplate[]>('/api/catalog'),
  getTemplateYaml: (id: string) => request<{ id: string; yaml: string }>(`/api/catalog/${id}/yaml`),
  validateTemplateYaml: (yaml: string) =>
    request<{ valid: boolean; template?: GameTemplate; errors?: string[] }>('/api/catalog/validate', {
      method: 'POST',
      body: JSON.stringify({ yaml }),
    }),
  importTemplateYaml: (yaml: string) =>
    request<GameTemplate>('/api/catalog/import', {
      method: 'POST',
      body: JSON.stringify({ yaml }),
    }),
  deleteCustomTemplate: (id: string) =>
    request<{ ok: boolean }>(`/api/catalog/${id}`, { method: 'DELETE' }),

  getInstances: () => request<InstanceWithJoin[]>('/api/instances'),
  getInstance: (id: string) => request<InstanceDetail>(`/api/instances/${id}`),
  createInstance: (input: CreateInstanceInput) =>
    request<InstanceWithJoin>('/api/instances', {
      method: 'POST',
      body: JSON.stringify(input),
    }),
  updateInstanceConfig: (id: string, input: UpdateInstanceConfigInput) =>
    request<InstanceWithJoin>(`/api/instances/${id}/config`, {
      method: 'PATCH',
      body: JSON.stringify(input),
    }),
  startInstance: (id: string, input: Partial<StartInstanceInput> = {}) =>
    request<InstanceWithJoin>(`/api/instances/${id}/start`, {
      method: 'POST',
      body: JSON.stringify(input),
    }),
  stopInstance: (id: string) =>
    request<InstanceWithJoin>(`/api/instances/${id}/stop`, { method: 'POST', body: '{}' }),
  restartInstance: (id: string) =>
    request<InstanceWithJoin>(`/api/instances/${id}/restart`, { method: 'POST', body: '{}' }),
  sendCommand: (id: string, command: string) =>
    request<{ ok: boolean; response: string | null }>(`/api/instances/${id}/command`, {
      method: 'POST',
      body: JSON.stringify({ command }),
    }),
  extendLease: (id: string, minutes = 60) =>
    request<ServerLease>(`/api/instances/${id}/lease/extend`, {
      method: 'POST',
      body: JSON.stringify({ minutes }),
    }),
  promoteLease: (id: string) =>
    request<ServerInstance>(`/api/instances/${id}/lease/promote`, { method: 'POST', body: '{}' }),
  createBackup: (id: string, note?: string) =>
    request<BackupRecord>(`/api/instances/${id}/backups`, {
      method: 'POST',
      body: JSON.stringify({ note }),
    }),
  getBackupDownloadUrl: (id: string, backupId: string) =>
    `/api/instances/${encodeURIComponent(id)}/backups/${encodeURIComponent(backupId)}/download`,
  restoreBackup: (id: string, backupId: string) =>
    request<{ ok: boolean; restoredBackup: BackupRecord; safetyBackup: BackupRecord; extractedFiles: number }>(
      `/api/instances/${encodeURIComponent(id)}/backups/${encodeURIComponent(backupId)}/restore`,
      { method: 'POST', body: '{}' }
    ),
  deleteBackup: (id: string, backupId: string) =>
    request<{ ok: boolean; deleted: BackupRecord }>(
      `/api/instances/${encodeURIComponent(id)}/backups/${encodeURIComponent(backupId)}`,
      { method: 'DELETE' }
    ),
  updateBackupPolicy: (id: string, policy: Partial<BackupPolicy>) =>
    request<{ policy: BackupPolicy; instance: InstanceWithJoin }>(
      `/api/instances/${encodeURIComponent(id)}/backups/policy`,
      {
        method: 'PUT',
        body: JSON.stringify(policy),
      }
    ),

  // Diagnostics & Logs
  getInstanceLogDownloadUrl: (id: string) => `/api/instances/${encodeURIComponent(id)}/logs/download`,
  getInstanceDebugReport: (id: string) =>
    request<InstanceDebugReport>(`/api/instances/${encodeURIComponent(id)}/debug-report`),
  getDiagnosticLogs: (level?: DiagnosticLevel, limit = 100) => {
    const params = new URLSearchParams({ limit: String(limit) });
    if (level) params.set('level', level);
    return request<AppDiagnosticEvent[]>(`/api/diagnostics/logs?${params.toString()}`);
  },
  clearDiagnosticLogs: () => request<{ ok: boolean }>('/api/diagnostics/logs', { method: 'DELETE' }),
  getSystemDiagnosticsReport: () => request<SystemDiagnosticsReport>('/api/diagnostics/report'),

  deleteInstance: (id: string) =>
    request<{ ok: boolean }>(`/api/instances/${id}`, { method: 'DELETE' }),
};

export function formatRemaining(isoDate: string): string {
  const diffMin = Math.max(0, Math.round((new Date(isoDate).getTime() - Date.now()) / 60_000));
  if (diffMin >= 60) {
    const h = Math.floor(diffMin / 60);
    const m = diffMin % 60;
    return m > 0 ? `${h}h ${m}m` : `${h}h`;
  }
  return `${diffMin}m`;
}

export function formatHostSourceLabel(source?: PublicHostSource): string {
  switch (source) {
    case 'duckdns':
    case 'detected_duckdns':
      return 'DuckDNS';
    case 'public_ip':
      return 'Public IP';
    case 'manual':
    case 'env':
      return 'Custom';
    case 'lan':
      return 'LAN';
    default:
      return 'Local';
  }
}
