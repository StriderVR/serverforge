import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import type { ServerInstance } from '@serverforge/shared';

export interface EnsureSteamCmdOptions {
  fetchImpl?: typeof fetch;
  platform?: NodeJS.Platform;
  extraSearchPaths?: string[];
}

export interface SteamNativeLaunchPlan {
  exe: string;
  args: string[];
  extraEnv?: NodeJS.ProcessEnv;
}

/**
 * Returns Valve's official SteamCMD archive download URL for the given platform.
 */
export function buildSteamCmdDownloadUrl(platform: NodeJS.Platform = process.platform): string {
  if (platform === 'win32') {
    return 'https://steamcdn-a.akamaihd.net/client/installer/steamcmd.zip';
  }
  if (platform === 'darwin') {
    return 'https://steamcdn-a.akamaihd.net/client/installer/steamcmd_osx.tar.gz';
  }
  return 'https://steamcdn-a.akamaihd.net/client/installer/steamcmd_linux.tar.gz';
}

/**
 * Searches ServerForge's managed tools directory and standard OS installation paths
 * for an existing SteamCMD binary. Returns the executable path or null if not installed.
 */
export function findExistingSteamCmd(
  toolsDir: string,
  platform: NodeJS.Platform = process.platform,
  extraSearchPaths: string[] = []
): string | null {
  const isWin = platform === 'win32';
  const localTool = path.join(toolsDir, 'steamcmd', isWin ? 'steamcmd.exe' : 'steamcmd.sh');
  const candidates: string[] = [localTool, ...extraSearchPaths];

  if (isWin) {
    candidates.push(
      'C:\\steamcmd\\steamcmd.exe',
      'C:\\Program Files (x86)\\SteamCMD\\steamcmd.exe',
      'C:\\Program Files\\SteamCMD\\steamcmd.exe'
    );
  } else {
    candidates.push('/usr/games/steamcmd', '/usr/bin/steamcmd', '/usr/local/bin/steamcmd');
  }

  for (const candidate of candidates) {
    if (candidate && fs.existsSync(candidate)) {
      return candidate;
    }
  }
  return null;
}

async function extractSteamCmdArchive(
  archivePath: string,
  destDir: string,
  platform: NodeJS.Platform
): Promise<void> {
  fs.mkdirSync(destDir, { recursive: true });
  const runExtractor = (cmd: string, args: string[]) =>
    new Promise<void>((resolve, reject) => {
      const proc = spawn(cmd, args, { windowsHide: true });
      let errOut = '';
      proc.stderr?.on('data', (d: Buffer) => {
        errOut += d.toString('utf8');
      });
      proc.on('error', (err) => reject(err));
      proc.on('close', (code) => {
        if (code === 0) resolve();
        else {
          reject(
            new Error(
              `SteamCMD archive extraction failed (${cmd} code ${code})${errOut ? `: ${errOut.slice(0, 200)}` : ''}`
            )
          );
        }
      });
    });

  if (platform === 'win32') {
    try {
      await runExtractor('tar', ['-xf', archivePath, '-C', destDir]);
      return;
    } catch {
      await runExtractor('powershell.exe', [
        '-NoProfile',
        '-Command',
        `Expand-Archive -Path '${archivePath.replace(/'/g, "''")}' -DestinationPath '${destDir.replace(/'/g, "''")}' -Force`,
      ]);
      return;
    }
  }

  if (archivePath.endsWith('.zip')) {
    await runExtractor('unzip', ['-o', archivePath, '-d', destDir]);
  } else {
    await runExtractor('tar', ['-xzf', archivePath, '-C', destDir]);
  }
}

/**
 * Ensures Valve SteamCMD is installed locally. If missing, automatically downloads
 * and extracts the official portable SteamCMD package into `toolsDir/steamcmd`.
 */
