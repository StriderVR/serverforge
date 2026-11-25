import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import dotenv from 'dotenv';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Workspace root is three levels up from packages/server/src (or dist)
export const WORKSPACE_ROOT = path.resolve(__dirname, '../../..');

dotenv.config({ path: path.join(WORKSPACE_ROOT, '.env') });

export type RuntimeMode = 'auto' | 'docker' | 'native' | 'mock';

export interface AppConfig {
  port: number;
  host: string;
  publicHost: string;
  runtimeMode: RuntimeMode;
  dataDir: string;
  catalogDir: string;
  customCatalogDir: string;
  instancesDir: string;
  backupsDir: string;
  toolsDir: string;
  webDistDir: string;
  dbPath: string;
  jwtSecret: string;
  discordToken: string;
  discordClientId: string;
  discordGuildId: string;
}

function loadOrCreateJwtSecret(dataDir: string): string {
  if (process.env.JWT_SECRET && process.env.JWT_SECRET.trim().length >= 16) {
    return process.env.JWT_SECRET.trim();
  }
  fs.mkdirSync(dataDir, { recursive: true });
  const secretPath = path.join(dataDir, '.jwt-secret');
  if (fs.existsSync(secretPath)) {
    return fs.readFileSync(secretPath, 'utf8').trim();
  }
  const secret = crypto.randomBytes(48).toString('hex');
  fs.writeFileSync(secretPath, secret, { mode: 0o600 });
  return secret;
}

export function loadConfig(overrides: Partial<AppConfig> = {}): AppConfig {
  const dataDir = overrides.dataDir
    ? path.resolve(overrides.dataDir)
    : path.resolve(WORKSPACE_ROOT, process.env.DATA_DIR || 'data');

  const runtimeModeRaw = (overrides.runtimeMode || process.env.RUNTIME_MODE || 'auto').toLowerCase();
  const runtimeMode: RuntimeMode =
    runtimeModeRaw === 'docker' || runtimeModeRaw === 'native' || runtimeModeRaw === 'mock'
      ? runtimeModeRaw
      : 'auto';

  const customCatalogDir = path.join(dataDir, 'custom-games');
  const instancesDir = path.join(dataDir, 'instances');
  const backupsDir = path.join(dataDir, 'backups');
  const toolsDir = path.join(dataDir, 'tools');

  for (const dir of [dataDir, customCatalogDir, instancesDir, backupsDir, toolsDir]) {
    fs.mkdirSync(dir, { recursive: true });
  }

  return {
    port: overrides.port ?? Number(process.env.PORT || 3000),
    host: overrides.host ?? (process.env.HOST || '0.0.0.0'),
    publicHost: overrides.publicHost ?? (process.env.PUBLIC_HOST || 'localhost'),
    runtimeMode,
    dataDir,
    catalogDir: overrides.catalogDir ?? path.join(WORKSPACE_ROOT, 'catalog', 'games'),
    customCatalogDir,
    instancesDir,
    backupsDir,
    toolsDir,
    webDistDir: overrides.webDistDir ?? path.join(WORKSPACE_ROOT, 'packages', 'web', 'dist'),
    dbPath: overrides.dbPath ?? path.join(dataDir, 'serverforge.sqlite'),
    jwtSecret: overrides.jwtSecret ?? loadOrCreateJwtSecret(dataDir),
    discordToken: overrides.discordToken ?? (process.env.DISCORD_TOKEN || ''),
    discordClientId: overrides.discordClientId ?? (process.env.DISCORD_CLIENT_ID || ''),
    discordGuildId: overrides.discordGuildId ?? (process.env.DISCORD_GUILD_ID || ''),
  };
}
