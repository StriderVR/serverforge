import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { SECRET_MASK_SENTINEL } from '@serverforge/shared';
import { createServerForgeApp, type ServerForgeApp } from '../api/server.js';
import { AppDatabase } from '../db/database.js';
import { ENC_PREFIX, SecretVault } from '../services/secret-vault.js';

const tmpDirs: string[] = [];
const apps: ServerForgeApp[] = [];

function makeTmpDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sf-secret-vault-'));
  tmpDirs.push(dir);
  return dir;
}

afterEach(async () => {
  while (apps.length > 0) {
    await apps.pop()!.close();
  }
  while (tmpDirs.length > 0) {
    fs.rmSync(tmpDirs.pop()!, { recursive: true, force: true });
  }
});

describe('Secret Vault (AES-256-GCM + DPAPI) & Write-Only Masked API (#63)', () => {
  it('encrypts/decrypts with AES-256-GCM, uses unique IVs, and supports Windows DPAPI key protection', () => {
    const dir = makeTmpDir();
    let protectedBlob = '';
    const vault = new SecretVault({
      dataDir: dir,
      platform: 'win32',
      dpapiProtectImpl: (plainB64) => {
        protectedBlob = `DPAPI:${Buffer.from(plainB64, 'base64').toString('hex')}`;
        return protectedBlob;
      },
      dpapiUnprotectImpl: (blob) => {
        const hex = blob.replace(/^DPAPI:/, '');
        return Buffer.from(hex, 'hex').toString('base64');
      },
    });

    expect(vault.getStatus().keyProtection).toBe('dpapi');
    expect(fs.existsSync(path.join(dir, '.vault.key.dpapi'))).toBe(true);

    const enc1 = vault.encrypt('super-secret-token-1234');
    const enc2 = vault.encrypt('super-secret-token-1234');
    expect(enc1.startsWith(ENC_PREFIX)).toBe(true);
    expect(enc2.startsWith(ENC_PREFIX)).toBe(true);
    expect(enc1).not.toBe(enc2); // random 12-byte IV each time

    expect(vault.decrypt(enc1)).toEqual({ value: 'super-secret-token-1234', undecryptable: false });

    // Re-open with the same DPAPI unprotect -> decrypts identically
    const vault2 = new SecretVault({
      dataDir: dir,
      platform: 'win32',
      dpapiProtectImpl: () => protectedBlob,
      dpapiUnprotectImpl: (blob) => Buffer.from(blob.replace(/^DPAPI:/, ''), 'hex').toString('base64'),
    });
    expect(vault2.decrypt(enc1)).toEqual({ value: 'super-secret-token-1234', undecryptable: false });
  });

  it('migrates legacy plaintext secrets in SQLite and handles undecryptable key rotation gracefully', async () => {
    const dir = makeTmpDir();
    const dbPath = path.join(dir, 'serverforge.sqlite');

    // Step 1: Seed a legacy unencrypted SQLite database (no SecretVault)
    const legacyDb = new AppDatabase(dbPath);
    legacyDb.saveSettings({
      discordBotToken: 'legacy-discord-secret-9876',
      duckdnsToken: 'legacy-duck-token-5555',
      curseforgeApiKey: '$2a$10$legacycurseforgekey1234567890',
    });
    legacyDb.createInstance({
      id: 'inst-legacy-1',
      slug: 'legacy-mc',
      name: 'Legacy MC',
      gameId: 'minecraft-java',
      runtime: 'native',
      status: 'stopped',
      ports: { game: 25565 },
      config: { MOTD: 'Hello', RCON_PASSWORD: 'legacy-rcon-password' },
      memoryLimitMb: 4096,
      autoStart: false,
      autoRestartOnCrash: true,
      discordEnabled: true,
      upnpMode: 'inherit',
      containerId: null,
      externalDir: null,
      launchScript: null,
      lastError: null,
      lastCrash: null,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      lastStartedAt: null,
    });
    legacyDb.close();

    // Step 2: Boot ServerForge with SecretVault -> automatically encrypts plaintext in SQLite
    const sf1 = await createServerForgeApp({
      dataDir: dir,
      dbPath,
      runtimeMode: 'mock',
      publicHost: '127.0.0.1',
    });
    apps.push(sf1);

    // Inspect raw SQLite rows directly: plaintext must NOT appear on disk
    const rawSettingsRow = sf1.db.db.prepare('SELECT value_json FROM settings WHERE key = ?').get('system') as {
      value_json: string;
    };
    expect(rawSettingsRow.value_json).not.toContain('legacy-discord-secret-9876');
    expect(rawSettingsRow.value_json).not.toContain('legacy-duck-token-5555');
    expect(rawSettingsRow.value_json).not.toContain('legacycurseforgekey');
    expect(rawSettingsRow.value_json).toContain(ENC_PREFIX);

    const rawInstRow = sf1.db.db
      .prepare('SELECT config_json FROM instances WHERE id = ?')
      .get('inst-legacy-1') as { config_json: string };
    expect(rawInstRow.config_json).not.toContain('legacy-rcon-password');
    expect(rawInstRow.config_json).toContain(ENC_PREFIX);

    // Internal DB reads still return decrypted plaintext transparently
    const decryptedSettings = sf1.db.getSettings();
    expect(decryptedSettings.discordBotToken).toBe('legacy-discord-secret-9876');
    expect(decryptedSettings.duckdnsToken).toBe('legacy-duck-token-5555');
    expect(sf1.db.getInstanceById('inst-legacy-1')?.config.RCON_PASSWORD).toBe('legacy-rcon-password');

    await sf1.close();
    apps.pop();

    // Step 3: Simulate moving SQLite to another machine (delete .vault.key so a brand new key is generated)
    fs.unlinkSync(path.join(dir, '.vault.key'));

    const sf2 = await createServerForgeApp({
      dataDir: dir,
      dbPath,
      runtimeMode: 'mock',
      publicHost: '127.0.0.1',
    });
    apps.push(sf2);

    // Does not crash; reports undecryptable fields cleanly
    const recoveredSettings = sf2.db.getSettings();
    expect(recoveredSettings.discordBotToken).toBe('');
    const status = sf2.secretVault.getStatus();
    expect(status.undecryptableFields).toContain('settings.discordBotToken');
    expect(status.undecryptableFields).toContain('settings.duckdnsToken');
  });

  it('masks secrets in GET /api/settings & /api/instances* and preserves unchanged secrets on PUT/PATCH', async () => {
    const dir = makeTmpDir();
    const sf = await createServerForgeApp({
      dataDir: dir,
      runtimeMode: 'mock',
      publicHost: '127.0.0.1',
    });
    apps.push(sf);

    const { token } = sf.auth.setupInitialAdmin('admin', 'strong-password-123');
    const headers = { authorization: `Bearer ${token}` };

    // Save secrets via PUT /api/settings
    const put1 = await sf.app.inject({
      method: 'PUT',
      url: '/api/settings',
      headers,
      payload: {
        discordBotToken: 'MTEwOTg3NjU0MzIx.FakeToken.SecretPart9999',
        duckdnsToken: 'duck-secret-token-7777',
        curseforgeApiKey: '$2a$10$curseforge-secret-key-8888',
      },
    });
    expect(put1.statusCode).toBe(200);
    const putBody = put1.json();
    expect(putBody.discordBotToken).toBe('');
    expect(putBody.duckdnsToken).toBe('');
    expect(putBody.curseforgeApiKey).toBe('');
    expect(putBody.hasDiscordBotToken).toBe(true);
    expect(putBody.discordBotTokenPreview).toBe('••••••••9999');
    expect(putBody.hasDuckdnsToken).toBe(true);
    expect(putBody.duckdnsTokenPreview).toBe('••••••••7777');
    expect(putBody.hasCurseforgeApiKey).toBe(true);
    expect(putBody.curseforgeApiKeyPreview).toBe('••••••••8888');

    // GET /api/settings never leaks raw tokens
    const getRes = await sf.app.inject({ method: 'GET', url: '/api/settings', headers });
    expect(getRes.statusCode).toBe(200);
    expect(getRes.body).not.toContain('SecretPart9999');
    expect(getRes.body).not.toContain('duck-secret-token-7777');
    expect(getRes.body).not.toContain('curseforge-secret-key-8888');

    // Subsequent PUT with blank token strings (simulating normal Save Changes click) preserves stored secrets
    const getBody = getRes.json() as Record<string, unknown>;
    const put2 = await sf.app.inject({
      method: 'PUT',
      url: '/api/settings',
      headers,
      payload: {
        ...getBody,
        maxConcurrentServers: 3,
      },
    });
    expect(put2.statusCode).toBe(200);
    expect(sf.db.getSettings().duckdnsToken).toBe('duck-secret-token-7777');
    expect(sf.db.getSettings().discordBotToken).toBe('MTEwOTg3NjU0MzIx.FakeToken.SecretPart9999');

    // Explicit clear flag erases only the requested secret
    const putClear = await sf.app.inject({
      method: 'PUT',
      url: '/api/settings',
      headers,
      payload: { clearDuckdnsToken: true },
    });
    expect(putClear.statusCode).toBe(200);
    expect(putClear.json().hasDuckdnsToken).toBe(false);
    expect(sf.db.getSettings().duckdnsToken).toBe('');
    expect(sf.db.getSettings().discordBotToken).toBe('MTEwOTg3NjU0MzIx.FakeToken.SecretPart9999');

    // Instance API masks RCON_PASSWORD and preserves it when PATCH submits the mask sentinel
    const createRes = await sf.app.inject({
      method: 'POST',
      url: '/api/instances',
      headers,
      payload: {
        gameId: 'minecraft',
        name: 'Vault Test MC',
        runtime: 'native',
        config: { MOTD: 'Initial', RCON_PASSWORD: 'my-secret-rcon-value' },
      },
    });
    expect(createRes.statusCode).toBe(201);
    const created = createRes.json();
    expect(created.config.RCON_PASSWORD).toBe(SECRET_MASK_SENTINEL);
    expect(createRes.body).not.toContain('my-secret-rcon-value');

    // PATCH config changing MOTD while leaving masked RCON_PASSWORD preserves the real secret in DB
    const patchRes = await sf.app.inject({
      method: 'PATCH',
      url: `/api/instances/${created.id}/config`,
      headers,
      payload: {
        config: { MOTD: 'Updated MOTD', RCON_PASSWORD: SECRET_MASK_SENTINEL },
      },
    });
    expect(patchRes.statusCode).toBe(200);
    expect(patchRes.json().config.MOTD).toBe('Updated MOTD');
    expect(patchRes.json().config.RCON_PASSWORD).toBe(SECRET_MASK_SENTINEL);
    expect(sf.db.getInstanceById(created.id)?.config.RCON_PASSWORD).toBe('my-secret-rcon-value');
  });
});
