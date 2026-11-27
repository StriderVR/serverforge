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

export const MinecraftCrashCategorySchema = z.enum([
  'missing_dependency',
  'client_only_mod',
  'java_version_mismatch',
  'out_of_memory',
  'port_in_use',
  'mod_error',
  'plugin_error',
  'unknown',
]);
export type MinecraftCrashCategory = z.infer<typeof MinecraftCrashCategorySchema>;

export const MinecraftCrashSuspectedModSchema = z.object({
  modId: z.string().optional(),
  modName: z.string().optional(),
  jarFile: z.string().optional(),
  reason: z.string().optional(),
});
export type MinecraftCrashSuspectedMod = z.infer<typeof MinecraftCrashSuspectedModSchema>;

export const MinecraftCrashMissingDependencySchema = z.object({
  modId: z.string(),
  requiredBy: z.string().optional(),
  versionRange: z.string().optional(),
});
export type MinecraftCrashMissingDependency = z.infer<typeof MinecraftCrashMissingDependencySchema>;

export const MinecraftCrashAnalysisSchema = z.object({
  category: MinecraftCrashCategorySchema,
  headline: z.string(),
  summary: z.string(),
  recommendedFix: z.string(),
  suspectedMods: z.array(MinecraftCrashSuspectedModSchema).default([]),
  missingDependencies: z.array(MinecraftCrashMissingDependencySchema).default([]),
  requiredJavaMajor: z.number().int().nullable().optional(),
  crashReportFile: z.string().nullable().optional(),
  evidenceLines: z.array(z.string()).default([]),
});
export type MinecraftCrashAnalysis = z.infer<typeof MinecraftCrashAnalysisSchema>;

export const CrashSummarySchema = z.object({
  crashedAt: z.string(),
  exitCode: z.number().int().nullable(),
  attemptCount: z.number().int().min(0),
  maxAttempts: z.number().int().min(1),
  nextRestartAt: z.string().nullable(),
  halted: z.boolean().default(false),
  reason: z.string(),
  logTail: z.array(z.string()).default([]),
  analysis: MinecraftCrashAnalysisSchema.nullable().optional(),
});
export type CrashSummary = z.infer<typeof CrashSummarySchema>;

export const UpnpModeSchema = z.enum(['inherit', 'enabled', 'disabled']);
export type UpnpMode = z.infer<typeof UpnpModeSchema>;

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
  upnpMode: UpnpModeSchema.optional(),
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
  upnpMode: UpnpModeSchema.optional().default('inherit'),
  startImmediately: z.boolean().optional().default(false),
});
export type CreateInstanceInput = z.input<typeof CreateInstanceInputSchema>;

export const UpdateInstanceConfigInputSchema = z.object({
  name: z.string().min(2).max(60).optional(),
  memoryLimitMb: z.number().int().min(512).max(131072).optional(),
  ports: z.record(z.string(), z.number().int().min(1024).max(65535)).optional(),
  runtime: RuntimeKindSchema.optional(),
  autoStart: z.boolean().optional(),
  autoRestartOnCrash: z.boolean().optional(),
  discordEnabled: z.boolean().optional(),
  upnpMode: UpnpModeSchema.optional(),
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

export const DashboardAccessModeSchema = z.enum(['lan_and_tailscale', 'localhost_only', 'custom']);
export type DashboardAccessMode = z.infer<typeof DashboardAccessModeSchema>;

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
  discordBotToken: z.string().default(''),
  discordGuildId: z.string().default(''),
  discordAllowedRoleIds: z.array(z.string()).default([]),
  discordAdminRoleIds: z.array(z.string()).default([]),
  discordNotifyChannelId: z.string().default(''),
  discordStatusPanelChannelId: z.string().default(''),
  discordStatusPanelMessageId: z.string().default(''),
  discordPlayerActivityEnabled: z.boolean().default(false),
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
  lastSeenReleaseVersion: z.string().default(''),
  lastKnownLanIp: z.string().default(''),
  upnpEnabled: z.boolean().default(false),
  dashboardAccessMode: DashboardAccessModeSchema.default('lan_and_tailscale'),
  trustedCidrs: z.array(z.string()).default([]),
  discordSecurityAlertsEnabled: z.boolean().default(true),
  lockHostFsBrowsing: z.boolean().default(false),
  blockExecutableUploads: z.boolean().default(false),
  httpsEnabled: z.boolean().default(false),
  httpsCertMode: z.enum(['self_signed', 'custom']).default('self_signed'),
  httpsCertPath: z.string().default(''),
  httpsKeyPath: z.string().default(''),
  updateChannel: z.enum(['stable', 'experimental']).default('stable'),
  githubIssueToken: z.string().default(''),
});
export type SystemSettings = z.infer<typeof SystemSettingsSchema>;

