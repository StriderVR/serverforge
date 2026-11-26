import fs from 'node:fs';
import path from 'node:path';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { spawn, execFile, type ChildProcess } from 'node:child_process';
import type { GameTemplate, InstanceRuntimeStats, ServerInstance } from '@serverforge/shared';
import { buildTemplateVariables, renderTemplateString } from '../catalog/catalog-service.js';
import type { QueryService } from '../query/query-service.js';
import type { CurseForgeService } from '../services/curseforge-service.js';
import { parsePropertiesFile } from '../services/import-service.js';
import type { ModrinthService } from '../services/modrinth-service.js';
import {
  buildFactorioWin64DownloadUrl,
  FACTORIO_LINUX_HEADLESS_URL,
  findFactorioExecutableInRoot,
  findLocalFactorioInstall,
  hasExistingFactorioSave,
  probeWslAvailable,
  toWslPath,
  writeFactorioConfigFiles,
} from './factorio-helper.js';
import {
  buildJavaEnv,
  ensureJavaRuntime,
  javaTagToMajor,
  parseRequiredJavaFromCrashLogs,
  recommendJavaMajorForMcVersion,
  type DetectedJava,
} from './java-helper.js';
import { splitArgs, type RuntimeAdapter, type RuntimeStartResult } from './runtime-adapter.js';
import {
  buildArkAsaNativeLaunchPlan,
  buildPalworldNativeLaunchPlan,
  buildSatisfactoryNativeLaunchPlan,
  ensureSteamCmd,
  writePalworldSettingsIni,
} from './steamcmd-helper.js';

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
 * (for example `-XX:+UseCompactObjectHeaders`, which requires Java 24/25 and crashes Java 21),
 * and re-enables lines previously commented out by ServerForge when the active Java runtime supports them.
 */
