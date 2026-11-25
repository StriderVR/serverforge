import { DatabaseSync } from 'node:sqlite';
import crypto from 'node:crypto';
import type {
  AuditLogEntry,
  BackupRecord,
  InstanceStatus,
  RuntimeKind,
  ServerInstance,
  ServerLease,
  SystemSettings,
} from '@serverforge/shared';
import { SystemSettingsSchema } from '@serverforge/shared';

export interface UserRecord {
  id: string;
  username: string;
  passwordHash: string;
  role: 'admin';
  createdAt: string;
}

export class AppDatabase {
  public readonly db: DatabaseSync;

  constructor(dbPath: string) {
    this.db = new DatabaseSync(dbPath);
    this.db.exec('PRAGMA journal_mode = WAL;');
    this.db.exec('PRAGMA foreign_keys = ON;');
    this.migrate();
  }

  private migrate(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS users (
        id TEXT PRIMARY KEY,
        username TEXT UNIQUE NOT NULL,
        password_hash TEXT NOT NULL,
        role TEXT NOT NULL DEFAULT 'admin',
        created_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS instances (
        id TEXT PRIMARY KEY,
        slug TEXT UNIQUE NOT NULL,
        name TEXT NOT NULL,
        game_id TEXT NOT NULL,
        runtime TEXT NOT NULL,
        status TEXT NOT NULL DEFAULT 'stopped',
        ports_json TEXT NOT NULL,
        config_json TEXT NOT NULL,
        memory_limit_mb INTEGER NOT NULL,
        auto_start INTEGER NOT NULL DEFAULT 0,
        discord_enabled INTEGER NOT NULL DEFAULT 1,
        container_id TEXT,
        external_dir TEXT,
        launch_script TEXT,
        last_error TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        last_started_at TEXT
      );

      CREATE TABLE IF NOT EXISTS leases (
        id TEXT PRIMARY KEY,
        instance_id TEXT NOT NULL REFERENCES instances(id) ON DELETE CASCADE,
        requested_by TEXT NOT NULL,
        requested_by_id TEXT,
        source TEXT NOT NULL,
        channel_id TEXT,
        started_at TEXT NOT NULL,
        expires_at TEXT NOT NULL,
        max_expires_at TEXT NOT NULL,
        idle_timeout_minutes INTEGER NOT NULL DEFAULT 30,
        empty_since TEXT,
        warning_sent_at TEXT,
        active INTEGER NOT NULL DEFAULT 1
      );

      CREATE INDEX IF NOT EXISTS idx_leases_active ON leases(instance_id, active);

      CREATE TABLE IF NOT EXISTS settings (
        key TEXT PRIMARY KEY,
        value_json TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS backups (
        id TEXT PRIMARY KEY,
        instance_id TEXT NOT NULL REFERENCES instances(id) ON DELETE CASCADE,
        filename TEXT NOT NULL,
        size_bytes INTEGER NOT NULL,
        created_at TEXT NOT NULL,
        note TEXT
      );

      CREATE TABLE IF NOT EXISTS audit_logs (
        id TEXT PRIMARY KEY,
        timestamp TEXT NOT NULL,
        actor TEXT NOT NULL,
        source TEXT NOT NULL,
        action TEXT NOT NULL,
        instance_id TEXT,
        details TEXT
      );

      CREATE INDEX IF NOT EXISTS idx_audit_logs_ts ON audit_logs(timestamp DESC);
    `);

    // Safe additive column migrations for existing v1.0/v1.1 SQLite databases
    const cols = this.db.prepare('PRAGMA table_info(instances)').all() as Array<{ name: string }>;
    const colNames = new Set(cols.map((c) => c.name));
    if (!colNames.has('external_dir')) {
      this.db.exec('ALTER TABLE instances ADD COLUMN external_dir TEXT;');
    }
    if (!colNames.has('launch_script')) {
      this.db.exec('ALTER TABLE instances ADD COLUMN launch_script TEXT;');
    }
  }

  close(): void {
    this.db.close();
  }

  // --- Users ---

  countUsers(): number {
    const row = this.db.prepare('SELECT COUNT(*) as count FROM users').get() as { count: number };
    return row.count;
  }

  findUserByUsername(username: string): UserRecord | null {
    const row = this.db
      .prepare('SELECT id, username, password_hash, role, created_at FROM users WHERE username = ?')
      .get(username) as Record<string, string> | undefined;
    if (!row) return null;
    return {
      id: row.id,
      username: row.username,
      passwordHash: row.password_hash,
      role: 'admin',
      createdAt: row.created_at,
    };
  }

  findUserById(id: string): UserRecord | null {
    const row = this.db
      .prepare('SELECT id, username, password_hash, role, created_at FROM users WHERE id = ?')
      .get(id) as Record<string, string> | undefined;
    if (!row) return null;
    return {
      id: row.id,
      username: row.username,
      passwordHash: row.password_hash,
      role: 'admin',
      createdAt: row.created_at,
    };
  }

  createUser(username: string, passwordHash: string): UserRecord {
    const user: UserRecord = {
      id: crypto.randomUUID(),
      username,
      passwordHash,
      role: 'admin',
      createdAt: new Date().toISOString(),
    };
    this.db
      .prepare('INSERT INTO users (id, username, password_hash, role, created_at) VALUES (?, ?, ?, ?, ?)')
      .run(user.id, user.username, user.passwordHash, user.role, user.createdAt);
    return user;
  }

  // --- Settings ---

  getSettings(defaultPublicHost = 'localhost'): SystemSettings {
    const row = this.db.prepare('SELECT value_json FROM settings WHERE key = ?').get('system') as
      | { value_json: string }
      | undefined;
    if (!row) {
      return SystemSettingsSchema.parse({ publicHost: defaultPublicHost });
    }
    try {
      return SystemSettingsSchema.parse(JSON.parse(row.value_json));
    } catch {
      return SystemSettingsSchema.parse({ publicHost: defaultPublicHost });
    }
  }

  saveSettings(patch: Partial<SystemSettings>, defaultPublicHost = 'localhost'): SystemSettings {
    const current = this.getSettings(defaultPublicHost);
    const merged = SystemSettingsSchema.parse({ ...current, ...patch });
    this.db
      .prepare(
        'INSERT INTO settings (key, value_json) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value_json = excluded.value_json'
      )
      .run('system', JSON.stringify(merged));
    return merged;
  }

  // --- Instances ---

  private mapInstanceRow(row: Record<string, unknown>): ServerInstance {
    return {
      id: String(row.id),
      slug: String(row.slug),
      name: String(row.name),
      gameId: String(row.game_id),
      runtime: String(row.runtime) as RuntimeKind,
      status: String(row.status) as InstanceStatus,
      ports: JSON.parse(String(row.ports_json)),
      config: JSON.parse(String(row.config_json)),
      memoryLimitMb: Number(row.memory_limit_mb),
      autoStart: Boolean(row.auto_start),
      discordEnabled: Boolean(row.discord_enabled),
      containerId: row.container_id ? String(row.container_id) : null,
      externalDir: row.external_dir ? String(row.external_dir) : null,
      launchScript: row.launch_script ? String(row.launch_script) : null,
      lastError: row.last_error ? String(row.last_error) : null,
      createdAt: String(row.created_at),
      updatedAt: String(row.updated_at),
      lastStartedAt: row.last_started_at ? String(row.last_started_at) : null,
    };
  }

  listInstances(): ServerInstance[] {
    const rows = this.db
      .prepare('SELECT * FROM instances ORDER BY created_at DESC')
      .all() as Record<string, unknown>[];
    return rows.map((r) => this.mapInstanceRow(r));
  }

  getInstanceById(id: string): ServerInstance | null {
    const row = this.db.prepare('SELECT * FROM instances WHERE id = ?').get(id) as
      | Record<string, unknown>
      | undefined;
    return row ? this.mapInstanceRow(row) : null;
  }

  getInstanceBySlugOrId(identifier: string): ServerInstance | null {
    const row = this.db
      .prepare('SELECT * FROM instances WHERE id = ? OR lower(slug) = lower(?) OR lower(name) = lower(?)')
      .get(identifier, identifier, identifier) as Record<string, unknown> | undefined;
    return row ? this.mapInstanceRow(row) : null;
  }

  createInstance(instance: ServerInstance): ServerInstance {
    this.db
      .prepare(
        `INSERT INTO instances (
          id, slug, name, game_id, runtime, status, ports_json, config_json,
          memory_limit_mb, auto_start, discord_enabled, container_id, external_dir,
          launch_script, last_error, created_at, updated_at, last_started_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .run(
        instance.id,
        instance.slug,
        instance.name,
        instance.gameId,
        instance.runtime,
        instance.status,
        JSON.stringify(instance.ports),
        JSON.stringify(instance.config),
        instance.memoryLimitMb,
        instance.autoStart ? 1 : 0,
        instance.discordEnabled ? 1 : 0,
        instance.containerId,
        instance.externalDir ?? null,
        instance.launchScript ?? null,
        instance.lastError,
        instance.createdAt,
        instance.updatedAt,
        instance.lastStartedAt
      );
    return instance;
  }

  updateInstance(
    id: string,
    patch: Partial<{
      name: string;
      runtime: RuntimeKind;
      status: InstanceStatus;
      ports: Record<string, number>;
      config: Record<string, string | number | boolean>;
      memoryLimitMb: number;
      autoStart: boolean;
      discordEnabled: boolean;
      containerId: string | null;
      externalDir: string | null;
      launchScript: string | null;
      lastError: string | null;
      lastStartedAt: string | null;
    }>
  ): ServerInstance | null {
    const existing = this.getInstanceById(id);
    if (!existing) return null;

    const updated: ServerInstance = {
      ...existing,
      ...patch,
      updatedAt: new Date().toISOString(),
    };

    this.db
      .prepare(
        `UPDATE instances SET
          name = ?, runtime = ?, status = ?, ports_json = ?, config_json = ?,
          memory_limit_mb = ?, auto_start = ?, discord_enabled = ?,
          container_id = ?, external_dir = ?, launch_script = ?,
          last_error = ?, updated_at = ?, last_started_at = ?
         WHERE id = ?`
      )
      .run(
        updated.name,
        updated.runtime,
        updated.status,
        JSON.stringify(updated.ports),
        JSON.stringify(updated.config),
        updated.memoryLimitMb,
        updated.autoStart ? 1 : 0,
        updated.discordEnabled ? 1 : 0,
        updated.containerId,
        updated.externalDir ?? null,
        updated.launchScript ?? null,
        updated.lastError,
        updated.updatedAt,
        updated.lastStartedAt,
        id
      );

    return updated;
  }

  deleteInstance(id: string): boolean {
    const result = this.db.prepare('DELETE FROM instances WHERE id = ?').run(id);
    return Number(result.changes) > 0;
  }

  // --- Leases ---

  private mapLeaseRow(row: Record<string, unknown>): ServerLease {
    return {
      id: String(row.id),
      instanceId: String(row.instance_id),
      requestedBy: String(row.requested_by),
      requestedById: row.requested_by_id ? String(row.requested_by_id) : null,
      source: String(row.source) as 'discord' | 'web',
      channelId: row.channel_id ? String(row.channel_id) : null,
      startedAt: String(row.started_at),
      expiresAt: String(row.expires_at),
      maxExpiresAt: String(row.max_expires_at),
      idleTimeoutMinutes: Number(row.idle_timeout_minutes),
      emptySince: row.empty_since ? String(row.empty_since) : null,
      warningSentAt: row.warning_sent_at ? String(row.warning_sent_at) : null,
      active: Boolean(row.active),
    };
  }

  createLease(lease: ServerLease): ServerLease {
    // Deactivate any previous active leases for this instance
    this.db.prepare('UPDATE leases SET active = 0 WHERE instance_id = ? AND active = 1').run(lease.instanceId);
    this.db
      .prepare(
        `INSERT INTO leases (
          id, instance_id, requested_by, requested_by_id, source, channel_id,
          started_at, expires_at, max_expires_at, idle_timeout_minutes,
          empty_since, warning_sent_at, active
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .run(
        lease.id,
        lease.instanceId,
        lease.requestedBy,
        lease.requestedById,
        lease.source,
        lease.channelId,
        lease.startedAt,
        lease.expiresAt,
        lease.maxExpiresAt,
        lease.idleTimeoutMinutes,
        lease.emptySince,
        lease.warningSentAt,
        lease.active ? 1 : 0
      );
    return lease;
  }

  getActiveLeaseForInstance(instanceId: string): ServerLease | null {
    const row = this.db
      .prepare('SELECT * FROM leases WHERE instance_id = ? AND active = 1 ORDER BY started_at DESC LIMIT 1')
      .get(instanceId) as Record<string, unknown> | undefined;
    return row ? this.mapLeaseRow(row) : null;
  }

  listActiveLeases(): ServerLease[] {
    const rows = this.db
      .prepare('SELECT * FROM leases WHERE active = 1 ORDER BY expires_at ASC')
      .all() as Record<string, unknown>[];
    return rows.map((r) => this.mapLeaseRow(r));
  }

  getLeaseById(id: string): ServerLease | null {
    const row = this.db.prepare('SELECT * FROM leases WHERE id = ?').get(id) as
      | Record<string, unknown>
      | undefined;
    return row ? this.mapLeaseRow(row) : null;
  }

  updateLease(
    id: string,
    patch: Partial<{
      expiresAt: string;
      emptySince: string | null;
      warningSentAt: string | null;
      active: boolean;
    }>
  ): ServerLease | null {
    const existing = this.getLeaseById(id);
    if (!existing) return null;
    const updated: ServerLease = { ...existing, ...patch };
    this.db
      .prepare(
        'UPDATE leases SET expires_at = ?, empty_since = ?, warning_sent_at = ?, active = ? WHERE id = ?'
      )
      .run(
        updated.expiresAt,
        updated.emptySince,
        updated.warningSentAt,
        updated.active ? 1 : 0,
        id
      );
    return updated;
  }

  deactivateLeasesForInstance(instanceId: string): void {
    this.db.prepare('UPDATE leases SET active = 0 WHERE instance_id = ? AND active = 1').run(instanceId);
  }

  // --- Backups ---

  createBackupRecord(record: BackupRecord): BackupRecord {
    this.db
      .prepare(
        'INSERT INTO backups (id, instance_id, filename, size_bytes, created_at, note) VALUES (?, ?, ?, ?, ?, ?)'
      )
      .run(record.id, record.instanceId, record.filename, record.sizeBytes, record.createdAt, record.note);
    return record;
  }

  listBackups(instanceId: string): BackupRecord[] {
    const rows = this.db
      .prepare('SELECT * FROM backups WHERE instance_id = ? ORDER BY created_at DESC')
      .all(instanceId) as Record<string, unknown>[];
    return rows.map((r) => ({
      id: String(r.id),
      instanceId: String(r.instance_id),
      filename: String(r.filename),
      sizeBytes: Number(r.size_bytes),
      createdAt: String(r.created_at),
      note: r.note ? String(r.note) : null,
    }));
  }

  deleteBackupRecord(id: string): boolean {
    const res = this.db.prepare('DELETE FROM backups WHERE id = ?').run(id);
    return Number(res.changes) > 0;
  }

  // --- Audit Logs ---

  addAuditLog(entry: Omit<AuditLogEntry, 'id' | 'timestamp'>): AuditLogEntry {
    const record: AuditLogEntry = {
      id: crypto.randomUUID(),
      timestamp: new Date().toISOString(),
      ...entry,
    };
    this.db
      .prepare(
        'INSERT INTO audit_logs (id, timestamp, actor, source, action, instance_id, details) VALUES (?, ?, ?, ?, ?, ?, ?)'
      )
      .run(
        record.id,
        record.timestamp,
        record.actor,
        record.source,
        record.action,
        record.instanceId,
        record.details
      );
    return record;
  }

  listAuditLogs(limit = 100): AuditLogEntry[] {
    const rows = this.db
      .prepare('SELECT * FROM audit_logs ORDER BY timestamp DESC LIMIT ?')
      .all(limit) as Record<string, unknown>[];
    return rows.map((r) => ({
      id: String(r.id),
      timestamp: String(r.timestamp),
      actor: String(r.actor),
      source: String(r.source) as 'web' | 'discord' | 'system',
      action: String(r.action),
      instanceId: r.instance_id ? String(r.instance_id) : null,
      details: r.details ? String(r.details) : null,
    }));
  }
}
