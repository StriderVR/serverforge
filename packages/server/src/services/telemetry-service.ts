import os from 'node:os';
import si from 'systeminformation';
import type { HostMetrics } from '@serverforge/shared';
import type { AppDatabase } from '../db/database.js';
import type { RuntimeManager } from '../runtimes/runtime-manager.js';

export interface MemorySnapshot {
  totalGb: number;
  usedGb: number;
  freeGb: number;
}

export class TelemetryService {
  private cachedDistro: string | null = null;
  private memoryOverride: MemorySnapshot | null = null;

  constructor(
    private readonly db: AppDatabase,
    private readonly runtimeManager: RuntimeManager,
    private readonly getDiscordStatus: () => { connected: boolean; botTag: string | null },
    private readonly defaultPublicHost: string
  ) {}

  /** Used in automated tests to deterministically test low-RAM guardrail enforcement. */
  setMemoryOverrideForTesting(snapshot: MemorySnapshot | null): void {
    this.memoryOverride = snapshot;
  }

  async getMemorySnapshot(): Promise<MemorySnapshot> {
    if (this.memoryOverride) {
      return this.memoryOverride;
    }
    const mem = await si.mem();
    const totalGb = Number((mem.total / 1024 ** 3).toFixed(2));
    const freeGb = Number((mem.available / 1024 ** 3).toFixed(2));
    const usedGb = Number(Math.max(0, totalGb - freeGb).toFixed(2));
    return { totalGb, usedGb, freeGb };
  }

  async getHostMetrics(runningServersCount: number): Promise<HostMetrics> {
    const settings = this.db.getSettings(this.defaultPublicHost);
    const [load, mem, fsSizes, runtimes] = await Promise.all([
      si.currentLoad().catch(() => ({ currentLoad: 0 })),
      this.getMemorySnapshot(),
      si.fsSize().catch(() => []),
      this.runtimeManager.getAvailability(),
    ]);

    if (!this.cachedDistro) {
      try {
        const osInfo = await si.osInfo();
        this.cachedDistro = `${osInfo.distro} ${osInfo.release}`.trim();
      } catch {
        this.cachedDistro = `${os.type()} ${os.release()}`;
      }
    }

    const primaryDisk = fsSizes[0];
    const diskTotalGb = primaryDisk ? Number((primaryDisk.size / 1024 ** 3).toFixed(1)) : 0;
    const diskUsedGb = primaryDisk ? Number((primaryDisk.used / 1024 ** 3).toFixed(1)) : 0;
    const diskFreeGb = primaryDisk ? Number(Math.max(0, (primaryDisk.size - primaryDisk.used) / 1024 ** 3).toFixed(1)) : 0;

    const discord = this.getDiscordStatus();

    return {
      hostname: os.hostname(),
      platform: process.platform,
      osDistro: this.cachedDistro,
      cpuLoadPercent: Number((load.currentLoad || 0).toFixed(1)),
      cpuCores: os.cpus().length,
      memoryTotalGb: mem.totalGb,
      memoryUsedGb: mem.usedGb,
      memoryFreeGb: mem.freeGb,
      memoryReservedForOsGb: settings.hostRamReserveGb,
      diskTotalGb,
      diskUsedGb,
      diskFreeGb,
      uptimeSeconds: Math.floor(os.uptime()),
      runningServers: runningServersCount,
      maxConcurrentServers: settings.maxConcurrentServers,
      runtimesAvailable: runtimes,
      discordConnected: discord.connected,
      discordBotTag: discord.botTag,
    };
  }
}
