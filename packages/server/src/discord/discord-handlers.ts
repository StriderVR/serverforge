import type { GameTemplate, PublicHostSource, ServerInstance, SystemSettings } from '@serverforge/shared';
import type { CatalogService } from '../catalog/catalog-service.js';
import type { AppConfig } from '../config.js';
import type { AppDatabase } from '../db/database.js';
import { isLocalOrPrivateHost } from '../services/network-service.js';
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
  guideInstanceId?: string;
}

const COLOR_GREEN = 0x10b981;
const COLOR_AMBER = 0xf59e0b;
const COLOR_RED = 0xef4444;
const COLOR_SLATE = 0x475569;

const DISCORD_EMBED_TITLE_MAX = 256;
const DISCORD_EMBED_DESC_MAX = 4096;
const DISCORD_FIELD_NAME_MAX = 256;
const DISCORD_FIELD_VALUE_MAX = 1024;
const DISCORD_EMBED_TOTAL_MAX = 6000;

const SECRET_KEY_RE = /(?:PASSWORD|PASSWD|SECRET|TOKEN|API_KEY)/i;

export interface GuideInterpolationContext {
  address: string;
  host: string;
  primaryPort: string;
  publicPorts: Record<string, number>;
  safeConfig: Record<string, string>;
}

export function hasConfiguredPublicHost(publicHost: string, publicHostSource: PublicHostSource): boolean {
  const trimmed = publicHost.trim();
  if (!trimmed) return false;
  if (publicHostSource === 'fallback' || publicHostSource === 'lan') return false;
  if (isLocalOrPrivateHost(trimmed)) return false;
  return true;
}

export function truncateDiscordText(text: string, maxLen: number): string {
  if (maxLen <= 0) return '';
  if (text.length <= maxLen) return text;
  if (maxLen === 1) return '…';
  return `${text.slice(0, maxLen - 1).trimEnd()}…`;
}

function getSecretConfigKeys(template: GameTemplate | null): Set<string> {
  const keys = new Set<string>(['RCON_PASSWORD', 'ADMIN_PASSWORD', 'SERVER_PASSWORD', 'FACTORIO_TOKEN', 'CF_API_KEY']);
  if (template) {
    for (const field of template.configFields) {
      if (field.type === 'secret' || SECRET_KEY_RE.test(field.key)) {
        keys.add(field.key);
      }
    }
  }
  return keys;
}

function redactInstanceSecrets(text: string, inst: ServerInstance, template: GameTemplate | null): string {
  const secretKeys = getSecretConfigKeys(template);
  let out = text;
  for (const [key, rawVal] of Object.entries(inst.config)) {
    if (!secretKeys.has(key) && !SECRET_KEY_RE.test(key)) continue;
    const val = String(rawVal ?? '').trim();
    if (val.length >= 3) {
      out = out.split(val).join('[REDACTED]');
    }
  }
  return out;
}

export function interpolateGuideText(text: string, ctx: GuideInterpolationContext): string {
  // Replace double-brace placeholders FIRST so {{HOST}} is never partially consumed by {host}.
  const afterDouble = text.replace(/\{\{\s*([A-Za-z0-9_]+)\s*\}\}/g, (_match, rawKey: string) => {
    const upper = rawKey.toUpperCase();
    if (upper === 'ADDRESS') return ctx.address;
    if (upper === 'HOST') return ctx.host;
    if (upper === 'PORT' || upper === 'PORT_PRIMARY') return ctx.primaryPort;
    if (upper.startsWith('PORT_')) {
      const portKey = upper.slice(5).toLowerCase();
      if (portKey in ctx.publicPorts) return String(ctx.publicPorts[portKey]);
      if (portKey === 'game') return ctx.primaryPort;
      return '';
    }
    if (upper in ctx.safeConfig) return ctx.safeConfig[upper] ?? '';
    return '';
  });

  // Replace single-brace placeholders SECOND ({address}, {host}, {port}, {port_<name>}).
  return afterDouble.replace(/\{\s*([A-Za-z0-9_]+)\s*\}/g, (match, rawKey: string) => {
    const lower = rawKey.toLowerCase();
    if (lower === 'address') return ctx.address;
    if (lower === 'host') return ctx.host;
    if (lower === 'port') return ctx.primaryPort;
    if (lower.startsWith('port_')) {
      const portKey = lower.slice(5);
      if (portKey in ctx.publicPorts) return String(ctx.publicPorts[portKey]);
      if (portKey === 'game') return ctx.primaryPort;
      return '';
    }
    return match;
  });
}

