import type { ServerInstance, SystemSettings } from '@serverforge/shared';
import type { CatalogService } from '../catalog/catalog-service.js';
import type { AppConfig } from '../config.js';
import type { AppDatabase } from '../db/database.js';
import { GuardrailError, type ServerOrchestrator } from '../services/orchestrator.js';

export interface DiscordActorContext {
  userId: string;
  username: string;
  roleIds: string[];
  isGuildAdmin: boolean;
  channelId: string | null;
}

export interface CommandOutcome {
  ok: boolean;
  title: string;
  description: string;
  color: number;
  ephemeral?: boolean;
  fields?: Array<{ name: string; value: string; inline?: boolean }>;
  instanceIdForButtons?: string;
}

const COLOR_GREEN = 0x10b981;
const COLOR_AMBER = 0xf59e0b;
const COLOR_RED = 0xef4444;
const COLOR_SLATE = 0x475569;

export function hasDiscordAdminAccess(actor: DiscordActorContext, settings: SystemSettings): boolean {
  if (actor.isGuildAdmin) return true;
  return settings.discordAdminRoleIds.some((r) => actor.roleIds.includes(r));
}

export function hasDiscordBootAccess(actor: DiscordActorContext, settings: SystemSettings): boolean {
  if (hasDiscordAdminAccess(actor, settings)) return true;
  if (settings.discordAllowedRoleIds.length === 0) return false;
  return settings.discordAllowedRoleIds.some((r) => actor.roleIds.includes(r));
}

export function canStopFromDiscord(
  actor: DiscordActorContext,
  instance: ServerInstance,
  settings: SystemSettings
): boolean {
  if (hasDiscordAdminAccess(actor, settings)) return true;
  return Boolean(instance.activeLease?.requestedById && instance.activeLease.requestedById === actor.userId);
}

export function formatRemainingMinutes(isoDate: string): string {
  const diffMin = Math.max(0, Math.round((new Date(isoDate).getTime() - Date.now()) / 60_000));
  if (diffMin >= 60) {
    const h = Math.floor(diffMin / 60);
    const m = diffMin % 60;
    return m > 0 ? `${h}h ${m}m` : `${h}h`;
  }
  return `${diffMin}m`;
}

export class DiscordCommandHandler {
  constructor(
    private readonly config: AppConfig,
    private readonly db: AppDatabase,
    private readonly catalog: CatalogService,
    private readonly orchestrator: ServerOrchestrator
  ) {}

  getAutocompleteChoices(query: string): Array<{ name: string; value: string }> {
    const q = query.trim().toLowerCase();
    return this.orchestrator
      .listInstances()
      .filter((inst) => inst.discordEnabled)
      .filter((inst) => !q || inst.name.toLowerCase().includes(q) || inst.slug.toLowerCase().includes(q))
      .slice(0, 25)
      .map((inst) => ({
        name: `${inst.name} [${inst.status}]`,
        value: inst.slug,
      }));
  }

  handleList(): CommandOutcome {
    const settings = this.db.getSettings(this.config.publicHost);
    const instances = this.orchestrator.listInstances().filter((i) => i.discordEnabled);
    const running = this.orchestrator.getRunningCount();

    if (instances.length === 0) {
      return {
        ok: true,
        title: 'ServerForge — Game Servers',
        description: 'No Discord-enabled game servers have been deployed yet. Deploy one from the Web Dashboard.',
        color: COLOR_SLATE,
      };
    }

    const fields = instances.map((inst) => {
      const tpl = this.catalog.getTemplate(inst.gameId);
      const join = this.orchestrator.getJoinAddress(inst);
      const statusBadge =
        inst.status === 'running'
          ? 'ONLINE'
          : inst.status === 'starting'
            ? 'STARTING'
            : inst.status === 'error'
              ? 'ERROR'
              : 'OFFLINE';

      const parts = [`**Status:** \`${statusBadge}\``];
      if (inst.status === 'running') {
        parts.push(`**Join:** \`${join}\``);
        if (inst.stats?.playerCount !== null && inst.stats?.playerCount !== undefined) {
          parts.push(`**Players:** ${inst.stats.playerCount}/${inst.stats.maxPlayers ?? '?'}`);
        }
        if (inst.activeLease) {
          parts.push(`**Auto-stop:** in ${formatRemainingMinutes(inst.activeLease.expiresAt)}`);
        }
      } else {
        parts.push(`**RAM Needed:** ${tpl?.resources.minRamGb ?? '?'} GB`);
      }

      return {
        name: `${inst.name} (\`${inst.slug}\`)`,
        value: parts.join(' • '),
        inline: false,
      };
    });

    return {
      ok: true,
      title: `ServerForge — Game Servers (${running}/${settings.maxConcurrentServers} Running)`,
      description: 'Use `/server start <name>` to temporarily boot a server.',
      color: COLOR_GREEN,
      fields,
    };
  }

