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

    const serverDir = path.join(instanceDir, 'server');
    fs.mkdirSync(serverDir, { recursive: true });

    if (nativeSpec.installer === 'steamcmd' && nativeSpec.steamAppId) {
      await this.ensureSteamCmdInstalled(nativeSpec.steamAppId, serverDir, nativeSpec.steamBeta, onLog);
    }

    const vars = buildTemplateVariables({
      config: instance.config,
      ports: instance.ports,
      memoryLimitMb: instance.memoryLimitMb,
    });

    const isWin = process.platform === 'win32';
    const rawExe = isWin ? nativeSpec.executableWindows : (nativeSpec.executableLinux ?? nativeSpec.executableWindows);
    const exePath = path.isAbsolute(rawExe) || !rawExe.includes('/') && !rawExe.includes('\\')
      ? rawExe
      : path.join(serverDir, rawExe);

    const renderedArgs = renderTemplateString(nativeSpec.argsTemplate, vars);
    const args = splitArgs(renderedArgs);

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
