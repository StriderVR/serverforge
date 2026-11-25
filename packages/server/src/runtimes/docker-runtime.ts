import fs from 'node:fs';
import path from 'node:path';
import Docker from 'dockerode';
import type { GameTemplate, InstanceRuntimeStats, ServerInstance } from '@serverforge/shared';
import { buildTemplateVariables, renderTemplateString } from '../catalog/catalog-service.js';
import type { QueryService } from '../query/query-service.js';
import type { RuntimeAdapter, RuntimeStartResult } from './runtime-adapter.js';

export class DockerRuntimeAdapter implements RuntimeAdapter {
  public readonly kind = 'docker' as const;
  private readonly docker: Docker;
  private readonly activeLogStreams = new Map<string, NodeJS.ReadableStream>();

  constructor(
    private readonly queryService: QueryService,
    private readonly getGlobalVars: () => Record<string, string> = () => ({})
  ) {
    this.docker =
      process.platform === 'win32'
        ? new Docker({ socketPath: '//./pipe/docker_engine' })
        : new Docker({ socketPath: '/var/run/docker.sock' });
  }

  async isAvailable(): Promise<boolean> {
    try {
      await this.docker.ping();
      return true;
    } catch {
      return false;
    }
  }

  private containerName(instance: ServerInstance): string {
    return `serverforge-${instance.slug}`;
  }

  private async pullImageIfNeeded(image: string, onLog: (line: string) => void): Promise<void> {
    try {
      await this.docker.getImage(image).inspect();
      onLog(`[Docker] Image ${image} is ready locally.`);
      return;
    } catch {
      onLog(`[Docker] Pulling image ${image} (first-time setup may take a few minutes)...`);
    }

    await new Promise<void>((resolve, reject) => {
      this.docker.pull(image, (err: Error | null, stream: NodeJS.ReadableStream) => {
        if (err) return reject(err);
        let lastStatus = '';
        this.docker.modem.followProgress(
          stream,
          (finishErr: Error | null) => {
            if (finishErr) reject(finishErr);
            else {
              onLog(`[Docker] Finished pulling ${image}.`);
              resolve();
            }
          },
          (event: { status?: string; id?: string }) => {
            if (event.status && event.status !== lastStatus) {
              lastStatus = event.status;
              onLog(`[Docker] ${event.status}${event.id ? ` (${event.id})` : ''}`);
            }
          }
        );
      });
    });
  }

  resolveImage(instance: ServerInstance, template: GameTemplate): string {
    const dockerSpec = template.runtimes.docker;
    if (!dockerSpec) {
      throw new Error(`Game template "${template.name}" does not define a Docker runtime.`);
    }
    const vars = buildTemplateVariables({
      config: { ...this.getGlobalVars(), ...instance.config },
      ports: instance.ports,
      memoryLimitMb: instance.memoryLimitMb,
    });
    return renderTemplateString(dockerSpec.image, vars) || dockerSpec.image;
  }

  buildContainerEnv(instance: ServerInstance, template: GameTemplate): string[] {
    const dockerSpec = template.runtimes.docker;
    if (!dockerSpec) return [];
    const vars = buildTemplateVariables({
      config: { ...this.getGlobalVars(), ...instance.config },
      ports: instance.ports,
      memoryLimitMb: instance.memoryLimitMb,
    });
    const env: string[] = [];
    for (const [k, v] of Object.entries(dockerSpec.envTemplate)) {
      const rendered = renderTemplateString(v, vars);
      if (rendered !== '') {
        env.push(`${k}=${rendered}`);
      }
    }
    return env;
  }

  async start(
    instance: ServerInstance,
    template: GameTemplate,
    instanceDir: string,
    onLog: (line: string) => void,
    onExit: (code: number | null) => void
  ): Promise<RuntimeStartResult> {
    const dockerSpec = template.runtimes.docker;
    if (!dockerSpec) {
      throw new Error(`Game template "${template.name}" does not define a Docker runtime.`);
    }

    const image = this.resolveImage(instance, template);
    await this.pullImageIfNeeded(image, onLog);

    const env = this.buildContainerEnv(instance, template);

    const binds: string[] = [];
    for (const vol of dockerSpec.volumes) {
      const hostPath = path.join(instanceDir, vol.hostSubdir);
      fs.mkdirSync(hostPath, { recursive: true });
      binds.push(`${hostPath}:${vol.containerPath}`);
    }

    const exposedPorts: Record<string, Record<string, never>> = {};
    const portBindings: Record<string, Array<{ HostPort: string }>> = {};

    for (const portSpec of template.ports) {
      const allocatedPort = instance.ports[portSpec.key] ?? portSpec.defaultPort;
      const protocols = portSpec.protocol === 'both' ? ['tcp', 'udp'] : [portSpec.protocol];
      for (const proto of protocols) {
        const containerKey = `${allocatedPort}/${proto}`;
        exposedPorts[containerKey] = {};
        portBindings[containerKey] = [{ HostPort: String(allocatedPort) }];
      }
    }

    // Remove previous stopped container with the same name so config/ports stay fresh
    const name = this.containerName(instance);
    try {
      const existing = this.docker.getContainer(name);
      const info = await existing.inspect();
      if (info.State.Running) {
        await existing.stop({ t: 15 });
      }
      await existing.remove({ force: true });
    } catch {
      // Container doesn't exist yet
    }

    onLog(`[Docker] Creating container ${name} (${image})...`);
    const container = await this.docker.createContainer({
      name,
      Image: image,
      Env: env,
      Cmd: dockerSpec.command,
      ExposedPorts: exposedPorts,
      Tty: false,
      OpenStdin: true,
      Labels: {
        'serverforge.managed': 'true',
        'serverforge.instanceId': instance.id,
        'serverforge.gameId': instance.gameId,
      },
      HostConfig: {
        Binds: binds,
        PortBindings: portBindings,
        Memory: instance.memoryLimitMb * 1024 * 1024,
        RestartPolicy: { Name: 'no' },
      },
    });

    await container.start();
    onLog(`[Docker] Container ${container.id.slice(0, 12)} started.`);

    this.attachLogs(instance.id, container, onLog);

    // Watch for container exit
    container
      .wait()
      .then((res: { StatusCode?: number }) => {
        this.detachLogs(instance.id);
        onExit(res.StatusCode ?? 0);
      })
      .catch(() => {
        this.detachLogs(instance.id);
        onExit(null);
      });

    return { externalId: container.id };
  }

