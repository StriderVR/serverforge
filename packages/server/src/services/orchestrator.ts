import crypto from 'node:crypto';
import EventEmitter from 'node:events';
import fs from 'node:fs';
import path from 'node:path';
import archiver from 'archiver';
import type {
  BackupPolicy,
  BackupRecord,
  CrashSummary,
  CreateInstanceInput,
  GameTemplate,
  ImportServerInput,
  InstanceRuntimeStats,
  PublicHostSource,
  RuntimeKind,
  ServerInstance,
  ServerLease,
  StartInstanceInput,
  UpdateInstanceConfigInput,
} from '@serverforge/shared';
import { BackupPolicySchema } from '@serverforge/shared';
import type { CatalogService } from '../catalog/catalog-service.js';
import type { AppConfig } from '../config.js';
import type { AppDatabase } from '../db/database.js';
import { ConsoleLogBuffer } from '../runtimes/runtime-adapter.js';
import type { RuntimeManager } from '../runtimes/runtime-manager.js';
import { extractZipSafely } from './backup-scheduler.js';
import type { DiagnosticsService } from './diagnostics-service.js';
import { enableRconInServerProperties } from './import-service.js';
import type { NetworkAddressService } from './network-service.js';
import type { TelemetryService } from './telemetry-service.js';

export class GuardrailError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'GuardrailError';
  }
}

export interface WatchdogOptions {
  windowMs?: number;
  maxRestarts?: number;
  baseBackoffMs?: number;
}

export interface OrchestratorEvents {
  'console:line': (payload: { instanceId: string; line: string; timestamp: string }) => void;
  'instance:update': (instance: ServerInstance) => void;
  'instance:deleted': (instanceId: string) => void;
  'instance:crash': (payload: { instance: ServerInstance; crash: CrashSummary; channelId: string | null }) => void;
  'lease:warning': (payload: {
    lease: ServerLease;
    instance: ServerInstance;
    reason: 'ttl' | 'idle';
    minutesRemaining: number;
  }) => void;
  'lease:expired': (payload: { lease: ServerLease; instance: ServerInstance; reason: 'ttl' | 'idle' }) => void;
}

interface CrashTrackerState {
  timestamps: number[];
  timer?: NodeJS.Timeout;
}

export class ServerOrchestrator extends EventEmitter {
  public readonly logs: ConsoleLogBuffer;
  private readonly statsCache = new Map<string, InstanceRuntimeStats>();
  private readonly intentionalStops = new Set<string>();
  private readonly crashStates = new Map<string, CrashTrackerState>();
  private watchdogWindowMs = 15 * 60_000;
  private watchdogMaxRestarts = 3;
  private watchdogBaseBackoffMs = 10_000;

  constructor(
    private readonly config: AppConfig,
    private readonly db: AppDatabase,
    private readonly catalog: CatalogService,
    private readonly runtimeManager: RuntimeManager,
    private readonly telemetry: TelemetryService,
    private readonly network?: NetworkAddressService,
    private readonly diagnostics?: DiagnosticsService,
    watchdogOptions?: WatchdogOptions
  ) {
    super();
    this.logs = new ConsoleLogBuffer(600, {
      persistDir: path.join(config.logsDir, 'instances'),
    });
    if (watchdogOptions?.windowMs !== undefined) this.watchdogWindowMs = watchdogOptions.windowMs;
    if (watchdogOptions?.maxRestarts !== undefined) this.watchdogMaxRestarts = watchdogOptions.maxRestarts;
    if (watchdogOptions?.baseBackoffMs !== undefined) this.watchdogBaseBackoffMs = watchdogOptions.baseBackoffMs;
  }

  /** Allows tests to tune crash watchdog backoff & window timings deterministically. */
  configureWatchdog(options: WatchdogOptions): void {
    if (options.windowMs !== undefined) this.watchdogWindowMs = options.windowMs;
    if (options.maxRestarts !== undefined) this.watchdogMaxRestarts = options.maxRestarts;
    if (options.baseBackoffMs !== undefined) this.watchdogBaseBackoffMs = options.baseBackoffMs;
  }

  private cancelPendingCrashRestart(instanceId: string): void {
    const state = this.crashStates.get(instanceId);
    if (state?.timer) {
      clearTimeout(state.timer);
      state.timer = undefined;
    }
  }

  dispose(): void {
    for (const [id] of this.crashStates) {
      this.cancelPendingCrashRestart(id);
    }
    this.crashStates.clear();
  }

  private slugify(name: string): string {
    const base = name
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 32) || 'server';

