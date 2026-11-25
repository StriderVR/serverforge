import { execFile } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type {
  DiscoveredProcess,
  FolderBrowseResult,
  ImportInspectionResult,
  ImportLaunchCandidate,
} from '@serverforge/shared';

export function parsePropertiesFile(content: string): Record<string, string> {
  const result: Record<string, string> = {};
  for (const rawLine of content.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith('#') || line.startsWith('!')) continue;
    const eqIdx = line.indexOf('=');
    if (eqIdx <= 0) continue;
    const key = line.slice(0, eqIdx).trim();
    const val = line.slice(eqIdx + 1).trim().replace(/\\:/g, ':');
    result[key] = val;
  }
  return result;
}

/**
 * Safely updates ONLY RCON keys inside an existing server.properties file,
 * preserving every custom modded setting and comment line untouched.
 */
export function enableRconInServerProperties(
  serverDir: string,
  rconPort: number,
  rconPassword: string
): void {
  const propsPath = path.join(serverDir, 'server.properties');
  const existing = fs.existsSync(propsPath) ? fs.readFileSync(propsPath, 'utf8') : '';
  const lines = existing ? existing.split(/\r?\n/) : [];
  const updates: Record<string, string> = {
    'enable-rcon': 'true',
    'rcon.port': String(rconPort),
    'rcon.password': rconPassword,
  };
  const seen = new Set<string>();
  const out = lines.map((line) => {
    const trimmed = line.trimStart();
    if (!trimmed || trimmed.startsWith('#') || trimmed.startsWith('!')) return line;
    const eqIdx = line.indexOf('=');
    if (eqIdx <= 0) return line;
    const key = line.slice(0, eqIdx).trim();
    if (key in updates) {
      seen.add(key);
      return `${key}=${updates[key]}`;
    }
    return line;
  });

  for (const [k, v] of Object.entries(updates)) {
    if (!seen.has(k)) {
      out.push(`${k}=${v}`);
    }
  }

  fs.writeFileSync(propsPath, out.join('\n').replace(/\n+$/, '\n'), 'utf8');
}

export function parseXmxMemoryMb(text: string): number | null {
  // Matches -Xmx10G, -Xmx8192M, MAX_RAM=12G, etc.
  const xmxMatch = text.match(/-Xmx(\d+)\s*([GMK])/i) ?? text.match(/MAX_RAM\s*=\s*"?(\d+)\s*([GM])"?/i);
  if (!xmxMatch) return null;
  const amount = Number.parseInt(xmxMatch[1], 10);
  const unit = xmxMatch[2].toUpperCase();
  if (!Number.isFinite(amount) || amount <= 0) return null;
  if (unit === 'G') return amount * 1024;
  if (unit === 'M') return amount;
  if (unit === 'K') return Math.max(512, Math.round(amount / 1024));
  return null;
}

const SCRIPT_PRIORITY = [
  'startserver.bat',
  'serverstart.bat',
  'start.bat',
  'run.bat',
  'launch.bat',
  'startserver.sh',
  'serverstart.sh',
  'start.sh',
  'run.sh',
  'launch.sh',
];

