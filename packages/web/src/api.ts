import type {
  AuditLogEntry,
  BackupRecord,
  CreateInstanceInput,
  GameTemplate,
  HostMetrics,
  ServerInstance,
  ServerLease,
  StartInstanceInput,
  SystemSettings,
  UpdateInstanceConfigInput,
} from '@serverforge/shared';

export interface InstanceWithJoin extends ServerInstance {
  joinAddress: string;
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
  const res = await fetch(url, {
    credentials: 'include',
    headers: {
      'Content-Type': 'application/json',
      ...(init?.headers ?? {}),
    },
    ...init,
  });

  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    throw new Error((data as { error?: string }).error || `Request failed (${res.status})`);
  }
  return data as T;
}

export const api = {
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
  getAuditLogs: (limit = 60) => request<AuditLogEntry[]>(`/api/audit?limit=${limit}`),

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