    let candidate = base;
    let suffix = 2;
    while (this.db.getInstanceBySlugOrId(candidate)) {
      candidate = `${base}-${suffix}`;
      suffix += 1;
    }
    return candidate;
  }

  private generateSecret(length = 16): string {
    return crypto.randomBytes(length).toString('base64url').slice(0, length);
  }

  /**
   * Automatically allocates non-overlapping host ports across all configured instances.
   */
  allocatePorts(template: GameTemplate, requestedPorts?: Record<string, number>): Record<string, number> {
    const usedPorts = new Set<number>();
    for (const inst of this.db.listInstances()) {
      for (const p of Object.values(inst.ports)) {
        usedPorts.add(p);
      }
    }

    const allocated: Record<string, number> = {};
    for (const portSpec of template.ports) {
      let port = requestedPorts?.[portSpec.key] ?? portSpec.defaultPort;
      while (usedPorts.has(port) && port < 65500) {
        port += 1;
      }
      if (usedPorts.has(port)) {
        throw new Error(`Unable to allocate a free port for "${portSpec.label}"`);
      }
      usedPorts.add(port);
      allocated[portSpec.key] = port;
    }
    return allocated;
  }

  private buildInitialConfig(
    template: GameTemplate,
    provided: Record<string, string | number | boolean>
  ): Record<string, string | number | boolean> {
    const merged: Record<string, string | number | boolean> = {};
    for (const field of template.configFields) {
      const userVal = provided[field.key];
      if (userVal !== undefined && userVal !== '') {
        merged[field.key] = userVal;
      } else if (field.autoGenerate) {
        merged[field.key] = this.generateSecret(16);
      } else if (field.default !== undefined) {
        merged[field.key] = field.default;
      } else if (field.type === 'boolean') {
        merged[field.key] = false;
      } else {
        merged[field.key] = '';
      }
    }
    return merged;
  }

  getRunningCount(): number {
    return this.db
      .listInstances()
      .filter((i) => i.status === 'running' || i.status === 'starting' || i.status === 'installing').length;
  }

  enrichInstance(instance: ServerInstance): ServerInstance {
    return {
      ...instance,
      activeLease: this.db.getActiveLeaseForInstance(instance.id),
      stats: instance.status === 'running' ? (this.statsCache.get(instance.id) ?? null) : null,
    };
  }

  listInstances(): ServerInstance[] {
    return this.db.listInstances().map((inst) => this.enrichInstance(inst));
  }

  getInstance(idOrSlug: string): ServerInstance | null {
    const inst = this.db.getInstanceBySlugOrId(idOrSlug);
    return inst ? this.enrichInstance(inst) : null;
  }

  getJoinAddressInfo(instance: ServerInstance): {
    joinAddress: string;
    localJoinAddress: string | null;
    publicHost: string;
    publicHostSource: PublicHostSource;
  } {
    const template = this.catalog.getTemplate(instance.gameId);
    const primarySpec = template?.ports.find((p) => p.primary) ?? template?.ports[0];
    const port = primarySpec ? instance.ports[primarySpec.key] : Object.values(instance.ports)[0];

    const resolved = this.network
      ? this.network.resolveEffectiveHost()
      : { host: this.db.getSettings(this.config.publicHost).publicHost, source: 'fallback' as PublicHostSource };

    const lanIp = this.network?.getLanIp() ?? null;
    const localJoinAddress =
      lanIp && lanIp.toLowerCase() !== resolved.host.toLowerCase() ? `${lanIp}:${port}` : null;

    return {
      joinAddress: `${resolved.host}:${port}`,
      localJoinAddress,
      publicHost: resolved.host,
      publicHostSource: resolved.source,
    };
  }

  getJoinAddress(instance: ServerInstance): string {
    return this.getJoinAddressInfo(instance).joinAddress;
  }

  createInstance(input: CreateInstanceInput, actor = 'admin', source: 'web' | 'discord' = 'web'): ServerInstance {
    const template = this.catalog.getTemplate(input.gameId);
    if (!template) {
      throw new Error(`Unknown game template: "${input.gameId}"`);
    }

    const defaultRuntime: RuntimeKind =
      this.config.runtimeMode === 'docker'
        ? template.runtimes.docker
          ? 'docker'
          : template.runtimes.preferred
        : template.runtimes.native
          ? 'native'
          : template.runtimes.preferred;
    const runtime: RuntimeKind = input.runtime ?? defaultRuntime;
    if (runtime === 'docker' && !template.runtimes.docker) {
      throw new Error(`Template "${template.name}" does not support Docker runtime.`);
    }
    if (runtime === 'native' && !template.runtimes.native) {
      throw new Error(`Template "${template.name}" does not support Native runtime.`);
    }

    const ports = this.allocatePorts(template, input.ports);
    const config = this.buildInitialConfig(template, input.config ?? {});
    const memoryLimitMb = input.memoryLimitMb ?? Math.round(template.resources.recommendedRamGb * 1024);
    const now = new Date().toISOString();

    const instance: ServerInstance = {
      id: crypto.randomUUID(),
      slug: this.slugify(input.name),
      name: input.name.trim(),
      gameId: template.id,
      runtime,
      status: 'stopped',
      ports,
      config,
      memoryLimitMb,
      autoStart: input.autoStart ?? false,
      autoRestartOnCrash: input.autoRestartOnCrash ?? true,
      discordEnabled: input.discordEnabled ?? true,
      containerId: null,
      externalDir: null,
      launchScript: null,
      lastError: null,
      lastCrash: null,
      backupPolicy: BackupPolicySchema.parse({}),
      createdAt: now,
      updatedAt: now,
      lastStartedAt: null,
    };

    const instanceDir = this.getInstanceDir(instance.id);
    fs.mkdirSync(instanceDir, { recursive: true });

    this.db.createInstance(instance);
    this.db.addAuditLog({
      actor,
      source,
      action: 'instance.create',
      instanceId: instance.id,
      details: `Deployed ${template.name} (${instance.name}) using ${runtime} runtime`,
    });

    const enriched = this.enrichInstance(instance);
    this.emit('instance:update', enriched);
    return enriched;
  }

  importInstance(input: ImportServerInput, actor = 'admin'): ServerInstance {
    const template = this.catalog.getTemplate(input.gameId);
    if (!template) {
      throw new Error(`Unknown game template: "${input.gameId}"`);
    }

    const resolvedSource = path.resolve(input.folderPath.trim().replace(/^["']|["']$/g, ''));
    if (!fs.existsSync(resolvedSource) || !fs.statSync(resolvedSource).isDirectory()) {
      throw new Error(`Import folder not found: ${resolvedSource}`);
    }

    const id = crypto.randomUUID();
    const mode = input.mode ?? 'link';
    const runtime: RuntimeKind = input.runtime ?? 'native';
    const ports = this.allocatePorts(template, input.ports);
    const config = this.buildInitialConfig(template, input.config ?? {});
    const memoryLimitMb = input.memoryLimitMb ?? Math.round(template.resources.recommendedRamGb * 1024);
    const now = new Date().toISOString();

    let targetServerDir = resolvedSource;
    let externalDir: string | null = resolvedSource;

    if (mode === 'copy') {
      const managedServerDir = path.join(this.getInstanceDir(id), 'server');
      fs.mkdirSync(managedServerDir, { recursive: true });
      fs.cpSync(resolvedSource, managedServerDir, { recursive: true, force: true });
      targetServerDir = managedServerDir;
      externalDir = null;
    } else {
      fs.mkdirSync(this.getInstanceDir(id), { recursive: true });
    }

    // Safely enable RCON inside server.properties for Minecraft servers if requested
    const isMinecraft = template.id === 'minecraft' || template.id === 'minecraft-curseforge';
    if (isMinecraft && input.enableRcon !== false) {
      const rconPort = ports.rcon ?? 25575;
      const rconPassword = String(config.RCON_PASSWORD || this.generateSecret(16));
      config.RCON_PASSWORD = rconPassword;
      enableRconInServerProperties(targetServerDir, rconPort, rconPassword);
    }

    const instance: ServerInstance = {
      id,
      slug: this.slugify(input.name),
      name: input.name.trim(),
      gameId: template.id,
      runtime,
      status: 'stopped',
      ports,
      config,
      memoryLimitMb,
      autoStart: input.autoStart ?? false,
      autoRestartOnCrash: input.autoRestartOnCrash ?? true,
      discordEnabled: input.discordEnabled ?? true,
      containerId: null,
      externalDir,
      launchScript: input.launchScript?.trim() || null,
      lastError: null,
      lastCrash: null,
      backupPolicy: BackupPolicySchema.parse({}),
      createdAt: now,
      updatedAt: now,
      lastStartedAt: null,
    };

    this.db.createInstance(instance);
    this.db.addAuditLog({
      actor,
      source: 'web',
      action: 'instance.import',
      instanceId: instance.id,
      details: `Imported ${instance.name} (${mode === 'link' ? `linked to ${resolvedSource}` : 'copied to managed storage'})`,
    });

    const enriched = this.enrichInstance(instance);
    this.emit('instance:update', enriched);
    return enriched;
  }

  updateInstanceConfig(
    id: string,
    patch: UpdateInstanceConfigInput,
    actor = 'admin'
  ): ServerInstance {
    const existing = this.db.getInstanceById(id);
    if (!existing) throw new Error('Server instance not found.');
    if (existing.status === 'running' || existing.status === 'starting') {
      throw new Error('Stop the server before modifying its configuration.');
    }

    let nextRuntime = existing.runtime;
    if (patch.runtime && patch.runtime !== existing.runtime) {
      const template = this.catalog.getTemplate(existing.gameId);
      if (template) {
        if (patch.runtime === 'docker' && !template.runtimes.docker) {
          throw new Error(`Template "${template.name}" does not support Docker runtime.`);
        }
        if (patch.runtime === 'native' && !template.runtimes.native) {
          throw new Error(`Template "${template.name}" does not support Native runtime.`);
        }
      }
      nextRuntime = patch.runtime;
    }

    const nextPolicy = patch.backupPolicy
      ? BackupPolicySchema.parse({ ...(existing.backupPolicy ?? {}), ...patch.backupPolicy })
      : existing.backupPolicy;

    const updated = this.db.updateInstance(id, {
      name: patch.name?.trim() || existing.name,
      runtime: nextRuntime,
      memoryLimitMb: patch.memoryLimitMb ?? existing.memoryLimitMb,
      autoStart: patch.autoStart ?? existing.autoStart,
      autoRestartOnCrash: patch.autoRestartOnCrash ?? existing.autoRestartOnCrash,
      discordEnabled: patch.discordEnabled ?? existing.discordEnabled,
      launchScript: patch.launchScript !== undefined ? patch.launchScript : existing.launchScript,
      config: patch.config ? { ...existing.config, ...patch.config } : existing.config,
      backupPolicy: nextPolicy,
      lastError: nextRuntime !== existing.runtime ? null : existing.lastError,
      status: nextRuntime !== existing.runtime && existing.status === 'error' ? 'stopped' : existing.status,
    });
    if (!updated) throw new Error('Failed to update instance.');

    this.db.addAuditLog({
      actor,
      source: 'web',
      action: 'instance.config',
      instanceId: id,
      details:
        nextRuntime !== existing.runtime
          ? `Switched ${updated.name} runtime from ${existing.runtime} to ${nextRuntime}`
          : `Updated configuration for ${updated.name}`,
    });

    const enriched = this.enrichInstance(updated);
    this.emit('instance:update', enriched);
    return enriched;
  }

  /**
   * Updates an instance's backup schedule & retention policy without requiring a server stop.
   */
  updateBackupPolicy(id: string, patch: Partial<BackupPolicy>, actor = 'admin'): ServerInstance {
    const existing = this.db.getInstanceById(id);
    if (!existing) throw new Error('Server instance not found.');
    const merged = BackupPolicySchema.parse({
      ...(existing.backupPolicy ?? {}),
      ...patch,
    });
    const updated = this.db.updateInstance(id, { backupPolicy: merged });
    if (!updated) throw new Error('Failed to update backup policy.');

    this.db.addAuditLog({
      actor,
      source: 'web',
      action: 'instance.backup_policy',
      instanceId: id,
      details: merged.enabled
        ? `Enabled auto-backups (${merged.scheduleMode === 'daily' ? `daily @ ${merged.dailyTime}` : `every ${merged.intervalHours}h`}, keep ${merged.maxCount}${merged.maxTotalGb > 0 ? ` / ${merged.maxTotalGb} GB` : ''})`
        : `Updated backup retention policy (auto-backups disabled, keep ${merged.maxCount})`,
    });

    const enriched = this.enrichInstance(updated);
    this.emit('instance:update', enriched);
    return enriched;
  }

  getInstanceDir(instanceId: string): string {
    return path.join(this.config.instancesDir, instanceId);
  }

  private appendLog(instanceId: string, line: string): void {
    const entry = this.logs.append(instanceId, line);
    this.emit('console:line', { instanceId, line: entry.line, timestamp: entry.timestamp });
  }

  private handleUnexpectedExit(instanceId: string, exitCode: number | null): void {
    if (this.intentionalStops.has(instanceId)) return;

    const cur = this.db.getInstanceById(instanceId);
    if (!cur || cur.status === 'stopping' || cur.status === 'stopped') return;

    // Exit code 0 without intentional stop = clean in-game shutdown (e.g., admin ran /stop)
    if (exitCode === 0) {
      this.cancelPendingCrashRestart(instanceId);
      this.db.deactivateLeasesForInstance(instanceId);
      this.statsCache.delete(instanceId);
      const stopped = this.db.updateInstance(instanceId, {
        status: 'stopped',
        lastError: null,
      });
      if (stopped) {
        this.emit('instance:update', this.enrichInstance(stopped));
      }
      return;
    }

    const nowMs = Date.now();
    const crashedAt = new Date(nowMs).toISOString();
    const logTail = this.logs.getLines(instanceId).slice(-50).map((entry) => entry.line);
    const detailLine = [...logTail]
      .reverse()
      .map((line) => line.trim())
      .find(
        (line) =>
          line &&
          !line.startsWith('[Native] Process exited') &&
          !line.startsWith('[Mock] Process terminated') &&
          !line.startsWith('[Watchdog]')
      );

    const exitLabel = exitCode !== null ? `code ${exitCode}` : 'unexpected signal';
    const baseReason = detailLine
      ? `Server crashed unexpectedly (${exitLabel}): ${detailLine.slice(0, 220)}`
      : `Server crashed unexpectedly (${exitLabel})`;

    // Capture any active lease so auto-recovery can restore it cleanly
    const activeLease = this.db.getActiveLeaseForInstance(instanceId);
    const leaseChannelId = activeLease?.channelId ?? null;
    const leaseSnapshot = activeLease
      ? {
          remainingMinutes: Math.max(15, Math.ceil((new Date(activeLease.expiresAt).getTime() - nowMs) / 60_000)),
          idleTimeoutMinutes: activeLease.idleTimeoutMinutes,
          requestedBy: activeLease.requestedBy,
          requestedById: activeLease.requestedById ?? undefined,
          source: activeLease.source,
          channelId: activeLease.channelId ?? undefined,
        }
      : null;

    this.statsCache.delete(instanceId);

    // Update rolling crash-loop window
    let tracker = this.crashStates.get(instanceId);
    if (!tracker) {
      tracker = { timestamps: [] };
      this.crashStates.set(instanceId, tracker);
    }
    this.cancelPendingCrashRestart(instanceId);
    tracker.timestamps = tracker.timestamps.filter((ts) => nowMs - ts <= this.watchdogWindowMs);
    tracker.timestamps.push(nowMs);
    const attemptCount = tracker.timestamps.length;

    const autoRestartEnabled = cur.autoRestartOnCrash !== false;
    const withinBudget = autoRestartEnabled && attemptCount <= this.watchdogMaxRestarts;

    if (withinBudget) {
      const delayMs = this.watchdogBaseBackoffMs * Math.pow(2, attemptCount - 1);
      const nextRestartAt = new Date(nowMs + delayMs).toISOString();
      const crash: CrashSummary = {
        crashedAt,
        exitCode,
        attemptCount,
        maxAttempts: this.watchdogMaxRestarts,
        nextRestartAt,
        halted: false,
        reason: baseReason,
        logTail,
      };

      const updated = this.db.updateInstance(instanceId, {
        status: 'error',
        lastError: baseReason,
        lastCrash: crash,
      });

      this.appendLog(
        instanceId,
        `[Watchdog] ${baseReason}. Scheduling automatic restart in ${Math.max(1, Math.round(delayMs / 1000))}s (attempt ${attemptCount}/${this.watchdogMaxRestarts})...`
      );
      this.diagnostics?.record({
        level: 'error',
        source: 'runtime',
        instanceId,
        message: `${cur.name}: ${baseReason} (auto-restart ${attemptCount}/${this.watchdogMaxRestarts})`,
        details: logTail.slice(-10).join('\n'),
      });
      this.db.addAuditLog({
        actor: 'Watchdog',
        source: 'system',
        action: 'instance.crash',
        instanceId,
        details: `${baseReason} — scheduling auto-restart ${attemptCount}/${this.watchdogMaxRestarts}`,
      });

      if (updated) {
        const enriched = this.enrichInstance(updated);
        this.emit('instance:update', enriched);
        this.emit('instance:crash', { instance: enriched, crash, channelId: leaseChannelId });
      }

      tracker.timer = setTimeout(() => {
        if (tracker) tracker.timer = undefined;
        void this.executeWatchdogRestart(instanceId, leaseSnapshot, attemptCount);
      }, delayMs);
      tracker.timer.unref?.();
    } else {
      this.db.deactivateLeasesForInstance(instanceId);
      const haltReason = !autoRestartEnabled
        ? `${baseReason} (auto-restart disabled)`
        : `${baseReason} — Crash-loop circuit breaker triggered (${attemptCount} crashes within ${Math.max(1, Math.round(this.watchdogWindowMs / 60_000))}m); auto-restart halted.`;

      const crash: CrashSummary = {
        crashedAt,
        exitCode,
        attemptCount,
        maxAttempts: this.watchdogMaxRestarts,
        nextRestartAt: null,
        halted: true,
        reason: haltReason,
        logTail,
      };

      const updated = this.db.updateInstance(instanceId, {
        status: 'error',
        lastError: haltReason,
        lastCrash: crash,
      });

      this.appendLog(instanceId, `[Watchdog] ${haltReason}`);
      this.diagnostics?.record({
        level: 'error',
        source: 'runtime',
        instanceId,
        message: `${cur.name}: ${haltReason}`,
        details: logTail.slice(-10).join('\n'),
      });
      this.db.addAuditLog({
        actor: 'Watchdog',
        source: 'system',
        action: 'instance.crash_halted',
        instanceId,
        details: haltReason,
      });

      if (updated) {
        const enriched = this.enrichInstance(updated);
        this.emit('instance:update', enriched);
        this.emit('instance:crash', { instance: enriched, crash, channelId: leaseChannelId });
      }
    }
  }

  private async executeWatchdogRestart(
    instanceId: string,
    leaseSnapshot: {
      remainingMinutes: number;
      idleTimeoutMinutes: number;
      requestedBy: string;
      requestedById?: string;
      source: 'web' | 'discord';
      channelId?: string;
    } | null,
    attemptCount: number
  ): Promise<void> {
    const cur = this.db.getInstanceById(instanceId);
    if (!cur || cur.status !== 'error' || this.intentionalStops.has(instanceId)) {
      return;
    }

    this.appendLog(
      instanceId,
      `[Watchdog] Executing automatic crash recovery restart (attempt ${attemptCount}/${this.watchdogMaxRestarts})...`
    );

    try {
      await this.startInstance(
        instanceId,
        {
          temporary: Boolean(leaseSnapshot),
          durationMinutes: leaseSnapshot?.remainingMinutes,
          idleTimeoutMinutes: leaseSnapshot?.idleTimeoutMinutes,
          requestedBy: leaseSnapshot?.requestedBy ?? 'Watchdog',
          requestedById: leaseSnapshot?.requestedById,
          source: leaseSnapshot?.source ?? 'web',
          channelId: leaseSnapshot?.channelId,
        },
        { isWatchdogRestart: true }
      );
      this.appendLog(instanceId, `[Watchdog] Automatic crash recovery succeeded (attempt ${attemptCount}).`);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      this.appendLog(instanceId, `[Watchdog] Automatic restart attempt ${attemptCount} failed: ${msg}`);
      this.diagnostics?.record({
        level: 'error',
        source: 'runtime',
        instanceId,
        message: `${cur.name}: Watchdog auto-restart failed — ${msg}`,
      });
    }
  }

  async startInstance(
    idOrSlug: string,
    input: StartInstanceInput = { temporary: false, source: 'web' },
    internalOpts: { isWatchdogRestart?: boolean } = {}
  ): Promise<ServerInstance> {
    const instance = this.db.getInstanceBySlugOrId(idOrSlug);
    if (!instance) {
      throw new Error(`Server instance "${idOrSlug}" not found.`);
    }
    if (instance.status === 'running' || instance.status === 'starting' || instance.status === 'installing') {
      throw new GuardrailError(`"${instance.name}" is already ${instance.status}.`);
    }

    const template = this.catalog.getTemplate(instance.gameId);
    if (!template) {
      throw new Error(`Game template "${instance.gameId}" is missing.`);
    }

    const settings = this.db.getSettings(this.config.publicHost);

    // Guardrail 1: Concurrency cap
    const runningCount = this.getRunningCount();
    if (runningCount >= settings.maxConcurrentServers) {
      throw new GuardrailError(
        `Concurrent server limit reached (${runningCount}/${settings.maxConcurrentServers} running). Stop another server first.`
      );
    }

    // Guardrail 2: Host RAM availability
    const mem = await this.telemetry.getMemorySnapshot();
    const usableRamGb = Number((mem.freeGb - settings.hostRamReserveGb).toFixed(2));
    if (usableRamGb < template.resources.minRamGb) {
      throw new GuardrailError(
        `Insufficient free RAM to start ${template.name}. Requires ${template.resources.minRamGb} GB, but only ${Math.max(0, usableRamGb)} GB is available after keeping ${settings.hostRamReserveGb} GB reserved for the OS.`
      );
    }

    this.cancelPendingCrashRestart(instance.id);
    this.intentionalStops.delete(instance.id);
    if (!internalOpts.isWatchdogRestart) {
      this.crashStates.delete(instance.id);
    }

    const adapter = await this.runtimeManager.resolveAdapter(instance.runtime);
    const startingInst = this.db.updateInstance(instance.id, {
      status: 'starting',
      lastError: null,
      ...(internalOpts.isWatchdogRestart ? {} : { lastCrash: null }),
    })!;
    this.appendLog(
      instance.id,
      `[ServerForge] Preparing to start "${instance.name}" (${template.name} • ${instance.runtime})...`
    );
    this.emit('instance:update', this.enrichInstance(startingInst));

    try {
      const startRes = await adapter.start(
        startingInst,
        template,
        this.getInstanceDir(instance.id),
        (line) => this.appendLog(instance.id, line),
        (exitCode) => {
          this.handleUnexpectedExit(instance.id, exitCode);
        },
        (nextStatus) => {
          const cur = this.db.getInstanceById(instance.id);
          if (!cur || cur.status === nextStatus) return;
          const updated = this.db.updateInstance(instance.id, { status: nextStatus });
          if (updated) {
            this.emit('instance:update', this.enrichInstance(updated));
          }
        }
      );

      const nowIso = new Date().toISOString();
      const recoveredCrash =
        internalOpts.isWatchdogRestart && startingInst.lastCrash
          ? { ...startingInst.lastCrash, nextRestartAt: null }
          : null;
      const runningInst = this.db.updateInstance(instance.id, {
        status: 'running',
        containerId: startRes.externalId,
        lastStartedAt: nowIso,
        lastError: null,
        lastCrash: recoveredCrash,
      })!;

      if (input.temporary) {
        const durationMin = Math.min(
          input.durationMinutes ?? settings.defaultLeaseMinutes,
          settings.maxLeaseMinutes
        );
        const idleMin = input.idleTimeoutMinutes ?? settings.defaultIdleTimeoutMinutes;
        const nowMs = Date.now();
        const lease: ServerLease = {
          id: crypto.randomUUID(),
          instanceId: instance.id,
          requestedBy: input.requestedBy || 'admin',
          requestedById: input.requestedById ?? null,
          source: input.source ?? 'web',
          channelId: input.channelId ?? (settings.discordNotifyChannelId || null),
          startedAt: new Date(nowMs).toISOString(),
          expiresAt: new Date(nowMs + durationMin * 60_000).toISOString(),
          maxExpiresAt: new Date(nowMs + settings.maxLeaseMinutes * 60_000).toISOString(),
          idleTimeoutMinutes: idleMin,
          emptySince: null,
          warningSentAt: null,
          active: true,
        };
        this.db.createLease(lease);
      }

      this.db.addAuditLog({
        actor: internalOpts.isWatchdogRestart ? 'Watchdog' : input.requestedBy || 'admin',
        source: internalOpts.isWatchdogRestart ? 'system' : input.source ?? 'web',
        action: internalOpts.isWatchdogRestart
          ? 'instance.auto_restart'
          : input.temporary
            ? 'instance.start_temporary'
            : 'instance.start',
        instanceId: instance.id,
        details: internalOpts.isWatchdogRestart
          ? `Auto-restarted ${instance.name} after unexpected crash`
          : input.temporary
            ? `Started ${instance.name} with temporary lease (${input.durationMinutes ?? settings.defaultLeaseMinutes}m)`
            : `Started ${instance.name}`,
      });

      const enriched = this.enrichInstance(runningInst);
      this.emit('instance:update', enriched);
      return enriched;
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      this.appendLog(instance.id, `[Error] Failed to start: ${msg}`);
      this.diagnostics?.record({
        level: 'error',
        source: 'orchestrator',
        instanceId: instance.id,
        message: `${instance.name}: Failed to start — ${msg}`,
      });
      const errored = this.db.updateInstance(instance.id, {
        status: 'error',
        lastError: msg,
      })!;
      this.emit('instance:update', this.enrichInstance(errored));
      throw err;
    }
  }

  async stopInstance(
    idOrSlug: string,
    actor = 'admin',
    source: 'web' | 'discord' | 'system' = 'web',
    reason?: string
  ): Promise<ServerInstance> {
    const instance = this.db.getInstanceBySlugOrId(idOrSlug);
    if (!instance) {
      throw new Error(`Server instance "${idOrSlug}" not found.`);
    }

    this.cancelPendingCrashRestart(instance.id);
    this.crashStates.delete(instance.id);

    if (instance.status === 'stopped') {
      return this.enrichInstance(instance);
    }

    this.intentionalStops.add(instance.id);
    const template = this.catalog.getTemplate(instance.gameId);
    const stopping = this.db.updateInstance(instance.id, { status: 'stopping' })!;
    this.emit('instance:update', this.enrichInstance(stopping));

    try {
      const adapter = await this.runtimeManager.resolveAdapter(instance.runtime);
      if (template) {
        await adapter.stop(stopping, template, (line) => this.appendLog(instance.id, line));
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      this.appendLog(instance.id, `[Warning] Stop encountered error: ${msg}`);
      this.diagnostics?.record({
        level: 'warn',
        source: 'orchestrator',
        instanceId: instance.id,
        message: `${instance.name}: Stop encountered warning — ${msg}`,
      });
    } finally {
      this.intentionalStops.delete(instance.id);
    }

    this.db.deactivateLeasesForInstance(instance.id);
    this.statsCache.delete(instance.id);

    const stopped = this.db.updateInstance(instance.id, {
      status: 'stopped',
      lastError: null,
      lastCrash: null,
    })!;

    this.db.addAuditLog({
      actor,
      source,
      action: 'instance.stop',
      instanceId: instance.id,
      details: reason ? `Stopped ${instance.name}: ${reason}` : `Stopped ${instance.name}`,
    });

    const enriched = this.enrichInstance(stopped);
    this.emit('instance:update', enriched);
    return enriched;
  }

  async restartInstance(idOrSlug: string, actor = 'admin'): Promise<ServerInstance> {
    const existing = this.db.getInstanceBySlugOrId(idOrSlug);
    if (!existing) throw new Error('Server instance not found.');
    const activeLease = this.db.getActiveLeaseForInstance(existing.id);
    await this.stopInstance(existing.id, actor, 'web', 'Restart requested');
    return this.startInstance(existing.id, {
      temporary: Boolean(activeLease),
      durationMinutes: activeLease
        ? Math.max(15, Math.ceil((new Date(activeLease.expiresAt).getTime() - Date.now()) / 60_000))
        : undefined,
      idleTimeoutMinutes: activeLease?.idleTimeoutMinutes,
      requestedBy: activeLease?.requestedBy ?? actor,
      requestedById: activeLease?.requestedById ?? undefined,
      source: activeLease?.source ?? 'web',
      channelId: activeLease?.channelId ?? undefined,
    });
  }

  async sendCommand(idOrSlug: string, command: string, actor = 'admin'): Promise<string | null> {
    const instance = this.db.getInstanceBySlugOrId(idOrSlug);
    if (!instance) throw new Error('Server instance not found.');
    if (instance.status !== 'running') {
      throw new Error('Server must be running to send commands.');
    }
    const template = this.catalog.getTemplate(instance.gameId);
    if (!template) throw new Error('Game template not found.');

    const adapter = await this.runtimeManager.resolveAdapter(instance.runtime);
    const reply = await adapter.sendCommand(instance, template, command);
    this.db.addAuditLog({
      actor,
      source: 'web',
      action: 'instance.command',
      instanceId: instance.id,
      details: command,
    });
    return reply;
  }

  extendLease(
    instanceIdOrSlug: string,
    extraMinutes: number,
    actor = 'admin',
    source: 'web' | 'discord' = 'web'
  ): ServerLease {
    const instance = this.db.getInstanceBySlugOrId(instanceIdOrSlug);
    if (!instance) throw new Error('Server instance not found.');
    const lease = this.db.getActiveLeaseForInstance(instance.id);
    if (!lease) throw new Error(`"${instance.name}" does not have an active temporary lease.`);

    const currentExpiry = new Date(lease.expiresAt).getTime();
    const maxExpiry = new Date(lease.maxExpiresAt).getTime();
    const nextExpiry = Math.min(currentExpiry + extraMinutes * 60_000, maxExpiry);

    if (nextExpiry <= currentExpiry) {
      throw new GuardrailError('This temporary lease has already reached its maximum allowed duration.');
    }

    const updated = this.db.updateLease(lease.id, {
      expiresAt: new Date(nextExpiry).toISOString(),
      emptySince: null,
      warningSentAt: null,
    })!;

    this.db.addAuditLog({
      actor,
      source,
      action: 'lease.extend',
      instanceId: instance.id,
      details: `Extended lease for ${instance.name} by ${Math.round((nextExpiry - currentExpiry) / 60_000)}m`,
    });

    this.emit('instance:update', this.enrichInstance(instance));
    return updated;
  }

  promoteToPermanent(instanceId: string, actor = 'admin'): ServerInstance {
    const instance = this.db.getInstanceById(instanceId);
    if (!instance) throw new Error('Server instance not found.');
    this.db.deactivateLeasesForInstance(instance.id);
    this.db.addAuditLog({
      actor,
      source: 'web',
      action: 'lease.promote_permanent',
      instanceId: instance.id,
      details: `Removed auto-shutdown lease for ${instance.name}`,
    });
    const enriched = this.enrichInstance(instance);
    this.emit('instance:update', enriched);
    return enriched;
  }

  async refreshInstanceStats(instanceId: string): Promise<InstanceRuntimeStats | null> {
    const instance = this.db.getInstanceById(instanceId);
    if (!instance || instance.status !== 'running') {
      this.statsCache.delete(instanceId);
      return null;
    }
    const template = this.catalog.getTemplate(instance.gameId);
    if (!template) return null;

    try {
      const adapter = await this.runtimeManager.resolveAdapter(instance.runtime);
      const stats = await adapter.getStats(instance, template);
      if (stats) {
        this.statsCache.set(instanceId, stats);
      }
      return stats;
    } catch {
      return null;
    }
  }

  private getBackupFilePath(instanceId: string, filename: string): string {
    const backupDir = path.resolve(this.config.backupsDir, instanceId);
    const safeName = path.basename(filename);
    const resolved = path.resolve(backupDir, safeName);
    if (!resolved.startsWith(backupDir + path.sep)) {
      throw new Error('Invalid backup filename.');
    }
    return resolved;
  }

  async createBackup(
    instanceId: string,
    note?: string,
    actor = 'admin',
    options: { source?: 'web' | 'system'; applyRetention?: boolean } = {}
  ): Promise<BackupRecord> {
    const instance = this.db.getInstanceById(instanceId);
    if (!instance) throw new Error('Server instance not found.');

    const sourceDir = instance.externalDir ? path.resolve(instance.externalDir) : this.getInstanceDir(instance.id);
    const backupDir = path.join(this.config.backupsDir, instance.id);
    fs.mkdirSync(backupDir, { recursive: true });

    const stamp = new Date().toISOString().replace(/[:.]/g, '-');
    let filename = `${instance.slug}-${stamp}.zip`;
    let outPath = path.join(backupDir, filename);
    if (fs.existsSync(outPath)) {
      filename = `${instance.slug}-${stamp}-${crypto.randomBytes(3).toString('hex')}.zip`;
      outPath = path.join(backupDir, filename);
    }

    try {
      await new Promise<void>((resolve, reject) => {
        const output = fs.createWriteStream(outPath);
        const archive = archiver('zip', { zlib: { level: 6 } });
        output.on('close', () => resolve());
        output.on('error', (err) => reject(err));
        archive.on('error', (err) => reject(err));
        archive.pipe(output);
        if (fs.existsSync(sourceDir)) {
          archive.directory(sourceDir, false);
        }
        void archive.finalize();
      });
    } catch (err) {
      this.diagnostics?.record({
        level: 'error',
        source: 'backup',
        instanceId: instance.id,
        message: `${instance.name}: Backup creation failed — ${err instanceof Error ? err.message : String(err)}`,
      });
      throw err;
    }

    const stat = fs.statSync(outPath);
    const record: BackupRecord = {
      id: crypto.randomUUID(),
      instanceId: instance.id,
      filename,
      sizeBytes: stat.size,
      createdAt: new Date().toISOString(),
      note: note?.trim() || null,
    };

    this.db.createBackupRecord(record);
    this.db.addAuditLog({
      actor,
      source: options.source ?? 'web',
      action: 'instance.backup',
      instanceId: instance.id,
      details: `Created backup ${filename} (${Math.round(stat.size / 1024)} KB)`,
    });
    this.appendLog(instance.id, `[Backup] Created snapshot ${filename} (${Math.round(stat.size / 1024)} KB).`);

    if (options.applyRetention) {
      this.pruneBackups(instance.id, actor, options.source ?? 'system');
    }

    return record;
  }

  getBackupDownload(instanceId: string, backupId: string): { record: BackupRecord; filePath: string } {
    const instance = this.db.getInstanceById(instanceId);
    if (!instance) throw new Error('Server instance not found.');
    const record = this.db.getBackupById(backupId);
    if (!record || record.instanceId !== instance.id) {
      throw new Error('Backup not found for this server.');
    }
    const filePath = this.getBackupFilePath(instance.id, record.filename);
    if (!fs.existsSync(filePath)) {
      throw new Error(`Backup archive file "${record.filename}" is missing on disk.`);
    }
    return { record, filePath };
  }

  deleteBackup(
    instanceId: string,
    backupId: string,
    actor = 'admin',
    source: 'web' | 'system' = 'web'
  ): BackupRecord {
    const instance = this.db.getInstanceById(instanceId);
    if (!instance) throw new Error('Server instance not found.');
    const record = this.db.getBackupById(backupId);
    if (!record || record.instanceId !== instance.id) {
      throw new Error('Backup not found for this server.');
    }

    const filePath = this.getBackupFilePath(instance.id, record.filename);
    if (fs.existsSync(filePath)) {
      try {
        fs.rmSync(filePath, { force: true, maxRetries: 3, retryDelay: 150 });
      } catch (err) {
        console.warn(`[Orchestrator] Warning removing backup file ${filePath}:`, err);
      }
    }

    this.db.deleteBackupRecord(record.id);
    this.db.addAuditLog({
      actor,
      source,
      action: 'instance.backup_delete',
      instanceId: instance.id,
      details: `Deleted backup ${record.filename}`,
    });
    return record;
  }

  /**
   * Prunes oldest backups exceeding maxCount or maxTotalGb in the instance's backupPolicy.
   * Always retains at least the newest backup.
   */
  pruneBackups(
    instanceId: string,
    actor = 'Scheduler',
    source: 'web' | 'system' = 'system',
    overrideLimits?: { maxCount?: number; maxTotalBytes?: number }
  ): BackupRecord[] {
    const instance = this.db.getInstanceById(instanceId);
    if (!instance) return [];

    const policy = BackupPolicySchema.parse(instance.backupPolicy ?? {});
    const maxCount = Math.max(1, overrideLimits?.maxCount ?? policy.maxCount);
    const maxTotalBytes =
      overrideLimits?.maxTotalBytes !== undefined
        ? overrideLimits.maxTotalBytes
        : policy.maxTotalGb > 0
          ? Math.floor(policy.maxTotalGb * 1024 * 1024 * 1024)
          : 0;

    // listBackups returns newest-first
    const backups = this.db.listBackups(instance.id);
    const deleted: BackupRecord[] = [];
    let keptBytes = 0;

    for (let i = 0; i < backups.length; i++) {
      const b = backups[i];
      const alwaysKeepNewest = i === 0;
      const exceedsCount = i >= maxCount;
      const exceedsSize = maxTotalBytes > 0 && keptBytes + b.sizeBytes > maxTotalBytes;

      if (!alwaysKeepNewest && (exceedsCount || exceedsSize)) {
        try {
          this.deleteBackup(instance.id, b.id, actor, source);
          deleted.push(b);
        } catch {
          // ignore if already removed
        }
      } else {
        keptBytes += b.sizeBytes;
      }
    }

    if (deleted.length > 0) {
      this.appendLog(instance.id, `[Backup] Retention policy pruned ${deleted.length} older backup(s).`);
    }
    return deleted;
  }

  async restoreBackup(
    instanceId: string,
    backupId: string,
    actor = 'admin'
  ): Promise<{ restoredBackup: BackupRecord; safetyBackup: BackupRecord; extractedFiles: number }> {
    const instance = this.db.getInstanceById(instanceId);
    if (!instance) throw new Error('Server instance not found.');
    const { record: targetBackup, filePath } = this.getBackupDownload(instance.id, backupId);

    // Gracefully stop the server first so files aren't locked or half-written
    if (instance.status !== 'stopped' && instance.status !== 'error') {
      this.appendLog(instance.id, `[Backup] Stopping server before restoring ${targetBackup.filename}...`);
      await this.stopInstance(instance.id, actor, 'web', `Pre-restore stop for ${targetBackup.filename}`);
    }

    // Create automatic pre-restore safety snapshot before touching existing world data
    const safetyBackup = await this.createBackup(
      instance.id,
      `Auto safety backup before restoring ${targetBackup.filename}`,
      actor,
      { source: 'system', applyRetention: false }
    );

    const targetDir = instance.externalDir ? path.resolve(instance.externalDir) : this.getInstanceDir(instance.id);
    const stagingDir = path.join(this.config.backupsDir, `.restore-stage-${instance.id}-${Date.now()}`);

    try {
      fs.mkdirSync(stagingDir, { recursive: true });
      const extractedFiles = extractZipSafely(filePath, stagingDir);

      fs.mkdirSync(targetDir, { recursive: true });
      // Clear current files in targetDir cleanly before copying restored files
      for (const entry of fs.readdirSync(targetDir)) {
        fs.rmSync(path.join(targetDir, entry), { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
      }
      for (const entry of fs.readdirSync(stagingDir)) {
        fs.cpSync(path.join(stagingDir, entry), path.join(targetDir, entry), { recursive: true, force: true });
      }

      this.db.addAuditLog({
        actor,
        source: 'web',
        action: 'instance.backup_restore',
        instanceId: instance.id,
        details: `Restored backup ${targetBackup.filename} (${extractedFiles} file(s); safety snapshot: ${safetyBackup.filename})`,
      });
      this.appendLog(
        instance.id,
        `[Backup] Restored ${targetBackup.filename} (${extractedFiles} file(s)). Safety snapshot saved as ${safetyBackup.filename}.`
      );
      return { restoredBackup: targetBackup, safetyBackup, extractedFiles };
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      this.diagnostics?.record({
        level: 'error',
        source: 'backup',
        instanceId: instance.id,
        message: `${instance.name}: Restore failed for ${targetBackup.filename} — ${msg}`,
      });
      throw err;
    } finally {
      try {
        if (fs.existsSync(stagingDir)) {
          fs.rmSync(stagingDir, { recursive: true, force: true, maxRetries: 3, retryDelay: 150 });
        }
      } catch {
        // ignore temp cleanup warning
      }
    }
  }

  async deleteInstance(instanceId: string, actor = 'admin'): Promise<void> {
    const instance = this.db.getInstanceById(instanceId);
    if (!instance) throw new Error('Server instance not found.');

    this.cancelPendingCrashRestart(instance.id);
    this.crashStates.delete(instance.id);

    if (instance.status !== 'stopped') {
      await this.stopInstance(instance.id, actor, 'web', 'Instance deleted');
    }

    try {
      const adapter = await this.runtimeManager.resolveAdapter(instance.runtime);
      await adapter.remove(instance);
    } catch {
      // Ignore runtime cleanup error if daemon unavailable
    }

    // Only delete ServerForge-managed directory; NEVER touch a user's linked externalDir!
    const managedDir = this.getInstanceDir(instance.id);
    if (fs.existsSync(managedDir)) {
      try {
        fs.rmSync(managedDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 250 });
      } catch (err) {
        console.warn(`[Orchestrator] Managed folder cleanup warning for ${instance.name}:`, err);
      }
    }

    this.logs.clear(instance.id);
    this.statsCache.delete(instance.id);
    this.db.deleteInstance(instance.id);
    this.db.addAuditLog({
      actor,
      source: 'web',
      action: instance.externalDir ? 'instance.unlink' : 'instance.delete',
      instanceId: instance.id,
      details: instance.externalDir
        ? `Unlinked ${instance.name} (preserved original files at ${instance.externalDir})`
        : `Deleted instance ${instance.name}`,
    });
    this.emit('instance:deleted', instance.id);
  }

  listRunningInstances(): ServerInstance[] {
    return this.listInstances().filter(
      (i) => i.status === 'running' || i.status === 'starting' || i.status === 'installing'
    );
  }

  async stopAllRunning(
    actor = 'System',
    source: 'web' | 'discord' | 'system' = 'system',
    reason = 'Shutdown requested'
  ): Promise<string[]> {
    const running = this.listRunningInstances();
    const stoppedIds: string[] = [];
    for (const inst of running) {
      try {
        await this.stopInstance(inst.id, actor, source, reason);
        stoppedIds.push(inst.id);
      } catch (err) {
        console.error(`[Orchestrator] Failed to stop ${inst.name}:`, err);
      }
    }
    return stoppedIds;
  }

  async startAutoStartInstances(skipIds = new Set<string>()): Promise<string[]> {
    const startedIds: string[] = [];
    const candidates = this.listInstances().filter(
      (i) => i.autoStart && i.status === 'stopped' && !skipIds.has(i.id)
    );
    for (const inst of candidates) {
      try {
        await this.startInstance(inst.id, {
          temporary: false,
          requestedBy: 'AutoStart',
          source: 'web',
        });
        startedIds.push(inst.id);
      } catch (err) {
        console.error(`[Orchestrator] Auto-start skipped for ${inst.name}:`, err);
      }
    }
    return startedIds;
  }

  /**
   * Reconciles database statuses on startup (e.g., if Windows PC rebooted while servers were running).
   */
  async reconcileOnStartup(): Promise<void> {
    for (const inst of this.db.listInstances()) {
      if (inst.status === 'running' || inst.status === 'starting' || inst.status === 'stopping') {
        let alive = false;
        try {
          const adapter = await this.runtimeManager.resolveAdapter(inst.runtime);
          alive = await adapter.isRunning(inst);
        } catch {
          alive = false;
        }
        if (!alive) {
          this.db.deactivateLeasesForInstance(inst.id);
          this.db.updateInstance(inst.id, { status: 'stopped' });
        }
      }
    }
  }
}