export type BugReportCategory =
  | 'networking'
  | 'game_template'
  | 'updater'
  | 'web_ui'
  | 'discord'
  | 'security'
  | 'other';

export interface BugReportInput {
  title: string;
  category: BugReportCategory;
  description: string;
  stepsToReproduce?: string;
  instanceId?: string | null;
  includeDiagnostics?: boolean;
}

export interface BugReportPreviewResult {
  title: string;
  labels: string[];
  markdown: string;
  githubNewIssueUrl: string;
  truncatedForUrl: boolean;
  hasDirectToken: boolean;
  githubRepo: string;
}

export interface BugReportSubmitResult {
  ok: boolean;
  issueNumber: number;
  issueUrl: string;
  title: string;
}

export interface TlsStatus {
  enabled: boolean;
  active: boolean;
  mode: 'self_signed' | 'custom';
  certPath: string | null;
  keyPath: string | null;
  fingerprint256: string | null;
  validFrom: string | null;
  validTo: string | null;
  sans: string[];
  fallbackReason: string | null;
  restartRequired: boolean;
}

export interface SecurityHealthCheckItem {
  id: string;
  title: string;
  status: 'pass' | 'warn' | 'fail';
  detail: string;
  recommendation?: string;
}

export interface SecurityHealthReport {
  score: number;
  maxScore: number;
  isElevatedAdmin: boolean;
  platform: string;
  httpsEnabled: boolean;
  recentFailedLogins24h: number;
  checks: SecurityHealthCheckItem[];
}

export interface AuditLogQueryResult {
  items: AuditLogEntry[];
  total: number;
  limit: number;
  offset: number;
}

export const SECRET_MASK_SENTINEL = '••••••••';

export interface SecretVaultStatus {
  encrypted: boolean;
  keyProtection: 'dpapi' | 'keyfile';
  undecryptableFields: string[];
}

export interface SystemSettingsResponse extends SystemSettings {
  hasDiscordBotToken?: boolean;
  discordBotTokenPreview?: string;
  hasDuckdnsToken?: boolean;
  duckdnsTokenPreview?: string;
  hasCurseforgeApiKey?: boolean;
  curseforgeApiKeyPreview?: string;
  hasGithubIssueToken?: boolean;
  githubIssueTokenPreview?: string;
  secretVaultStatus?: SecretVaultStatus;
}

export type SystemSettingsUpdatePayload = Partial<SystemSettings> & {
  clearDiscordBotToken?: boolean;
  clearDuckdnsToken?: boolean;
  clearCurseforgeApiKey?: boolean;
  clearGithubIssueToken?: boolean;
};

export interface AuthSessionSummary {
  id: string;
  ip: string;
  userAgent: string;
  createdAt: string;
  lastSeenAt: string;
  expiresAt: string;
  isCurrent: boolean;
}

export interface TotpStatus {
  enabled: boolean;
  recoveryCodesRemaining: number;
}

export interface TotpEnrollmentPayload {
  secret: string;
  otpAuthUri: string;
  recoveryCodes: string[];
}

export interface DiscordGuildSummary {
  id: string;
  name: string;
  iconUrl: string | null;
  memberCount: number | null;
}

export interface DiscordChannelSummary {
  id: string;
  name: string;
  categoryName: string | null;
  canSend: boolean;
}

export interface DiscordRoleSummary {
  id: string;
  name: string;
  colorHex: string;
  position: number;
}

export interface DiscordDiscoveryStatus {
  connected: boolean;
  connecting: boolean;
  hasToken: boolean;
  tokenSource: 'settings' | 'env' | 'none';
  botTag: string | null;
  botId: string | null;
  applicationId: string | null;
  inviteUrl: string | null;
  lastError: string | null;
  selectedGuildId: string;
  guilds: DiscordGuildSummary[];
  channels: DiscordChannelSummary[];
  roles: DiscordRoleSummary[];
  statusPanelActive: boolean;
}

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

