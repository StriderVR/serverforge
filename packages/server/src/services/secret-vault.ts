import { execFileSync } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import {
  SECRET_MASK_SENTINEL,
  type SecretVaultStatus,
  type SystemSettings,
  type SystemSettingsResponse,
} from '@serverforge/shared';

export const ENC_PREFIX = 'enc:v1:';
export const SENSITIVE_CONFIG_KEY_RE =
  /(password|passwd|secret|token|api[_-]?key|auth|cookie|credential|private[_-]?key)/i;

const SETTINGS_SECRET_FIELDS = [
  'discordBotToken',
  'duckdnsToken',
  'curseforgeApiKey',
  'githubIssueToken',
] as const;
type SettingsSecretField = (typeof SETTINGS_SECRET_FIELDS)[number];

export function isSensitiveConfigKey(key: string): boolean {
  return SENSITIVE_CONFIG_KEY_RE.test(key);
}

export function isEncryptedValue(value: string): boolean {
  return typeof value === 'string' && value.startsWith(ENC_PREFIX);
}

export function maskSecretPreview(plaintext: string): string {
  const trimmed = plaintext.trim();
  if (!trimmed) return '';
  if (trimmed.length <= 6) return SECRET_MASK_SENTINEL;
  return `${SECRET_MASK_SENTINEL}${trimmed.slice(-4)}`;
}

export interface SecretVaultOptions {
  dataDir: string;
  platform?: NodeJS.Platform;
  disableOsExec?: boolean;
  dpapiProtectImpl?: (plainKeyBase64: string) => string;
  dpapiUnprotectImpl?: (protectedBase64: string) => string;
}

function defaultDpapiProtect(plainKeyBase64: string): string {
  const script =
    "Add-Type -AssemblyName System.Security; " +
    "$bytes = [Convert]::FromBase64String($env:SF_VAULT_PAYLOAD); " +
    "$prot = [Security.Cryptography.ProtectedData]::Protect($bytes, $null, [Security.Cryptography.DataProtectionScope]::CurrentUser); " +
    "[Console]::Out.Write([Convert]::ToBase64String($prot))";
  const out = execFileSync(
    'powershell.exe',
    ['-NoProfile', '-NonInteractive', '-Command', script],
    {
      env: { ...process.env, SF_VAULT_PAYLOAD: plainKeyBase64 },
      encoding: 'utf8',
      timeout: 10_000,
      windowsHide: true,
    }
  );
  return out.trim();
}

function defaultDpapiUnprotect(protectedBase64: string): string {
  const script =
    "Add-Type -AssemblyName System.Security; " +
    "$bytes = [Convert]::FromBase64String($env:SF_VAULT_PAYLOAD); " +
    "$plain = [Security.Cryptography.ProtectedData]::Unprotect($bytes, $null, [Security.Cryptography.DataProtectionScope]::CurrentUser); " +
    "[Console]::Out.Write([Convert]::ToBase64String($plain))";
  const out = execFileSync(
    'powershell.exe',
    ['-NoProfile', '-NonInteractive', '-Command', script],
    {
      env: { ...process.env, SF_VAULT_PAYLOAD: protectedBase64 },
      encoding: 'utf8',
      timeout: 10_000,
      windowsHide: true,
    }
  );
  return out.trim();
}

export class SecretVault {
  private readonly masterKey: Buffer;
  private readonly keyProtection: 'dpapi' | 'keyfile';
  private readonly undecryptableFields = new Set<string>();

  constructor(options: SecretVaultOptions) {
    fs.mkdirSync(options.dataDir, { recursive: true });
    const platform = options.platform ?? process.platform;
    const useDpapi =
      platform === 'win32' &&
      (!options.disableOsExec || Boolean(options.dpapiProtectImpl && options.dpapiUnprotectImpl));

    if (useDpapi) {
      const protect = options.dpapiProtectImpl ?? defaultDpapiProtect;
      const unprotect = options.dpapiUnprotectImpl ?? defaultDpapiUnprotect;
      const dpapiPath = path.join(options.dataDir, '.vault.key.dpapi');
      const loaded = this.loadOrCreateDpapiKey(dpapiPath, protect, unprotect);
      if (loaded) {
        this.masterKey = loaded;
        this.keyProtection = 'dpapi';
        return;
      }
    }

    const keyfilePath = path.join(options.dataDir, '.vault.key');
    this.masterKey = this.loadOrCreateKeyfile(keyfilePath);
    this.keyProtection = 'keyfile';
  }

