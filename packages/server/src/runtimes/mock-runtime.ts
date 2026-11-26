import fs from 'node:fs';
import path from 'node:path';
import type { GameTemplate, InstanceRuntimeStats, ServerInstance } from '@serverforge/shared';
import type { RuntimeAdapter, RuntimeStartResult } from './runtime-adapter.js';

interface MockServerState {
  startedAt: number;
  players: string[];
  saveCount: number;
  heartbeatTimer?: NodeJS.Timeout;
  onLog: (line: string) => void;
  onExit?: (code: number | null) => void;
}

/**
 * Simulated runtime adapter for automated tests and instant interactive UI previews
 * without requiring Docker or multi-gigabyte game downloads.
 */
export class MockRuntimeAdapter implements RuntimeAdapter {
  public readonly kind = 'mock' as const;
  private readonly running = new Map<string, MockServerState>();

  async isAvailable(): Promise<boolean> {
    return true;
  }

  /** Test helper to simulate players joining/leaving a mock server. */
  setSimulatedPlayers(instanceId: string, players: string[]): void {
    const state = this.running.get(instanceId);
    if (state) {
      state.players = [...players];
      state.onLog(`[Mock] Active players updated: ${players.length > 0 ? players.join(', ') : '(empty)'}`);
    }
  }

  /** Test helper to simulate an unexpected process crash on a running mock server. */
  simulateCrash(instanceId: string, exitCode: number | null = 1, crashLines: string[] = []): boolean {
    const state = this.running.get(instanceId);
    if (!state) return false;
    if (state.heartbeatTimer) clearInterval(state.heartbeatTimer);
    for (const line of crashLines) {
      state.onLog(line);
    }
    state.onLog(`[Mock] Process terminated unexpectedly with exit code ${exitCode ?? 'SIGKILL'}`);
    this.running.delete(instanceId);
    state.onExit?.(exitCode);
    return true;
  }

  getSaveCount(instanceId: string): number {
    return this.running.get(instanceId)?.saveCount ?? 0;
  }

  async start(
    instance: ServerInstance,
    template: GameTemplate,
    instanceDir: string,
    onLog: (line: string) => void,
    onExit?: (code: number | null) => void
  ): Promise<RuntimeStartResult> {
    fs.mkdirSync(path.join(instanceDir, 'data'), { recursive: true });
    // Seed a dummy world file so backups have realistic content
    const worldFile = path.join(instanceDir, 'data', 'world-state.json');
    if (!fs.existsSync(worldFile)) {
      fs.writeFileSync(
        worldFile,
        JSON.stringify({ game: template.id, instance: instance.name, createdAt: new Date().toISOString() }, null, 2)
      );
    }

    onLog(`[Mock:${instance.runtime}] Initializing ${template.name} (${instance.name})...`);
    onLog(`[Mock:${instance.runtime}] Allocating memory limit: ${instance.memoryLimitMb} MB`);
    onLog(
      `[Mock:${instance.runtime}] Bound ports: ${Object.entries(instance.ports)
        .map(([k, p]) => `${k}=${p}`)
        .join(', ')}`
    );
    onLog(`[Mock:${instance.runtime}] World loaded successfully. Server is ready for players!`);

    const state: MockServerState = {
      startedAt: Date.now(),
      players: [],
      saveCount: 0,
      onLog,
      onExit,
    };

    state.heartbeatTimer = setInterval(() => {
      onLog(`[${template.shortName}] Server tick healthy — ${state.players.length} player(s) online.`);
    }, 45000);
    state.heartbeatTimer.unref?.();

    this.running.set(instance.id, state);
    return { externalId: `mock-${instance.id.slice(0, 8)}` };
  }

  async stop(instance: ServerInstance, template: GameTemplate, onLog: (line: string) => void): Promise<void> {
    const state = this.running.get(instance.id);
    if (!state) return;
    if (state.heartbeatTimer) clearInterval(state.heartbeatTimer);
    if (template.lifecycle.saveCommand) {
      state.saveCount += 1;
      onLog(`[Mock] Executed graceful save command: ${template.lifecycle.saveCommand}`);
    }
    onLog(`[Mock] ${instance.name} saved and stopped cleanly.`);
    this.running.delete(instance.id);
  }

  async sendCommand(instance: ServerInstance, template: GameTemplate, command: string): Promise<string | null> {
    const state = this.running.get(instance.id);
    if (!state) return null;

    const trimmed = command.trim();
    state.onLog(`> ${trimmed}`);

    if (trimmed.startsWith('mock:join ')) {
      const player = trimmed.slice('mock:join '.length).trim();
      if (player && !state.players.includes(player)) {
        state.players.push(player);
      }
      const reply = `[Mock] Player "${player}" joined (${state.players.length} online).`;
      state.onLog(reply);
      return reply;
    }
    if (trimmed.startsWith('mock:leave ')) {
      const player = trimmed.slice('mock:leave '.length).trim();
      state.players = state.players.filter((p) => p !== player);
      const reply = `[Mock] Player "${player}" disconnected (${state.players.length} online).`;
      state.onLog(reply);
      return reply;
    }
    if (trimmed === template.lifecycle.saveCommand || trimmed.toLowerCase().includes('save')) {
      state.saveCount += 1;
      const reply = `[${template.shortName}] World saved cleanly.`;
      state.onLog(reply);
      return reply;
    }

    const reply = `[${template.shortName}] Executed command: ${trimmed}`;
    state.onLog(reply);
    return reply;
  }

  async getStats(instance: ServerInstance, template: GameTemplate): Promise<InstanceRuntimeStats | null> {
    const state = this.running.get(instance.id);
    if (!state) return null;
    const uptimeSeconds = Math.max(0, Math.floor((Date.now() - state.startedAt) / 1000));
    const baseMem = Math.round(template.resources.minRamGb * 1024 * 0.45);
    const maxPlayers = Number(instance.config.MAX_PLAYERS) || 10;

    return {
      cpuPercent: Number((4.5 + state.players.length * 2.1).toFixed(1)),
      memoryMb: baseMem + state.players.length * 140,
      playerCount: state.players.length,
      maxPlayers,
      players: [...state.players],
      uptimeSeconds,
    };
  }

  async isRunning(instance: ServerInstance): Promise<boolean> {
    return this.running.has(instance.id);
  }

  async remove(instance: ServerInstance): Promise<void> {
    const state = this.running.get(instance.id);
    if (state?.heartbeatTimer) clearInterval(state.heartbeatTimer);
    this.running.delete(instance.id);
  }
}