function sanitizePublicUrl(rawUrl: string): string | null {
  const trimmed = rawUrl.trim();
  if (!trimmed) return null;
  try {
    const parsed = new URL(trimmed);
    if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') return null;
    if (isLocalOrPrivateHost(parsed.hostname)) return null;
    return parsed.toString();
  } catch {
    return null;
  }
}

function buildGuideModpackInfo(inst: ServerInstance): { name: string; value: string } | null {
  if (inst.gameId === 'minecraft-curseforge') {
    const slug = String(inst.config.CF_SLUG ?? '').trim();
    const fileId = String(inst.config.CF_FILE_ID ?? '').trim();
    const safePageUrl = sanitizePublicUrl(String(inst.config.CF_PAGE_URL ?? ''));
    const parts: string[] = ['CurseForge'];
    if (slug) parts.push(`Pack: \`${slug}\``);
    if (fileId) parts.push(`File ID: \`${fileId}\``);
    if (safePageUrl) parts.push(`[Modpack Page](${safePageUrl})`);
    return { name: 'Modpack', value: parts.join(' • ') };
  }

  if (inst.gameId === 'minecraft-modrinth') {
    const projectId = String(inst.config.MR_PROJECT_ID ?? '').trim();
    const versionId = String(inst.config.MR_VERSION_ID ?? '').trim();
    const parts: string[] = ['Modrinth'];
    if (projectId) parts.push(`Pack: \`${projectId}\``);
    if (versionId) parts.push(`Version: \`${versionId}\``);
    return { name: 'Modpack', value: parts.join(' • ') };
  }

  if (inst.gameId === 'minecraft') {
    const serverType = String(inst.config.SERVER_TYPE ?? '').trim();
    const mcVersion = String(inst.config.MC_VERSION ?? '').trim();
    const loaderVersion = String(inst.config.LOADER_VERSION ?? '').trim();
    const modpackSlug = String(inst.config.MODPACK_SLUG ?? '').trim();
    const parts: string[] = [];
    if (serverType) {
      parts.push(loaderVersion ? `Loader: **${serverType}** (\`${loaderVersion}\`)` : `Loader: **${serverType}**`);
    }
    if (mcVersion) parts.push(`Minecraft: \`${mcVersion}\``);
    if (modpackSlug) parts.push(`Modpack: \`${modpackSlug}\``);
    if (parts.length === 0) return null;
    return { name: modpackSlug ? 'Modpack & Loader' : 'Loader & Version', value: parts.join(' • ') };
  }

  return null;
}

function formatGuidePorts(inst: ServerInstance, template: GameTemplate | null): string {
  if (template) {
    const publicSpecs = template.ports.filter((p) => !p.internalOnly);
    if (publicSpecs.length > 0) {
      return publicSpecs
        .map((p) => {
          const allocated = inst.ports[p.key] ?? p.defaultPort;
          const proto = p.protocol === 'both' ? 'TCP/UDP' : p.protocol.toUpperCase();
          return `${p.label}: \`${allocated}\` (${proto})`;
        })
        .join('\n');
    }
  } else {
    const entries = Object.entries(inst.ports).filter(
      ([key]) => key.toLowerCase() !== 'rcon' && key.toLowerCase() !== 'rest'
    );
    if (entries.length > 0) {
      return entries.map(([key, port]) => `${key}: \`${port}\``).join('\n');
    }
  }
  return 'No public game ports configured';
}