  private loadOrCreateDpapiKey(
    dpapiPath: string,
    protect: (plainB64: string) => string,
    unprotect: (protectedB64: string) => string
  ): Buffer | null {
    try {
      if (fs.existsSync(dpapiPath)) {
        const blob = fs.readFileSync(dpapiPath, 'utf8').trim();
        if (blob) {
          try {
            const plainB64 = unprotect(blob);
            const buf = Buffer.from(plainB64, 'base64');
            if (buf.length === 32) {
              return buf;
            }
          } catch {
            // Database + DPAPI key likely moved from another Windows machine/user.
            // Preserve the unreadable blob for debugging and rotate cleanly instead of crashing.
            try {
              fs.renameSync(dpapiPath, `${dpapiPath}.unreadable.${Date.now()}`);
            } catch {
              // ignore rename failure
            }
          }
        }
      }
      const fresh = crypto.randomBytes(32);
      const protectedBlob = protect(fresh.toString('base64'));
      fs.writeFileSync(dpapiPath, protectedBlob, { encoding: 'utf8', mode: 0o600 });
      return fresh;
    } catch {
      return null;
    }
  }

  private loadOrCreateKeyfile(keyfilePath: string): Buffer {
    if (fs.existsSync(keyfilePath)) {
      const raw = fs.readFileSync(keyfilePath, 'utf8').trim();
      const buf = Buffer.from(raw, 'base64');
      if (buf.length === 32) {
        return buf;
      }
    }
    const fresh = crypto.randomBytes(32);
    fs.writeFileSync(keyfilePath, fresh.toString('base64'), { encoding: 'utf8', mode: 0o600 });
    try {
      fs.chmodSync(keyfilePath, 0o600);
    } catch {
      // Windows NTFS ignores POSIX chmod; safe to ignore
    }
    return fresh;
  }

  encrypt(plaintext: string): string {
    if (!plaintext) return '';
    if (isEncryptedValue(plaintext)) return plaintext;
    const iv = crypto.randomBytes(12);
    const cipher = crypto.createCipheriv('aes-256-gcm', this.masterKey, iv);
    const encrypted = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
    const tag = cipher.getAuthTag();
    return `${ENC_PREFIX}${iv.toString('base64url')}:${tag.toString('base64url')}:${encrypted.toString('base64url')}`;
  }

  decrypt(stored: string, fieldLabel?: string): { value: string; undecryptable: boolean } {
    if (!stored) return { value: '', undecryptable: false };
    if (!isEncryptedValue(stored)) {
      return { value: stored, undecryptable: false };
    }

    const payload = stored.slice(ENC_PREFIX.length);
    const parts = payload.split(':');
    if (parts.length !== 3) {
      if (fieldLabel) this.undecryptableFields.add(fieldLabel);
      return { value: '', undecryptable: true };
    }

    try {
      const [ivB64, tagB64, ctB64] = parts;
      const iv = Buffer.from(ivB64, 'base64url');
      const tag = Buffer.from(tagB64, 'base64url');
      const ct = Buffer.from(ctB64, 'base64url');
      const decipher = crypto.createDecipheriv('aes-256-gcm', this.masterKey, iv);
      decipher.setAuthTag(tag);
      const plain = Buffer.concat([decipher.update(ct), decipher.final()]).toString('utf8');
      if (fieldLabel) this.undecryptableFields.delete(fieldLabel);
      return { value: plain, undecryptable: false };
    } catch {
      if (fieldLabel) this.undecryptableFields.add(fieldLabel);
      return { value: '', undecryptable: true };
    }
  }

  clearUndecryptableField(fieldLabel: string): void {
    this.undecryptableFields.delete(fieldLabel);
  }

  getStatus(): SecretVaultStatus {
    return {
      encrypted: true,
      keyProtection: this.keyProtection,
      undecryptableFields: [...this.undecryptableFields].sort(),
    };
  }

  encryptSettingsObject(settings: SystemSettings): Record<string, unknown> {
    const out: Record<string, unknown> = { ...settings };
    for (const field of SETTINGS_SECRET_FIELDS) {
      const val = settings[field];
      if (typeof val === 'string' && val.length > 0) {
        out[field] = this.encrypt(val);
        this.clearUndecryptableField(`settings.${field}`);
      } else {
        out[field] = '';
        this.clearUndecryptableField(`settings.${field}`);
      }
    }
    return out;
  }

