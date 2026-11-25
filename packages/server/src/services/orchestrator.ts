import crypto from 'node:crypto';
import EventEmitter from 'node:events';
import fs from 'node:fs';
import path from 'node:path';
import archiver from 'archiver';
import type {
  BackupRecord,
  CreateInstanceInput,
  GameTemplate,
  InstanceRuntimeStats,
  RuntimeKind,
  ServerInstance,
  ServerLease,
  StartInstanceInput,
  UpdateInstanceConfigInput,
} from '@serverforge/shared';
import type { CatalogService } from '../catalog/catalog-service.js';
import type { AppConfig } from '../config.js';
import type { AppDatabase } from '../db/database.js';
import { ConsoleLogBuffer } from '../runtimes/runtime-adapter.js';
import type { RuntimeManager } from '../runtimes/runtime-manager.js';
import type { TelemetryService } from './telemetry-service.js';

export class GuardrailError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'GuardrailError';
  }
}

export interface OrchestratorEvents {
  'console:line': (payload: { instanceId: string; line: string; timestamp: string }) => void;
  'instance:update': (instance: ServerInstance) => void;
  'instance:deleted': (instanceId: string) => void;
  'lease:warning': (payload: {
    lease: ServerLease;
    instance: ServerInstance;
    reason: 'ttl' | 'idle';
    minutesRemaining: number;
  }) => void;
  'lease:expired': (payload: { lease: ServerLease; instance: ServerInstance; reason: 'ttl' | 'idle' }) => void;
}

export class ServerOrchestrator extends EventEmitter {
  public readonly logs = new ConsoleLogBuffer(600);
  private readonly statsCache = new Map<string, InstanceRuntimeStats>();