function buildGuideSteps(
  inst: ServerInstance,
  template: GameTemplate | null,
  ctx: GuideInterpolationContext,
  hasPublicHost: boolean,
  hasJoinPassword: boolean
): string {
  const rawSteps = template?.connectSteps?.map((s) => s.trim()).filter(Boolean) ?? [];
  if (rawSteps.length > 0) {
    return rawSteps
      .map((step, idx) => `${idx + 1}. ${redactInstanceSecrets(interpolateGuideText(step, ctx), inst, template)}`)
      .join('\n');
  }

  const gameName = template?.name ?? inst.gameId;
  const rawHint = template?.joinHint?.trim() ?? '';
  if (rawHint) {
    const interpolatedHint = redactInstanceSecrets(interpolateGuideText(rawHint, ctx), inst, template);
    const lines = [`1. Launch **${gameName}**.`, `2. ${interpolatedHint}`];
    if (hasJoinPassword) {
      lines.push('3. Enter the server password (ask the host).');
    }
    return lines.join('\n');
  }

  const lines = hasPublicHost
    ? [
        `1. Launch **${gameName}**.`,
        '2. Open the multiplayer / direct connect menu.',
        `3. Connect to \`${ctx.address}\`.`,
      ]
    : [
        '1. Ask the server host for the public server address (DuckDNS / Public Host is not configured yet).',
        `2. Launch **${gameName}** and open the multiplayer / direct connect menu.`,
        `3. Connect using the host's address on port \`${ctx.primaryPort}\`.`,
      ];

  if (hasJoinPassword) {
    lines.push('4. Enter the server password (ask the host).');
  }
  return lines.join('\n');
}

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
      description: 'Use `/server start <name>` to temporarily boot a server or `/server guide <name>` for join instructions.',
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
      guideInstanceId: inst.discordEnabled ? inst.id : undefined,
    };
  }

  /**
   * Public friend-facing command: returns live Online/Offline status, player count, copyable WAN/DuckDNS
   * join address & public ports, modpack/loader details, and interpolated per-game connect steps.
   */
  async handleGuide(serverIdentifier: string): Promise<CommandOutcome> {
    const query = serverIdentifier.trim();
    const inst = this.orchestrator.getInstance(query);
    if (!inst) {
      return {
        ok: false,
        title: 'Server Not Found',
        description: `Could not find a server named \`${query || serverIdentifier}\`. Run \`/server list\` to see available servers.`,
        color: COLOR_RED,
        ephemeral: true,
      };
    }

    if (!inst.discordEnabled) {
      return {
        ok: false,
        title: 'Discord Guide Disabled',
        description: `\`${inst.name}\` is restricted to Web Dashboard management only.`,
        color: COLOR_RED,
        ephemeral: true,
      };
    }

    const template = this.catalog.getTemplate(inst.gameId);
    let stats = inst.status === 'running' ? (inst.stats ?? null) : null;
    if (inst.status === 'running') {
      try {
        const fresh = await this.orchestrator.refreshInstanceStats(inst.id);
        if (fresh) stats = fresh;
      } catch {
        // Keep cached stats or null — never fail guide generation on query timeout/error
      }
    }

    const joinInfo = this.orchestrator.getJoinAddressInfo(inst);
    const hasPublicHost = hasConfiguredPublicHost(joinInfo.publicHost, joinInfo.publicHostSource);
    const primarySpec = template?.ports.find((p) => p.primary) ?? template?.ports[0];
    const primaryPortNum = primarySpec
      ? (inst.ports[primarySpec.key] ?? primarySpec.defaultPort)
      : Object.values(inst.ports)[0];
    const primaryPort = primaryPortNum !== undefined ? String(primaryPortNum) : 'default';
    const publicAddress = hasPublicHost
      ? primaryPortNum !== undefined
        ? `${joinInfo.publicHost}:${primaryPortNum}`
        : joinInfo.publicHost
      : '';

    const publicPorts: Record<string, number> = {};
    if (template) {
      for (const p of template.ports) {
        if (p.internalOnly) continue;
        const allocated = inst.ports[p.key] ?? p.defaultPort;
        publicPorts[p.key.toLowerCase()] = allocated;
      }
    } else {
      for (const [key, port] of Object.entries(inst.ports)) {
        const lower = key.toLowerCase();
        if (lower === 'rcon' || lower === 'rest') continue;
        publicPorts[lower] = port;
      }
    }

    const secretKeys = getSecretConfigKeys(template);
    const safeConfig: Record<string, string> = {};
    for (const [key, rawVal] of Object.entries(inst.config)) {
      if (secretKeys.has(key) || SECRET_KEY_RE.test(key)) continue;
      safeConfig[key.toUpperCase()] = String(rawVal ?? '').trim();
    }

    const ctx: GuideInterpolationContext = {
      address: hasPublicHost ? publicAddress : '<ask-host-for-address>',
      host: hasPublicHost ? joinInfo.publicHost : '<ask-host-for-host>',
      primaryPort,
      publicPorts,
      safeConfig,
    };

    const hasJoinPassword = String(inst.config.SERVER_PASSWORD ?? '').trim().length > 0;

    const statusValue =
      inst.status === 'running'
        ? '🟢 ONLINE'
        : inst.status === 'starting' || inst.status === 'installing'
          ? `🟡 ${inst.status.toUpperCase()}`
          : inst.status === 'error'
            ? '🔴 ERROR'
            : '⚫ OFFLINE';

    const playersValue =
      inst.status === 'running'
        ? stats && stats.playerCount !== null && stats.playerCount !== undefined
          ? `${stats.playerCount}/${stats.maxPlayers ?? '?'}`
          : 'Query unavailable'
        : 'Offline (0 online)';

    const duckDnsNote =
      joinInfo.publicHostSource === 'duckdns' || joinInfo.publicHostSource === 'detected_duckdns'
        ? '\n*(via DuckDNS)*'
        : '';

    const joinAddressValue = hasPublicHost
      ? `\`\`\`\n${publicAddress}\n\`\`\`${duckDnsNote}`
      : '⚠️ Public join address is not configured yet. Ask the host to configure **DuckDNS** or a **Public Host** in ServerForge (**Settings → Networking**).';

    const fields: Array<{ name: string; value: string; inline?: boolean }> = [
      { name: 'Status', value: statusValue, inline: true },
      { name: 'Players', value: playersValue, inline: true },
    ];

    if (hasJoinPassword) {
      fields.push({
        name: 'Join Password',
        value: 'Password required — ask the host',
        inline: true,
      });
    }

    fields.push({ name: 'Join Address', value: joinAddressValue, inline: false });
    fields.push({ name: 'Ports', value: formatGuidePorts(inst, template), inline: false });

    const modpackInfo = buildGuideModpackInfo(inst);
    if (modpackInfo) {
      fields.push({
        name: modpackInfo.name,
        value: redactInstanceSecrets(modpackInfo.value, inst, template),
        inline: false,
      });
    }

    const stepsFieldIndex = fields.length;
    fields.push({
      name: 'How to Connect',
      value: buildGuideSteps(inst, template, ctx, hasPublicHost, hasJoinPassword),
      inline: false,
    });

    if (inst.status === 'running' && inst.activeLease) {
      fields.push({
        name: 'Temporary Lease',
        value: `Auto-stops in **${formatRemainingMinutes(inst.activeLease.expiresAt)}** (started by ${inst.activeLease.requestedBy})`,
        inline: false,
      });
    }

    const gameName = template?.name ?? inst.gameId;
    const rawDescription =
      inst.status === 'running'
        ? `**${gameName}** is currently **online** and ready to join.`
        : inst.status === 'starting' || inst.status === 'installing'
          ? `**${gameName}** is currently **${inst.status}** — you can copy the connection details below while it finishes booting.`
          : `**${gameName}** is currently **offline**. Use \`/server start ${inst.slug}\` (or the Live Status Panel) to boot it when you're ready to play.`;

    const title = truncateDiscordText(`How to Connect — ${inst.name}`, DISCORD_EMBED_TITLE_MAX);
    const description = truncateDiscordText(rawDescription, DISCORD_EMBED_DESC_MAX);

    const boundedFields = fields.map((f) => ({
      ...f,
      name: truncateDiscordText(f.name, DISCORD_FIELD_NAME_MAX),
      value: truncateDiscordText(f.value, DISCORD_FIELD_VALUE_MAX),
    }));

    const calcTotal = () =>
      title.length + description.length + boundedFields.reduce((acc, f) => acc + f.name.length + f.value.length, 0);

    let overflow = calcTotal() - DISCORD_EMBED_TOTAL_MAX;
    if (overflow > 0 && boundedFields[stepsFieldIndex]) {
      const targetMax = Math.max(32, boundedFields[stepsFieldIndex].value.length - overflow);
      boundedFields[stepsFieldIndex] = {
        ...boundedFields[stepsFieldIndex],
        value: truncateDiscordText(boundedFields[stepsFieldIndex].value, targetMax),
      };
      overflow = calcTotal() - DISCORD_EMBED_TOTAL_MAX;
    }
    if (overflow > 0) {
      const indices = boundedFields.map((_, idx) => idx).sort((a, b) => boundedFields[b].value.length - boundedFields[a].value.length);
      for (const idx of indices) {
        if (overflow <= 0) break;
        const curLen = boundedFields[idx].value.length;
        if (curLen <= 16) continue;
        const targetMax = Math.max(16, curLen - overflow);
        boundedFields[idx] = {
          ...boundedFields[idx],
          value: truncateDiscordText(boundedFields[idx].value, targetMax),
        };
        overflow = calcTotal() - DISCORD_EMBED_TOTAL_MAX;
      }
    }

    const color =
      inst.status === 'running'
        ? COLOR_GREEN
        : inst.status === 'starting' || inst.status === 'installing'
          ? COLOR_AMBER
          : inst.status === 'error'
            ? COLOR_RED
            : COLOR_SLATE;

    return {
      ok: true,
      title,
      description,
      color,
      fields: boundedFields,
    };
  }

  /**
   * Admin command: triggers a world backup snapshot for a server from Discord.
   */
  async handleBackup(
    actor: DiscordActorContext,
    serverIdentifier: string,
    note?: string
  ): Promise<CommandOutcome> {
    const settings = this.db.getSettings(this.config.publicHost);
    if (!hasDiscordAdminAccess(actor, settings)) {
      return {
        ok: false,
        title: 'Admin Permission Required',
        description: 'Only Discord admins or configured Admin Roles can trigger backups from Discord.',
        color: COLOR_RED,
        ephemeral: true,
      };
    }

    const inst = this.orchestrator.getInstance(serverIdentifier);
    if (!inst) {
      return {
        ok: false,
        title: 'Server Not Found',
        description: `Could not find a server named \`${serverIdentifier}\`.`,
        color: COLOR_RED,
        ephemeral: true,
      };
    }

    try {
      const backup = await this.orchestrator.createBackup(
        inst.id,
        actor.username,
        note?.trim() || `Discord backup by ${actor.username}`
      );
      const sizeMb = (backup.sizeBytes / (1024 * 1024)).toFixed(2);
      return {
        ok: true,
        title: `Backup Created — ${inst.name}`,
        description: `World snapshot saved by **${actor.username}**.`,
        color: COLOR_GREEN,
        fields: [
          { name: 'Archive', value: `\`${backup.filename}\``, inline: true },
          { name: 'Size', value: `${sizeMb} MB`, inline: true },
          { name: 'Note', value: backup.note || '—', inline: false },
        ],
      };
    } catch (err) {
      return {
        ok: false,
        title: 'Backup Failed',
        description: err instanceof Error ? err.message : String(err),
        color: COLOR_RED,
        ephemeral: true,
      };
    }
  }

  /**
   * Admin command: broadcasts an in-game announcement to a running server via RCON/stdin.
   */
  async handleSay(
    actor: DiscordActorContext,
    serverIdentifier: string,
    message: string
  ): Promise<CommandOutcome> {
    const settings = this.db.getSettings(this.config.publicHost);
    if (!hasDiscordAdminAccess(actor, settings)) {
      return {
        ok: false,
        title: 'Admin Permission Required',
        description: 'Only Discord admins or configured Admin Roles can broadcast announcements.',
        color: COLOR_RED,
        ephemeral: true,
      };
    }

    const cleanMessage = message.replace(/[\r\n]+/g, ' ').trim();
    if (!cleanMessage) {
      return {
        ok: false,
        title: 'Empty Message',
        description: 'Provide a non-empty message to broadcast.',
        color: COLOR_AMBER,
        ephemeral: true,
      };
    }

    const inst = this.orchestrator.getInstance(serverIdentifier);
    if (!inst) {
      return {
        ok: false,
        title: 'Server Not Found',
        description: `Could not find a server named \`${serverIdentifier}\`.`,
        color: COLOR_RED,
        ephemeral: true,
      };
    }

    if (inst.status !== 'running') {
      return {
        ok: false,
        title: 'Server Offline',
        description: `**${inst.name}** must be running to broadcast an in-game message.`,
        color: COLOR_AMBER,
        ephemeral: true,
      };
    }

    const command =
      inst.gameId === 'ark-survival-ascended' || inst.gameId === 'palworld'
        ? `Broadcast [Discord/${actor.username}] ${cleanMessage}`
        : inst.gameId === 'factorio'
          ? `[Discord/${actor.username}] ${cleanMessage}`
          : `say [Discord/${actor.username}] ${cleanMessage}`;

    try {
      const reply = await this.orchestrator.sendCommand(inst.id, command, actor.username);
      return {
        ok: true,
        title: `Announcement Sent — ${inst.name}`,
        description: `> ${cleanMessage}`,
        color: COLOR_GREEN,
        fields: [
          { name: 'Sent By', value: actor.username, inline: true },
          ...(reply ? [{ name: 'Server Reply', value: `\`${reply.slice(0, 180)}\``, inline: false }] : []),
        ],
      };
    } catch (err) {
      return {
        ok: false,
        title: 'Broadcast Failed',
        description: err instanceof Error ? err.message : String(err),
        color: COLOR_RED,
        ephemeral: true,
      };
    }
  }

  /**
   * Admin command: manages Minecraft server whitelists (`add`, `remove`, `list`) via RCON.
   */
  async handleWhitelist(
    actor: DiscordActorContext,
    serverIdentifier: string,
    action: 'add' | 'remove' | 'list',
    player?: string
  ): Promise<CommandOutcome> {
    const settings = this.db.getSettings(this.config.publicHost);
    if (!hasDiscordAdminAccess(actor, settings)) {
      return {
        ok: false,
        title: 'Admin Permission Required',
        description: 'Only Discord admins or configured Admin Roles can manage whitelists.',
        color: COLOR_RED,
        ephemeral: true,
      };
    }

    const inst = this.orchestrator.getInstance(serverIdentifier);
    if (!inst) {
      return {
        ok: false,
        title: 'Server Not Found',
        description: `Could not find a server named \`${serverIdentifier}\`.`,
        color: COLOR_RED,
        ephemeral: true,
      };
    }

    if (inst.gameId !== 'minecraft' && inst.gameId !== 'minecraft-curseforge') {
      return {
        ok: false,
        title: 'Unsupported Game',
        description: `\`/server whitelist\` is currently supported for Minecraft servers (**${inst.name}** is \`${inst.gameId}\`).`,
        color: COLOR_AMBER,
        ephemeral: true,
      };
    }

    if (inst.status !== 'running') {
      return {
        ok: false,
        title: 'Server Offline',
        description: `**${inst.name}** must be running to update its whitelist via RCON.`,
        color: COLOR_AMBER,
        ephemeral: true,
      };
    }

    const safePlayer = (player ?? '').trim();
    if (action !== 'list') {
      if (!safePlayer || !/^[A-Za-z0-9_]{2,32}$/.test(safePlayer)) {
        return {
          ok: false,
          title: 'Invalid Player Name',
          description: 'Provide a valid Minecraft username (2–32 letters, numbers, or underscores).',
          color: COLOR_AMBER,
          ephemeral: true,
        };
      }
    }

    const cmd = action === 'list' ? 'whitelist list' : `whitelist ${action} ${safePlayer}`;
    try {
      const reply = await this.orchestrator.sendCommand(inst.id, cmd, actor.username);
      return {
        ok: true,
        title: `Whitelist Updated — ${inst.name}`,
        description: reply ? `\`${reply.slice(0, 500)}\`` : `Executed \`${cmd}\`.`,
        color: COLOR_GREEN,
        fields: [
          { name: 'Action', value: action.toUpperCase(), inline: true },
          ...(safePlayer ? [{ name: 'Player', value: `\`${safePlayer}\``, inline: true }] : []),
        ],
      };
    } catch (err) {
      return {
        ok: false,
        title: 'Whitelist Command Failed',
        description: err instanceof Error ? err.message : String(err),
        color: COLOR_RED,
        ephemeral: true,
      };
    }
  }

  /**
   * Builds the persistent, auto-updating Live Status Panel embed and interactive quick-action button rows.
   * Respects Discord's strict 5-action-row / 5-buttons-per-row message limits.
   */
  buildStatusPanelPayload(): StatusPanelPayload {
    const settings = this.db.getSettings(this.config.publicHost);
    const instances = this.orchestrator.listInstances().filter((i) => i.discordEnabled);
    const running = this.orchestrator.getRunningCount();

    if (instances.length === 0) {
      return {
        title: 'ServerForge — Live Server Status',
        description: 'No Discord-enabled game servers have been deployed yet. Deploy one from the ServerForge Web Dashboard.',
        color: COLOR_SLATE,
        fields: [],
        buttonRows: [[{ customId: 'sf:panel_refresh', label: 'Refresh Now', style: 'secondary' }]],
      };
    }

    // Prioritize running servers first so online servers and Stop/+1h buttons appear at the top
    const prioritized = [...instances].sort((a, b) => {
      const rank = (s: ServerInstance['status']) => (s === 'running' ? 0 : s === 'starting' || s === 'installing' ? 1 : 2);
      return rank(a.status) - rank(b.status);
    });

    const fields = prioritized.slice(0, 25).map((inst) => {
      const tpl = this.catalog.getTemplate(inst.gameId);
      const join = this.orchestrator.getJoinAddress(inst);
      const statusLabel =
        inst.status === 'running'
          ? '🟢 ONLINE'
          : inst.status === 'starting' || inst.status === 'installing'
            ? `🟡 ${inst.status.toUpperCase()}`
            : inst.status === 'error'
              ? '🔴 ERROR'
              : '⚫ OFFLINE';

      const details: string[] = [statusLabel];
      if (inst.status === 'running') {
        details.push(`Join: \`${join}\``);
        if (inst.stats?.playerCount !== null && inst.stats?.playerCount !== undefined) {
          details.push(`Players: **${inst.stats.playerCount}/${inst.stats.maxPlayers ?? '?'}**`);
        }
        if (inst.activeLease) {
          details.push(`Auto-stop: **${formatRemainingMinutes(inst.activeLease.expiresAt)}**`);
        }
      } else if (inst.status === 'error' && inst.lastError) {
        details.push(inst.lastError.slice(0, 90));
      } else {
        details.push(`${tpl?.shortName ?? inst.gameId} • ${tpl?.resources.minRamGb ?? '?'} GB RAM`);
      }

      return {
        name: `${inst.name} (\`${inst.slug}\`)`,
        value: details.join(' • '),
        inline: false,
      };
    });

    // Build up to 4 rows of quick-action server buttons + 1 final utility row (max 5 rows total)
    const buttonRows: StatusPanelButtonSpec[][] = [];
    const shorten = (name: string, max = 18) => (name.length > max ? `${name.slice(0, max - 1)}…` : name);
    const isCompactRow = (row: StatusPanelButtonSpec[] | undefined): row is StatusPanelButtonSpec[] =>
      Boolean(
        row && row.every((b) => b.customId.startsWith('sf:panel_start:') || b.customId.startsWith('sf:guide:'))
      );

    for (const inst of prioritized) {
      const shortName = shorten(inst.name, 16);
      const guideBtn: StatusPanelButtonSpec = {
        customId: `sf:guide:${inst.id}`,
        label: `Guide ${shortName}`,
        style: 'secondary',
      };

      if (inst.status === 'running') {
        if (buttonRows.length >= 4) break;
        buttonRows.push([
          { customId: `sf:extend:${inst.id}`, label: `+1h ${shortName}`, style: 'primary' },
          { customId: `sf:stop:${inst.id}`, label: `Stop ${shortName}`, style: 'danger' },
          guideBtn,
        ]);
      } else if (inst.status === 'stopped' || inst.status === 'error') {
        // Pack up to 2 stopped servers (4 buttons: Start + Guide each) onto a single compact row
        const lastRow = buttonRows[buttonRows.length - 1];
        const startBtn: StatusPanelButtonSpec = {
          customId: `sf:panel_start:${inst.id}`,
          label: `Start ${shortName}`,
          style: 'success',
        };
        if (isCompactRow(lastRow) && lastRow.length + 2 <= 4) {
          lastRow.push(startBtn, guideBtn);
        } else {
          if (buttonRows.length >= 4) continue;
          buttonRows.push([startBtn, guideBtn]);
        }
      } else {
        // starting / installing: offer a Guide button so friends can prep while the server boots
        const lastRow = buttonRows[buttonRows.length - 1];
        if (isCompactRow(lastRow) && lastRow.length + 1 <= 5) {
          lastRow.push(guideBtn);
        } else {
          if (buttonRows.length >= 4) continue;
          buttonRows.push([guideBtn]);
        }
      }
    }

    buttonRows.push([{ customId: 'sf:panel_refresh', label: 'Refresh Now', style: 'secondary' }]);

    return {
      title: `ServerForge — Live Server Status (${running}/${settings.maxConcurrentServers} Running)`,
      description:
        'Click a button below to start, extend, stop, or view the connect guide for a server — or use `/server start <name>` and `/server guide <name>`. This panel updates automatically.',
      color: running > 0 ? COLOR_GREEN : COLOR_SLATE,
      fields,
      buttonRows,
    };
  }
}

