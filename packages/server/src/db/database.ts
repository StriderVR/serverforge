import { DatabaseSync } from 'node:sqlite';
import crypto from 'node:crypto';
import type {
  AuditLogEntry,
  BackupPolicy,
  BackupRecord,
  CrashSummary,
  InstanceStatus,
  RuntimeKind,
  ServerInstance,
  ServerLease,
  SystemSettings,
  UpnpMappingRecord,
  UpnpMode,
  UpnpProtocolKind,
} from '@serverforge/shared';
import { BackupPolicySchema, SystemSettingsSchema } from '@serverforge/shared';
import type { SecretVault } from '../services/secret-vault.js';

export interface UserRecord {
  id: string;
  username: string;
  passwordHash: string;
  role: 'admin';
  createdAt: string;
  totpSecret: string | null;
  totpEnabled: boolean;
  recoveryCodes: string[];
}

export interface SessionRecord {
  id: string;
  userId: string;
  ip: string;
  userAgent: string;
  createdAt: string;
  lastSeenAt: string;
  expiresAt: string;
  revoked: boolean;
}

export class AppDatabase {
  public readonly db: DatabaseSync;
  private secretVault: SecretVault | null = null;

  constructor(dbPath: string, secretVault?: SecretVault) {
    this.db = new DatabaseSync(dbPath);
    this.secretVault = secretVault ?? null;
    this.db.exec('PRAGMA journal_mode = WAL;');
    this.db.exec('PRAGMA foreign_keys = ON;');
    this.migrate();
    if (this.secretVault) {
      this.migratePlaintextSecrets();
    }
  }

  attachSecretVault(vault: SecretVault): { migratedSettings: boolean; migratedInstances: number } {
    this.secretVault = vault;
    return this.migratePlaintextSecrets();
  }

  migratePlaintextSecrets(): { migratedSettings: boolean; migratedInstances: number } {
    if (!this.secretVault) {
      return { migratedSettings: false, migratedInstances: 0 };
    }
    let migratedSettings = false;
    const settingsRow = this.db.prepare('SELECT value_json FROM settings WHERE key = ?').get('system') as
      | { value_json: string }
      | undefined;
    if (settingsRow) {
      try {
        const rawObj = JSON.parse(settingsRow.value_json) as Record<string, unknown>;
        const { decrypted, needsMigration } = this.secretVault.decryptSettingsObject(rawObj);
        if (needsMigration) {
          const parsed = SystemSettingsSchema.parse(decrypted);
          const encrypted = this.secretVault.encryptSettingsObject(parsed);
          this.db
            .prepare('UPDATE settings SET value_json = ? WHERE key = ?')
            .run(JSON.stringify(encrypted), 'system');
          migratedSettings = true;
        }
      } catch {
        // ignore malformed row; getSettings handles fallback
      }
    }

    let migratedInstances = 0;
    const instanceRows = this.db.prepare('SELECT id, slug, config_json FROM instances').all() as Array<{
      id: string;
      slug: string;
      config_json: string;
    }>;
    for (const row of instanceRows) {
      try {
        const rawConfig = JSON.parse(row.config_json) as Record<string, string | number | boolean>;
        const { decrypted, needsMigration } = this.secretVault.decryptInstanceConfig(rawConfig, row.slug);
        if (needsMigration) {
          const encrypted = this.secretVault.encryptInstanceConfig(decrypted, row.slug);
          this.db
            .prepare('UPDATE instances SET config_json = ? WHERE id = ?')
            .run(JSON.stringify(encrypted), row.id);
          migratedInstances += 1;
        }
      } catch {
        // ignore malformed config_json
      }
    }

    return { migratedSettings, migratedInstances };
  }