export interface UpdaterReleaseOption {
  tag: string;
  version: string;
  name: string;
  prerelease: boolean;
  publishedAt: string | null;
  releaseUrl: string | null;
  releaseNotes: string | null;
  hasExeAsset: boolean;
  exeDownloadUrl: string | null;
  exeSizeBytes: number | null;
  isCurrent: boolean;
}

export interface UpdaterStatus {
  currentVersion: string;
  latestVersion: string | null;
  updateAvailable: boolean;
  channel?: 'stable' | 'experimental';
  targetTag?: string | null;
  isPrerelease?: boolean;
  pendingExeBuild?: boolean;
  pendingVersion?: string | null;
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

export interface InstanceFileEntry {
  name: string;
  path: string;
  isDirectory: boolean;
  sizeBytes: number;
  updatedAt: string;
  editable: boolean;
}

export interface InstanceQuickFile {
  label: string;
  path: string;
  exists: boolean;
}

export interface InstanceFileListing {
  currentPath: string;
  parentPath: string | null;
  entries: InstanceFileEntry[];
  quickFiles: InstanceQuickFile[];
}

export interface InstanceFileContent {
  path: string;
  name: string;
  content: string;
  sizeBytes: number;
  updatedAt: string;
}

export interface MinecraftPropertiesResponse {
  exists: boolean;
  path: string;
  properties: Record<string, string>;
  rawContent: string;
  managedKeys: string[];
  restartRequired: boolean;
}

export interface ModrinthProjectSummary {
  projectId: string;
  slug: string;
  title: string;
  description: string;
  projectType: 'modpack' | 'mod' | 'plugin';
  iconUrl: string | null;
  downloads: number;
  categories: string[];
  loaders: string[];
  gameVersions: string[];
  websiteUrl: string;
  recommendedJavaTag: 'java25' | 'java21' | 'java17' | 'java8' | 'latest';
}

export interface ModrinthVersionDependency {
  projectId: string | null;
  versionId: string | null;
  dependencyType: 'required' | 'optional' | 'incompatible' | 'embedded';
}

export interface ModrinthVersionSummary {
  id: string;
  projectId: string;
  name: string;
  versionNumber: string;
  datePublished: string;
  gameVersions: string[];
  loaders: string[];
  primaryFile: {
    url: string;
    filename: string;
    size: number;
  } | null;
  dependencies: ModrinthVersionDependency[];
  recommendedJavaTag: 'java25' | 'java21' | 'java17' | 'java8' | 'latest';
}

export interface InstalledAddonEntry {
  filename: string;
  baseName: string;
  folder: 'mods' | 'plugins';
  enabled: boolean;
  sizeBytes: number;
  updatedAt: string;
  modrinthProjectId?: string | null;
  modrinthVersionId?: string | null;
  modrinthTitle?: string | null;
  modrinthVersionNumber?: string | null;
}

export interface InstalledAddonsResponse {
  defaultFolder: 'mods' | 'plugins';
  availableFolders: Array<'mods' | 'plugins'>;
  detectedLoader: string | null;
  detectedMcVersion: string | null;
  addons: InstalledAddonEntry[];
}

export interface AddonUpdateCandidate {
  filename: string;
  folder: 'mods' | 'plugins';
  projectId: string;
  title: string;
  currentVersionId: string;
  currentVersionNumber: string;
  latestVersionId: string;
  latestVersionNumber: string;
  latestVersionName: string;
}

export interface InstanceUpdateOption {
  id: string;
  label: string;
  date: string;
  gameVersions: string[];
  recommendedJavaTag?: string;
}

export interface InstanceUpdateCheckResult {
  supported: boolean;
  kind: 'steamcmd' | 'curseforge' | 'modrinth' | 'unsupported';
  message: string;
  updateAvailable: boolean;
  currentVersionId: string | null;
  latestVersionId: string | null;
  latestVersionLabel: string | null;
  availableVersions: InstanceUpdateOption[];
  appId?: number | null;
  branch?: string | null;
}

export interface InstanceUpdateResult {
  ok: boolean;
  kind: 'steamcmd' | 'curseforge' | 'modrinth';
  summary: string;
  backupCreated: string | null;
  restarted: boolean;
  newVersionId?: string | null;
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
