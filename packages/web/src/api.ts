import type {
  AddonUpdateCandidate,
  AppDiagnosticEvent,
  AuditLogEntry,
  AuthSessionSummary,
  BackupPolicy,
  BackupRecord,
  ConsolidatedPortMapEntry,
  CreateInstanceInput,
  CurseForgeModpackFile,
  CurseForgeModpackSummary,
  DiagnosticLevel,
  DiscoveredProcess,
  FirewallApplyResult,
  FirewallRemoveResult,
  FirewallStatus,
  FolderBrowseResult,
  FolderPickResult,
  GameTemplate,
  HostMetrics,
  ImportInspectionResult,
  ImportServerInput,
  InstalledAddonEntry,
  InstalledAddonsResponse,
  InstanceConnectivityReport,
  InstanceDebugReport,
  InstanceFileContent,
  InstanceFileEntry,
  InstanceFileListing,
  InstanceNetworkGuide,
  InstanceUpdateCheckResult,
  InstanceUpdateResult,
  MaintenanceStatus,
  MinecraftPropertiesResponse,
  ModrinthProjectSummary,
  ModrinthVersionSummary,
  NetworkStatus,
  PublicHostSource,
  ServerInstance,
  ServerLease,
  StartInstanceInput,
  SystemDiagnosticsReport,
  SystemSettings,
  SystemSettingsResponse,
  SystemSettingsUpdatePayload,
  TotpEnrollmentPayload,
  TotpStatus,
  UpdateInstanceConfigInput,
  UpdaterStatus,
  UpnpInstanceStatus,
  UpnpMappingRecord,
  UpnpMode,
  UpnpRouterInfo,
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
  login: (username: string, password: string, totpCode?: string) =>
    request<{
      user?: { id: string; username: string };
      requiresTotp?: boolean;
      usedRecoveryCode?: boolean;
      recoveryCodesRemaining?: number;
    }>('/api/auth/login', {
      method: 'POST',
      body: JSON.stringify({ username, password, ...(totpCode ? { totpCode } : {}) }),
    }),
  logout: () => request<{ ok: boolean }>('/api/auth/logout', { method: 'POST' }),
  getAuthSessions: () => request<AuthSessionSummary[]>('/api/auth/sessions'),
  revokeAuthSession: (sessionId: string) =>
    request<{ ok: boolean }>(`/api/auth/sessions/${encodeURIComponent(sessionId)}`, { method: 'DELETE' }),
  revokeAllAuthSessions: (keepCurrent = false) =>
    request<{ ok: boolean; revokedCount: number }>('/api/auth/sessions/revoke-all', {
      method: 'POST',
      body: JSON.stringify({ keepCurrent }),
    }),
  changePassword: (currentPassword: string, newPassword: string) =>
    request<{ ok: boolean; revokedOtherSessions: number }>('/api/auth/change-password', {
      method: 'POST',
      body: JSON.stringify({ currentPassword, newPassword }),
    }),
  getTotpStatus: () => request<TotpStatus>('/api/auth/totp/status'),
  beginTotpEnrollment: () =>
    request<TotpEnrollmentPayload>('/api/auth/totp/enroll', {
      method: 'POST',
      body: '{}',
    }),
  enableTotp: (code: string) =>
    request<TotpStatus>('/api/auth/totp/enable', {
      method: 'POST',
      body: JSON.stringify({ code }),
    }),
  disableTotp: (currentPassword: string) =>
    request<TotpStatus>('/api/auth/totp/disable', {
      method: 'POST',
      body: JSON.stringify({ currentPassword }),
    }),

  getHostMetrics: () => request<HostMetrics>('/api/host/metrics'),
  getSettings: () => request<SystemSettingsResponse>('/api/settings'),
  saveSettings: (patch: SystemSettingsUpdatePayload) =>
    request<SystemSettingsResponse>('/api/settings', {
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
    request<{ ok: boolean; saved?: boolean; message: string; normalizedKey: string; keyPreview?: string }>('/api/curseforge/test', {
      method: 'POST',
      body: JSON.stringify(apiKey !== undefined ? { apiKey, saveOnSuccess: true } : { saveOnSuccess: true }),
    }),
  searchCurseForge: (q: string) =>
    request<CurseForgeModpackSummary[]>(`/api/curseforge/search?q=${encodeURIComponent(q)}`),
  getCurseForgeFiles: (modId: number) =>
    request<CurseForgeModpackFile[]>(`/api/curseforge/mods/${modId}/files`),
  getCurseForgeServerPackUrl: (modId: number, fileId: number) =>
    request<{ url: string | null }>(`/api/curseforge/mods/${modId}/files/${fileId}/download-url`),

  // Discord Bot Setup, Discovery & Live Status Panel
  getDiscordStatus: () => request<import('@serverforge/shared').DiscordDiscoveryStatus>('/api/discord/status'),
  connectDiscord: (token?: string) =>
    request<import('@serverforge/shared').DiscordDiscoveryStatus>('/api/discord/connect', {
      method: 'POST',
      body: JSON.stringify(token !== undefined ? { token } : {}),
    }),
  disconnectDiscord: (clearToken = false) =>
    request<import('@serverforge/shared').DiscordDiscoveryStatus>('/api/discord/disconnect', {
      method: 'POST',
      body: JSON.stringify({ clearToken }),
    }),
  syncDiscordCommands: () =>
    request<{ ok: boolean; scope: string }>('/api/discord/sync-commands', {
      method: 'POST',
      body: '{}',
    }),
  sendDiscordTestMessage: (channelId?: string) =>
    request<{ ok: boolean; channelName: string }>('/api/discord/test-message', {
      method: 'POST',
      body: JSON.stringify(channelId ? { channelId } : {}),
    }),
  postDiscordStatusPanel: (channelId?: string, repost = false) =>
    request<{ ok: boolean; channelId: string; messageId: string; updatedExisting: boolean }>('/api/discord/panel', {
      method: 'POST',
      body: JSON.stringify({ ...(channelId ? { channelId } : {}), repost }),
    }),

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
  getConsolidatedPortMap: () =>
    request<{ lanIp: string | null; entries: ConsolidatedPortMapEntry[] }>('/api/network/port-map'),
  getInstanceNetworkGuide: (id: string) =>
    request<InstanceNetworkGuide>(`/api/instances/${id}/network-guide`),
  getInstanceFirewall: (id: string) =>
    request<FirewallStatus>(`/api/instances/${id}/firewall`),
  applyInstanceFirewall: (id: string, switchProfileToPrivate = false) =>
    request<FirewallApplyResult>(`/api/instances/${id}/firewall/apply`, {
      method: 'POST',
      body: JSON.stringify({ switchProfileToPrivate }),
    }),
  removeInstanceFirewall: (id: string) =>
    request<FirewallRemoveResult>(`/api/instances/${id}/firewall`, {
      method: 'DELETE',
    }),
  runInstanceNetworkCheck: (id: string) =>
    request<InstanceConnectivityReport>(`/api/instances/${id}/network-check`, {
      method: 'POST',
      body: '{}',
    }),
  getUpnpStatus: () =>
    request<{ globalEnabled: boolean; router: UpnpRouterInfo | null; activeMappings: UpnpMappingRecord[] }>(
      '/api/network/upnp/status'
    ),
  discoverUpnpRouter: () =>
    request<{ globalEnabled: boolean; router: UpnpRouterInfo; activeMappings: UpnpMappingRecord[] }>(
      '/api/network/upnp/discover',
      { method: 'POST', body: '{}' }
    ),
  getInstanceUpnp: (id: string) => request<UpnpInstanceStatus>(`/api/instances/${id}/upnp`),
  setInstanceUpnpMode: (id: string, upnpMode: UpnpMode) =>
    request<UpnpInstanceStatus>(`/api/instances/${id}/upnp`, {
      method: 'PATCH',
      body: JSON.stringify({ upnpMode }),
    }),
  mapInstanceUpnp: (id: string) =>
    request<UpnpInstanceStatus>(`/api/instances/${id}/upnp/map`, {
      method: 'POST',
      body: '{}',
    }),
  unmapInstanceUpnp: (id: string) =>
    request<{ ok: boolean; removed: number; status: UpnpInstanceStatus }>(`/api/instances/${id}/upnp`, {
      method: 'DELETE',
    }),
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

  // In-Browser File Manager (#12)
  listInstanceFiles: (id: string, dirPath = '') =>
    request<InstanceFileListing>(
      `/api/instances/${encodeURIComponent(id)}/files?path=${encodeURIComponent(dirPath)}`
    ),
  readInstanceFile: (id: string, relPath: string) =>
    request<InstanceFileContent>(
      `/api/instances/${encodeURIComponent(id)}/files/content?path=${encodeURIComponent(relPath)}`
    ),
  writeInstanceFile: (id: string, relPath: string, content: string) =>
    request<InstanceFileContent>(`/api/instances/${encodeURIComponent(id)}/files/content`, {
      method: 'PUT',
      body: JSON.stringify({ path: relPath, content }),
    }),
  mkdirInstanceDir: (id: string, relPath: string) =>
    request<{ path: string }>(`/api/instances/${encodeURIComponent(id)}/files/mkdir`, {
      method: 'POST',
      body: JSON.stringify({ path: relPath }),
    }),
  uploadInstanceFile: (
    id: string,
    dir: string,
    file: File,
    onProgress?: (percent: number) => void
  ): Promise<InstanceFileEntry> =>
    new Promise((resolve, reject) => {
      const xhr = new XMLHttpRequest();
      const params = new URLSearchParams({ dir, filename: file.name });
      xhr.open('POST', `/api/instances/${encodeURIComponent(id)}/files/upload?${params.toString()}`);
      xhr.withCredentials = true;
      xhr.setRequestHeader('Content-Type', 'application/octet-stream');
      xhr.upload.onprogress = (ev) => {
        if (ev.lengthComputable && onProgress) {
          onProgress(Math.min(100, Math.round((ev.loaded / ev.total) * 100)));
        }
      };
      xhr.onload = () => {
        try {
          const parsed = JSON.parse(xhr.responseText || '{}') as InstanceFileEntry & { error?: string };
          if (xhr.status >= 200 && xhr.status < 300) {
            resolve(parsed);
          } else {
            reject(new Error(parsed.error || `Upload failed (HTTP ${xhr.status})`));
          }
        } catch {
          reject(new Error(`Upload failed (HTTP ${xhr.status})`));
        }
      };
      xhr.onerror = () => reject(new Error('Network error while uploading file.'));
      xhr.send(file);
    }),
  getInstanceFileDownloadUrl: (id: string, relPath: string) =>
    `/api/instances/${encodeURIComponent(id)}/files/download?path=${encodeURIComponent(relPath)}`,
  renameInstanceFile: (id: string, relPath: string, newName: string) =>
    request<{ fromPath: string; toPath: string }>(`/api/instances/${encodeURIComponent(id)}/files/rename`, {
      method: 'POST',
      body: JSON.stringify({ path: relPath, newName }),
    }),
  deleteInstanceFile: (id: string, relPath: string) =>
    request<{ ok: boolean; deletedPath: string }>(
      `/api/instances/${encodeURIComponent(id)}/files?path=${encodeURIComponent(relPath)}`,
      { method: 'DELETE' }
    ),

  // Minecraft server.properties Editor (#36)
  getMinecraftProperties: (id: string) =>
    request<MinecraftPropertiesResponse>(`/api/instances/${encodeURIComponent(id)}/minecraft/properties`),
  saveMinecraftProperties: (
    id: string,
    payload: {
      properties?: Record<string, string>;
      rawContent?: string;
      createIfMissing?: boolean;
      allowManagedOverride?: boolean;
      restartAfterSave?: boolean;
    }
  ) =>
    request<MinecraftPropertiesResponse & { restarted?: boolean }>(
      `/api/instances/${encodeURIComponent(id)}/minecraft/properties`,
      {
        method: 'PUT',
        body: JSON.stringify(payload),
      }
    ),

  // Modrinth & Mods/Plugins Manager (#14)
  searchModrinth: (opts: { q?: string; type: 'modpack' | 'mod' | 'plugin'; loader?: string; version?: string; limit?: number }) => {
    const params = new URLSearchParams({ type: opts.type });
    if (opts.q) params.set('q', opts.q);
    if (opts.loader) params.set('loader', opts.loader);
    if (opts.version) params.set('version', opts.version);
    if (opts.limit) params.set('limit', String(opts.limit));
    return request<{ results: ModrinthProjectSummary[] }>(`/api/modrinth/search?${params.toString()}`);
  },
  getModrinthVersions: (projectId: string, opts?: { loader?: string; version?: string }) => {
    const params = new URLSearchParams();
    if (opts?.loader) params.set('loader', opts.loader);
    if (opts?.version) params.set('version', opts.version);
    const qs = params.toString();
    return request<{ versions: ModrinthVersionSummary[] }>(
      `/api/modrinth/projects/${encodeURIComponent(projectId)}/versions${qs ? `?${qs}` : ''}`
    );
  },
  listInstanceAddons: (id: string) =>
    request<InstalledAddonsResponse>(`/api/instances/${encodeURIComponent(id)}/addons`),
  installInstanceAddon: (
    id: string,
    payload: { projectId: string; versionId?: string; folder?: 'mods' | 'plugins'; loader?: string; gameVersion?: string }
  ) =>
    request<{ ok: boolean; installed: InstalledAddonEntry[]; dependenciesInstalled: string[] }>(
      `/api/instances/${encodeURIComponent(id)}/addons/install`,
      {
        method: 'POST',
        body: JSON.stringify(payload),
      }
    ),
  toggleInstanceAddon: (id: string, folder: 'mods' | 'plugins', filename: string) =>
    request<{ ok: boolean; filename: string; enabled: boolean }>(
      `/api/instances/${encodeURIComponent(id)}/addons/toggle`,
      {
        method: 'POST',
        body: JSON.stringify({ folder, filename }),
      }
    ),
  deleteInstanceAddon: (id: string, folder: 'mods' | 'plugins', filename: string) =>
    request<{ ok: boolean }>(
      `/api/instances/${encodeURIComponent(id)}/addons?folder=${encodeURIComponent(folder)}&filename=${encodeURIComponent(filename)}`,
      { method: 'DELETE' }
    ),
  checkInstanceAddonUpdates: (id: string) =>
    request<{ updates: AddonUpdateCandidate[] }>(`/api/instances/${encodeURIComponent(id)}/addons/updates`),

  // One-Click Game Server & Modpack Updates (#13)
  checkInstanceUpdate: (id: string) =>
    request<InstanceUpdateCheckResult>(`/api/instances/${encodeURIComponent(id)}/update-check`),
  updateInstance: (
    id: string,
    payload: { createBackup?: boolean; targetVersionId?: string; restartIfRunning?: boolean }
  ) =>
    request<InstanceUpdateResult>(`/api/instances/${encodeURIComponent(id)}/update`, {
      method: 'POST',
      body: JSON.stringify(payload),
    }),

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