export function sanitizeUserJvmArgs(
  content: string,
  javaMajor: number
): { content: string; removedFlags: string[]; restoredFlags: string[] } {
  const removedFlags: string[] = [];
  const restoredFlags: string[] = [];
  const outLines = content.split(/\r?\n/).map((line) => {
    const trimmed = line.trim();
    if (!trimmed) return line;

    // Re-enable flags previously disabled by ServerForge if the current Java version now supports them
    const disabledMatch = trimmed.match(/^#\s*\[ServerForge\]\s+disabled for Java \d+:\s*(.+)$/i);
    if (disabledMatch) {
      const originalLine = disabledMatch[1].trim();
      const origTokens = originalLine.split(/\s+/).filter(Boolean);
      if (origTokens.length > 0 && !origTokens.some((tok) => isIncompatibleJvmFlag(tok, javaMajor))) {
        restoredFlags.push(...origTokens);
        return originalLine;
      }
      return line;
    }

    if (trimmed.startsWith('#')) return line;
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
  return { content: outLines.join('\n'), removedFlags, restoredFlags };
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
 * Inspects an extracted Minecraft / CurseForge server folder for artifacts indicating
 * a specific minimum Java major version (for example, Minecraft 26.x / NeoForge 26.x+
 * server libraries, installers, or start scripts that require Java 25).
 */
export function detectRequiredJavaMajorFromServerDir(serverDir: string): number | null {
  if (!fs.existsSync(serverDir)) return null;
  let highest: number | null = null;
  const noteRequired = (major: number | null) => {
    if (major !== null) {
      highest = highest === null ? major : Math.max(highest, major);
    }
  };

  // 1. Check installed NeoForge / Minecraft / Forge library version folders
  const versionedLibRoots: Array<{ dir: string; kind: 'neoforge' | 'minecraft' | 'forge' }> = [
    { dir: path.join(serverDir, 'libraries', 'net', 'neoforged', 'neoforge'), kind: 'neoforge' },
    { dir: path.join(serverDir, 'libraries', 'net', 'minecraft', 'server'), kind: 'minecraft' },
    { dir: path.join(serverDir, 'libraries', 'net', 'minecraftforge', 'forge'), kind: 'forge' },
  ];

  for (const { dir, kind } of versionedLibRoots) {
    if (!fs.existsSync(dir)) continue;
    try {
      for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        if (!entry.isDirectory()) continue;
        const m = entry.name.match(/^(\d+)\.(\d+)(?:\.(\d+))?/);
        if (!m) continue;
        const major = Number.parseInt(m[1], 10);
        if (major >= 26) {
          // Mojang / NeoForge 26.x+ (2026+ releases) require Java 25
          noteRequired(25);
        } else if (kind === 'minecraft' || kind === 'forge') {
          noteRequired(recommendJavaMajorForMcVersion(entry.name));
        } else if (kind === 'neoforge' && major >= 21) {
          noteRequired(21);
        }
      }
    } catch {
      // ignore unreadable directories
    }
  }

  // 2. Check root installer JARs (e.g., neoforge-26.1.2.126-installer.jar)
  try {
    const files = fs.readdirSync(serverDir);
    for (const file of files) {
      const instMatch = file.match(/^(?:neo)?forge-(\d+)\.(\d+)(?:\.(\d+))?/i);
      if (instMatch) {
        const major = Number.parseInt(instMatch[1], 10);
        if (major >= 26) {
          noteRequired(25);
        } else if (major === 1) {
          noteRequired(recommendJavaMajorForMcVersion(`${instMatch[1]}.${instMatch[2]}.${instMatch[3] ?? '0'}`));
        }
      }
    }
  } catch {
    // ignore unreadable root
  }

  // 3. Inspect pack metadata/startup scripts for explicit 26.x / Java 25 declarations
  const hintFiles = [
    'startserver.bat',
    'startserver.sh',
    'startserver.ps1',
    'variables.txt',
    'server-setup-config.yaml',
  ];
  for (const name of hintFiles) {
    const full = path.join(serverDir, name);
    if (!fs.existsSync(full)) continue;
    try {
      const stat = fs.statSync(full);
      if (!stat.isFile() || stat.size > 256 * 1024) continue;
      const content = fs.readFileSync(full, 'utf8');
      if (
        /\b(?:NEOFORGE_VERSION|MC_VERSION|MINECRAFT_VERSION|MODLOADER_VERSION)\s*[:=]\s*["']?(?:2[6-9]|[3-9]\d)\.\d+/i.test(
          content
        ) ||
        /\bJAVA_VERSION\s*[:=]\s*["']?25\b/i.test(content) ||
        /neoforge-(?:2[6-9]|[3-9]\d)\.\d+/i.test(content)
      ) {
        noteRequired(25);
      }
    } catch {
      // ignore unreadable hint file
    }
  }

  return highest;
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
      if (sanitized.restoredFlags.length > 0) {
        onLog?.(
          `[Java] Re-enabled JVM flag(s) compatible with Java ${javaMajor} in user_jvm_args.txt: ${Array.from(new Set(sanitized.restoredFlags)).join(', ')}`
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

const PRESERVED_MODPACK_ROOT_ENTRIES = new Set([
  'world',
  'world_nether',
  'world_the_end',
  'server.properties',
  'whitelist.json',
  'ops.json',
  'banned-players.json',
  'banned-ips.json',
  'eula.txt',
  'user_jvm_args.txt',
  'logs',
  'crash-reports',
  'backups',
  '.serverforge-modrinth.json',
]);

const MODPACK_REPLACE_DIRS = new Set([
  'mods',
  'config',
  'defaultconfigs',
  'kubejs',
  'scripts',
  'libraries',
  'packmenu',
]);

/**
 * Safely upgrades a modpack server directory from a staged extraction folder while
 * preserving worlds (including custom `level-name`), `server.properties`, `whitelist.json`,
 * `ops.json`, `banned-*.json`, `eula.txt`, and `user_jvm_args.txt`.
 */
export function applySafeModpackUpgrade(
  stagedDir: string,
  serverDir: string,
  onLog: (line: string) => void
): { replacedCount: number; preservedEntries: string[] } {
  fs.mkdirSync(serverDir, { recursive: true });
  const preserved = new Set(PRESERVED_MODPACK_ROOT_ENTRIES);

  // Also preserve custom `level-name` world folder configured in server.properties
  const propsPath = path.join(serverDir, 'server.properties');
  if (fs.existsSync(propsPath)) {
    const props = parsePropertiesFile(fs.readFileSync(propsPath, 'utf8'));
    const levelName = props['level-name']?.trim();
    if (levelName) {
      preserved.add(levelName.toLowerCase());
    }
  }

  let replacedCount = 0;
  const skippedPreserved: string[] = [];

  for (const entry of fs.readdirSync(stagedDir, { withFileTypes: true })) {
    const lower = entry.name.toLowerCase();
    if (preserved.has(lower)) {
      skippedPreserved.push(entry.name);
      continue;
    }

    const src = path.join(stagedDir, entry.name);
    const dst = path.join(serverDir, entry.name);

    if (entry.isDirectory() && MODPACK_REPLACE_DIRS.has(lower) && fs.existsSync(dst)) {
      fs.rmSync(dst, { recursive: true, force: true, maxRetries: 4, retryDelay: 150 });
    }
    fs.cpSync(src, dst, { recursive: true, force: true });
    replacedCount += 1;
  }

  onLog(
    `[Update] Applied ${replacedCount} modpack item(s) while preserving user worlds & configs${skippedPreserved.length > 0 ? ` (${skippedPreserved.join(', ')})` : ''}.`
  );
  return { replacedCount, preservedEntries: skippedPreserved };
}

export class NativeProcessRuntimeAdapter implements RuntimeAdapter {
  public readonly kind = 'native' as const;
  private readonly processes = new Map<string, ManagedProcess>();

  constructor(
    private readonly toolsDir: string,
    private readonly queryService: QueryService,
    private readonly curseforge?: CurseForgeService,
    private readonly getGlobalVars: () => Record<string, string> = () => ({}),
    private readonly fetchImpl: typeof fetch = fetch,
    private readonly modrinth?: ModrinthService
  ) {}

  async isAvailable(): Promise<boolean> {
    return true;
  }

  private async ensureSteamCmdInstalled(
    appId: number,
    installDir: string,
    beta: string | undefined,
    onLog: (line: string) => void
  ): Promise<void> {
    const steamcmdBin = await ensureSteamCmd(this.toolsDir, onLog, {
      fetchImpl: this.fetchImpl,
    });
    const resolvedDir = path.resolve(installDir);
    fs.mkdirSync(resolvedDir, { recursive: true });
    onLog(
      `[SteamCMD] Updating/verifying Steam AppID ${appId}${beta ? ` (branch: ${beta})` : ''} in ${resolvedDir}...`
    );

    const args = ['+force_install_dir', resolvedDir, '+login', 'anonymous', '+app_update', String(appId)];
    if (beta) {
      args.push('-beta', beta);
    }
    args.push('validate', '+quit');

    const runOnce = () =>
      new Promise<{ code: number | null; sawSuccess: boolean }>((resolve, reject) => {
        let sawSuccess = false;
        const proc = spawn(steamcmdBin, args, {
          cwd: path.dirname(steamcmdBin),
          windowsHide: true,
        });
        const handleChunk = (d: Buffer) => {
          for (const line of d.toString('utf8').split(/\r?\n/)) {
            const trimmed = line.trim();
            if (!trimmed) continue;
            if (
              new RegExp(`Success!\\s+App\\s+'?${appId}'?\\s+(?:fully installed|already up to date)`, 'i').test(trimmed)
            ) {
              sawSuccess = true;
            }
            onLog(`[SteamCMD] ${trimmed}`);
          }
        };
        proc.stdout?.on('data', handleChunk);
        proc.stderr?.on('data', handleChunk);
        proc.on('error', (err) => {
          reject(new Error(`Failed to launch SteamCMD (${steamcmdBin}): ${err.message}`));
        });
        proc.on('close', (code) => {
          resolve({ code, sawSuccess });
        });
      });

    // Freshly extracted SteamCMD on Windows self-updates on its first run and may exit with code 7 once.
    for (let attempt = 1; attempt <= 2; attempt++) {
      const { code, sawSuccess } = await runOnce();
      if (code === 0 || sawSuccess) {
        onLog(`[SteamCMD] AppID ${appId} is up to date.`);
        return;
      }
      if (attempt === 1 && (code === 7 || code === 8)) {
        onLog(
          `[SteamCMD] SteamCMD exited with code ${code} (common during first-run SteamCMD self-update or transient CDN reset). Retrying automatically...`
        );
        continue;
      }
      throw new Error(`SteamCMD exited with code ${code ?? 'unknown'} while installing AppID ${appId}.`);
    }
  }

  private async streamDownloadToFile(
    url: string,
    destPath: string,
    onLog: (line: string) => void,
    label: string
  ): Promise<void> {
    const res = await this.fetchImpl(url, {
      headers: { 'User-Agent': 'ServerForge (+https://github.com/StriderVR/serverforge)' },
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
    await this.extractArchive(zipPath, destDir);
  }

  private async extractArchive(archivePath: string, destDir: string): Promise<void> {
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
          else reject(new Error(`${cmd} exited with code ${code}${errOut ? `: ${errOut.slice(0, 200)}` : ''}`));
        });
      });

    const lower = archivePath.toLowerCase();

    if (process.platform === 'win32') {
      // Windows 10/11 includes native bsdtar (`tar.exe`), which extracts .zip, .tar.gz, and .tar.xz cleanly
      try {
        await runExtractor('tar', ['-xf', archivePath, '-C', destDir]);
        return;
      } catch (tarErr) {
        if (lower.endsWith('.zip')) {
          await runExtractor('powershell.exe', [
            '-NoProfile',
            '-Command',
            `Expand-Archive -Path '${archivePath.replace(/'/g, "''")}' -DestinationPath '${destDir.replace(/'/g, "''")}' -Force`,
          ]);
          return;
        }
        throw tarErr;
      }
    }

    if (lower.endsWith('.tar.xz') || lower.endsWith('.txz')) {
      await runExtractor('tar', ['-xJf', archivePath, '-C', destDir]);
      return;
    }
    if (lower.endsWith('.tar.gz') || lower.endsWith('.tgz')) {
      await runExtractor('tar', ['-xzf', archivePath, '-C', destDir]);
      return;
    }
    await runExtractor('unzip', ['-o', archivePath, '-d', destDir]);
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
    let requiredMajor = javaTagToMajor(recommendedJavaTag);
    const detectedFromDir = detectRequiredJavaMajorFromServerDir(serverDir);
    if (detectedFromDir !== null && detectedFromDir > requiredMajor) {
      onLog(
        `[Java] Detected Minecraft/NeoForge pack files requiring Java ${detectedFromDir} in server directory (was configured for Java ${requiredMajor}) — upgrading runtime automatically.`
      );
      requiredMajor = detectedFromDir;
    }
    const detectedFromCrash = parseRequiredJavaFromCrashLogs(instance.lastCrash?.logTail ?? []);
    if (detectedFromCrash !== null && detectedFromCrash > requiredMajor) {
      onLog(
        `[Java] Previous crash log indicated Java ${detectedFromCrash} is required — upgrading runtime automatically.`
      );
      requiredMajor = detectedFromCrash;
    }

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

  public async prepareModrinthModpack(
    instance: ServerInstance,
    serverDir: string,
    onLog: (line: string) => void,
    onStatus?: (status: 'installing' | 'starting') => void,
    javaOverride?: DetectedJava
  ): Promise<NativeLaunchPlan> {
    const markerPath = path.join(serverDir, '.serverforge-mrpack-installed');
    let recommendedJavaTag = String(instance.config.JAVA_IMAGE_TAG ?? 'java21');
    let mcVersion = '';
    let fabricVersion = '';

    const alreadyHasRunnable =
      fs.existsSync(markerPath) ||
      Boolean(findNativeMinecraftLauncher(serverDir, 'java', instance.memoryLimitMb));

    if (!alreadyHasRunnable) {
      if (!this.modrinth) {
        throw new Error('Modrinth service is unavailable for native .mrpack installation.');
      }
      onStatus?.('installing');
      const { index } = await this.modrinth.installMrpackArchive(
        {
          projectIdOrSlug: String(instance.config.MR_PROJECT_ID ?? ''),
          versionId: String(instance.config.MR_VERSION_ID ?? ''),
          packUrlOrPath: String(instance.config.MR_PACK_URL ?? ''),
        },
        serverDir,
        onLog
      );

      mcVersion = index.dependencies?.minecraft ?? '';
      fabricVersion = index.dependencies?.['fabric-loader'] ?? '';
      if (mcVersion) {
        const major = recommendJavaMajorForMcVersion(mcVersion);
        recommendedJavaTag = `java${major}`;
      }

      // If no server launcher jar exists yet, auto-install the Fabric server jar when Fabric is declared
      const jarPath = path.join(serverDir, 'server.jar');
      if (!findNativeMinecraftLauncher(serverDir, 'java', instance.memoryLimitMb)) {
        if (fabricVersion && mcVersion) {
          onLog(`[Modrinth] Installing Fabric server launcher (MC ${mcVersion}, loader ${fabricVersion})...`);
          const instRes = await this.fetchImpl('https://meta.fabricmc.net/v2/versions/installer', {
            signal: AbortSignal.timeout(15_000),
          });
          if (instRes.ok) {
            const installers = (await instRes.json()) as Array<{ version: string; stable: boolean }>;
            const installerVer = installers.find((i) => i.stable)?.version ?? installers[0]?.version ?? '1.0.1';
            const fabricUrl = `https://meta.fabricmc.net/v2/versions/loader/${encodeURIComponent(mcVersion)}/${encodeURIComponent(fabricVersion)}/${encodeURIComponent(installerVer)}/server/jar`;
            await this.streamDownloadToFile(fabricUrl, jarPath, onLog, `Fabric ${mcVersion}`);
          }
        } else if (mcVersion && !index.dependencies?.forge && !index.dependencies?.neoforge) {
          // Vanilla fallback for pure resource/datapack .mrpack
          const manifestRes = await this.fetchImpl('https://piston-meta.mojang.com/mc/game/version_manifest_v2.json', {
            signal: AbortSignal.timeout(15_000),
          });
          if (manifestRes.ok) {
            const manifest = (await manifestRes.json()) as { versions?: Array<{ id: string; url: string }> };
            const entry = (manifest.versions ?? []).find((v) => v.id === mcVersion);
            if (entry) {
              const verRes = await this.fetchImpl(entry.url, { signal: AbortSignal.timeout(15_000) });
              if (verRes.ok) {
                const verMeta = (await verRes.json()) as { downloads?: { server?: { url?: string } } };
                if (verMeta.downloads?.server?.url) {
                  await this.streamDownloadToFile(verMeta.downloads.server.url, jarPath, onLog, `Vanilla ${mcVersion}`);
                }
              }
            }
          }
        }
      }

      fs.writeFileSync(markerPath, new Date().toISOString(), 'utf8');
      onLog('[Modrinth] Modpack installed cleanly.');
    }

    let requiredMajor = javaTagToMajor(recommendedJavaTag);
    const detectedFromDir = detectRequiredJavaMajorFromServerDir(serverDir);
    if (detectedFromDir !== null && detectedFromDir > requiredMajor) {
      requiredMajor = detectedFromDir;
    }

    const java =
      javaOverride ??
      (await ensureJavaRuntime(requiredMajor, this.toolsDir, onLog, {
        fetchImpl: this.fetchImpl,
      }));

    writeMinecraftBaseConfig(serverDir, instance, 'ServerForge Modrinth Modpack', java.major, onLog);

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
        `No runnable Minecraft server JAR or startup script was found in ${serverDir} after installing the Modrinth pack.`
      );
    }

    onStatus?.('starting');
    return {
      ...launcher,
      extraEnv: buildJavaEnv(process.env, java),
    };
  }

  public async updateSteamCmdServer(
    template: GameTemplate,
    instance: ServerInstance,
    serverDir: string,
    onLog: (line: string) => void
  ): Promise<void> {
    const appId = template.runtimes.native?.steamAppId;
    if (!appId) {
      throw new Error(`Template "${template.name}" does not have a SteamCMD AppID.`);
    }
    const steamBeta =
      template.id === 'satisfactory' && Boolean(instance.config.EXPERIMENTAL)
        ? 'experimental'
        : template.runtimes.native?.steamBeta;
    await this.ensureSteamCmdInstalled(appId, serverDir, steamBeta, onLog);
  }

  public async upgradeCurseForgeModpack(
    instance: ServerInstance,
    serverDir: string,
    targetFileId: string | undefined,
    onLog: (line: string) => void
  ): Promise<{ newFileId: string; recommendedJavaTag: string }> {
    if (!this.curseforge) {
      throw new Error('CurseForge service is unavailable.');
    }
    const cfSlug = String(instance.config.CF_SLUG ?? '').trim();
    const cfPageUrl = String(instance.config.CF_PAGE_URL ?? '').trim();
    const apiKey = this.getGlobalVars().CF_API_KEY ?? '';

    onLog(`[Update] Resolving CurseForge Server Pack for "${cfSlug || cfPageUrl || instance.name}"...`);
    const resolved = await this.curseforge.resolveServerPackForNative({
      slug: cfSlug,
      fileId: targetFileId ?? '',
      pageUrl: cfPageUrl,
      apiKey,
    });

    const stageDir = path.join(path.dirname(serverDir), `.cf-upgrade-${instance.id}-${Date.now()}`);
    const zipPath = path.join(stageDir, 'server-pack.zip');
    const extractDir = path.join(stageDir, 'extracted');
    fs.mkdirSync(extractDir, { recursive: true });

    try {
      onLog(
        `[Update] Downloading "${resolved.modName}" Server Pack (file #${resolved.serverPackFileId})...`
      );
      await this.streamDownloadToFile(resolved.downloadUrl, zipPath, onLog, 'CurseForge Upgrade');
      onLog('[Update] Extracting staged modpack upgrade...');
      await this.extractZip(zipPath, extractDir);
      flattenSingleRootSubdir(extractDir);
      applySafeModpackUpgrade(extractDir, serverDir, onLog);
      fs.writeFileSync(path.join(serverDir, '.serverforge-pack-installed'), new Date().toISOString(), 'utf8');
      return {
        newFileId: String(resolved.serverPackFileId),
        recommendedJavaTag: resolved.recommendedJavaTag,
      };
    } finally {
      fs.rmSync(stageDir, { recursive: true, force: true, maxRetries: 4, retryDelay: 150 });
    }
  }

  public async upgradeModrinthModpack(
    instance: ServerInstance,
    serverDir: string,
    targetVersionId: string | undefined,
    onLog: (line: string) => void
  ): Promise<{ newVersionId: string | null; recommendedJavaTag: string }> {
    if (!this.modrinth) {
      throw new Error('Modrinth service is unavailable.');
    }
    const stageDir = path.join(path.dirname(serverDir), `.mr-upgrade-${instance.id}-${Date.now()}`);
    fs.mkdirSync(stageDir, { recursive: true });
    try {
      const { index, resolvedVersionId } = await this.modrinth.installMrpackArchive(
        {
          projectIdOrSlug: String(instance.config.MR_PROJECT_ID ?? ''),
          versionId: targetVersionId ?? '',
          packUrlOrPath: String(instance.config.MR_PACK_URL ?? ''),
        },
        stageDir,
        onLog
      );
      applySafeModpackUpgrade(stageDir, serverDir, onLog);
      fs.writeFileSync(path.join(serverDir, '.serverforge-mrpack-installed'), new Date().toISOString(), 'utf8');
      const mcVer = index.dependencies?.minecraft ?? '';
      const recommendedJavaTag = mcVer ? `java${recommendJavaMajorForMcVersion(mcVer)}` : String(instance.config.JAVA_IMAGE_TAG ?? 'java21');
      return { newVersionId: resolvedVersionId, recommendedJavaTag };
    } finally {
      fs.rmSync(stageDir, { recursive: true, force: true, maxRetries: 4, retryDelay: 150 });
    }
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

    let requiredMajor = recommendJavaMajorForMcVersion(mcVersion);
    const detectedFromDir = detectRequiredJavaMajorFromServerDir(serverDir);
    if (detectedFromDir !== null && detectedFromDir > requiredMajor) {
      requiredMajor = detectedFromDir;
    }
    const detectedFromCrash = parseRequiredJavaFromCrashLogs(instance.lastCrash?.logTail ?? []);
    if (detectedFromCrash !== null && detectedFromCrash > requiredMajor) {
      requiredMajor = detectedFromCrash;
    }

    let java =
      javaOverride ??
      (await ensureJavaRuntime(requiredMajor, this.toolsDir, onLog, {
        fetchImpl: this.fetchImpl,
      }));

    let launcher = findNativeMinecraftLauncher(serverDir, java.javaBin, instance.memoryLimitMb, process.platform, java.major);

    if (!launcher) {
      onStatus?.('installing');
      const jarPath = path.join(serverDir, 'server.jar');
      let resolvedMcVersion: string | null = null;

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
        resolvedMcVersion = targetVer;

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
        resolvedMcVersion = entry.id;

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
        resolvedMcVersion = targetMc;

        const fabricUrl = `https://meta.fabricmc.net/v2/versions/loader/${encodeURIComponent(targetMc)}/${encodeURIComponent(targetLoader)}/${encodeURIComponent(targetInstaller)}/server/jar`;
        onLog(`[Minecraft] Downloading Fabric ${targetMc} (loader ${targetLoader}) server.jar...`);
        await this.streamDownloadToFile(fabricUrl, jarPath, onLog, `Fabric ${targetMc}`);
      } else {
        throw new Error(
          `Native auto-install for "${flavor}" is not yet built into the vanilla Minecraft template. Use the "Minecraft (CurseForge Modpack)" template for native modded servers, or deploy with the Docker runtime.`
        );
      }

      if (resolvedMcVersion && !javaOverride) {
        const resolvedMajor = recommendJavaMajorForMcVersion(resolvedMcVersion);
        if (resolvedMajor > java.major) {
          onLog(
            `[Java] Resolved Minecraft ${resolvedMcVersion} requires Java ${resolvedMajor} — upgrading runtime automatically.`
          );
          java = await ensureJavaRuntime(resolvedMajor, this.toolsDir, onLog, {
            fetchImpl: this.fetchImpl,
          });
        }
      }

      launcher = findNativeMinecraftLauncher(serverDir, java.javaBin, instance.memoryLimitMb, process.platform, java.major);
    }

    writeMinecraftBaseConfig(serverDir, instance, 'ServerForge Minecraft World', java.major, onLog);

    if (!launcher) {
      throw new Error(`Minecraft server JAR was not found in ${serverDir}.`);
    }

    onStatus?.('starting');
    return {
      ...launcher,
      extraEnv: buildJavaEnv(process.env, java),
    };
  }

  public async prepareFactorioServer(
    instance: ServerInstance,
    serverDir: string,
    onLog: (line: string) => void,
    onStatus?: (status: 'installing' | 'starting') => void,
    options: {
      platform?: NodeJS.Platform;
      searchDirs?: string[];
      steamVdfPaths?: string[];
      wslAvailableOverride?: boolean;
      skipCreateSaveExec?: boolean;
    } = {}
  ): Promise<NativeLaunchPlan> {
    const platform = options.platform ?? process.platform;
    let runViaWsl = false;
    let factorioExePath: string | null = null;

    // 1. Check if already installed directly inside this instance's serverDir
    const existingInDir = findFactorioExecutableInRoot(serverDir, platform);
    if (existingInDir) {
      factorioExePath = existingInDir;
    } else if (platform === 'win32') {
      // Also check if a Linux headless build was already extracted for WSL2 in this instance
      const existingLinuxInDir = findFactorioExecutableInRoot(serverDir, 'linux');
      if (existingLinuxInDir && (options.wslAvailableOverride ?? (await probeWslAvailable()))) {
        factorioExePath = existingLinuxInDir;
        runViaWsl = true;
      }
    }

    // 2. Optional user-provided FACTORIO_SOURCE (local directory, archive path, or URL)
    const sourceOverride = String(instance.config.FACTORIO_SOURCE ?? '').trim();
    if (!factorioExePath && sourceOverride) {
      if (fs.existsSync(sourceOverride) && fs.statSync(sourceOverride).isDirectory()) {
        const exeInOverride = findFactorioExecutableInRoot(sourceOverride, platform);
        if (!exeInOverride) {
          throw new Error(
            `FACTORIO_SOURCE folder "${sourceOverride}" does not contain a Factorio executable (expected bin/x64/${platform === 'win32' ? 'factorio.exe' : 'factorio'}).`
          );
        }
        onLog(`[Factorio] Using Factorio installation from ${sourceOverride}.`);
        factorioExePath = exeInOverride;
      } else {
        onStatus?.('installing');
        const ext = sourceOverride.toLowerCase().endsWith('.tar.xz')
          ? '.tar.xz'
          : sourceOverride.toLowerCase().endsWith('.tar.gz')
            ? '.tar.gz'
            : '.zip';
        const archivePath = path.join(serverDir, `factorio-source${ext}`);
        if (/^https?:\/\//i.test(sourceOverride)) {
          onLog('[Factorio] Downloading Factorio archive from FACTORIO_SOURCE URL...');
          await this.streamDownloadToFile(sourceOverride, archivePath, onLog, 'Factorio Server');
        } else if (fs.existsSync(sourceOverride)) {
          onLog(`[Factorio] Copying local Factorio archive from ${sourceOverride}...`);
          fs.copyFileSync(sourceOverride, archivePath);
        } else {
          throw new Error(`FACTORIO_SOURCE path not found: ${sourceOverride}`);
        }
        onLog('[Factorio] Extracting Factorio archive...');
        await this.extractArchive(archivePath, serverDir);
        fs.rmSync(archivePath, { force: true });
        flattenSingleRootSubdir(serverDir, 1);
        factorioExePath = findFactorioExecutableInRoot(serverDir, platform);
      }
    }

    // 3. Auto-detect local Steam / standalone installation (Windows) or download free headless (Linux)
    if (!factorioExePath) {
      const localDetected = findLocalFactorioInstall(serverDir, platform, {
        searchDirs: options.searchDirs,
        steamVdfPaths: options.steamVdfPaths,
      });
      if (localDetected) {
        onLog(
          `[Factorio] Auto-detected local Factorio installation at ${localDetected.exePath}. Using isolated instance config & saves in ${serverDir}.`
        );
        factorioExePath = localDetected.exePath;
      }
    }

    if (!factorioExePath && platform === 'linux') {
      onStatus?.('installing');
      const archivePath = path.join(serverDir, 'factorio-headless.tar.xz');
      onLog('[Factorio] Downloading official free Factorio Linux Headless server from factorio.com...');
      await this.streamDownloadToFile(FACTORIO_LINUX_HEADLESS_URL, archivePath, onLog, 'Factorio Headless');
      onLog('[Factorio] Extracting Factorio Linux Headless archive...');
      await this.extractArchive(archivePath, serverDir);
      fs.rmSync(archivePath, { force: true });
      flattenSingleRootSubdir(serverDir, 1);
      factorioExePath = findFactorioExecutableInRoot(serverDir, 'linux');
    }

    if (!factorioExePath && platform === 'win32') {
      const cfUser = String(instance.config.FACTORIO_USERNAME ?? '').trim();
      const cfToken = String(instance.config.FACTORIO_TOKEN ?? '').trim();

      if (cfUser && cfToken) {
        onStatus?.('installing');
        const archivePath = path.join(serverDir, 'factorio-win64.zip');
        onLog('[Factorio] Downloading official Factorio Windows 64-bit ZIP using Factorio.com credentials...');
        await this.streamDownloadToFile(
          buildFactorioWin64DownloadUrl(cfUser, cfToken),
          archivePath,
          onLog,
          'Factorio Windows ZIP'
        );
        onLog('[Factorio] Extracting Factorio Windows ZIP...');
        await this.extractArchive(archivePath, serverDir);
        fs.rmSync(archivePath, { force: true });
        flattenSingleRootSubdir(serverDir, 1);
        factorioExePath = findFactorioExecutableInRoot(serverDir, 'win32');
      } else if (options.wslAvailableOverride ?? (await probeWslAvailable())) {
        onStatus?.('installing');
        const archivePath = path.join(serverDir, 'factorio-headless.tar.xz');
        onLog(
          '[Factorio] No local Windows Factorio install found — WSL2 detected! Auto-downloading official free Factorio Linux Headless server...'
        );
        await this.streamDownloadToFile(FACTORIO_LINUX_HEADLESS_URL, archivePath, onLog, 'Factorio Headless (WSL2)');
        onLog('[Factorio] Extracting Factorio Headless archive...');
        try {
          await this.extractArchive(archivePath, serverDir);
        } catch {
          await new Promise<void>((resolve, reject) => {
            const proc = spawn('wsl.exe', ['-e', 'tar', '-xJf', toWslPath(archivePath), '-C', toWslPath(serverDir)], {
              windowsHide: true,
            });
            proc.on('error', reject);
            proc.on('close', (code) =>
              code === 0 ? resolve() : reject(new Error(`WSL tar extraction exited with code ${code}`))
            );
          });
        }
        fs.rmSync(archivePath, { force: true });
        flattenSingleRootSubdir(serverDir, 1);
        factorioExePath = findFactorioExecutableInRoot(serverDir, 'linux');
        if (factorioExePath) {
          runViaWsl = true;
        }
      }
    }

    if (!factorioExePath) {
      throw new Error(
        platform === 'win32'
          ? 'Factorio server binary was not found. Wube only distributes the free no-login headless server for Linux, so on Windows you have 3 easy options: (1) Install Factorio via Steam on this PC (ServerForge auto-detects it automatically), (2) Open Server Configuration and enter your Factorio.com Username + Auth Token (from factorio.com/profile) or a local Factorio ZIP/folder path in FACTORIO_SOURCE, or (3) Enable WSL2 (`wsl --install`) or switch Runtime to Docker to auto-download the free official Linux headless server.'
          : `Factorio server binary was not found in ${serverDir} after installation.`
      );
    }

    if (!runViaWsl && platform !== 'win32') {
      try {
        fs.chmodSync(factorioExePath, 0o755);
      } catch {
        // ignore chmod errors
      }
    }

    // Write isolated config.ini & server-settings.json inside serverDir
    const { configIniPath, serverSettingsPath, saveFilePath } = writeFactorioConfigFiles(serverDir, instance, {
      useWslPaths: runViaWsl,
    });

    const configArg = runViaWsl ? toWslPath(configIniPath) : configIniPath;
    const settingsArg = runViaWsl ? toWslPath(serverSettingsPath) : serverSettingsPath;
    const saveArg = runViaWsl ? toWslPath(saveFilePath) : saveFilePath;

    // Create an initial save map if saves/ is empty so `--start-server-load-latest` succeeds on first boot
    if (!hasExistingFactorioSave(serverDir) && !options.skipCreateSaveExec) {
      onStatus?.('installing');
      onLog(`[Factorio] No world save found yet — creating initial map (${path.basename(saveFilePath)})...`);
      const createCmd = runViaWsl ? 'wsl.exe' : factorioExePath;
      const createArgs = runViaWsl
        ? ['-e', toWslPath(factorioExePath), '--config', configArg, '--create', saveArg]
        : ['--config', configArg, '--create', saveArg];

      await new Promise<void>((resolve, reject) => {
        const proc = spawn(createCmd, createArgs, {
          cwd: serverDir,
          windowsHide: true,
        });
        proc.stdout?.on('data', (d: Buffer) => {
          for (const line of d.toString('utf8').split(/\r?\n/)) {
            if (line.trim()) onLog(`[Factorio] ${line.trim()}`);
          }
        });
        proc.stderr?.on('data', (d: Buffer) => {
          for (const line of d.toString('utf8').split(/\r?\n/)) {
            if (line.trim()) onLog(`[Factorio] ${line.trim()}`);
          }
        });
        proc.on('error', reject);
        proc.on('close', (code) => {
          if (code === 0) resolve();
          else reject(new Error(`Factorio initial map creation failed with exit code ${code}`));
        });
      });
    }

    const portGame = instance.ports.game ?? 34197;
    const portRcon = instance.ports.rcon ?? 27015;
    const rconPass = String(instance.config.RCON_PASSWORD ?? '').trim();

    const serverArgs = [
      '--config',
      configArg,
      '--start-server-load-latest',
      '--server-settings',
      settingsArg,
      '--port',
      String(portGame),
      '--rcon-port',
      String(portRcon),
    ];
    if (rconPass) {
      serverArgs.push('--rcon-password', rconPass);
    }

    onStatus?.('starting');
    if (runViaWsl) {
      return {
        exe: 'wsl.exe',
        args: ['-e', toWslPath(factorioExePath), ...serverArgs],
      };
    }
    return {
      exe: factorioExePath,
      args: serverArgs,
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
      } else if (template.id === 'minecraft-modrinth') {
        customLaunch = await this.prepareModrinthModpack(instance, serverDir, onLog, onStatus);
      } else if (nativeSpec.installer === 'java') {
        customLaunch = await this.prepareJavaMinecraftServer(instance, serverDir, onLog, onStatus);
      } else if (template.id === 'factorio' || nativeSpec.installer === 'download') {
        customLaunch = await this.prepareFactorioServer(instance, serverDir, onLog, onStatus);
      } else if (nativeSpec.installer === 'steamcmd' && nativeSpec.steamAppId) {
        onStatus?.('installing');
        const steamBeta =
          template.id === 'satisfactory' && Boolean(instance.config.EXPERIMENTAL)
            ? 'experimental'
            : nativeSpec.steamBeta;
        await this.ensureSteamCmdInstalled(nativeSpec.steamAppId, serverDir, steamBeta, onLog);

        if (template.id === 'satisfactory') {
          customLaunch = buildSatisfactoryNativeLaunchPlan(serverDir, instance);
        } else if (template.id === 'palworld') {
          writePalworldSettingsIni(serverDir, instance);
          onLog('[Palworld] Synced PalWorldSettings.ini (Admin Password, RCON & REST API enabled).');
          customLaunch = buildPalworldNativeLaunchPlan(serverDir, instance);
        } else if (template.id === 'ark-survival-ascended') {
          customLaunch = buildArkAsaNativeLaunchPlan(serverDir, instance);
        }

        onStatus?.('starting');
      }
    }

    const vars = buildTemplateVariables({
      config: instance.config,
      ports: instance.ports,
      memoryLimitMb: instance.memoryLimitMb,
    });

    const rawExe = isWin ? nativeSpec.executableWindows : (nativeSpec.executableLinux ?? nativeSpec.executableWindows);
    const localRootExe = path.join(serverDir, rawExe);
    const defaultExePath = path.isAbsolute(rawExe)
      ? rawExe
      : !rawExe.includes('/') && !rawExe.includes('\\')
        ? fs.existsSync(localRootExe)
          ? localRootExe
          : rawExe
        : localRootExe;

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
