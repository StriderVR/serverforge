import { execFile } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import type { ServerInstance } from '@serverforge/shared';

export const FACTORIO_LINUX_HEADLESS_URL = 'https://factorio.com/get-download/stable/headless/linux64';

export interface DetectedFactorio {
  exePath: string;
  rootDir: string;
  source: 'instance' | 'local';
}

export interface FindFactorioOptions {
  searchDirs?: string[];
  steamVdfPaths?: string[];
}

/**
 * Builds the official Wube Factorio Windows 64-bit ZIP download URL using a Factorio.com account token.
 */
export function buildFactorioWin64DownloadUrl(username: string, token: string): string {
  return `https://www.factorio.com/get-download/stable/alpha/win64-manual?username=${encodeURIComponent(username.trim())}&token=${encodeURIComponent(token.trim())}`;
}

/**
 * Parses Steam's `libraryfolders.vdf` to extract all configured Steam library root directories.
 */
export function parseSteamLibraryFoldersVdf(vdfContent: string): string[] {
  const dirs: string[] = [];
  const seen = new Set<string>();
  const pathRegex = /"path"\s+"([^"]+)"/gi;
  let match: RegExpExecArray | null;
  while ((match = pathRegex.exec(vdfContent)) !== null) {
    const normalized = match[1].replace(/\\\\/g, '\\').trim();
    if (!normalized) continue;
    const key = normalized.toLowerCase();
    if (!seen.has(key)) {
      seen.add(key);
      dirs.push(normalized);
    }
  }
  return dirs;
}

/**
 * Resolves a Factorio executable inside a given root directory (`bin/x64/factorio.exe` or `bin/x64/factorio`).
 */
export function findFactorioExecutableInRoot(
  rootDir: string,
  platform: NodeJS.Platform = process.platform
): string | null {
  if (!rootDir || !fs.existsSync(rootDir)) return null;
  const relCandidates =
    platform === 'win32'
      ? [path.join('bin', 'x64', 'factorio.exe'), 'factorio.exe']
      : [path.join('bin', 'x64', 'factorio'), 'factorio'];

  for (const rel of relCandidates) {
    const full = path.join(rootDir, rel);
    if (fs.existsSync(full)) return full;
  }
  return null;
}

/**
 * Locates an existing Factorio installation, checking the instance's own `serverDir` first
 * and then scanning Steam libraries and common Windows/Linux installation paths.
 */
export function findLocalFactorioInstall(
  serverDir: string,
  platform: NodeJS.Platform = process.platform,
  options: FindFactorioOptions = {}
): DetectedFactorio | null {
  const inInstance = findFactorioExecutableInRoot(serverDir, platform);
  if (inInstance) {
    return { exePath: inInstance, rootDir: serverDir, source: 'instance' };
  }

  const candidateRoots: string[] = [...(options.searchDirs ?? [])];

  if (platform === 'win32') {
    const vdfPaths = options.steamVdfPaths ?? [
      'C:\\Program Files (x86)\\Steam\\steamapps\\libraryfolders.vdf',
      'C:\\Program Files\\Steam\\steamapps\\libraryfolders.vdf',
    ];
    for (const vdfPath of vdfPaths) {
      if (!fs.existsSync(vdfPath)) continue;
      try {
        const raw = fs.readFileSync(vdfPath, 'utf8');
        for (const libRoot of parseSteamLibraryFoldersVdf(raw)) {
          candidateRoots.push(path.win32.join(libRoot, 'steamapps', 'common', 'Factorio'));
        }
      } catch {
        // ignore unreadable VDF
      }
    }

    candidateRoots.push(
      'C:\\Program Files (x86)\\Steam\\steamapps\\common\\Factorio',
      'C:\\Program Files\\Steam\\steamapps\\common\\Factorio',
      'C:\\Program Files\\Factorio',
      'C:\\Games\\Factorio',
      'D:\\SteamLibrary\\steamapps\\common\\Factorio',
      'E:\\SteamLibrary\\steamapps\\common\\Factorio'
    );
  }

  const seen = new Set<string>();
  for (const root of candidateRoots) {
    const key = platform === 'win32' ? root.toLowerCase() : root;
    if (seen.has(key)) continue;
    seen.add(key);

    const exe = findFactorioExecutableInRoot(root, platform);
    if (exe) {
      return { exePath: exe, rootDir: root, source: 'local' };
    }
  }

  return null;
}