  async handleStart(
    actor: DiscordActorContext,
    serverIdentifier: string,
    durationHours?: number
  ): Promise<CommandOutcome> {
    const settings = this.db.getSettings(this.config.publicHost);
    if (!hasDiscordBootAccess(actor, settings)) {
      return {
        ok: false,
        title: 'Permission Denied',
        description:
          'You do not have a Discord role authorized to boot game servers. Ask an admin to add your role in ServerForge Settings.',
        color: COLOR_RED,
        ephemeral: true,
      };
    }

    const existing = this.orchestrator.getInstance(serverIdentifier);
    if (!existing) {
      return {
        ok: false,
        title: 'Server Not Found',
        description: `Could not find a server named \`${serverIdentifier}\`. Run \`/server list\` to see available servers.`,
        color: COLOR_RED,
        ephemeral: true,
      };
    }

    if (!existing.discordEnabled) {
      return {
        ok: false,
        title: 'Discord Boot Disabled',
        description: `\`${existing.name}\` is restricted to Web Dashboard management only.`,
        color: COLOR_RED,
        ephemeral: true,
      };
    }

    const requestedMinutes = durationHours
      ? Math.round(durationHours * 60)
      : settings.defaultLeaseMinutes;

    try {
      const started = await this.orchestrator.startInstance(existing.id, {
        temporary: true,
        durationMinutes: Math.min(Math.max(requestedMinutes, 30), settings.maxLeaseMinutes),
        idleTimeoutMinutes: settings.defaultIdleTimeoutMinutes,
        requestedBy: actor.username,
        requestedById: actor.userId,
        source: 'discord',
        channelId: actor.channelId ?? undefined,
      });

      const joinAddr = this.orchestrator.getJoinAddress(started);
      const lease = started.activeLease;

      return {
        ok: true,
        title: `${started.name} is Online`,
        description: `Temporarily booted by **${actor.username}**. The world will automatically save and shut down when the lease expires or the server stays empty.`,
        color: COLOR_GREEN,
        fields: [
          { name: 'Join Address', value: `\`${joinAddr}\``, inline: true },
          {
            name: 'Max Lease',
            value: lease ? formatRemainingMinutes(lease.expiresAt) : 'None',
            inline: true,
          },
          {
            name: 'Idle Auto-Stop',
            value: lease && lease.idleTimeoutMinutes > 0 ? `${lease.idleTimeoutMinutes}m empty` : 'Disabled',
            inline: true,
          },
        ],
        instanceIdForButtons: started.id,
      };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return {
        ok: false,
        title: err instanceof GuardrailError ? 'Server Guardrail Blocked Boot' : 'Failed to Boot Server',
        description: message,
        color: COLOR_AMBER,
        ephemeral: true,
      };
    }
  }

