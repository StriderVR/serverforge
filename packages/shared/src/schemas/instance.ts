import { z } from 'zod';
import { RuntimeKindSchema } from './game-template.js';

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
  discordEnabled: z.boolean().default(true),
  containerId: z.string().nullable(),
  lastError: z.string().nullable(),
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
  discordEnabled: z.boolean().optional().default(true),
  startImmediately: z.boolean().optional().default(false),
});
export type CreateInstanceInput = z.infer<typeof CreateInstanceInputSchema>;

export const UpdateInstanceConfigInputSchema = z.object({
  name: z.string().min(2).max(60).optional(),
  memoryLimitMb: z.number().int().min(512).max(131072).optional(),
  discordEnabled: z.boolean().optional(),
  config: z.record(z.string(), z.union([z.string(), z.number(), z.boolean()])).optional(),
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
export type StartInstanceInput = z.infer<typeof StartInstanceInputSchema>;

export const SystemSettingsSchema = z.object({
  publicHost: z.string().default('localhost'),
  maxConcurrentServers: z.number().int().min(1).max(32).default(2),
  hostRamReserveGb: z.number().min(1).max(64).default(4),
  defaultLeaseMinutes: z.number().int().min(15).max(1440).default(180),
  maxLeaseMinutes: z.number().int().min(30).max(2880).default(480),
  defaultIdleTimeoutMinutes: z.number().int().min(0).max(240).default(30),
  warningBeforeStopMinutes: z.number().int().min(1).max(60).default(10),
  discordAllowedRoleIds: z.array(z.string()).default([]),
  discordAdminRoleIds: z.array(z.string()).default([]),
  discordNotifyChannelId: z.string().default(''),
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

export type WsServerEvent =
  | { type: 'console:line'; instanceId: string; line: string; timestamp: string }
  | { type: 'instance:update'; instance: ServerInstance }
  | { type: 'instance:deleted'; instanceId: string }
  | { type: 'host:metrics'; metrics: HostMetrics }
  | { type: 'lease:warning'; lease: ServerLease; instanceName: string; reason: 'ttl' | 'idle'; minutesRemaining: number };