export async function ensureSteamCmd(
  toolsDir: string,
  onLog: (line: string) => void,
  options: EnsureSteamCmdOptions = {}
): Promise<string> {
  const platform = options.platform ?? process.platform;
  const fetchImpl = options.fetchImpl ?? fetch;

  const existing = findExistingSteamCmd(toolsDir, platform, options.extraSearchPaths);
  if (existing) {
    onLog(`[SteamCMD] Using SteamCMD at ${existing}.`);
    return existing;
  }

  const targetDir = path.join(toolsDir, 'steamcmd');
  fs.mkdirSync(targetDir, { recursive: true });

  const url = buildSteamCmdDownloadUrl(platform);
  const ext = platform === 'win32' ? '.zip' : '.tar.gz';
  const archivePath = path.join(targetDir, `steamcmd-installer${ext}`);

  onLog('[SteamCMD] SteamCMD was not found on this machine. Auto-downloading official portable Valve SteamCMD...');

  const res = await fetchImpl(url, {
    headers: { 'User-Agent': 'ServerForge (+https://github.com/StriderVR/serverforge)' },
    redirect: 'follow',
    signal: AbortSignal.timeout(180_000),
  });

  if (!res.ok) {
    throw new Error(
      `Failed to auto-download SteamCMD from Valve (HTTP ${res.status}). You can install SteamCMD manually into ${targetDir} from https://developer.valvesoftware.com/wiki/SteamCMD.`
    );
  }

  if (res.body) {
    const totalBytes = Number(res.headers.get('content-length') || 0);
    let downloaded = 0;
    let lastLoggedPct = 0;

    if (totalBytes > 0) {
      onLog(`[SteamCMD] Downloading SteamCMD... 0% (0.0 / ${(totalBytes / (1024 * 1024)).toFixed(1)} MB)`);
    } else {
      onLog('[SteamCMD] Downloading SteamCMD...');
    }

    const reader = res.body.getReader();
    const nodeStream = new Readable({
      async read() {
        try {
          const { done, value } = await reader.read();
          if (done) {
            this.push(null);
            return;
          }
          downloaded += value.byteLength;
          if (totalBytes > 0) {
            const pct = Math.min(100, Math.floor((downloaded / totalBytes) * 100));
            if (pct >= lastLoggedPct + 25 || pct === 100) {
              lastLoggedPct = pct;
              onLog(
                `[SteamCMD] Downloading SteamCMD... ${pct}% (${(downloaded / (1024 * 1024)).toFixed(1)} / ${(totalBytes / (1024 * 1024)).toFixed(1)} MB)`
              );
            }
          }
          this.push(Buffer.from(value));
        } catch (err) {
          this.destroy(err instanceof Error ? err : new Error(String(err)));
        }
      },
    });
    await pipeline(nodeStream, fs.createWriteStream(archivePath));
  } else {
    const buf = Buffer.from(await res.arrayBuffer());
    fs.writeFileSync(archivePath, buf);
  }

  onLog('[SteamCMD] Extracting portable SteamCMD...');
  await extractSteamCmdArchive(archivePath, targetDir, platform);
  fs.rmSync(archivePath, { force: true });

  const binPath = path.join(targetDir, platform === 'win32' ? 'steamcmd.exe' : 'steamcmd.sh');
  if (!fs.existsSync(binPath)) {
    throw new Error(`SteamCMD archive extracted, but ${path.basename(binPath)} was not found in ${targetDir}.`);
  }

  if (platform !== 'win32') {
    try {
      fs.chmodSync(binPath, 0o755);
    } catch {
      // ignore chmod errors
    }
  }

  onLog(`[SteamCMD] Portable SteamCMD installed at ${binPath}.`);
  return binPath;
}

/**
 * Escapes quotes inside PalWorldSettings.ini quoted string values.
 */
