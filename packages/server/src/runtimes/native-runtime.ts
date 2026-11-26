import fs from 'node:fs';
import path from 'node:path';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { spawn, execFile, type ChildProcess } from 'node:child_process';
import type { GameTemplate, InstanceRuntimeStats, ServerInstance } from '@serverforge/shared';
import { buildTemplateVariables, renderTemplateString } from '../catalog/catalog-service.js';
import type { QueryService } from '../query/query-service.js';
import type { CurseForgeService } from '../services/curseforge-service.js';
import {
  buildJavaEnv,
  ensureJavaRuntime,
  javaTagToMajor,
  recommendJavaMajorForMcVersion,
  type DetectedJava,
} from './java-helper.js';
import { splitArgs, type RuntimeAdapter, type RuntimeStartResult } from './runtime-adapter.js';

interface ManagedProcess {
  child: ChildProcess;
  startedAt: number;
}

export interface NativeLaunchPlan {
  exe: string;
  args: string[];
  extraEnv?: NodeJS.ProcessEnv;
}

const WIN_SCRIPT_PRIORITY = [
  'startserver.bat',
  'serverstart.bat',
  'start.bat',
  'run.bat',
  'launch.bat',
  'startserver.ps1',
  'serverstart.ps1',
  'start.ps1',
  'run.ps1',
  'launch.ps1',
];

const UNIX_SCRIPT_PRIORITY = [
  'startserver.sh',
  'serverstart.sh',
  'start.sh',
  'run.sh',
  'launch.sh',
];

const SERVER_JAR_PRIORITY = [
  'fabric-server-launch.jar',
  'server.jar',
];

const IGNORE_ROOT_ENTRIES = new Set(['__macosx', '.ds_store', 'thumbs.db', 'desktop.ini']);

/**
 * If an extracted Server Pack ZIP placed all files inside a single top-level directory
 * (e.g., `All-the-Mods-10-Server-Files/`), moves them up into `serverDir` so startup scripts,
 * `eula.txt`, `server.properties`, and `user_jvm_args.txt` live directly at the root.
 */
export function flattenSingleRootSubdir(serverDir: string, maxPasses = 2): boolean {
  let flattened = false;
  for (let pass = 0; pass < maxPasses; pass++) {
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(serverDir, { withFileTypes: true });
    } catch {
      break;
    }

    const meaningful = entries.filter(
      (e) =>
        !IGNORE_ROOT_ENTRIES.has(e.name.toLowerCase()) &&
        !e.name.startsWith('.serverforge-') &&
        e.name.toLowerCase() !== 'server-pack.zip'
    );

    if (meaningful.length !== 1 || !meaningful[0].isDirectory()) {
      break;
    }

    const nestedDir = path.join(serverDir, meaningful[0].name);
    const childEntries = fs.readdirSync(nestedDir, { withFileTypes: true });
    for (const child of childEntries) {
      const src = path.join(nestedDir, child.name);
      const dst = path.join(serverDir, child.name);
      if (fs.existsSync(dst)) {
        fs.rmSync(dst, { recursive: true, force: true });
      }
      fs.renameSync(src, dst);
    }
    fs.rmSync(nestedDir, { recursive: true, force: true });
    flattened = true;
  }
  return flattened;
}

/**
 * Checks whether a single JVM flag token is unsupported on the target Java major version.
 */