export interface StatusPanelButtonSpec {
  customId: string;
  label: string;
  style: 'primary' | 'secondary' | 'success' | 'danger';
}

export interface StatusPanelPayload {
  title: string;
  description: string;
  color: number;
  fields: Array<{ name: string; value: string; inline?: boolean }>;
  buttonRows: StatusPanelButtonSpec[][];
}

/**
 * Formats a compact Discord activity embed payload when players join or leave a server.
 */
export function formatPlayerActivityMessage(
  instanceName: string,
  joined: string[],
  left: string[],
  playerCount: number | null,
  maxPlayers: number | null
): { title: string; description: string; color: number } | null {
  if (joined.length === 0 && left.length === 0) return null;

  const lines: string[] = [];
  for (const p of joined) {
    lines.push(`🟢 **${p}** joined **${instanceName}**`);
  }
  for (const p of left) {
    lines.push(`⚪ **${p}** left **${instanceName}**`);
  }
  const countSuffix =
    playerCount !== null ? ` (${playerCount}${maxPlayers !== null ? `/${maxPlayers}` : ''} online)` : '';

  return {
    title: `Player Activity — ${instanceName}${countSuffix}`,
    description: lines.join('\n'),
    color: joined.length > 0 ? COLOR_GREEN : COLOR_SLATE,
  };
}
