import { z } from 'zod';
import { RuntimeKindSchema, type RuntimeKind } from './game-template.js';

export const InstanceStatusSchema = z.enum([
  'stopped',
  'installing',
  'starting',
  'running',
  'stopping',
  'error',
]);
export type InstanceStatus = z.infer<typeof InstanceStatusSchema>;

export const ServerLeaseSchema = z.object({
  id: z.string(),
  instanceId: z.string(),
  requestedBy: z.string(),
  requestedById: z.string().nullable(),
  source: z.enum(['discord', 'web']),
  channelId: z.string().nullable(),
  startedAt: z.string(),
  expiresAt: z.string(),
  maxExpiresAt: z.string(),
  idleTimeoutMinutes: z.number().int().min(0),
  emptySince: z.string().nullable(),
  warningSentAt: z.string().nullable(),
  active: z.boolean(),
});
export type ServerLease = z.infer<typeof ServerLeaseSchema>;

export const InstanceRuntimeStatsSchema = z.object({
  cpuPercent: z.number(),
  memoryMb: z.number(),
  playerCount: z.number().int().nullable(),
  maxPlayers: z.number().int().nullable(),
  players: z.array(z.string()).default([]),
  uptimeSeconds: z.number().int().nullable(),
});
export type InstanceRuntimeStats = z.infer<typeof InstanceRuntimeStatsSchema>;

export const BackupPolicySchema = z.object({
  enabled: z.boolean().default(false),
  scheduleMode: z.enum(['interval', 'daily']).default('daily'),
  intervalHours: z.number().int().min(1).max(168).default(6),
  dailyTime: z
    .string()
    .regex(/^([01]\d|2[0-3]):[0-5]\d$/, 'Time must be HH:MM (24-hour)')
    .default('03:00'),
  onlyWhenRunning: z.boolean().default(true),
  maxCount: z.number().int().min(1).max(200).default(10),
  maxTotalGb: z.number().min(0).max(500).default(0),
  lastAutoBackupAt: z.string().nullable().default(null),
});
export type BackupPolicy = z.infer<typeof BackupPolicySchema>;

export const CrashSummarySchema = z.object({
  crashedAt: z.string(),
  exitCode: z.number().int().nullable(),
  attemptCount: z.number().int().min(0),
  maxAttempts: z.number().int().min(1),
  nextRestartAt: z.string().nullable(),
  halted: z.boolean().default(false),
  reason: z.string(),
  logTail: z.array(z.string()).default([]),
});
export type CrashSummary = z.infer<typeof CrashSummarySchema>;

export const ServerInstanceSchema = z.object({
  id: z.string(),
  slug: z.string(),
  name: z.string(),
  gameId: z.string(),
  runtime: RuntimeKindSchema,
  status: InstanceStatusSchema,
  ports: z.record(z.string(), z.number().int()),
  config: z.record(z.string(), z.union([z.string(), z.number(), z.boolean()])),
  memoryLimitMb: z.number().int().positive(),
  autoStart: z.boolean().default(false),
  autoRestartOnCrash: z.boolean().optional().default(true),
  discordEnabled: z.boolean().default(true),
  containerId: z.string().nullable(),
  externalDir: z.string().nullable().optional().default(null),
  launchScript: z.string().nullable().optional().default(null),
  lastError: z.string().nullable(),
  lastCrash: CrashSummarySchema.nullable().optional().default(null),
  backupPolicy: BackupPolicySchema.optional(),
  createdAt: z.string(),
  updatedAt: z.string(),
  lastStartedAt: z.string().nullable(),
  activeLease: ServerLeaseSchema.nullable().optional(),
  stats: InstanceRuntimeStatsSchema.nullable().optional(),
});
export type ServerInstance = z.infer<typeof ServerInstanceSchema>;