/**
 * Converts a Windows drive path (e.g. `C:\ServerForge\data\server`) to a WSL `/mnt/c/...` path.
 */
export function toWslPath(windowsPath: string): string {
  const normalized = windowsPath.replace(/\\/g, '/');
  const driveMatch = normalized.match(/^([A-Za-z]):\/(.*)$/);
  if (driveMatch) {
    return `/mnt/${driveMatch[1].toLowerCase()}/${driveMatch[2]}`;
  }
  return normalized;
}

/**
 * Checks whether Windows Subsystem for Linux (WSL) has an available Linux distro.
 */
export async function probeWslAvailable(): Promise<boolean> {
  if (process.platform !== 'win32') return false;
  return new Promise((resolve) => {
    execFile('wsl.exe', ['-e', 'true'], { timeout: 5000, windowsHide: true }, (err) => {
      resolve(!err);
    });
  });
}

/**
 * Checks whether at least one `.zip` world save exists inside `serverDir/saves`.
 */
export function hasExistingFactorioSave(serverDir: string): boolean {
  const savesDir = path.join(serverDir, 'saves');
  if (!fs.existsSync(savesDir)) return false;
  try {
    return fs.readdirSync(savesDir).some((f) => f.toLowerCase().endsWith('.zip'));
  } catch {
    return false;
  }
}

/**
 * Writes an isolated `config.ini` and `server-settings.json` inside `serverDir` so Factorio
 * keeps all saves, mods, and logs inside the instance folder and applies ServerForge config fields.
 */
export function writeFactorioConfigFiles(
  serverDir: string,
  instance: ServerInstance,
  options: { readDataPath?: string; useWslPaths?: boolean } = {}
): {
  configIniPath: string;
  serverSettingsPath: string;
  saveFilePath: string;
} {
  const savesDir = path.join(serverDir, 'saves');
  fs.mkdirSync(savesDir, { recursive: true });

  const configIniPath = path.join(serverDir, 'config.ini');
  const writeDataPath = options.useWslPaths ? toWslPath(serverDir) : serverDir;
  const readDataPath = options.readDataPath ?? '__PATH__executable__/../../data';

  const configIni = [
    '[path]',
    `read-data=${readDataPath}`,
    `write-data=${writeDataPath}`,
    '',
  ].join('\n');
  fs.writeFileSync(configIniPath, configIni, 'utf8');

  const serverSettingsPath = path.join(serverDir, 'server-settings.json');
  let existingSettings: Record<string, unknown> = {};
  if (fs.existsSync(serverSettingsPath)) {
    try {
      const parsed = JSON.parse(fs.readFileSync(serverSettingsPath, 'utf8'));
      if (parsed && typeof parsed === 'object') {
        existingSettings = parsed as Record<string, unknown>;
      }
    } catch {
      // regenerate cleanly
    }
  }

  const mergedSettings: Record<string, unknown> = {
    name: instance.name || 'ServerForge Factorio',
    description: 'Hosted on demand via ServerForge',
    tags: ['serverforge'],
    visibility: {
      public: false,
      lan: true,
    },
    username: String(instance.config.FACTORIO_USERNAME ?? ''),
    token: String(instance.config.FACTORIO_TOKEN ?? ''),
    require_user_verification: true,
    max_upload_in_kilobytes_per_second: 0,
    auto_pause: true,
    autosave_interval: 10,
    autosave_slots: 5,
    ...existingSettings,
    // Always sync core ServerForge-managed config fields
    max_players: Number(instance.config.MAX_PLAYERS ?? 10),
    game_password: String(instance.config.SERVER_PASSWORD ?? ''),
  };

  fs.writeFileSync(serverSettingsPath, `${JSON.stringify(mergedSettings, null, 2)}\n`, 'utf8');

  const rawSaveName = String(instance.config.SAVE_NAME ?? 'serverforge-factory').trim() || 'serverforge-factory';
  const safeSaveName = rawSaveName.replace(/[^a-zA-Z0-9._-]/g, '_').replace(/\.zip$/i, '');
  const saveFilePath = path.join(savesDir, `${safeSaveName}.zip`);

  return { configIniPath, serverSettingsPath, saveFilePath };
}
