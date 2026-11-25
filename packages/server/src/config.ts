import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import dotenv from 'dotenv';
import {
  EMBEDDED_CATALOG_FILES,
  EMBEDDED_ENV_EXAMPLE,
  IS_BUNDLED_EXE,
} from './embedded-assets.js';

export function isSeaExecutable(): boolean {
  try {
    // Node 22 built-in node:sea module detects Single Executable Application mode
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const sea = process.getBuiltinModule?.('node:sea') as { isSea?: () => boolean } | undefined;
    return Boolean(sea?.isSea?.());
  } catch {
    return false;
  }
}

function resolveWorkspaceRoot(): string {
  if (process.env.SERVERFORGE_HOME) {
    return path.resolve(process.env.SERVERFORGE_HOME);
  }
  if (isSeaExecutable()) {
    return path.dirname(process.execPath);
  }
  if (IS_BUNDLED_EXE) {
    return process.cwd();
  }
  const currentFile = fileURLToPath(import.meta.url);
  return path.resolve(path.dirname(currentFile), '../../..');
}

export const WORKSPACE_ROOT = resolveWorkspaceRoot();

function materializeBundledDefaults(rootDir: string): void {
  if (!IS_BUNDLED_EXE) return;

  // Create .env beside ServerForge.exe on first run if absent
  const envPath = path.join(rootDir, '.env');
  if (!fs.existsSync(envPath) && EMBEDDED_ENV_EXAMPLE) {
    fs.writeFileSync(envPath, EMBEDDED_ENV_EXAMPLE, 'utf8');
  }

  // Extract built-in YAML game templates beside ServerForge.exe so users can inspect/extend them
  const catalogDir = path.join(rootDir, 'catalog', 'games');
  fs.mkdirSync(catalogDir, { recursive: true });
  for (const [filename, content] of Object.entries(EMBEDDED_CATALOG_FILES)) {
    const target = path.join(catalogDir, filename);
    if (!fs.existsSync(target)) {
      fs.writeFileSync(target, content, 'utf8');
    }
  }
}

materializeBundledDefaults(WORKSPACE_ROOT);
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