export const CreateInstanceInputSchema = z.object({
  name: z.string().min(2).max(60),
  gameId: z.string().min(1),
  runtime: RuntimeKindSchema.optional(),
  memoryLimitMb: z.number().int().min(512).max(131072).optional(),
  ports: z.record(z.string(), z.number().int().min(1024).max(65535)).optional(),
  config: z.record(z.string(), z.union([z.string(), z.number(), z.boolean()])).default({}),
  autoStart: z.boolean().optional().default(false),
  autoRestartOnCrash: z.boolean().optional().default(true),
  discordEnabled: z.boolean().optional().default(true),
  startImmediately: z.boolean().optional().default(false),
});
export type CreateInstanceInput = z.input<typeof CreateInstanceInputSchema>;

export const UpdateInstanceConfigInputSchema = z.object({
  name: z.string().min(2).max(60).optional(),
  memoryLimitMb: z.number().int().min(512).max(131072).optional(),
  runtime: RuntimeKindSchema.optional(),
  autoStart: z.boolean().optional(),
  autoRestartOnCrash: z.boolean().optional(),
  discordEnabled: z.boolean().optional(),
  launchScript: z.string().nullable().optional(),
  config: z.record(z.string(), z.union([z.string(), z.number(), z.boolean()])).optional(),
  backupPolicy: BackupPolicySchema.partial().optional(),
});
export type UpdateInstanceConfigInput = z.infer<typeof UpdateInstanceConfigInputSchema>;

export const StartInstanceInputSchema = z.object({
  temporary: z.boolean().optional().default(false),
  durationMinutes: z.number().int().min(15).max(1440).optional(),
  idleTimeoutMinutes: z.number().int().min(0).max(480).optional(),
  requestedBy: z.string().optional(),
  requestedById: z.string().optional(),
  source: z.enum(['web', 'discord']).optional().default('web'),
  channelId: z.string().optional(),
});
export type StartInstanceInput = z.input<typeof StartInstanceInputSchema>;

export const PublicHostModeSchema = z.enum(['auto', 'manual', 'duckdns']);
export type PublicHostMode = z.infer<typeof PublicHostModeSchema>;

export type PublicHostSource =
  | 'duckdns'
  | 'detected_duckdns'
  | 'public_ip'
  | 'manual'
  | 'env'
  | 'lan'
  | 'fallback';

export interface NetworkStatus {
  effectiveHost: string;
  effectiveHostSource: PublicHostSource;
  publicIp: string | null;
  lanIp: string | null;
  detectedDuckDnsDomains: string[];
  duckdnsDomain: string;
  duckdnsConfigured: boolean;
  duckdnsLastUpdateAt: string | null;
  duckdnsLastStatus: string | null;
  lastCheckedAt: string | null;
}

export const SystemSettingsSchema = z.object({
  publicHost: z.string().default('localhost'),
  publicHostMode: PublicHostModeSchema.default('auto'),
  duckdnsDomain: z.string().default(''),
  duckdnsToken: z.string().default(''),
  duckdnsAutoUpdate: z.boolean().default(false),
  maxConcurrentServers: z.number().int().min(1).max(32).default(2),
  hostRamReserveGb: z.number().min(1).max(64).default(4),
  defaultLeaseMinutes: z.number().int().min(15).max(1440).default(180),
  maxLeaseMinutes: z.number().int().min(30).max(2880).default(480),
  defaultIdleTimeoutMinutes: z.number().int().min(0).max(240).default(30),
  warningBeforeStopMinutes: z.number().int().min(1).max(60).default(10),
  discordAllowedRoleIds: z.array(z.string()).default([]),
  discordAdminRoleIds: z.array(z.string()).default([]),
  discordNotifyChannelId: z.string().default(''),
  githubRepo: z.string().default('StriderVR/serverforge'),
  autoUpdateOnBoot: z.boolean().default(false),
  dailyRebootEnabled: z.boolean().default(false),
  dailyRebootTime: z
    .string()
    .regex(/^([01]\d|2[0-3]):[0-5]\d$/, 'Time must be HH:MM (24-hour)')
    .default('04:00'),
  dailyRebootDelayIfPlayersOnline: z.boolean().default(true),
  dailyRebootResumePolicy: z.enum(['resume_running', 'autostart_only']).default('autostart_only'),
  curseforgeApiKey: z.string().default(''),
});
export type SystemSettings = z.infer<typeof SystemSettingsSchema>;