function escapePalIniString(val: string): string {
  return val.replace(/["\r\n]/g, '').trim();
}

/**
 * Initializes or merges `PalWorldSettings.ini` from `DefaultPalWorldSettings.ini` so
 * Server Name, Description, Max Players, Passwords, RCON, and the Palworld REST API
 * are properly configured for Native Windows & Linux servers.
 */
export function writePalworldSettingsIni(
  serverDir: string,
  instance: ServerInstance,
  platform: NodeJS.Platform = process.platform
): string {
  const platformSubdir = platform === 'win32' ? 'WindowsServer' : 'LinuxServer';
  const configDir = path.join(serverDir, 'Pal', 'Saved', 'Config', platformSubdir);
  fs.mkdirSync(configDir, { recursive: true });
  const iniPath = path.join(configDir, 'PalWorldSettings.ini');

  let content = '';
  if (fs.existsSync(iniPath)) {
    content = fs.readFileSync(iniPath, 'utf8').trim();
  }

  if (!content || !content.includes('OptionSettings=')) {
    const defaultPath = path.join(serverDir, 'DefaultPalWorldSettings.ini');
    if (fs.existsSync(defaultPath)) {
      const rawDefault = fs.readFileSync(defaultPath, 'utf8');
      const headerIdx = rawDefault.indexOf('[/Script/Pal.PalGameWorldSettings]');
      content = (headerIdx >= 0 ? rawDefault.slice(headerIdx) : rawDefault).trim();
    } else {
      content =
        '[/Script/Pal.PalGameWorldSettings]\n' +
        'OptionSettings=(ServerName="ServerForge Palworld",ServerDescription="",AdminPassword="",ServerPassword="",PublicPort=8211,ServerPlayerMaxNum=8,RCONEnabled=True,RCONPort=25575,RESTAPIEnabled=True,RESTAPIPort=8212)';
    }
  }

  const updates: Array<{ key: string; value: string; quoted: boolean }> = [
    { key: 'ServerName', value: escapePalIniString(String(instance.config.SERVER_NAME ?? instance.name)), quoted: true },
    {
      key: 'ServerDescription',
      value: escapePalIniString(String(instance.config.SERVER_DESCRIPTION ?? 'Hosted on demand via ServerForge')),
      quoted: true,
    },
    { key: 'ServerPlayerMaxNum', value: String(Number(instance.config.MAX_PLAYERS ?? 8)), quoted: false },
    { key: 'ServerPassword', value: escapePalIniString(String(instance.config.SERVER_PASSWORD ?? '')), quoted: true },
    { key: 'AdminPassword', value: escapePalIniString(String(instance.config.ADMIN_PASSWORD ?? '')), quoted: true },
    { key: 'PublicPort', value: String(instance.ports.game ?? 8211), quoted: false },
    { key: 'RCONEnabled', value: 'True', quoted: false },
    { key: 'RCONPort', value: String(instance.ports.rcon ?? 25575), quoted: false },
    { key: 'RESTAPIEnabled', value: 'True', quoted: false },
    { key: 'RESTAPIPort', value: String(instance.ports.rest ?? 8212), quoted: false },
  ];

  const match = content.match(/OptionSettings=\(([^)]*)\)/);
  if (match) {
    let inner = match[1];
    for (const { key, value, quoted } of updates) {
      const formatted = quoted ? `${key}="${value}"` : `${key}=${value}`;
      const keyRegex = new RegExp(`(^|,)(${key})=(\"[^\"]*\"|[^,)]*)`, 'i');
      if (keyRegex.test(inner)) {
        inner = inner.replace(keyRegex, `$1${formatted}`);
      } else {
        inner = inner.length > 0 ? `${inner},${formatted}` : formatted;
      }
    }
    content = content.replace(/OptionSettings=\([^)]*\)/, `OptionSettings=(${inner})`);
  }

  fs.writeFileSync(iniPath, `${content.trim()}\n`, 'utf8');
  return iniPath;
}

/**
 * Builds the direct native launch plan for Satisfactory Dedicated Server.
 * On Windows, prefers `Engine/Binaries/Win64/FactoryServer-Win64-Shipping-Cmd.exe`
 * directly instead of the `FactoryServer.exe` bootstrap wrapper (which detaches and exits).
 */
export function buildSatisfactoryNativeLaunchPlan(
  serverDir: string,
  instance: ServerInstance,
  platform: NodeJS.Platform = process.platform
): SteamNativeLaunchPlan | null {
  const portGame = instance.ports.game ?? 7777;

  if (platform === 'win32') {
    const directExe = path.join(serverDir, 'Engine', 'Binaries', 'Win64', 'FactoryServer-Win64-Shipping-Cmd.exe');
    if (fs.existsSync(directExe)) {
      return {
        exe: directExe,
        args: ['FactoryGame', `-Port=${portGame}`, '-log', '-unattended'],
      };
    }
    const wrapperExe = path.join(serverDir, 'FactoryServer.exe');
    if (fs.existsSync(wrapperExe)) {
      return {
        exe: wrapperExe,
        args: [`-Port=${portGame}`, '-log', '-unattended'],
      };
    }
    return null;
  }

  const shPath = path.join(serverDir, 'FactoryServer.sh');
  if (fs.existsSync(shPath)) {
    try {
      fs.chmodSync(shPath, 0o755);
    } catch {
      // ignore chmod errors
    }
    return {
      exe: shPath,
      args: [`-Port=${portGame}`, '-unattended'],
    };
  }
  return null;
}

