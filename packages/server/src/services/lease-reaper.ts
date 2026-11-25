import type { CatalogService } from '../catalog/catalog-service.js';
import type { AppConfig } from '../config.js';
import type { AppDatabase } from '../db/database.js';
import type { ServerOrchestrator } from './orchestrator.js';

export class LeaseReaper {
  private timer: NodeJS.Timeout | null = null;
  private running = false;

  constructor(
    private readonly config: AppConfig,
    private readonly db: AppDatabase,
    private readonly catalog: CatalogService,
    private readonly orchestrator: ServerOrchestrator
  ) {}

  start(intervalMs = 30_000): void {
    if (this.timer) return;
    this.timer = setInterval(() => {
      void this.runSweep();
    }, intervalMs);
    this.timer.unref?.();
  }

  stop(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  /**
   * Executes one deterministic lease & idle evaluation pass.
   * Exposed publicly so tests can drive exact time progression cleanly.
   */
  async runSweep(nowMs = Date.now()): Promise<void> {
    if (this.running) return;
    this.running = true;

    try {
      const settings = this.db.getSettings(this.config.publicHost);
      const activeLeases = this.db.listActiveLeases();

      // Also refresh stats for any running non-leased servers so dashboard stays live
      for (const inst of this.db.listInstances()) {
        if (inst.status === 'running') {
          await this.orchestrator.refreshInstanceStats(inst.id);
        }
      }

      for (const lease of activeLeases) {
        const instance = this.db.getInstanceById(lease.instanceId);
        if (!instance || instance.status !== 'running') {
          this.db.updateLease(lease.id, { active: false });
          continue;
        }

        const template = this.catalog.getTemplate(instance.gameId);
        const bootGraceMs = (template?.lifecycle.bootGraceSeconds ?? 180) * 1000;
        const startedMs = new Date(lease.startedAt).getTime();
        const expiresMs = new Date(lease.expiresAt).getTime();
        const warnWindowMs = settings.warningBeforeStopMinutes * 60_000;

        // 1. Check hard TTL lease expiration
        if (nowMs >= expiresMs) {
          this.orchestrator.emit('lease:expired', { lease, instance, reason: 'ttl' });
          await this.orchestrator.stopInstance(
            instance.id,
            'LeaseReaper',
            'system',
            'Temporary lease duration expired'
          );
          continue;
        }

        // 2. Check idle empty-server timeout (after boot grace period)
        let idleExpiresMs: number | null = null;
        if (lease.idleTimeoutMinutes > 0 && nowMs - startedMs >= bootGraceMs) {
          const stats = await this.orchestrator.refreshInstanceStats(instance.id);
          const playerCount = stats?.playerCount;

          if (playerCount === 0) {
            const emptySinceIso = lease.emptySince ?? new Date(nowMs).toISOString();
            if (!lease.emptySince) {
              this.db.updateLease(lease.id, { emptySince: emptySinceIso });
            }
            idleExpiresMs = new Date(emptySinceIso).getTime() + lease.idleTimeoutMinutes * 60_000;

            if (nowMs >= idleExpiresMs) {
              this.orchestrator.emit('lease:expired', { lease, instance, reason: 'idle' });
              await this.orchestrator.stopInstance(
                instance.id,
                'LeaseReaper',
                'system',
                `Server idle with 0 players for ${lease.idleTimeoutMinutes} minutes`
              );
              continue;
            }
          } else if (playerCount !== null && playerCount !== undefined && playerCount > 0 && lease.emptySince) {
            // Players joined! Reset idle timer
            this.db.updateLease(lease.id, { emptySince: null, warningSentAt: null });
          }
        }

        // 3. Emit 10-minute warning if approaching either TTL or idle shutdown
        if (!lease.warningSentAt) {
          const ttlRemainingMs = expiresMs - nowMs;
          const idleRemainingMs = idleExpiresMs !== null ? idleExpiresMs - nowMs : Infinity;
          const soonestMs = Math.min(ttlRemainingMs, idleRemainingMs);

          if (soonestMs <= warnWindowMs && soonestMs > 0) {
            const reason: 'ttl' | 'idle' = idleRemainingMs < ttlRemainingMs ? 'idle' : 'ttl';
            const updatedLease = this.db.updateLease(lease.id, {
              warningSentAt: new Date(nowMs).toISOString(),
            })!;
            this.orchestrator.emit('lease:warning', {
              lease: updatedLease,
              instance,
              reason,
              minutesRemaining: Math.max(1, Math.ceil(soonestMs / 60_000)),
            });
          }
        }
      }
    } finally {
      this.running = false;
    }
  }
}