  private attachLogs(instanceId: string, container: Docker.Container, onLog: (line: string) => void): void {
    this.detachLogs(instanceId);
    container.logs(
      { follow: true, stdout: true, stderr: true, tail: 50 },
      (err, stream) => {
        if (err || !stream) return;
        this.activeLogStreams.set(instanceId, stream);
        let leftover = '';
        stream.on('data', (chunk: Buffer) => {
          // Strip Docker multiplexed 8-byte header bytes if present
          const text = chunk
            .toString('utf8')
            .replace(/[\x00-\x08\x0b\x0c\x0e-\x1f]/g, '');
          const combined = leftover + text;
          const lines = combined.split(/\r?\n/);
          leftover = lines.pop() ?? '';
          for (const line of lines) {
            if (line.trim()) onLog(line);
          }
        });
      }
    );
  }

  private detachLogs(instanceId: string): void {
    const stream = this.activeLogStreams.get(instanceId);
    if (stream && 'destroy' in stream && typeof stream.destroy === 'function') {
      stream.destroy();
    }
    this.activeLogStreams.delete(instanceId);
  }

  async stop(instance: ServerInstance, template: GameTemplate, onLog: (line: string) => void): Promise<void> {
    const id = instance.containerId || this.containerName(instance);
    onLog(`[Docker] Initiating graceful save & shutdown for ${instance.name}...`);
    await this.queryService.performGracefulSave(instance, template);

    try {
      const container = this.docker.getContainer(id);
      const info = await container.inspect();
      if (info.State.Running) {
        await container.stop({ t: template.lifecycle.gracefulStopTimeoutSeconds });
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      if (!message.includes('304') && !message.includes('404')) {
        throw err;
      }
    } finally {
      this.detachLogs(instance.id);
    }
    onLog(`[Docker] Container stopped cleanly.`);
  }

  async sendCommand(instance: ServerInstance, template: GameTemplate, command: string): Promise<string | null> {
    return this.queryService.sendRcon(instance, template, command);
  }

  async getStats(instance: ServerInstance, template: GameTemplate): Promise<InstanceRuntimeStats | null> {
    const id = instance.containerId || this.containerName(instance);
    try {
      const container = this.docker.getContainer(id);
      const info = await container.inspect();
      if (!info.State.Running) return null;

      const rawStats = (await container.stats({ stream: false })) as {
        cpu_stats?: { cpu_usage?: { total_usage?: number }; system_cpu_usage?: number; online_cpus?: number };
        precpu_stats?: { cpu_usage?: { total_usage?: number }; system_cpu_usage?: number };
        memory_stats?: { usage?: number };
      };

      const cpuDelta =
        (rawStats.cpu_stats?.cpu_usage?.total_usage ?? 0) -
        (rawStats.precpu_stats?.cpu_usage?.total_usage ?? 0);
      const sysDelta =
        (rawStats.cpu_stats?.system_cpu_usage ?? 0) - (rawStats.precpu_stats?.system_cpu_usage ?? 0);
      const cpus = rawStats.cpu_stats?.online_cpus ?? 1;
      const cpuPercent = sysDelta > 0 ? Math.max(0, Number(((cpuDelta / sysDelta) * cpus * 100).toFixed(1))) : 0;
      const memoryMb = Math.round((rawStats.memory_stats?.usage ?? 0) / (1024 * 1024));

      const startedAt = info.State.StartedAt ? new Date(info.State.StartedAt).getTime() : Date.now();
      const uptimeSeconds = Math.max(0, Math.floor((Date.now() - startedAt) / 1000));

      const query = await this.queryService.queryPlayers(instance, template);
      return {
        cpuPercent,
        memoryMb,
        playerCount: query.playerCount,
        maxPlayers: query.maxPlayers,
        players: query.players,
        uptimeSeconds,
      };
    } catch {
      return null;
    }
  }

  async isRunning(instance: ServerInstance): Promise<boolean> {
    const id = instance.containerId || this.containerName(instance);
    try {
      const info = await this.docker.getContainer(id).inspect();
      return Boolean(info.State.Running);
    } catch {
      return false;
    }
  }

  async remove(instance: ServerInstance): Promise<void> {
    this.detachLogs(instance.id);
    const id = instance.containerId || this.containerName(instance);
    try {
      const container = this.docker.getContainer(id);
      await container.remove({ force: true });
    } catch {
      // Container already removed or never created
    }
  }
}