/**
 * Builds the direct native launch plan for Palworld Dedicated Server.
 * On Windows, prefers `Pal/Binaries/Win64/PalServer-Win64-Shipping-Cmd.exe` directly
 * instead of the `PalServer.exe` bootstrap wrapper so stdout logs and stop signals stay attached.
 */
export function buildPalworldNativeLaunchPlan(
  serverDir: string,
  instance: ServerInstance,
  platform: NodeJS.Platform = process.platform
): SteamNativeLaunchPlan | null {
  const portGame = instance.ports.game ?? 8211;
  const portQuery = instance.ports.query ?? 27015;
  const maxPlayers = Number(instance.config.MAX_PLAYERS ?? 8);
  const args = [
    `-port=${portGame}`,
    `-queryport=${portQuery}`,
    `-players=${maxPlayers}`,
    '-useperfthreads',
    '-NoAsyncLoadingThread',
    '-UseMultithreadForDS',
  ];

  if (platform === 'win32') {
    const candidates = [
      path.join(serverDir, 'Pal', 'Binaries', 'Win64', 'PalServer-Win64-Shipping-Cmd.exe'),
      path.join(serverDir, 'Pal', 'Binaries', 'Win64', 'PalServer-Win64-Shipping-Test-Cmd.exe'),
      path.join(serverDir, 'PalServer.exe'),
    ];
    const found = candidates.find((p) => fs.existsSync(p));
    if (found) {
      return { exe: found, args };
    }
    return null;
  }

  const shPath = path.join(serverDir, 'PalServer.sh');
  if (fs.existsSync(shPath)) {
    try {
      fs.chmodSync(shPath, 0o755);
    } catch {
      // ignore chmod errors
    }
    return { exe: shPath, args };
  }
  return null;
}

/**
 * Builds clean native launch arguments for Ark: Survival Ascended (`ArkAscendedServer.exe`),
 * keeping the Unreal Engine map URL as a single argument and omitting empty password/mod flags.
 */
export function buildArkAsaNativeLaunchPlan(
  serverDir: string,
  instance: ServerInstance
): SteamNativeLaunchPlan | null {
  const exePath = path.join(serverDir, 'ShooterGame', 'Binaries', 'Win64', 'ArkAscendedServer.exe');
  if (!fs.existsSync(exePath)) return null;

  const map = String(instance.config.MAP ?? 'TheIsland_WP').trim() || 'TheIsland_WP';
  const sessionName = String(instance.config.SESSION_NAME ?? instance.name).replace(/[?"]/g, '').trim() || 'ServerForge ASA';
  const portGame = instance.ports.game ?? 7777;
  const portRcon = instance.ports.rcon ?? 27020;
  const rconPass = String(instance.config.RCON_PASSWORD ?? '').trim();
  const serverPass = String(instance.config.SERVER_PASSWORD ?? '').trim();
  const maxPlayers = Number(instance.config.MAX_PLAYERS ?? 10);
  const modIds = String(instance.config.MOD_IDS ?? '').trim();

  const urlParts = [
    map,
    'listen',
    `SessionName=${sessionName}`,
    `Port=${portGame}`,
    'RCONEnabled=True',
    `RCONPort=${portRcon}`,
  ];
  if (rconPass) {
    urlParts.push(`ServerAdminPassword=${rconPass}`);
  }
  if (serverPass) {
    urlParts.push(`ServerPassword=${serverPass}`);
  }

  const args = [
    urlParts.join('?'),
    `-WinLiveMaxPlayers=${maxPlayers}`,
    '-NoBattlEye',
    '-server',
    '-log',
  ];
  if (modIds) {
    args.push(`-mods=${modIds}`);
  }

  return { exe: exePath, args };
}