  private migrate(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS users (
        id TEXT PRIMARY KEY,
        username TEXT UNIQUE NOT NULL,
        password_hash TEXT NOT NULL,
        role TEXT NOT NULL DEFAULT 'admin',
        created_at TEXT NOT NULL,
        totp_secret TEXT,
        totp_enabled INTEGER NOT NULL DEFAULT 0,
        recovery_codes_json TEXT
      );

      CREATE TABLE IF NOT EXISTS sessions (
        id TEXT PRIMARY KEY,
        user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        ip TEXT NOT NULL DEFAULT '',
        user_agent TEXT NOT NULL DEFAULT '',
        created_at TEXT NOT NULL,
        last_seen_at TEXT NOT NULL,
        expires_at TEXT NOT NULL,
        revoked INTEGER NOT NULL DEFAULT 0
      );

      CREATE INDEX IF NOT EXISTS idx_sessions_user ON sessions(user_id, revoked);

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
        auto_restart_on_crash INTEGER NOT NULL DEFAULT 1,
        discord_enabled INTEGER NOT NULL DEFAULT 1,
        container_id TEXT,
        external_dir TEXT,
        launch_script TEXT,
        last_error TEXT,
        last_crash_json TEXT,
        backup_policy_json TEXT,
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

      CREATE TABLE IF NOT EXISTS upnp_mappings (
        id TEXT PRIMARY KEY,
        instance_id TEXT NOT NULL,
        external_port INTEGER NOT NULL,
        internal_port INTEGER NOT NULL,
        protocol TEXT NOT NULL,
        internal_client TEXT NOT NULL,
        description TEXT NOT NULL,
        lease_duration_seconds INTEGER NOT NULL,
        protocol_used TEXT NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );

      CREATE INDEX IF NOT EXISTS idx_upnp_mappings_inst ON upnp_mappings(instance_id);
    `);

    // Safe additive column migrations for existing SQLite databases
    const userCols = this.db.prepare('PRAGMA table_info(users)').all() as Array<{ name: string }>;
    const userColNames = new Set(userCols.map((c) => c.name));
    if (!userColNames.has('totp_secret')) {
      this.db.exec('ALTER TABLE users ADD COLUMN totp_secret TEXT;');
    }
    if (!userColNames.has('totp_enabled')) {
      this.db.exec('ALTER TABLE users ADD COLUMN totp_enabled INTEGER NOT NULL DEFAULT 0;');
    }
    if (!userColNames.has('recovery_codes_json')) {
      this.db.exec('ALTER TABLE users ADD COLUMN recovery_codes_json TEXT;');
    }

    const cols = this.db.prepare('PRAGMA table_info(instances)').all() as Array<{ name: string }>;
    const colNames = new Set(cols.map((c) => c.name));
    if (!colNames.has('external_dir')) {
      this.db.exec('ALTER TABLE instances ADD COLUMN external_dir TEXT;');
    }
    if (!colNames.has('launch_script')) {
      this.db.exec('ALTER TABLE instances ADD COLUMN launch_script TEXT;');
    }
    if (!colNames.has('auto_restart_on_crash')) {
      this.db.exec('ALTER TABLE instances ADD COLUMN auto_restart_on_crash INTEGER NOT NULL DEFAULT 1;');
    }
    if (!colNames.has('last_crash_json')) {
      this.db.exec('ALTER TABLE instances ADD COLUMN last_crash_json TEXT;');
    }
    if (!colNames.has('backup_policy_json')) {
      this.db.exec('ALTER TABLE instances ADD COLUMN backup_policy_json TEXT;');
    }
    if (!colNames.has('upnp_mode')) {
      this.db.exec("ALTER TABLE instances ADD COLUMN upnp_mode TEXT NOT NULL DEFAULT 'inherit';");
    }
  }

  close(): void {
    this.db.close();
  }

  // --- Users & Sessions ---

  private mapUserRow(row: Record<string, unknown>): UserRecord {
    let recoveryCodes: string[] = [];
    if (row.recovery_codes_json) {
      try {
        const parsed = JSON.parse(String(row.recovery_codes_json));
        if (Array.isArray(parsed)) {
          recoveryCodes = parsed.filter((v): v is string => typeof v === 'string');
        }
      } catch {
        recoveryCodes = [];
      }
    }
    return {
      id: String(row.id),
      username: String(row.username),
      passwordHash: String(row.password_hash),
      role: 'admin',
      createdAt: String(row.created_at),
      totpSecret: row.totp_secret ? String(row.totp_secret) : null,
      totpEnabled: Boolean(row.totp_enabled),
      recoveryCodes,
    };
  }

  private mapSessionRow(row: Record<string, unknown>): SessionRecord {
    return {
      id: String(row.id),
      userId: String(row.user_id),
      ip: String(row.ip ?? ''),
      userAgent: String(row.user_agent ?? ''),
      createdAt: String(row.created_at),
      lastSeenAt: String(row.last_seen_at),
      expiresAt: String(row.expires_at),
      revoked: Boolean(row.revoked),
    };
  }

  countUsers(): number {
    const row = this.db.prepare('SELECT COUNT(*) as count FROM users').get() as { count: number };
    return row.count;
  }

  findUserByUsername(username: string): UserRecord | null {
    const row = this.db
      .prepare(
        'SELECT id, username, password_hash, role, created_at, totp_secret, totp_enabled, recovery_codes_json FROM users WHERE username = ?'
      )
      .get(username) as Record<string, unknown> | undefined;
    if (!row) return null;
    return this.mapUserRow(row);
  }

  findUserById(id: string): UserRecord | null {
    const row = this.db
      .prepare(
        'SELECT id, username, password_hash, role, created_at, totp_secret, totp_enabled, recovery_codes_json FROM users WHERE id = ?'
      )
      .get(id) as Record<string, unknown> | undefined;
    if (!row) return null;
    return this.mapUserRow(row);
  }

  createUser(username: string, passwordHash: string): UserRecord {
    const user: UserRecord = {
      id: crypto.randomUUID(),
      username,
      passwordHash,
      role: 'admin',
      createdAt: new Date().toISOString(),
      totpSecret: null,
      totpEnabled: false,
      recoveryCodes: [],
    };
    this.db
      .prepare(
        'INSERT INTO users (id, username, password_hash, role, created_at, totp_secret, totp_enabled, recovery_codes_json) VALUES (?, ?, ?, ?, ?, NULL, 0, NULL)'
      )
      .run(user.id, user.username, user.passwordHash, user.role, user.createdAt);
    return user;
  }

  updateUserPassword(userId: string, passwordHash: string): void {
    this.db.prepare('UPDATE users SET password_hash = ? WHERE id = ?').run(passwordHash, userId);
  }

  updateUserTotp(
    userId: string,
    totpSecret: string | null,
    totpEnabled: boolean,
    recoveryCodes: string[]
  ): void {
    this.db
      .prepare('UPDATE users SET totp_secret = ?, totp_enabled = ?, recovery_codes_json = ? WHERE id = ?')
      .run(totpSecret, totpEnabled ? 1 : 0, JSON.stringify(recoveryCodes), userId);
  }

  createSession(input: {
    userId: string;
    ip: string;
    userAgent: string;
    expiresAt: string;
  }): SessionRecord {
    const now = new Date().toISOString();
    const session: SessionRecord = {
      id: crypto.randomUUID(),
      userId: input.userId,
      ip: input.ip,
      userAgent: input.userAgent.slice(0, 240),
      createdAt: now,
      lastSeenAt: now,
      expiresAt: input.expiresAt,
      revoked: false,
    };
    this.db
      .prepare(
        'INSERT INTO sessions (id, user_id, ip, user_agent, created_at, last_seen_at, expires_at, revoked) VALUES (?, ?, ?, ?, ?, ?, ?, 0)'
      )
      .run(
        session.id,
        session.userId,
        session.ip,
        session.userAgent,
        session.createdAt,
        session.lastSeenAt,
        session.expiresAt
      );
    return session;
  }

  getSessionById(sessionId: string): SessionRecord | null {
    const row = this.db
      .prepare(
        'SELECT id, user_id, ip, user_agent, created_at, last_seen_at, expires_at, revoked FROM sessions WHERE id = ?'
      )
      .get(sessionId) as Record<string, unknown> | undefined;
    return row ? this.mapSessionRow(row) : null;
  }

  listActiveSessions(userId: string): SessionRecord[] {
    const nowIso = new Date().toISOString();
    const rows = this.db
      .prepare(
        'SELECT id, user_id, ip, user_agent, created_at, last_seen_at, expires_at, revoked FROM sessions WHERE user_id = ? AND revoked = 0 AND expires_at > ? ORDER BY last_seen_at DESC'
      )
      .all(userId, nowIso) as Array<Record<string, unknown>>;
    return rows.map((r) => this.mapSessionRow(r));
  }

  touchSession(sessionId: string, nowIso = new Date().toISOString()): void {
    this.db.prepare('UPDATE sessions SET last_seen_at = ? WHERE id = ?').run(nowIso, sessionId);
  }

  revokeSession(sessionId: string, userId?: string): boolean {
    const res = userId
      ? this.db.prepare('UPDATE sessions SET revoked = 1 WHERE id = ? AND user_id = ?').run(sessionId, userId)
      : this.db.prepare('UPDATE sessions SET revoked = 1 WHERE id = ?').run(sessionId);
    return Number(res.changes ?? 0) > 0;
  }

  revokeAllSessionsForUser(userId: string, exceptSessionId?: string): number {
    const res = exceptSessionId
      ? this.db
          .prepare('UPDATE sessions SET revoked = 1 WHERE user_id = ? AND revoked = 0 AND id != ?')
          .run(userId, exceptSessionId)
      : this.db.prepare('UPDATE sessions SET revoked = 1 WHERE user_id = ? AND revoked = 0').run(userId);
    return Number(res.changes ?? 0);
  }

  hasSeenUserIp(userId: string, ip: string): boolean {
    const trimmed = ip.trim();
    if (!trimmed) return true;
    const row = this.db
      .prepare('SELECT 1 as found FROM sessions WHERE user_id = ? AND ip = ? LIMIT 1')
      .get(userId, trimmed) as { found?: number } | undefined;
    return Boolean(row?.found);
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
      const rawObj = JSON.parse(row.value_json) as Record<string, unknown>;
      const decryptedObj = this.secretVault
        ? this.secretVault.decryptSettingsObject(rawObj).decrypted
        : rawObj;
      const parsed = SystemSettingsSchema.parse(decryptedObj);
      const trimmedDefault = defaultPublicHost.trim();
      if (
        (!parsed.publicHost.trim() || parsed.publicHost.trim().toLowerCase() === 'localhost') &&
        trimmedDefault &&
        trimmedDefault.toLowerCase() !== 'localhost'
      ) {
        return { ...parsed, publicHost: trimmedDefault };
      }
      return parsed;
    } catch {
      return SystemSettingsSchema.parse({ publicHost: defaultPublicHost });
    }
  }

  saveSettings(patch: Partial<SystemSettings>, defaultPublicHost = 'localhost'): SystemSettings {
    const current = this.getSettings(defaultPublicHost);
    const merged = SystemSettingsSchema.parse({ ...current, ...patch });
    const toStore = this.secretVault ? this.secretVault.encryptSettingsObject(merged) : merged;
    this.db
      .prepare(
        'INSERT INTO settings (key, value_json) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value_json = excluded.value_json'
      )
      .run('system', JSON.stringify(toStore));
    return merged;
  }

  // --- Instances ---

  private mapInstanceRow(row: Record<string, unknown>): ServerInstance {
    let lastCrash: CrashSummary | null = null;
    if (row.last_crash_json) {
      try {
        lastCrash = JSON.parse(String(row.last_crash_json)) as CrashSummary;
      } catch {
        lastCrash = null;
      }
    }
    let backupPolicy: BackupPolicy = BackupPolicySchema.parse({});
    if (row.backup_policy_json) {
      try {
        backupPolicy = BackupPolicySchema.parse(JSON.parse(String(row.backup_policy_json)));
      } catch {
        backupPolicy = BackupPolicySchema.parse({});
      }
    }

    const rawConfig = JSON.parse(String(row.config_json)) as Record<string, string | number | boolean>;
    const config = this.secretVault
      ? this.secretVault.decryptInstanceConfig(rawConfig, String(row.slug)).decrypted
      : rawConfig;

    return {
      id: String(row.id),
      slug: String(row.slug),
      name: String(row.name),
      gameId: String(row.game_id),
      runtime: String(row.runtime) as RuntimeKind,
      status: String(row.status) as InstanceStatus,
      ports: JSON.parse(String(row.ports_json)),
      config,
      memoryLimitMb: Number(row.memory_limit_mb),
      autoStart: Boolean(row.auto_start),
      autoRestartOnCrash: row.auto_restart_on_crash === undefined ? true : Boolean(row.auto_restart_on_crash),
      discordEnabled: Boolean(row.discord_enabled),
      upnpMode: (row.upnp_mode ? String(row.upnp_mode) : 'inherit') as UpnpMode,
      containerId: row.container_id ? String(row.container_id) : null,
      externalDir: row.external_dir ? String(row.external_dir) : null,
      launchScript: row.launch_script ? String(row.launch_script) : null,
      lastError: row.last_error ? String(row.last_error) : null,
      lastCrash,
      backupPolicy,
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
    const policy = BackupPolicySchema.parse(instance.backupPolicy ?? {});
    const upnpMode: UpnpMode = instance.upnpMode ?? 'inherit';
    const storedConfig = this.secretVault
      ? this.secretVault.encryptInstanceConfig(instance.config, instance.slug)
      : instance.config;
    this.db
      .prepare(
        `INSERT INTO instances (
          id, slug, name, game_id, runtime, status, ports_json, config_json,
          memory_limit_mb, auto_start, auto_restart_on_crash, discord_enabled, upnp_mode,
          container_id, external_dir, launch_script, last_error, last_crash_json,
          backup_policy_json, created_at, updated_at, last_started_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .run(
        instance.id,
        instance.slug,
        instance.name,
        instance.gameId,
        instance.runtime,
        instance.status,
        JSON.stringify(instance.ports),
        JSON.stringify(storedConfig),
        instance.memoryLimitMb,
        instance.autoStart ? 1 : 0,
        instance.autoRestartOnCrash === false ? 0 : 1,
        instance.discordEnabled ? 1 : 0,
        upnpMode,
        instance.containerId,
        instance.externalDir ?? null,
        instance.launchScript ?? null,
        instance.lastError,
        instance.lastCrash ? JSON.stringify(instance.lastCrash) : null,
        JSON.stringify(policy),
        instance.createdAt,
        instance.updatedAt,
        instance.lastStartedAt
      );
    return {
      ...instance,
      autoRestartOnCrash: instance.autoRestartOnCrash === false ? false : true,
      upnpMode,
      lastCrash: instance.lastCrash ?? null,
      backupPolicy: policy,
    };
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
      autoRestartOnCrash: boolean;
      discordEnabled: boolean;
      upnpMode: UpnpMode;
      containerId: string | null;
      externalDir: string | null;
      launchScript: string | null;
      lastError: string | null;
      lastCrash: CrashSummary | null;
      backupPolicy: BackupPolicy;
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

    const policy = BackupPolicySchema.parse(updated.backupPolicy ?? {});
    updated.backupPolicy = policy;
    updated.upnpMode = updated.upnpMode ?? 'inherit';

    const storedConfig = this.secretVault
      ? this.secretVault.encryptInstanceConfig(updated.config, updated.slug)
      : updated.config;

    this.db
      .prepare(
        `UPDATE instances SET
          name = ?, runtime = ?, status = ?, ports_json = ?, config_json = ?,
          memory_limit_mb = ?, auto_start = ?, auto_restart_on_crash = ?, discord_enabled = ?,
          upnp_mode = ?, container_id = ?, external_dir = ?, launch_script = ?,
          last_error = ?, last_crash_json = ?, backup_policy_json = ?,
          updated_at = ?, last_started_at = ?
         WHERE id = ?`
      )
      .run(
        updated.name,
        updated.runtime,
        updated.status,
        JSON.stringify(updated.ports),
        JSON.stringify(storedConfig),
        updated.memoryLimitMb,
        updated.autoStart ? 1 : 0,
        updated.autoRestartOnCrash === false ? 0 : 1,
        updated.discordEnabled ? 1 : 0,
        updated.upnpMode,
        updated.containerId,
        updated.externalDir ?? null,
        updated.launchScript ?? null,
        updated.lastError,
        updated.lastCrash ? JSON.stringify(updated.lastCrash) : null,
        JSON.stringify(policy),
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

  getBackupById(id: string): BackupRecord | null {
    const r = this.db.prepare('SELECT * FROM backups WHERE id = ?').get(id) as Record<string, unknown> | undefined;
    if (!r) return null;
    return {
      id: String(r.id),
      instanceId: String(r.instance_id),
      filename: String(r.filename),
      sizeBytes: Number(r.size_bytes),
      createdAt: String(r.created_at),
      note: r.note ? String(r.note) : null,
    };
  }

  deleteBackupRecord(id: string): boolean {
    const res = this.db.prepare('DELETE FROM backups WHERE id = ?').run(id);
    return Number(res.changes) > 0;
  }

  // --- Audit Logs ---

  addAuditLog(
    entry: Omit<AuditLogEntry, 'id' | 'timestamp' | 'instanceId' | 'details'> & {
      instanceId?: string | null;
      details?: string | null;
    }
  ): AuditLogEntry {
    const record: AuditLogEntry = {
      id: crypto.randomUUID(),
      timestamp: new Date().toISOString(),
      actor: entry.actor,
      source: entry.source,
      action: entry.action,
      instanceId: entry.instanceId ?? null,
      details: entry.details ?? null,
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

  // --- UPnP Mappings (Crash-Recovery Tracking) ---

  private mapUpnpRow(r: Record<string, unknown>): UpnpMappingRecord {
    return {
      id: String(r.id),
      instanceId: String(r.instance_id),
      externalPort: Number(r.external_port),
      internalPort: Number(r.internal_port),
      protocol: String(r.protocol) as 'TCP' | 'UDP',
      internalClient: String(r.internal_client),
      description: String(r.description),
      leaseDurationSeconds: Number(r.lease_duration_seconds),
      protocolUsed: String(r.protocol_used) as UpnpProtocolKind,
      createdAt: String(r.created_at),
      updatedAt: String(r.updated_at),
    };
  }

  listUpnpMappings(instanceId?: string): UpnpMappingRecord[] {
    const rows = instanceId
      ? (this.db
          .prepare('SELECT * FROM upnp_mappings WHERE instance_id = ? ORDER BY external_port ASC, protocol ASC')
          .all(instanceId) as Record<string, unknown>[])
      : (this.db
          .prepare('SELECT * FROM upnp_mappings ORDER BY instance_id ASC, external_port ASC, protocol ASC')
          .all() as Record<string, unknown>[]);
    return rows.map((r) => this.mapUpnpRow(r));
  }

  upsertUpnpMapping(
    entry: Omit<UpnpMappingRecord, 'id' | 'createdAt' | 'updatedAt'>
  ): UpnpMappingRecord {
    const now = new Date().toISOString();
    const id = `${entry.instanceId}:${entry.externalPort}:${entry.protocol}`;
    const existing = this.db.prepare('SELECT created_at FROM upnp_mappings WHERE id = ?').get(id) as
      | { created_at: string }
      | undefined;
    const createdAt = existing?.created_at ?? now;
    this.db
      .prepare(
        `INSERT INTO upnp_mappings (
          id, instance_id, external_port, internal_port, protocol, internal_client,
          description, lease_duration_seconds, protocol_used, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(id) DO UPDATE SET
          internal_port = excluded.internal_port,
          internal_client = excluded.internal_client,
          description = excluded.description,
          lease_duration_seconds = excluded.lease_duration_seconds,
          protocol_used = excluded.protocol_used,
          updated_at = excluded.updated_at`
      )
      .run(
        id,
        entry.instanceId,
        entry.externalPort,
        entry.internalPort,
        entry.protocol,
        entry.internalClient,
        entry.description,
        entry.leaseDurationSeconds,
        entry.protocolUsed,
        createdAt,
        now
      );
    return {
      id,
      ...entry,
      createdAt,
      updatedAt: now,
    };
  }

  deleteUpnpMapping(id: string): boolean {
    const res = this.db.prepare('DELETE FROM upnp_mappings WHERE id = ?').run(id);
    return Number(res.changes) > 0;
  }

  deleteUpnpMappingsForInstance(instanceId: string): number {
    const res = this.db.prepare('DELETE FROM upnp_mappings WHERE instance_id = ?').run(instanceId);
    return Number(res.changes);
  }
}