  constructor(
    private readonly config: AppConfig,
    private readonly db: AppDatabase,
    private readonly catalog: CatalogService,
    private readonly runtimeManager: RuntimeManager,
    private readonly telemetry: TelemetryService
  ) {
    super();
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

  getJoinAddress(instance: ServerInstance): string {
    const settings = this.db.getSettings(this.config.publicHost);
    const template = this.catalog.getTemplate(instance.gameId);
    const primarySpec = template?.ports.find((p) => p.primary) ?? template?.ports[0];
    const port = primarySpec ? instance.ports[primarySpec.key] : Object.values(instance.ports)[0];
    return `${settings.publicHost}:${port}`;
  }

  createInstance(input: CreateInstanceInput, actor = 'admin', source: 'web' | 'discord' = 'web'): ServerInstance {
    const template = this.catalog.getTemplate(input.gameId);
    if (!template) {
      throw new Error(`Unknown game template: "${input.gameId}"`);
    }

    const runtime: RuntimeKind = input.runtime ?? template.runtimes.preferred;
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
      discordEnabled: input.discordEnabled ?? true,
      containerId: null,
      lastError: null,
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

    const updated = this.db.updateInstance(id, {
      name: patch.name?.trim() || existing.name,
      memoryLimitMb: patch.memoryLimitMb ?? existing.memoryLimitMb,
      autoStart: patch.autoStart ?? existing.autoStart,
      discordEnabled: patch.discordEnabled ?? existing.discordEnabled,
      config: patch.config ? { ...existing.config, ...patch.config } : existing.config,
    });
    if (!updated) throw new Error('Failed to update instance.');

    this.db.addAuditLog({
      actor,
      source: 'web',
      action: 'instance.config',
      instanceId: id,
      details: `Updated configuration for ${updated.name}`,
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

  async startInstance(idOrSlug: string, input: StartInstanceInput = { temporary: false, source: 'web' }): Promise<ServerInstance> {
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

    const adapter = await this.runtimeManager.resolveAdapter(instance.runtime);
    const startingInst = this.db.updateInstance(instance.id, {
      status: 'starting',
      lastError: null,
    })!;
    this.emit('instance:update', this.enrichInstance(startingInst));

    try {
      const startRes = await adapter.start(
        startingInst,
        template,
        this.getInstanceDir(instance.id),
        (line) => this.appendLog(instance.id, line),
        (exitCode) => {
          const cur = this.db.getInstanceById(instance.id);
          if (!cur || cur.status === 'stopping' || cur.status === 'stopped') return;
          const nextStatus = exitCode === 0 ? 'stopped' : 'error';
          const nextErr = exitCode && exitCode !== 0 ? `Server exited unexpectedly with code ${exitCode}` : null;
          this.db.deactivateLeasesForInstance(instance.id);
          this.statsCache.delete(instance.id);
          const crashed = this.db.updateInstance(instance.id, {
            status: nextStatus,
            lastError: nextErr,
          });
          if (crashed) {
            this.emit('instance:update', this.enrichInstance(crashed));
          }
        }
      );

      const nowIso = new Date().toISOString();
      const runningInst = this.db.updateInstance(instance.id, {
        status: 'running',
        containerId: startRes.externalId,
        lastStartedAt: nowIso,
        lastError: null,
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
        actor: input.requestedBy || 'admin',
        source: input.source ?? 'web',
        action: input.temporary ? 'instance.start_temporary' : 'instance.start',
        instanceId: instance.id,
        details: input.temporary
          ? `Started ${instance.name} with temporary lease (${input.durationMinutes ?? settings.defaultLeaseMinutes}m)`
          : `Started ${instance.name}`,
      });

      const enriched = this.enrichInstance(runningInst);
      this.emit('instance:update', enriched);
      return enriched;
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      this.appendLog(instance.id, `[Error] Failed to start: ${msg}`);
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
    if (instance.status === 'stopped') {
      return this.enrichInstance(instance);
    }

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
    }

    this.db.deactivateLeasesForInstance(instance.id);
    this.statsCache.delete(instance.id);

    const stopped = this.db.updateInstance(instance.id, {
      status: 'stopped',
      lastError: null,
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

  async createBackup(instanceId: string, note?: string, actor = 'admin'): Promise<BackupRecord> {
    const instance = this.db.getInstanceById(instanceId);
    if (!instance) throw new Error('Server instance not found.');

    const instanceDir = this.getInstanceDir(instance.id);
    const backupDir = path.join(this.config.backupsDir, instance.id);
    fs.mkdirSync(backupDir, { recursive: true });

    const stamp = new Date().toISOString().replace(/[:.]/g, '-');
    const filename = `${instance.slug}-${stamp}.zip`;
    const outPath = path.join(backupDir, filename);

    await new Promise<void>((resolve, reject) => {
      const output = fs.createWriteStream(outPath);
      const archive = archiver('zip', { zlib: { level: 6 } });
      output.on('close', () => resolve());
      archive.on('error', (err) => reject(err));
      archive.pipe(output);
      if (fs.existsSync(instanceDir)) {
        archive.directory(instanceDir, false);
      }
      void archive.finalize();
    });

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
      source: 'web',
      action: 'instance.backup',
      instanceId: instance.id,
      details: `Created backup ${filename} (${Math.round(stat.size / 1024)} KB)`,
    });
    return record;
  }

  async deleteInstance(instanceId: string, actor = 'admin'): Promise<void> {
    const instance = this.db.getInstanceById(instanceId);
    if (!instance) throw new Error('Server instance not found.');

    if (instance.status !== 'stopped') {
      await this.stopInstance(instance.id, actor, 'web', 'Instance deleted');
    }

    try {
      const adapter = await this.runtimeManager.resolveAdapter(instance.runtime);
      await adapter.remove(instance);
    } catch {
      // Ignore runtime cleanup error if daemon unavailable
    }

    const dir = this.getInstanceDir(instance.id);
    if (fs.existsSync(dir)) {
      fs.rmSync(dir, { recursive: true, force: true });
    }

    this.logs.clear(instance.id);
    this.statsCache.delete(instance.id);
    this.db.deleteInstance(instance.id);
    this.db.addAuditLog({
      actor,
      source: 'web',
      action: 'instance.delete',
      instanceId: instance.id,
      details: `Deleted instance ${instance.name}`,
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
