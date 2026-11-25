import fs from 'node:fs';
import path from 'node:path';
import { spawn, execFile, type ChildProcess } from 'node:child_process';
import type { GameTemplate, InstanceRuntimeStats, ServerInstance } from '@serverforge/shared';
import { buildTemplateVariables, renderTemplateString } from '../catalog/catalog-service.js';
import type { QueryService } from '../query/query-service.js';
import { splitArgs, type RuntimeAdapter, type RuntimeStartResult } from './runtime-adapter.js';

interface ManagedProcess {
  child: ChildProcess;
  startedAt: number;
}

export class NativeProcessRuntimeAdapter implements RuntimeAdapter {
  public readonly kind = 'native' as const;
  private readonly processes = new Map<string, ManagedProcess>();

  constructor(
    private readonly toolsDir: string,
    private readonly queryService: QueryService
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

  private async prepareCurseForgeServerPack(
    instance: ServerInstance,
    serverDir: string,
    onLog: (line: string) => void
  ): Promise<{ exe: string; args: string[] } | null> {
    const zipSource = String(instance.config.SERVER_PACK_ZIP ?? '').trim();
    const markerPath = path.join(serverDir, '.serverforge-pack-installed');

    if (zipSource && !fs.existsSync(markerPath)) {
      const localZipPath = path.join(serverDir, 'server-pack.zip');
      if (/^https?:\/\//i.test(zipSource)) {
        onLog(`[CurseForge] Downloading Native Server Pack ZIP...`);
        const res = await fetch(zipSource, { signal: AbortSignal.timeout(300_000) });
        if (!res.ok) {
          throw new Error(`Failed to download Server Pack ZIP (HTTP ${res.status})`);
        }
        const buf = Buffer.from(await res.arrayBuffer());
        fs.writeFileSync(localZipPath, buf);
      } else if (fs.existsSync(zipSource)) {
        onLog(`[CurseForge] Copying local Server Pack ZIP from ${zipSource}...`);
        fs.copyFileSync(zipSource, localZipPath);
      } else {
        throw new Error(`SERVER_PACK_ZIP path not found: ${zipSource}`);
      }

      onLog('[CurseForge] Extracting Server Pack ZIP...');
      await new Promise<void>((resolve, reject) => {
        const isWin = process.platform === 'win32';
        const proc = isWin
          ? spawn('powershell.exe', [
              '-NoProfile',
              '-Command',
              `Expand-Archive -Path '${localZipPath.replace(/'/g, "''")}' -DestinationPath '${serverDir.replace(/'/g, "''")}' -Force`,
            ])
          : spawn('unzip', ['-o', localZipPath, '-d', serverDir]);

        proc.on('error', (err) => reject(err));
        proc.on('close', (code) => {
          if (code === 0) resolve();
          else reject(new Error(`Server Pack ZIP extraction exited with code ${code}`));
        });
      });

      fs.rmSync(localZipPath, { force: true });
      fs.writeFileSync(markerPath, new Date().toISOString(), 'utf8');
      onLog('[CurseForge] Server Pack extracted cleanly.');
    }

    // Write eula.txt and merge key server.properties values (port + RCON)
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
      motd: String(instance.config.MOTD ?? 'ServerForge CurseForge Modpack'),
    };
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
    fs.writeFileSync(propsPath, updatedLines.filter(Boolean).join('\n') + '\n', 'utf8');

    // Update user_jvm_args.txt memory cap if present (standard Forge/NeoForge 1.18+ server packs)
    const jvmArgsPath = path.join(serverDir, 'user_jvm_args.txt');
    if (fs.existsSync(jvmArgsPath)) {
      fs.writeFileSync(jvmArgsPath, `-Xms2048M\n-Xmx${instance.memoryLimitMb}M\n`, 'utf8');
    }

    // Auto-detect standard CurseForge server pack startup scripts
    const isWin = process.platform === 'win32';
    const candidates = isWin
      ? ['startserver.bat', 'start.bat', 'run.bat', 'ServerStart.bat']
      : ['startserver.sh', 'start.sh', 'run.sh', 'ServerStart.sh'];
    for (const script of candidates) {
      const full = path.join(serverDir, script);
      if (fs.existsSync(full)) {
        return isWin
          ? { exe: 'cmd.exe', args: ['/c', full] }
          : { exe: 'bash', args: [full] };
      }
    }
    return null;
  }

  async start(
    instance: ServerInstance,
    template: GameTemplate,
    instanceDir: string,
    onLog: (line: string) => void,
    onExit: (code: number | null) => void
  ): Promise<RuntimeStartResult> {
    const nativeSpec = template.runtimes.native;
    if (!nativeSpec) {
      throw new Error(`Game template "${template.name}" does not define a Native runtime.`);
    }

    const serverDir = instance.externalDir
      ? path.resolve(instance.externalDir)
      : path.join(instanceDir, 'server');
    fs.mkdirSync(serverDir, { recursive: true });

    let customLaunch: { exe: string; args: string[] } | null = null;
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
        customLaunch = {
          exe: 'java',
          args: [`-Xms2048M`, `-Xmx${instance.memoryLimitMb}M`, '-jar', scriptPath, 'nogui'],
        };
      } else if (fs.existsSync(scriptPath)) {
        customLaunch = { exe: scriptPath, args: [] };
      }
    } else if (!instance.externalDir) {
      if (template.id === 'minecraft-curseforge') {
        customLaunch = await this.prepareCurseForgeServerPack(instance, serverDir, onLog);
      } else if (nativeSpec.installer === 'steamcmd' && nativeSpec.steamAppId) {
        await this.ensureSteamCmdInstalled(nativeSpec.steamAppId, serverDir, nativeSpec.steamBeta, onLog);
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

    const env: NodeJS.ProcessEnv = { ...process.env };
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

    if (!child.pid) {
      throw new Error(`Failed to spawn native server binary: ${exePath}`);
    }

    this.processes.set(instance.id, { child, startedAt: Date.now() });

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
    };

    pipeLines(child.stdout);
    pipeLines(child.stderr);

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
      managed.child.kill('SIGKILL');
      this.processes.delete(instance.id);
    }
  }
}