export const HostMetricsSchema = z.object({
  hostname: z.string(),
  platform: z.string(),
  osDistro: z.string(),
  cpuLoadPercent: z.number(),
  cpuCores: z.number().int(),
  memoryTotalGb: z.number(),
  memoryUsedGb: z.number(),
  memoryFreeGb: z.number(),
  memoryReservedForOsGb: z.number(),
  diskTotalGb: z.number(),
  diskUsedGb: z.number(),
  diskFreeGb: z.number(),
  uptimeSeconds: z.number(),
  runningServers: z.number().int(),
  maxConcurrentServers: z.number().int(),
  runtimesAvailable: z.object({
    docker: z.boolean(),
    native: z.boolean(),
    mock: z.boolean(),
  }),
  discordConnected: z.boolean(),
  discordBotTag: z.string().nullable(),
});
export type HostMetrics = z.infer<typeof HostMetricsSchema>;

export const BackupRecordSchema = z.object({
  id: z.string(),
  instanceId: z.string(),
  filename: z.string(),
  sizeBytes: z.number().int(),
  createdAt: z.string(),
  note: z.string().nullable(),
});
export type BackupRecord = z.infer<typeof BackupRecordSchema>;

export const AuditLogEntrySchema = z.object({
  id: z.string(),
  timestamp: z.string(),
  actor: z.string(),
  source: z.enum(['web', 'discord', 'system']),
  action: z.string(),
  instanceId: z.string().nullable(),
  details: z.string().nullable(),
});
export type AuditLogEntry = z.infer<typeof AuditLogEntrySchema>;

export interface UpdaterStatus {
  currentVersion: string;
  latestVersion: string | null;
  updateAvailable: boolean;
  releaseName: string | null;
  releaseNotes: string | null;
  releaseUrl: string | null;
  publishedAt: string | null;
  exeDownloadUrl: string | null;
  exeSizeBytes: number | null;
  installMode: 'exe' | 'source';
  githubRepo: string;
  runningServers: Array<{ id: string; name: string; runtime: RuntimeKind }>;
  error: string | null;
}

export interface MaintenanceStatus {
  enabled: boolean;
  dailyRebootTime: string;
  nextRebootAt: string | null;
  delayIfPlayersOnline: boolean;
  resumePolicy: 'resume_running' | 'autostart_only';
  deferredUntil: string | null;
  lastRebootTriggeredAt: string | null;
}

export interface WindowsRebootEvent {
  timestamp: string;
  process: string;
  reason: string;
  message: string;
}

export interface WindowsScheduledRebootTask {
  taskPath: string;
  taskName: string;
  state: string;
  command: string;
  nextRunTime: string | null;
}

export interface WindowsRebootInspection {
  platform: string;
  supported: boolean;
  recentRestarts: WindowsRebootEvent[];
  scheduledRebootTasks: WindowsScheduledRebootTask[];
  notes: string[];
}

export interface CurseForgeModpackSummary {
  id: number;
  name: string;
  slug: string;
  summary: string;
  downloadCount: number;
  logoUrl: string | null;
  websiteUrl: string | null;
  latestGameVersions: string[];
  recommendedJavaTag: 'java25' | 'java21' | 'java17' | 'java8' | 'latest';
}

export interface CurseForgeModpackFile {
  id: number;
  displayName: string;
  fileName: string;
  fileDate: string;
  gameVersions: string[];
  isServerPack: boolean;
  serverPackFileId: number | null;
  downloadUrl: string | null;
  recommendedJavaTag: 'java25' | 'java21' | 'java17' | 'java8' | 'latest';
}