export class SmartImportService {
  inspectDirectory(rawPath: string): ImportInspectionResult {
    const folderPath = path.resolve(rawPath.trim().replace(/^["']|["']$/g, ''));
    if (!fs.existsSync(folderPath)) {
      throw new Error(`Folder does not exist: ${folderPath}`);
    }
    const stat = fs.statSync(folderPath);
    if (!stat.isDirectory()) {
      throw new Error(`Path is not a directory: ${folderPath}`);
    }

    const entries = fs.readdirSync(folderPath, { withFileTypes: true });
    const entryNamesLower = new Map(entries.map((e) => [e.name.toLowerCase(), e.name]));
    const warnings: string[] = [];

    // 1. Detect non-Minecraft games first if their exact binaries exist
    if (fs.existsSync(path.join(folderPath, 'ShooterGame', 'Binaries', 'Win64', 'ArkAscendedServer.exe'))) {
      return {
        folderPath,
        suggestedName: path.basename(folderPath) || 'Ark ASA Server',
        detectedGameId: 'ark-survival-ascended',
        detectedGameName: 'Ark: Survival Ascended',
        modloader: null,
        modCount: 0,
        worldFolders: fs.existsSync(path.join(folderPath, 'ShooterGame', 'Saved')) ? ['ShooterGame/Saved'] : [],
        hasServerProperties: false,
        rconCurrentlyEnabled: false,
        launchCandidates: [
          {
            label: 'ArkAscendedServer.exe (Native Binary)',
            script: 'ShooterGame/Binaries/Win64/ArkAscendedServer.exe',
            recommended: true,
          },
        ],
        detectedPorts: { game: 7777, peer: 7778, rcon: 27020 },
        detectedMemoryMb: 16384,
        detectedConfig: {},
        warnings,
      };
    }

    if (entryNamesLower.has('palserver.exe') || entryNamesLower.has('palserver.sh')) {
      const bin = entryNamesLower.get('palserver.exe') ?? entryNamesLower.get('palserver.sh')!;
      return {
        folderPath,
        suggestedName: path.basename(folderPath) || 'Palworld Server',
        detectedGameId: 'palworld',
        detectedGameName: 'Palworld',
        modloader: null,
        modCount: 0,
        worldFolders: fs.existsSync(path.join(folderPath, 'Pal', 'Saved')) ? ['Pal/Saved'] : [],
        hasServerProperties: false,
        rconCurrentlyEnabled: false,
        launchCandidates: [{ label: bin, script: bin, recommended: true }],
        detectedPorts: { game: 8211, query: 27015, rest: 8212, rcon: 25575 },
        detectedMemoryMb: 16384,
        detectedConfig: {},
        warnings,
      };
    }

    if (entryNamesLower.has('factoryserver.exe') || entryNamesLower.has('factoryserver.sh')) {
      const bin = entryNamesLower.get('factoryserver.exe') ?? entryNamesLower.get('factoryserver.sh')!;
      return {
        folderPath,
        suggestedName: path.basename(folderPath) || 'Satisfactory Server',
        detectedGameId: 'satisfactory',
        detectedGameName: 'Satisfactory',
        modloader: null,
        modCount: 0,
        worldFolders: fs.existsSync(path.join(folderPath, 'FactoryGame', 'Saved')) ? ['FactoryGame/Saved'] : [],
        hasServerProperties: false,
        rconCurrentlyEnabled: false,
        launchCandidates: [{ label: bin, script: bin, recommended: true }],
        detectedPorts: { game: 7777 },
        detectedMemoryMb: 12288,
        detectedConfig: {},
        warnings,
      };
    }

    if (
      fs.existsSync(path.join(folderPath, 'bin', 'x64', 'factorio.exe')) ||
      fs.existsSync(path.join(folderPath, 'bin', 'x64', 'factorio'))
    ) {
      const bin = fs.existsSync(path.join(folderPath, 'bin', 'x64', 'factorio.exe'))
        ? 'bin/x64/factorio.exe'
        : 'bin/x64/factorio';
      return {
        folderPath,
        suggestedName: path.basename(folderPath) || 'Factorio Server',
        detectedGameId: 'factorio',
        detectedGameName: 'Factorio',
        modloader: null,
        modCount: 0,
        worldFolders: fs.existsSync(path.join(folderPath, 'saves')) ? ['saves'] : [],
        hasServerProperties: false,
        rconCurrentlyEnabled: false,
        launchCandidates: [{ label: bin, script: bin, recommended: true }],
        detectedPorts: { game: 34197, rcon: 27015 },
        detectedMemoryMb: 4096,
        detectedConfig: {},
        warnings,
      };
    }

    // 2. Inspect Minecraft (Vanilla / Paper / Modded Forge / NeoForge / Fabric / CurseForge)
    const propsPath = path.join(folderPath, 'server.properties');
    const hasServerProperties = fs.existsSync(propsPath);
    const props = hasServerProperties ? parsePropertiesFile(fs.readFileSync(propsPath, 'utf8')) : {};

    // Count installed mods
    const modsDir = path.join(folderPath, 'mods');
    let modCount = 0;
    if (fs.existsSync(modsDir) && fs.statSync(modsDir).isDirectory()) {
      modCount = fs.readdirSync(modsDir).filter((f) => f.toLowerCase().endsWith('.jar')).length;
    }

    // Detect modloader
    let modloader: string | null = null;
    if (fs.existsSync(path.join(folderPath, 'libraries', 'net', 'neoforged'))) {
      modloader = 'NeoForge';
    } else if (
      fs.existsSync(path.join(folderPath, 'libraries', 'net', 'minecraftforge')) ||
      entries.some((e) => /forge.*\.jar$/i.test(e.name))
    ) {
      modloader = 'Forge';
    } else if (
      entries.some((e) => /fabric.*\.jar$/i.test(e.name)) ||
      fs.existsSync(path.join(folderPath, '.fabric'))
    ) {
      modloader = 'Fabric';
    } else if (entries.some((e) => /(paper|purpur|spigot).*\.jar$/i.test(e.name))) {
      modloader = 'Paper / Spigot';
    } else if (modCount > 0) {
      modloader = 'Modded';
    }

    const isModdedMc = Boolean(
      modCount > 0 ||
        modloader === 'NeoForge' ||
        modloader === 'Forge' ||
        modloader === 'Fabric' ||
        entryNamesLower.has('user_jvm_args.txt') ||
        entryNamesLower.has('manifest.json')
    );

    // Detect world folders (folders containing level.dat)
    const worldFolders: string[] = [];
    for (const e of entries) {
      if (e.isDirectory() && fs.existsSync(path.join(folderPath, e.name, 'level.dat'))) {
        worldFolders.push(e.name);
      }
    }
    if (worldFolders.length === 0 && props['level-name'] && fs.existsSync(path.join(folderPath, props['level-name']))) {
      worldFolders.push(props['level-name']);
    }

    // Find startup scripts & runnable jars
    const launchCandidates: ImportLaunchCandidate[] = [];
    const seenScripts = new Set<string>();

    const addScriptCandidate = (fileName: string) => {
      if (seenScripts.has(fileName.toLowerCase())) return;
      seenScripts.add(fileName.toLowerCase());
      let containsPause = false;
      try {
        const content = fs.readFileSync(path.join(folderPath, fileName), 'utf8');
        containsPause = /^\s*pause\b/im.test(content);
      } catch {
        // ignore
      }
      launchCandidates.push({
        label: fileName,
        script: fileName,
        recommended: false,
        containsPause,
      });
    };

    for (const pref of SCRIPT_PRIORITY) {
      const actual = entryNamesLower.get(pref);
      if (actual) addScriptCandidate(actual);
    }

    for (const e of entries) {
      if (!e.isFile()) continue;
      const lower = e.name.toLowerCase();
      if (lower.endsWith('.bat') || lower.endsWith('.cmd') || lower.endsWith('.sh')) {
        addScriptCandidate(e.name);
      }
    }

    for (const e of entries) {
      if (!e.isFile()) continue;
      const lower = e.name.toLowerCase();
      if (lower.endsWith('.jar') && !lower.includes('installer')) {
        launchCandidates.push({
          label: `${e.name} (Java JAR)`,
          script: e.name,
          recommended: false,
        });
      }
    }

    // Mark first platform-matching candidate as recommended
    const isWin = process.platform === 'win32';
    const preferredIdx = launchCandidates.findIndex((c) =>
      isWin ? c.script.toLowerCase().endsWith('.bat') || c.script.toLowerCase().endsWith('.cmd') : c.script.toLowerCase().endsWith('.sh')
    );
    if (preferredIdx >= 0) {
      launchCandidates[preferredIdx].recommended = true;
    } else if (launchCandidates.length > 0) {
      launchCandidates[0].recommended = true;
    } else {
      warnings.push(
        'No startup script (.bat/.sh) or server .jar was found in the root of this folder. You may need to specify the startup script manually or select the subfolder containing run.bat / server.properties.'
      );
    }

    // Detect RAM allocation from user_jvm_args.txt, variables.txt, or launch scripts
    let detectedMemoryMb = isModdedMc ? 8192 : 4096;
    const ramFiles = ['user_jvm_args.txt', 'variables.txt', ...launchCandidates.map((c) => c.script).filter((s) => !s.endsWith('.jar'))];
    for (const f of ramFiles) {
      const full = path.join(folderPath, f);
      if (fs.existsSync(full) && fs.statSync(full).isFile()) {
        try {
          const parsed = parseXmxMemoryMb(fs.readFileSync(full, 'utf8'));
          if (parsed && parsed >= 1024) {
            detectedMemoryMb = parsed;
            break;
          }
        } catch {
          // ignore
        }
      }
    }

    const gamePort = Number.parseInt(props['server-port'] || '25565', 10) || 25565;
    const rconPort = Number.parseInt(props['rcon.port'] || '25575', 10) || 25575;
    const rconCurrentlyEnabled = String(props['enable-rcon'] || '').toLowerCase() === 'true';

    if (!hasServerProperties && modCount === 0 && worldFolders.length === 0) {
      warnings.push(
        'This folder does not contain server.properties, a mods/ directory, or a world folder yet. Double-check that you selected the server root folder.'
      );
    }

    if (!rconCurrentlyEnabled) {
      warnings.push(
        'RCON is currently disabled in server.properties. Leave "Auto-enable RCON" checked below so ServerForge can read live player counts and run safe save-all commands before stopping.'
      );
    }

    const recommendedCandidate = launchCandidates.find((c) => c.recommended);
    if (recommendedCandidate?.containsPause) {
      warnings.push(
        `Detected "pause" at the end of ${recommendedCandidate.script}. ServerForge will still stop the server cleanly via RCON and process-tree cleanup.`
      );
    }

    const detectedConfig: Record<string, string | number | boolean> = {
      MOTD: props['motd'] || path.basename(folderPath) || 'Imported Minecraft Server',
      MAX_PLAYERS: Number.parseInt(props['max-players'] || '10', 10) || 10,
      DIFFICULTY: props['difficulty'] || 'normal',
      GAMEMODE: props['gamemode'] || 'survival',
      VIEW_DISTANCE: Number.parseInt(props['view-distance'] || '10', 10) || 10,
      ONLINE_MODE: props['online-mode'] ? props['online-mode'].toLowerCase() !== 'false' : true,
      RCON_PASSWORD: props['rcon.password'] || '',
    };

    const detectedGameId = isModdedMc ? 'minecraft-curseforge' : 'minecraft';
    const detectedGameName = isModdedMc
      ? `Minecraft Modded (${modloader || 'Modpack'})`
      : `Minecraft (${modloader || 'Java'})`;

    return {
      folderPath,
      suggestedName: path.basename(folderPath) || detectedGameName,
      detectedGameId,
      detectedGameName,
      modloader,
      modCount,
      worldFolders,
      hasServerProperties,
      rconCurrentlyEnabled,
      launchCandidates,
      detectedPorts: { game: gamePort, rcon: rconPort },
      detectedMemoryMb,
      detectedConfig,
      warnings,
    };
  }

  browseDirectory(rawDir?: string): FolderBrowseResult {
    const trimmed = (rawDir || '').trim();

    // On Windows with empty path, list available drive letters (C:\, D:\, ...)
    if (!trimmed && process.platform === 'win32') {
      const drives: Array<{ name: string; path: string }> = [];
      for (let code = 67; code <= 90; code++) {
        const letter = `${String.fromCharCode(code)}:\\`;
        try {
          if (fs.existsSync(letter)) {
            drives.push({ name: letter, path: letter });
          }
        } catch {
          // skip unreadable drive
        }
      }
      return {
        currentPath: '',
        parentPath: null,
        directories: drives,
      };
    }

    const targetDir = trimmed ? path.resolve(trimmed) : os.homedir();
    if (!fs.existsSync(targetDir) || !fs.statSync(targetDir).isDirectory()) {
      throw new Error(`Directory not found: ${targetDir}`);
    }

    const directories: Array<{ name: string; path: string }> = [];
    for (const entry of fs.readdirSync(targetDir, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      if (entry.name.startsWith('$') || entry.name === 'System Volume Information') continue;
      directories.push({
        name: entry.name,
        path: path.join(targetDir, entry.name),
      });
    }
    directories.sort((a, b) => a.name.localeCompare(b.name));

    const parsedParent = path.dirname(targetDir);
    const parentPath =
      parsedParent === targetDir ? (process.platform === 'win32' ? '' : null) : parsedParent;

    return {
      currentPath: targetDir,
      parentPath,
      directories,
    };
  }

  async discoverRunningServers(): Promise<DiscoveredProcess[]> {
    if (process.platform !== 'win32') {
      return [];
    }

    const psScript = `
$targets = @('java.exe', 'javaw.exe', 'ArkAscendedServer.exe', 'PalServer.exe', 'PalServer-Win64-Shipping-Cmd.exe', 'FactoryServer.exe', 'factorio.exe')
$found = @()
$procs = Get-CimInstance Win32_Process -ErrorAction SilentlyContinue | Where-Object { $targets -contains $_.Name }
foreach ($p in $procs) {
  $cmd = [string]$p.CommandLine
  $exe = [string]$p.ExecutablePath
  if ($p.Name -match 'java' -and $cmd -notmatch '(?i)(server|forge|neoforge|fabric|paper|purpur|spigot|nogui|user_jvm_args|win_args)') {
    continue
  }
  $found += [PSCustomObject]@{
    pid = [int]$p.ProcessId
    processName = [string]$p.Name
    executablePath = $exe
    commandLine = $cmd
  }
}
$found | ConvertTo-Json -Depth 3 -Compress
`;

    return new Promise((resolve) => {
      execFile(
        'powershell.exe',
        ['-NoProfile', '-NonInteractive', '-Command', psScript],
        { timeout: 10_000, windowsHide: true },
        (err, stdout) => {
          if (err || !stdout.trim()) {
            resolve([]);
            return;
          }
          try {
            const parsed = JSON.parse(stdout.trim());
            const list = Array.isArray(parsed) ? parsed : [parsed];
            const results: DiscoveredProcess[] = list.map(
              (item: { pid: number; processName: string; executablePath?: string; commandLine?: string }) => {
                const cmd = item.commandLine || '';
                const nameLower = (item.processName || '').toLowerCase();
                let detectedGameId = 'minecraft-curseforge';
                if (nameLower.includes('ark')) detectedGameId = 'ark-survival-ascended';
                else if (nameLower.includes('palserver')) detectedGameId = 'palworld';
                else if (nameLower.includes('factory')) detectedGameId = 'satisfactory';
                else if (nameLower.includes('factorio')) detectedGameId = 'factorio';

                // Infer working directory from executablePath (non-java) or absolute paths in commandLine
                let workingDir: string | null = null;
                if (!nameLower.includes('java') && item.executablePath) {
                  workingDir = path.dirname(item.executablePath);
                } else {
                  const pathMatch = cmd.match(/([A-Za-z]:\\[^"\s]+?(?:\\libraries|\\server\.jar|\.jar))/i);
                  if (pathMatch) {
                    const matched = pathMatch[1];
                    const libIdx = matched.toLowerCase().indexOf('\\libraries');
                    workingDir = libIdx > 0 ? matched.slice(0, libIdx) : path.dirname(matched);
                  }
                }

                return {
                  pid: item.pid,
                  processName: item.processName,
                  detectedGameId,
                  workingDir,
                  commandLine: cmd.slice(0, 320),
                };
              }
            );
            resolve(results);
          } catch {
            resolve([]);
          }
        }
      );
    });
  }
}