  handleExtend(actor: DiscordActorContext, serverIdentifier: string, extraMinutes = 60): CommandOutcome {
    const settings = this.db.getSettings(this.config.publicHost);
    if (!hasDiscordBootAccess(actor, settings)) {
      return {
        ok: false,
        title: 'Permission Denied',
        description: 'You are not authorized to extend server leases.',
        color: COLOR_RED,
        ephemeral: true,
      };
    }

    const inst = this.orchestrator.getInstance(serverIdentifier);
    if (!inst) {
      return {
        ok: false,
        title: 'Server Not Found',
        description: `Could not find \`${serverIdentifier}\`.`,
        color: COLOR_RED,
        ephemeral: true,
      };
    }

    try {
      const lease = this.orchestrator.extendLease(inst.id, extraMinutes, actor.username, 'discord');
      return {
        ok: true,
        title: `Lease Extended — ${inst.name}`,
        description: `**${actor.username}** extended the session. Auto-shutdown is now in **${formatRemainingMinutes(lease.expiresAt)}**.`,
        color: COLOR_GREEN,
        instanceIdForButtons: inst.id,
      };
    } catch (err) {
      return {
        ok: false,
        title: 'Could Not Extend Lease',
        description: err instanceof Error ? err.message : String(err),
        color: COLOR_AMBER,
        ephemeral: true,
      };
    }
  }

  async handleStop(actor: DiscordActorContext, serverIdentifier: string): Promise<CommandOutcome> {
    const settings = this.db.getSettings(this.config.publicHost);
    const inst = this.orchestrator.getInstance(serverIdentifier);
    if (!inst) {
      return {
        ok: false,
        title: 'Server Not Found',
        description: `Could not find \`${serverIdentifier}\`.`,
        color: COLOR_RED,
        ephemeral: true,
      };
    }

    if (!canStopFromDiscord(actor, inst, settings)) {
      return {
        ok: false,
        title: 'Permission Denied',
        description: 'Only the person who started this temporary session or an admin can stop it.',
        color: COLOR_RED,
        ephemeral: true,
      };
    }

    if (inst.status === 'stopped') {
      return {
        ok: true,
        title: `${inst.name} is Already Stopped`,
        description: 'No action needed.',
        color: COLOR_SLATE,
        ephemeral: true,
      };
    }

    await this.orchestrator.stopInstance(inst.id, actor.username, 'discord', 'Stopped via Discord');
    return {
      ok: true,
      title: `${inst.name} Saved & Stopped`,
      description: `Gracefully saved and shut down by **${actor.username}**.`,
      color: COLOR_SLATE,
    };
  }

  async handleStatus(serverIdentifier: string): Promise<CommandOutcome> {
    const inst = this.orchestrator.getInstance(serverIdentifier);
    if (!inst) {
      return {
        ok: false,
        title: 'Server Not Found',
        description: `Could not find \`${serverIdentifier}\`.`,
        color: COLOR_RED,
        ephemeral: true,
      };
    }

    const stats = inst.status === 'running' ? await this.orchestrator.refreshInstanceStats(inst.id) : null;
    const joinAddr = this.orchestrator.getJoinAddress(inst);
    const fields: Array<{ name: string; value: string; inline?: boolean }> = [
      { name: 'Status', value: `\`${inst.status.toUpperCase()}\``, inline: true },
      { name: 'Join Address', value: `\`${joinAddr}\``, inline: true },
    ];

    if (stats) {
      fields.push({
        name: 'Players',
        value:
          stats.playerCount !== null ? `${stats.playerCount}/${stats.maxPlayers ?? '?'}` : 'Query unavailable',
        inline: true,
      });
      fields.push({
        name: 'Memory',
        value: stats.memoryMb > 0 ? `${stats.memoryMb} MB` : `${inst.memoryLimitMb} MB cap`,
        inline: true,
      });
    }

    if (inst.activeLease) {
      fields.push({
        name: 'Temporary Lease',
        value: `Ends in ${formatRemainingMinutes(inst.activeLease.expiresAt)} (by ${inst.activeLease.requestedBy})`,
        inline: false,
      });
    }

    return {
      ok: true,
      title: `Status — ${inst.name}`,
      description: inst.lastError ? `Last error: ${inst.lastError}` : `Runtime: \`${inst.runtime}\``,
      color: inst.status === 'running' ? COLOR_GREEN : COLOR_SLATE,
      fields,
      instanceIdForButtons: inst.status === 'running' ? inst.id : undefined,
    };
  }
}