export interface DiscoveredProcess {
  pid: number;
  processName: string;
  detectedGameId: string;
  workingDir: string | null;
  commandLine: string;
}

export interface FolderPickResult {
  supported: boolean;
  cancelled: boolean;
  folderPath: string | null;
  reason?: string;
}

export interface FolderBrowseEntry {
  name: string;
  path: string;
  isServerFolder?: boolean;
  serverHint?: string;
}

export interface FolderBrowseResult {
  currentPath: string;
  parentPath: string | null;
  directories: FolderBrowseEntry[];
  currentFolderHint?: string | null;
  previewFiles?: string[];
}

export interface ImportLaunchCandidate {
  label: string;
  script: string;
  recommended: boolean;
  containsPause?: boolean;
}

export interface DetectedServerSubfolder {
  name: string;
  relativePath: string;
  path: string;
  summary: string;
}

export interface ImportInspectionResult {
  folderPath: string;
  suggestedName: string;
  detectedGameId: string;
  detectedGameName: string;
  modloader: string | null;
  modCount: number;
  worldFolders: string[];
  hasServerProperties: boolean;
  rconCurrentlyEnabled: boolean;
  launchCandidates: ImportLaunchCandidate[];
  detectedPorts: Record<string, number>;
  detectedMemoryMb: number;
  detectedConfig: Record<string, string | number | boolean>;
  warnings: string[];
  autoResolvedFrom?: string | null;
  detectedSubfolders?: DetectedServerSubfolder[];
}

export const ImportServerInputSchema = z.object({
  folderPath: z.string().min(1),
  mode: z.enum(['link', 'copy']).default('link'),
  name: z.string().min(2).max(60),
  gameId: z.string().min(1),
  runtime: RuntimeKindSchema.default('native'),
  launchScript: z.string().nullable().optional(),
  ports: z.record(z.string(), z.number().int().min(1024).max(65535)).optional(),
  memoryLimitMb: z.number().int().min(512).max(131072).optional(),
  config: z.record(z.string(), z.union([z.string(), z.number(), z.boolean()])).default({}),
  enableRcon: z.boolean().optional().default(true),
  autoStart: z.boolean().optional().default(false),
  autoRestartOnCrash: z.boolean().optional().default(true),
  discordEnabled: z.boolean().optional().default(true),
});
export type ImportServerInput = z.input<typeof ImportServerInputSchema>;

export type DiagnosticLevel = 'info' | 'warn' | 'error';
export type DiagnosticSource = 'api' | 'orchestrator' | 'runtime' | 'discord' | 'updater' | 'backup' | 'system';

export interface AppDiagnosticEvent {
  id: string;
  timestamp: string;
  level: DiagnosticLevel;
  source: DiagnosticSource;
  message: string;
  statusCode?: number | null;
  method?: string | null;
  path?: string | null;
  instanceId?: string | null;
  details?: string | null;
}

export interface SystemDiagnosticsReport {
  generatedAt: string;
  markdown: string;
  errorCount: number;
  warnCount: number;
}

export interface InstanceDebugReport {
  generatedAt: string;
  filename: string;
  markdown: string;
}

export type WsServerEvent =
  | { type: 'console:line'; instanceId: string; line: string; timestamp: string }
  | { type: 'instance:update'; instance: ServerInstance }
  | { type: 'instance:deleted'; instanceId: string }
  | { type: 'instance:crash'; instanceId: string; instanceName: string; crash: CrashSummary }
  | { type: 'host:metrics'; metrics: HostMetrics }
  | { type: 'lease:warning'; lease: ServerLease; instanceName: string; reason: 'ttl' | 'idle'; minutesRemaining: number }
  | { type: 'updater:progress'; stage: 'downloading' | 'stopping_servers' | 'installing' | 'restarting' | 'error'; percent: number; message: string }
  | { type: 'maintenance:notice'; kind: 'warning' | 'deferred' | 'rebooting' | 'online'; message: string };