  decryptSettingsObject(raw: Record<string, unknown>): {
    decrypted: Record<string, unknown>;
    needsMigration: boolean;
  } {
    const out: Record<string, unknown> = { ...raw };
    let needsMigration = false;
    for (const field of SETTINGS_SECRET_FIELDS) {
      const val = raw[field];
      if (typeof val === 'string' && val.length > 0) {
        if (!isEncryptedValue(val)) {
          needsMigration = true;
          out[field] = val;
        } else {
          const res = this.decrypt(val, `settings.${field}`);
          out[field] = res.value;
        }
      }
    }
    return { decrypted: out, needsMigration };
  }

  encryptInstanceConfig(
    config: Record<string, string | number | boolean>,
    instanceLabel?: string
  ): Record<string, string | number | boolean> {
    const out: Record<string, string | number | boolean> = {};
    for (const [k, v] of Object.entries(config)) {
      if (isSensitiveConfigKey(k) && typeof v === 'string' && v.length > 0) {
        out[k] = this.encrypt(v);
        if (instanceLabel) this.clearUndecryptableField(`instance.${instanceLabel}.${k}`);
      } else {
        out[k] = v;
        if (instanceLabel && isSensitiveConfigKey(k)) {
          this.clearUndecryptableField(`instance.${instanceLabel}.${k}`);
        }
      }
    }
    return out;
  }

  decryptInstanceConfig(
    config: Record<string, string | number | boolean>,
    instanceLabel?: string
  ): { decrypted: Record<string, string | number | boolean>; needsMigration: boolean } {
    const out: Record<string, string | number | boolean> = {};
    let needsMigration = false;
    for (const [k, v] of Object.entries(config)) {
      if (isSensitiveConfigKey(k) && typeof v === 'string' && v.length > 0) {
        if (!isEncryptedValue(v)) {
          needsMigration = true;
          out[k] = v;
        } else {
          const label = instanceLabel ? `instance.${instanceLabel}.${k}` : `instance.${k}`;
          const res = this.decrypt(v, label);
          out[k] = res.value;
        }
      } else {
        out[k] = v;
      }
    }
    return { decrypted: out, needsMigration };
  }

  sanitizeSettingsForApi(settings: SystemSettings): SystemSettingsResponse {
    const mapField = (field: SettingsSecretField) => {
      const raw = (settings[field] ?? '').trim();
      return {
        has: raw.length > 0,
        preview: maskSecretPreview(raw),
      };
    };

    const discord = mapField('discordBotToken');
    const duck = mapField('duckdnsToken');
    const cf = mapField('curseforgeApiKey');
    const gh = mapField('githubIssueToken');

    return {
      ...settings,
      discordBotToken: '',
      duckdnsToken: '',
      curseforgeApiKey: '',
      githubIssueToken: '',
      hasDiscordBotToken: discord.has,
      discordBotTokenPreview: discord.preview,
      hasDuckdnsToken: duck.has,
      duckdnsTokenPreview: duck.preview,
      hasCurseforgeApiKey: cf.has,
      curseforgeApiKeyPreview: cf.preview,
      hasGithubIssueToken: gh.has,
      githubIssueTokenPreview: gh.preview,
      secretVaultStatus: this.getStatus(),
    };
  }

  sanitizeInstanceConfigForApi(
    config: Record<string, string | number | boolean>
  ): Record<string, string | number | boolean> {
    const out: Record<string, string | number | boolean> = {};
    for (const [k, v] of Object.entries(config)) {
      if (isSensitiveConfigKey(k) && typeof v === 'string' && v.trim().length > 0) {
        out[k] = SECRET_MASK_SENTINEL;
      } else {
        out[k] = v;
      }
    }
    return out;
  }

  mergeIncomingInstanceConfig(
    existing: Record<string, string | number | boolean>,
    incoming: Record<string, string | number | boolean>
  ): Record<string, string | number | boolean> {
    const merged: Record<string, string | number | boolean> = {};
    for (const [k, v] of Object.entries(incoming)) {
      if (isSensitiveConfigKey(k) && v === SECRET_MASK_SENTINEL && existing[k] !== undefined) {
        merged[k] = existing[k];
      } else {
        merged[k] = v;
      }
    }
    return merged;
  }
}