export function isIncompatibleJvmFlag(token: string, javaMajor: number): boolean {
  const clean = token.trim().replace(/^["']|["']$/g, '');
  if (!clean.startsWith('-XX:')) return false;
  if (javaMajor < 24 && /^-XX:[+-]UseCompactObjectHeaders$/i.test(clean)) return true;
  if (javaMajor < 21 && /^-XX:[+-]ZGenerational$/i.test(clean)) return true;
  if (
    javaMajor >= 14 &&
    /^-XX:[+-](?:UseConcMarkSweepGC|CMSIncrementalMode|UseParNewGC|CMSParallelRemarkEnabled)$/i.test(clean)
  ) {
    return true;
  }
  if (javaMajor >= 18 && /^-XX:[+-]UseBiasedLocking$/i.test(clean)) return true;
  return false;
}

/**
 * Removes or comments out JVM flags in `user_jvm_args.txt` that are incompatible with `javaMajor`
 * (for example `-XX:+UseCompactObjectHeaders`, which requires Java 24/25 and crashes Java 21).
 */
export function sanitizeUserJvmArgs(
  content: string,
  javaMajor: number
): { content: string; removedFlags: string[] } {
  const removedFlags: string[] = [];
  const outLines = content.split(/\r?\n/).map((line) => {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) return line;
    const tokens = trimmed.split(/\s+/);
    const kept: string[] = [];
    const removedHere: string[] = [];
    for (const tok of tokens) {
      if (isIncompatibleJvmFlag(tok, javaMajor)) {
        removedHere.push(tok);
        removedFlags.push(tok);
      } else {
        kept.push(tok);
      }
    }
    if (removedHere.length === 0) return line;
    if (kept.length === 0) {
      return `# [ServerForge] disabled for Java ${javaMajor}: ${trimmed}`;
    }
    return kept.join(' ');
  });
  return { content: outLines.join('\n'), removedFlags };
}

function stripIncompatibleJvmFlagsFromScript(
  content: string,
  javaMajor: number
): { content: string; removedFlags: string[] } {
  const removedFlags: string[] = [];
  const updated = content.replace(/(?:^|\s)(-XX:[+-][A-Za-z0-9]+)/g, (match, flag: string) => {
    if (isIncompatibleJvmFlag(flag, javaMajor)) {
      removedFlags.push(flag);
      return '';
    }
    return match;
  });
  return { content: updated, removedFlags };
}

/**
 * Sanitizes a Windows .bat/.cmd startup script for headless execution under ServerForge:
 * - Disables interactive `pause` commands that would hang forever
 * - Disables vendor auto-restart flags (ATM_RESTART/RESTART/AUTO_RESTART)
 * - Neutralizes `timeout /t` (which fails under piped stdio with "Input redirection is not supported")
 *   and breaks auto-restart `goto` loops so ServerForge cleanly detects crashes & stops
 * - Strips JVM flags incompatible with `javaMajor` (e.g., `-XX:+UseCompactObjectHeaders` on Java 21)
 */
export function createPauseSafeBatchWrapper(
  serverDir: string,
  scriptName: string,
  javaMajor?: number
): string {
  const fullPath = path.join(serverDir, scriptName);
  try {
    const original = fs.readFileSync(fullPath, 'utf8');
    let changed = false;

    const lines = original.split(/\r?\n/);
    const outLines: string[] = [];

    for (let i = 0; i < lines.length; i++) {
      let line = lines[i];

      // 1. Disable interactive `pause`
      if (/^\s*@?pause(?:\s+.*)?$/i.test(line)) {
        outLines.push(`rem [ServerForge] disabled interactive ${line.trim()}`);
        changed = true;
        continue;
      }

      // 2. Disable vendor auto-restart variables (e.g., ATM10 `set ATM_RESTART=true`)
      if (/^\s*(?:set\s+["']?(?:ATM_RESTART|RESTART|AUTO_RESTART|SERVER_RESTART)\s*=\s*)true["']?\s*$/i.test(line)) {
        outLines.push(line.replace(/true/i, 'false'));
        changed = true;
        continue;
      }

      // 3. Neutralize `timeout /t ...` (fails under piped stdio and causes tight crash loops)
      if (/^\s*@?timeout(?:\.exe)?\s+/i.test(line)) {
        const prevContext = lines.slice(Math.max(0, i - 3), i).join('\n');
        const nextContext = lines.slice(i + 1, Math.min(lines.length, i + 5)).join('\n');
        const isRestartLoop =
          /restarting\s+automatically|restart/i.test(prevContext) ||
          /^\s*@?goto\s+/im.test(nextContext);

        if (isRestartLoop) {
          outLines.push('rem [ServerForge] disabled vendor auto-restart loop (ServerForge manages lifecycle)');
          outLines.push('exit /b %ERRORLEVEL%');
        } else {
          const secMatch = line.match(/\/t\s+(\d+)/i);
          const secs = Math.min(Math.max(Number(secMatch?.[1] ?? 5), 1), 30);
          outLines.push(`ping -n ${secs + 1} 127.0.0.1 >nul`);
        }
        changed = true;
        continue;
      }

      // 4. Strip incompatible inline JVM flags for active Java major version
      if (javaMajor !== undefined) {
        const stripped = stripIncompatibleJvmFlagsFromScript(line, javaMajor);
        if (stripped.removedFlags.length > 0) {
          line = stripped.content;
          changed = true;
        }
      }

      outLines.push(line);
    }

    if (!changed) {
      return scriptName;
    }

    const wrapperName = '.serverforge-start.bat';
    fs.writeFileSync(path.join(serverDir, wrapperName), outLines.join('\r\n'), 'utf8');
    return wrapperName;
  } catch {
    return scriptName;
  }
}

/**
 * Detects Forge / NeoForge `win_args.txt` or `unix_args.txt` inside `libraries/net/...`.
 */
export function findModloaderArgsFile(serverDir: string, platform: NodeJS.Platform = process.platform): string | null {
  const targetFile = platform === 'win32' ? 'win_args.txt' : 'unix_args.txt';
  const searchRoots = [
    path.join(serverDir, 'libraries', 'net', 'neoforged', 'neoforge'),
    path.join(serverDir, 'libraries', 'net', 'minecraftforge', 'forge'),
  ];

  for (const root of searchRoots) {
    if (!fs.existsSync(root)) continue;
    try {
      const versionDirs = fs
        .readdirSync(root, { withFileTypes: true })
        .filter((d) => d.isDirectory())
        .map((d) => d.name)
        .sort()
        .reverse();
      for (const ver of versionDirs) {
        const candidate = path.join(root, ver, targetFile);
        if (fs.existsSync(candidate)) {
          return path.relative(serverDir, candidate);
        }
      }
    } catch {
      // ignore unreadable directories
    }
  }
  return null;
}

/**
 * Detects an unrun Forge / NeoForge installer JAR (e.g., `forge-1.20.1-47.3.0-installer.jar`).
 */
export function findForgeOrNeoForgeInstallerJar(serverDir: string): string | null {
  if (!fs.existsSync(serverDir)) return null;
  try {
    const files = fs.readdirSync(serverDir);
    const match = files.find((f) => /^(?:neo)?forge-.*installer\.jar$/i.test(f));
    return match ?? null;
  } catch {
    return null;
  }
}

/**
 * Auto-detects the best startup command for a native Minecraft / CurseForge server folder.
 * Returns null if no runnable script, Forge/NeoForge args file, or server JAR exists.
 */
export function findNativeMinecraftLauncher(
  serverDir: string,
  javaBin: string,
  memoryLimitMb: number,
  platform: NodeJS.Platform = process.platform,
  javaMajor?: number
): NativeLaunchPlan | null {
  if (!fs.existsSync(serverDir)) return null;

  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(serverDir, { withFileTypes: true });
  } catch {
    return null;
  }

  const fileMap = new Map<string, string>();
  for (const e of entries) {
    if (e.isFile()) {
      fileMap.set(e.name.toLowerCase(), e.name);
    }
  }

  const isWin = platform === 'win32';
  const scriptPriority = isWin ? WIN_SCRIPT_PRIORITY : UNIX_SCRIPT_PRIORITY;

  // 1. Standard startup scripts (case-insensitive)
  for (const lowerCandidate of scriptPriority) {
    const actualName = fileMap.get(lowerCandidate);
    if (!actualName) continue;

    if (lowerCandidate.endsWith('.bat') || lowerCandidate.endsWith('.cmd')) {
      const safeScript = createPauseSafeBatchWrapper(serverDir, actualName, javaMajor);
      // Use relative script name inside cwd=serverDir with /d /c to avoid Windows path-space quote bugs
      return { exe: 'cmd.exe', args: ['/d', '/c', safeScript] };
    }
    if (lowerCandidate.endsWith('.ps1')) {
      return {
        exe: 'powershell.exe',
        args: ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', path.join(serverDir, actualName)],
      };
    }
    if (lowerCandidate.endsWith('.sh')) {
      try {
        fs.chmodSync(path.join(serverDir, actualName), 0o755);
      } catch {
        // ignore chmod errors
      }
      return { exe: 'bash', args: [actualName] };
    }
  }

  const minMem = Math.min(2048, memoryLimitMb);

  // 2. Forge / NeoForge 1.17+ args file (`libraries/net/.../win_args.txt` or `unix_args.txt`)
  const argsFile = findModloaderArgsFile(serverDir, platform);
  if (argsFile) {
    const args: string[] = [];
    if (fileMap.has('user_jvm_args.txt')) {
      args.push('@user_jvm_args.txt');
    } else {
      args.push(`-Xms${minMem}M`, `-Xmx${memoryLimitMb}M`);
    }
    args.push(`@${argsFile}`, 'nogui');
    return { exe: javaBin, args };
  }

  // 3. Runnable server JAR (explicitly skipping *-installer.jar)
  for (const preferredJar of SERVER_JAR_PRIORITY) {
    const actual = fileMap.get(preferredJar);
    if (actual) {
      return {
        exe: javaBin,
        args: [`-Xms${minMem}M`, `-Xmx${memoryLimitMb}M`, '-jar', actual, 'nogui'],
      };
    }
  }

  const nonInstallerJars = entries
    .filter((e) => e.isFile() && e.name.toLowerCase().endsWith('.jar') && !/installer\.jar$/i.test(e.name))
    .map((e) => e.name);

  const prioritizedJar =
    nonInstallerJars.find((j) => /^(?:paper|purpur|spigot|fabric|forge|neoforge|minecraft_server)/i.test(j)) ??
    (nonInstallerJars.length === 1 ? nonInstallerJars[0] : null);

  if (prioritizedJar) {
    return {
      exe: javaBin,
      args: [`-Xms${minMem}M`, `-Xmx${memoryLimitMb}M`, '-jar', prioritizedJar, 'nogui'],
    };
  }

  return null;
}

/**
 * Merges core ServerForge values into `server.properties` while preserving any custom modpack keys,
 * and updates/sanitizes `user_jvm_args.txt` for the active Java major version.
 */
function writeMinecraftBaseConfig(
  serverDir: string,
  instance: ServerInstance,
  defaultMotd: string,
  javaMajor?: number,
  onLog?: (line: string) => void
): void {
  fs.writeFileSync(path.join(serverDir, 'eula.txt'), 'eula=true\n', 'utf8');

  const propsPath = path.join(serverDir, 'server.properties');
  const existingLines = fs.existsSync(propsPath)
    ? fs.readFileSync(propsPath, 'utf8').split(/\r?\n/)
    : [];

  const overrides: Record<string, string> = {
    'server-port': String(instance.ports.game ?? 25565),
    'enable-rcon': 'true',
    'rcon.port': String(instance.ports.rcon ?? 25575),
    'rcon.password': String(instance.config.RCON_PASSWORD ?? ''),
    'max-players': String(instance.config.MAX_PLAYERS ?? 8),
    motd: String(instance.config.MOTD ?? defaultMotd),
  };
  if (instance.config.DIFFICULTY !== undefined && instance.config.DIFFICULTY !== '') {
    overrides.difficulty = String(instance.config.DIFFICULTY);
  }
  if (instance.config.GAMEMODE !== undefined && instance.config.GAMEMODE !== '') {
    overrides.gamemode = String(instance.config.GAMEMODE);
  }
  if (instance.config.VIEW_DISTANCE !== undefined && instance.config.VIEW_DISTANCE !== '') {
    overrides['view-distance'] = String(instance.config.VIEW_DISTANCE);
  }
  if (instance.config.ONLINE_MODE !== undefined) {
    overrides['online-mode'] = String(Boolean(instance.config.ONLINE_MODE));
  }

  const seen = new Set<string>();
  const updatedLines = existingLines.map((line) => {
    const idx = line.indexOf('=');
    if (idx > 0 && !line.trimStart().startsWith('#')) {
      const key = line.slice(0, idx).trim();
      if (key in overrides) {
        seen.add(key);
        return `${key}=${overrides[key]}`;
      }
    }
    return line;
  });

  for (const [k, v] of Object.entries(overrides)) {
    if (!seen.has(k)) updatedLines.push(`${k}=${v}`);
  }
  fs.writeFileSync(propsPath, updatedLines.filter((l) => l !== undefined).join('\n').replace(/\n+$/, '\n'), 'utf8');

  // Update user_jvm_args.txt memory flags & sanitize version-incompatible JVM flags
  const jvmArgsPath = path.join(serverDir, 'user_jvm_args.txt');
  if (fs.existsSync(jvmArgsPath)) {
    const minMem = Math.min(2048, instance.memoryLimitMb);
    let rawJvm = fs.readFileSync(jvmArgsPath, 'utf8');
    if (javaMajor !== undefined) {
      const sanitized = sanitizeUserJvmArgs(rawJvm, javaMajor);
      rawJvm = sanitized.content;
      if (sanitized.removedFlags.length > 0) {
        onLog?.(
          `[Java] Disabled JVM flag(s) incompatible with Java ${javaMajor} in user_jvm_args.txt: ${Array.from(new Set(sanitized.removedFlags)).join(', ')}`
        );
      }
    }
    const existingJvm = rawJvm.split(/\r?\n/);
    const filtered = existingJvm.filter((l) => {
      const t = l.trim();
      return !/^-Xm[sx]\d+[GMK]?$/i.test(t);
    });
    filtered.push(`-Xms${minMem}M`, `-Xmx${instance.memoryLimitMb}M`);
    fs.writeFileSync(jvmArgsPath, filtered.join('\n').replace(/\n+$/, '\n'), 'utf8');
  }
}

export class NativeProcessRuntimeAdapter implements RuntimeAdapter {
  public readonly kind = 'native' as const;
  private readonly processes = new Map<string, ManagedProcess>();

  constructor(
    private readonly toolsDir: string,
    private readonly queryService: QueryService,
    private readonly curseforge?: CurseForgeService,
    private readonly getGlobalVars: () => Record<string, string> = () => ({}),
    private readonly fetchImpl: typeof fetch = fetch
  ) {}

  async isAvailable(): Promise<boolean> {
    return true;
  }

  private findSteamCmd(): string {
    const isWin = process.platform === 'win32';
    const localTool = path.join(this.toolsDir, 'steamcmd', isWin ? 'steamcmd.exe' : 'steamcmd.sh');
    if (fs.existsSync(localTool)) return localTool;

    if (isWin) {
      const commonPaths = [
        'C:\\steamcmd\\steamcmd.exe',
        'C:\\Program Files (x86)\\SteamCMD\\steamcmd.exe',
      ];
      for (const p of commonPaths) {
        if (fs.existsSync(p)) return p;
      }
      return 'steamcmd.exe';
    }
    return 'steamcmd';
  }

  private async ensureSteamCmdInstalled(
    appId: number,
    installDir: string,
    beta: string | undefined,
    onLog: (line: string) => void
  ): Promise<void> {
    const steamcmdBin = this.findSteamCmd();
    fs.mkdirSync(installDir, { recursive: true });
    onLog(`[SteamCMD] Updating/verifying Steam AppID ${appId} in ${installDir}...`);

    const args = ['+force_install_dir', installDir, '+login', 'anonymous', '+app_update', String(appId)];
    if (beta) {
      args.push('-beta', beta);
    }
    args.push('validate', '+quit');

    await new Promise<void>((resolve, reject) => {
      const proc = spawn(steamcmdBin, args, { windowsHide: true });
      proc.stdout?.on('data', (d: Buffer) => {
        for (const line of d.toString('utf8').split(/\r?\n/)) {
          if (line.trim()) onLog(`[SteamCMD] ${line.trim()}`);
        }
      });
      proc.stderr?.on('data', (d: Buffer) => {
        for (const line of d.toString('utf8').split(/\r?\n/)) {
          if (line.trim()) onLog(`[SteamCMD] ${line.trim()}`);
        }
      });
      proc.on('error', (err) => {
        reject(
          new Error(
            `Failed to launch SteamCMD (${steamcmdBin}): ${err.message}. Run scripts/install-windows.ps1 or install SteamCMD to C:\\steamcmd.`
          )
        );
      });
      proc.on('close', (code) => {
        if (code === 0) {
          onLog(`[SteamCMD] AppID ${appId} is up to date.`);
          resolve();
        } else {
          reject(new Error(`SteamCMD exited with code ${code}`));
        }
      });
    });
  }

  private async streamDownloadToFile(
    url: string,
    destPath: string,
    onLog: (line: string) => void,
    label: string
  ): Promise<void> {
    const res = await this.fetchImpl(url, {
      headers: { 'User-Agent': 'ServerForge/1.1.6 (+https://github.com/StriderVR/serverforge)' },
      redirect: 'follow',
      signal: AbortSignal.timeout(900_000),
    });
    if (!res.ok) {
      throw new Error(`Failed to download ${label} (HTTP ${res.status})`);
    }

    if (res.body) {
      const totalBytes = Number(res.headers.get('content-length') || 0);
      let downloaded = 0;
      let lastLoggedPct = 0;
      let lastLoggedMb = 0;

      if (totalBytes > 0) {
        onLog(`[Download] ${label}: 0% (0.0 / ${(totalBytes / (1024 * 1024)).toFixed(1)} MB)`);
      } else {
        onLog(`[Download] ${label}: Downloading...`);
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
              if (pct >= lastLoggedPct + 5 || pct === 100) {
                lastLoggedPct = pct;
                onLog(
                  `[Download] ${label}: ${pct}% (${(downloaded / (1024 * 1024)).toFixed(1)} / ${(totalBytes / (1024 * 1024)).toFixed(1)} MB)`
                );
              }
            } else {
              const mb = Math.floor(downloaded / (1024 * 1024));
              if (mb >= lastLoggedMb + 10) {
                lastLoggedMb = mb;
                onLog(`[Download] ${label}: ${mb} MB downloaded...`);
              }
            }
            this.push(Buffer.from(value));
          } catch (err) {
            this.destroy(err instanceof Error ? err : new Error(String(err)));
          }
        },
      });
      await pipeline(nodeStream, fs.createWriteStream(destPath));
    } else {
      const buf = Buffer.from(await res.arrayBuffer());
      fs.writeFileSync(destPath, buf);
    }
  }

  private async extractZip(zipPath: string, destDir: string): Promise<void> {
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
          else reject(new Error(`${cmd} exited with code ${code}${errOut ? `: ${errOut.slice(0, 200)}` : ''}`));
        });
      });

    if (process.platform === 'win32') {
      // Windows 10/11 includes native bsdtar (`tar.exe`), which extracts ZIPs ~10x faster than PowerShell Expand-Archive
      try {
        await runExtractor('tar', ['-xf', zipPath, '-C', destDir]);
        return;
      } catch {
        await runExtractor('powershell.exe', [
          '-NoProfile',
          '-Command',
          `Expand-Archive -Path '${zipPath.replace(/'/g, "''")}' -DestinationPath '${destDir.replace(/'/g, "''")}' -Force`,
        ]);
        return;
      }
    }

    await runExtractor('unzip', ['-o', zipPath, '-d', destDir]);
  }

  private async runModloaderInstaller(
    installerJar: string,
    serverDir: string,
    java: DetectedJava,
    onLog: (line: string) => void
  ): Promise<void> {
    onLog(`[Minecraft] Running modloader server installer (${installerJar}) with Java ${java.major}...`);
    await new Promise<void>((resolve, reject) => {
      const proc = spawn(java.javaBin, ['-jar', installerJar, '--installServer'], {
        cwd: serverDir,
        env: buildJavaEnv(process.env, java),
        windowsHide: true,
        stdio: ['ignore', 'pipe', 'pipe'],
      });
      proc.stdout?.on('data', (d: Buffer) => {
        for (const line of d.toString('utf8').split(/\r?\n/)) {
          if (line.trim()) onLog(`[Installer] ${line.trim()}`);
        }
      });
      proc.stderr?.on('data', (d: Buffer) => {
        for (const line of d.toString('utf8').split(/\r?\n/)) {
          if (line.trim()) onLog(`[Installer] ${line.trim()}`);
        }
      });
      proc.on('error', (err) => reject(err));
      proc.on('close', (code) => {
        if (code === 0) {
          onLog(`[Minecraft] Modloader server installation completed.`);
          resolve();
        } else {
          reject(new Error(`Modloader installer (${installerJar}) exited with code ${code}`));
        }
      });
    });
  }

  public async prepareCurseForgeServerPack(
    instance: ServerInstance,
    serverDir: string,
    onLog: (line: string) => void,
    onStatus?: (status: 'installing' | 'starting') => void,
    javaOverride?: DetectedJava
  ): Promise<NativeLaunchPlan> {
    let zipSource = String(instance.config.SERVER_PACK_ZIP ?? '').trim();
    const markerPath = path.join(serverDir, '.serverforge-pack-installed');
    let recommendedJavaTag = String(instance.config.JAVA_IMAGE_TAG ?? 'java21');

    const alreadyHasRunnable =
      fs.existsSync(markerPath) ||
      Boolean(findNativeMinecraftLauncher(serverDir, 'java', instance.memoryLimitMb));

    if (!alreadyHasRunnable) {
      onStatus?.('installing');

      // Auto-resolve CurseForge Server Pack ZIP from CF_SLUG / CF_FILE_ID / CF_PAGE_URL if SERVER_PACK_ZIP is blank
      if (!zipSource) {
        const cfSlug = String(instance.config.CF_SLUG ?? '').trim();
        const cfFileId = String(instance.config.CF_FILE_ID ?? '').trim();
        const cfPageUrl = String(instance.config.CF_PAGE_URL ?? '').trim();
        const apiKey = this.getGlobalVars().CF_API_KEY ?? '';

        if (!this.curseforge) {
          throw new Error(
            'CurseForge Server Pack ZIP is not configured. Provide SERVER_PACK_ZIP (URL or local .zip path) or switch to Docker runtime.'
          );
        }

        onLog(`[CurseForge] Resolving Native Server Pack for "${cfSlug || cfPageUrl || instance.name}"...`);
        const resolved = await this.curseforge.resolveServerPackForNative({
          slug: cfSlug,
          fileId: cfFileId,
          pageUrl: cfPageUrl,
          apiKey,
        });
        zipSource = resolved.downloadUrl;
        recommendedJavaTag = resolved.recommendedJavaTag;
        onLog(
          `[CurseForge] Found Server Pack for "${resolved.modName}" (file #${resolved.serverPackFileId}, recommended ${resolved.recommendedJavaTag}).`
        );
      }

      const localZipPath = path.join(serverDir, 'server-pack.zip');
      if (/^https?:\/\//i.test(zipSource)) {
        onLog(`[CurseForge] Downloading Native Server Pack ZIP...`);
        await this.streamDownloadToFile(zipSource, localZipPath, onLog, 'CurseForge Server Pack');
      } else if (fs.existsSync(zipSource)) {
        onLog(`[CurseForge] Copying local Server Pack ZIP from ${zipSource}...`);
        fs.copyFileSync(zipSource, localZipPath);
      } else {
        throw new Error(`SERVER_PACK_ZIP path not found: ${zipSource}`);
      }

      onLog('[CurseForge] Extracting Server Pack ZIP...');
      await this.extractZip(localZipPath, serverDir);
      fs.rmSync(localZipPath, { force: true });

      if (flattenSingleRootSubdir(serverDir)) {
        onLog('[CurseForge] Flattened nested server pack directory into server root.');
      }

      fs.writeFileSync(markerPath, new Date().toISOString(), 'utf8');
      onLog('[CurseForge] Server Pack extracted cleanly.');
    }

    // Ensure matching Java runtime first so JVM arg sanitization knows the exact Java major version
    const requiredMajor = javaTagToMajor(recommendedJavaTag);
    const java =
      javaOverride ??
      (await ensureJavaRuntime(requiredMajor, this.toolsDir, onLog, {
        fetchImpl: this.fetchImpl,
      }));

    // Write eula.txt, merge server.properties, and update/sanitize user_jvm_args.txt
    writeMinecraftBaseConfig(serverDir, instance, 'ServerForge CurseForge Modpack', java.major, onLog);

    // Detect launcher; if only a Forge/NeoForge installer JAR was shipped, run it first
    let launcher = findNativeMinecraftLauncher(
      serverDir,
      java.javaBin,
      instance.memoryLimitMb,
      process.platform,
      java.major
    );
    if (!launcher) {
      const installerJar = findForgeOrNeoForgeInstallerJar(serverDir);
      if (installerJar) {
        onStatus?.('installing');
        await this.runModloaderInstaller(installerJar, serverDir, java, onLog);
        launcher = findNativeMinecraftLauncher(
          serverDir,
          java.javaBin,
          instance.memoryLimitMb,
          process.platform,
          java.major
        );
      }
    }

    if (!launcher) {
      throw new Error(
        `No runnable server startup script (.bat/.ps1/.sh), Forge/NeoForge args file, or server .jar was found in ${serverDir}. Verify the Server Pack ZIP contents or set a Custom Startup Script in Configuration.`
      );
    }

    onStatus?.('starting');
    return {
      ...launcher,
      extraEnv: {
        ...buildJavaEnv(process.env, java),
        ATM_RESTART: 'false',
        RESTART: 'false',
        AUTO_RESTART: 'false',
        SERVER_RESTART: 'false',
      },
    };
  }

  public async prepareJavaMinecraftServer(
    instance: ServerInstance,
    serverDir: string,
    onLog: (line: string) => void,
    onStatus?: (status: 'installing' | 'starting') => void,
    javaOverride?: DetectedJava
  ): Promise<NativeLaunchPlan> {
    const flavor = String(instance.config.SERVER_TYPE ?? 'PAPER').trim().toUpperCase();
    const mcVersion = String(instance.config.MC_VERSION ?? 'LATEST').trim();

    const requiredMajor = recommendJavaMajorForMcVersion(mcVersion);
    const java =
      javaOverride ??
      (await ensureJavaRuntime(requiredMajor, this.toolsDir, onLog, {
        fetchImpl: this.fetchImpl,
      }));

    let launcher = findNativeMinecraftLauncher(serverDir, java.javaBin, instance.memoryLimitMb);

    if (!launcher) {
      onStatus?.('installing');
      const jarPath = path.join(serverDir, 'server.jar');

      if (flavor === 'PAPER') {
        onLog(`[Minecraft] Resolving PaperMC build for version ${mcVersion}...`);
        const projRes = await this.fetchImpl('https://api.papermc.io/v2/projects/paper', {
          signal: AbortSignal.timeout(15_000),
        });
        if (!projRes.ok) throw new Error(`PaperMC API error (HTTP ${projRes.status})`);
        const projData = (await projRes.json()) as { versions?: string[] };
        const versions = projData.versions ?? [];
        const targetVer =
          mcVersion.toUpperCase() === 'LATEST' ? versions[versions.length - 1] : mcVersion;
        if (!targetVer || !versions.includes(targetVer)) {
          throw new Error(`PaperMC version "${mcVersion}" was not found.`);
        }

        const buildsRes = await this.fetchImpl(
          `https://api.papermc.io/v2/projects/paper/versions/${encodeURIComponent(targetVer)}/builds`,
          { signal: AbortSignal.timeout(15_000) }
        );
        if (!buildsRes.ok) throw new Error(`PaperMC builds API error (HTTP ${buildsRes.status})`);
        const buildsData = (await buildsRes.json()) as {
          builds?: Array<{ build: number; downloads?: { application?: { name?: string } } }>;
        };
        const latestBuild = buildsData.builds?.[buildsData.builds.length - 1];
        const jarName = latestBuild?.downloads?.application?.name;
        if (!latestBuild || !jarName) {
          throw new Error(`No downloadable PaperMC JAR found for Minecraft ${targetVer}.`);
        }

        const downloadUrl = `https://api.papermc.io/v2/projects/paper/versions/${encodeURIComponent(targetVer)}/builds/${latestBuild.build}/downloads/${encodeURIComponent(jarName)}`;
        onLog(`[Minecraft] Downloading Paper ${targetVer} build #${latestBuild.build}...`);
        await this.streamDownloadToFile(downloadUrl, jarPath, onLog, `Paper ${targetVer}`);
      } else if (flavor === 'VANILLA') {
        onLog(`[Minecraft] Resolving Mojang Vanilla server for version ${mcVersion}...`);
        const manifestRes = await this.fetchImpl('https://piston-meta.mojang.com/mc/game/version_manifest_v2.json', {
          signal: AbortSignal.timeout(15_000),
        });
        if (!manifestRes.ok) throw new Error(`Mojang version manifest error (HTTP ${manifestRes.status})`);
        const manifest = (await manifestRes.json()) as {
          latest?: { release?: string };
          versions?: Array<{ id: string; url: string }>;
        };
        const targetId =
          mcVersion.toUpperCase() === 'LATEST' ? manifest.latest?.release : mcVersion;
        const entry = (manifest.versions ?? []).find((v) => v.id === targetId);
        if (!entry) throw new Error(`Vanilla Minecraft version "${mcVersion}" was not found.`);

        const verRes = await this.fetchImpl(entry.url, { signal: AbortSignal.timeout(15_000) });
        if (!verRes.ok) throw new Error(`Mojang version metadata error (HTTP ${verRes.status})`);
        const verMeta = (await verRes.json()) as { downloads?: { server?: { url?: string } } };
        const serverUrl = verMeta.downloads?.server?.url;
        if (!serverUrl) throw new Error(`No server JAR download available for Vanilla ${entry.id}.`);

        onLog(`[Minecraft] Downloading Vanilla Minecraft ${entry.id} server.jar...`);
        await this.streamDownloadToFile(serverUrl, jarPath, onLog, `Vanilla ${entry.id}`);
      } else if (flavor === 'FABRIC') {
        onLog(`[Minecraft] Resolving Fabric server launcher for version ${mcVersion}...`);
        const [gamesRes, loadersRes, installersRes] = await Promise.all([
          this.fetchImpl('https://meta.fabricmc.net/v2/versions/game', { signal: AbortSignal.timeout(15_000) }),
          this.fetchImpl('https://meta.fabricmc.net/v2/versions/loader', { signal: AbortSignal.timeout(15_000) }),
          this.fetchImpl('https://meta.fabricmc.net/v2/versions/installer', { signal: AbortSignal.timeout(15_000) }),
        ]);
        if (!gamesRes.ok || !loadersRes.ok || !installersRes.ok) {
          throw new Error('Fabric Meta API request failed.');
        }
        const games = (await gamesRes.json()) as Array<{ version: string; stable: boolean }>;
        const loaders = (await loadersRes.json()) as Array<{ version: string; stable: boolean }>;
        const installers = (await installersRes.json()) as Array<{ version: string; stable: boolean }>;

        const targetMc =
          mcVersion.toUpperCase() === 'LATEST'
            ? (games.find((g) => g.stable)?.version ?? games[0]?.version)
            : mcVersion;
        const targetLoader = loaders.find((l) => l.stable)?.version ?? loaders[0]?.version;
        const targetInstaller = installers.find((i) => i.stable)?.version ?? installers[0]?.version;

        if (!targetMc || !targetLoader || !targetInstaller) {
          throw new Error(`Could not resolve Fabric loader/installer versions for Minecraft ${mcVersion}.`);
        }

        const fabricUrl = `https://meta.fabricmc.net/v2/versions/loader/${encodeURIComponent(targetMc)}/${encodeURIComponent(targetLoader)}/${encodeURIComponent(targetInstaller)}/server/jar`;
        onLog(`[Minecraft] Downloading Fabric ${targetMc} (loader ${targetLoader}) server.jar...`);
        await this.streamDownloadToFile(fabricUrl, jarPath, onLog, `Fabric ${targetMc}`);
      } else {
        throw new Error(
          `Native auto-install for "${flavor}" is not yet built into the vanilla Minecraft template. Use the "Minecraft (CurseForge Modpack)" template for native modded servers, or deploy with the Docker runtime.`
        );
      }

      launcher = findNativeMinecraftLauncher(serverDir, java.javaBin, instance.memoryLimitMb);
    }

    writeMinecraftBaseConfig(serverDir, instance, 'ServerForge Minecraft World');

    if (!launcher) {
      throw new Error(`Minecraft server JAR was not found in ${serverDir}.`);
    }

    onStatus?.('starting');
    return {
      ...launcher,
      extraEnv: buildJavaEnv(process.env, java),
    };
  }

  async start(
    instance: ServerInstance,
    template: GameTemplate,
    instanceDir: string,
    onLog: (line: string) => void,
    onExit: (code: number | null) => void,
    onStatus?: (status: 'installing' | 'starting') => void
  ): Promise<RuntimeStartResult> {
    const nativeSpec = template.runtimes.native;
    if (!nativeSpec) {
      throw new Error(`Game template "${template.name}" does not define a Native runtime.`);
    }

    const serverDir = instance.externalDir
      ? path.resolve(instance.externalDir)
      : path.join(instanceDir, 'server');
    fs.mkdirSync(serverDir, { recursive: true });

    let customLaunch: NativeLaunchPlan | null = null;
    const isWin = process.platform === 'win32';

    if (instance.launchScript) {
      const script = instance.launchScript.trim();
      const scriptPath = path.isAbsolute(script) ? script : path.join(serverDir, script);
      const lower = script.toLowerCase();
      if (lower.endsWith('.bat') || lower.endsWith('.cmd')) {
        // When relative, run inside cwd=serverDir via `cmd.exe /d /c <script>` to avoid
        // Windows cmd.exe quote-stripping bugs on folder paths containing spaces.
        const cmdTarget = path.isAbsolute(script) ? scriptPath : script;
        customLaunch = { exe: 'cmd.exe', args: ['/d', '/c', cmdTarget] };
      } else if (lower.endsWith('.ps1')) {
        customLaunch = {
          exe: 'powershell.exe',
          args: ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', scriptPath],
        };
      } else if (lower.endsWith('.sh')) {
        customLaunch = { exe: 'bash', args: [scriptPath] };
      } else if (lower.endsWith('.jar')) {
        const minMem = Math.min(2048, instance.memoryLimitMb);
        customLaunch = {
          exe: 'java',
          args: [`-Xms${minMem}M`, `-Xmx${instance.memoryLimitMb}M`, '-jar', scriptPath, 'nogui'],
        };
      } else if (fs.existsSync(scriptPath)) {
        customLaunch = { exe: scriptPath, args: [] };
      }
    } else if (!instance.externalDir) {
      if (template.id === 'minecraft-curseforge') {
        customLaunch = await this.prepareCurseForgeServerPack(instance, serverDir, onLog, onStatus);
      } else if (nativeSpec.installer === 'java') {
        customLaunch = await this.prepareJavaMinecraftServer(instance, serverDir, onLog, onStatus);
      } else if (nativeSpec.installer === 'steamcmd' && nativeSpec.steamAppId) {
        onStatus?.('installing');
        await this.ensureSteamCmdInstalled(nativeSpec.steamAppId, serverDir, nativeSpec.steamBeta, onLog);
        onStatus?.('starting');
      }
    }

    const vars = buildTemplateVariables({
      config: instance.config,
      ports: instance.ports,
      memoryLimitMb: instance.memoryLimitMb,
    });

    const rawExe = isWin ? nativeSpec.executableWindows : (nativeSpec.executableLinux ?? nativeSpec.executableWindows);
    const defaultExePath =
      path.isAbsolute(rawExe) || (!rawExe.includes('/') && !rawExe.includes('\\'))
        ? rawExe
        : path.join(serverDir, rawExe);

    const renderedArgs = renderTemplateString(nativeSpec.argsTemplate, vars);
    const exePath = customLaunch?.exe ?? defaultExePath;
    const args = customLaunch?.args ?? splitArgs(renderedArgs);

    const env: NodeJS.ProcessEnv = { ...process.env, ...(customLaunch?.extraEnv ?? {}) };
    for (const [k, v] of Object.entries(nativeSpec.envTemplate)) {
      env[k] = renderTemplateString(v, vars);
    }

    const cwd = nativeSpec.workingSubdir ? path.join(serverDir, nativeSpec.workingSubdir) : serverDir;
    fs.mkdirSync(cwd, { recursive: true });

    onLog(`[Native] Spawning: ${exePath} ${args.join(' ')}`);
    const child = spawn(exePath, args, {
      cwd,
      env,
      windowsHide: true,
      stdio: ['pipe', 'pipe', 'pipe'],
    });

    const pipeLines = (stream: NodeJS.ReadableStream | null) => {
      if (!stream) return;
      let leftover = '';
      stream.on('data', (chunk: Buffer) => {
        const combined = leftover + chunk.toString('utf8');
        const lines = combined.split(/\r?\n/);
        leftover = lines.pop() ?? '';
        for (const line of lines) {
          if (line.trim()) onLog(line);
        }
      });
      stream.on('end', () => {
        if (leftover.trim()) {
          onLog(leftover.trim());
          leftover = '';
        }
      });
    };

    pipeLines(child.stdout);
    pipeLines(child.stderr);

    // Wait for either successful OS process spawn or immediate spawn error (e.g., ENOENT)
    await new Promise<void>((resolve, reject) => {
      const onSpawn = () => {
        child.off('error', onSpawnError);
        resolve();
      };
      const onSpawnError = (err: Error) => {
        child.off('spawn', onSpawn);
        onLog(`[Native] Process error: ${err.message}`);
        reject(new Error(`Failed to spawn native server binary (${exePath}): ${err.message}`));
      };
      child.once('spawn', onSpawn);
      child.once('error', onSpawnError);
    });

    if (!child.pid) {
      throw new Error(`Failed to spawn native server binary: ${exePath}`);
    }

    this.processes.set(instance.id, { child, startedAt: Date.now() });

    child.on('error', (err) => {
      onLog(`[Native] Process error: ${err.message}`);
    });

    child.on('exit', (code) => {
      this.processes.delete(instance.id);
      onLog(`[Native] Process exited with code ${code ?? 'unknown'}.`);
      onExit(code);
    });

    return { externalId: String(child.pid) };
  }

  async stop(instance: ServerInstance, template: GameTemplate, onLog: (line: string) => void): Promise<void> {
    const managed = this.processes.get(instance.id);
    if (!managed) return;

    onLog(`[Native] Saving world & initiating graceful shutdown for ${instance.name}...`);
    await this.queryService.performGracefulSave(instance, template);

    // If the template uses stdin stop commands, write it
    if (template.lifecycle.saveMethod === 'stdin' && template.lifecycle.stopCommand && managed.child.stdin?.writable) {
      managed.child.stdin.write(`${template.lifecycle.stopCommand}\n`);
    }

    const timeoutMs = template.lifecycle.gracefulStopTimeoutSeconds * 1000;
    const exitedCleanly = await new Promise<boolean>((resolve) => {
      if (managed.child.exitCode !== null) return resolve(true);
      const timer = setTimeout(() => resolve(false), Math.min(timeoutMs, 15000));
      managed.child.once('exit', () => {
        clearTimeout(timer);
        resolve(true);
      });
      if (process.platform !== 'win32') {
        managed.child.kill('SIGTERM');
      }
    });

    if (!exitedCleanly && managed.child.pid) {
      onLog(`[Native] Graceful shutdown timed out; terminating process tree (PID ${managed.child.pid})...`);
      if (process.platform === 'win32') {
        await new Promise<void>((resolve) => {
          execFile('taskkill', ['/PID', String(managed.child.pid), '/T', '/F'], () => resolve());
        });
      } else {
        managed.child.kill('SIGKILL');
      }
    }

    this.processes.delete(instance.id);
  }

  async sendCommand(instance: ServerInstance, template: GameTemplate, command: string): Promise<string | null> {
    // Prefer RCON when configured
    const rconReply = await this.queryService.sendRcon(instance, template, command);
    if (rconReply !== null) return rconReply;

    // Fallback to stdin
    const managed = this.processes.get(instance.id);
    if (managed?.child.stdin?.writable) {
      managed.child.stdin.write(`${command}\n`);
      return 'Command written to server stdin.';
    }
    return null;
  }

  async getStats(instance: ServerInstance, template: GameTemplate): Promise<InstanceRuntimeStats | null> {
    const managed = this.processes.get(instance.id);
    if (!managed) return null;

    const uptimeSeconds = Math.max(0, Math.floor((Date.now() - managed.startedAt) / 1000));
    const query = await this.queryService.queryPlayers(instance, template);

    return {
      cpuPercent: 0,
      memoryMb: 0,
      playerCount: query.playerCount,
      maxPlayers: query.maxPlayers,
      players: query.players,
      uptimeSeconds,
    };
  }

  async isRunning(instance: ServerInstance): Promise<boolean> {
    const managed = this.processes.get(instance.id);
    return Boolean(managed && managed.child.exitCode === null);
  }

  async remove(instance: ServerInstance): Promise<void> {
    const managed = this.processes.get(instance.id);
    if (managed && managed.child.exitCode === null) {
      if (process.platform === 'win32' && managed.child.pid) {
        await new Promise<void>((resolve) => {
          execFile('taskkill', ['/PID', String(managed.child.pid), '/T', '/F'], () => resolve());
        });
      } else {
        managed.child.kill('SIGKILL');
      }
      this.processes.delete(instance.id);
    }
  }
}
