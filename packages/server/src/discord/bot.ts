import {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  ChannelType,
  Client,
  EmbedBuilder,
  GatewayIntentBits,
  PermissionFlagsBits,
  REST,
  Routes,
  SlashCommandBuilder,
  type ButtonInteraction,
  type ChatInputCommandInteraction,
  type Guild,
  type Interaction,
  type TextBasedChannel,
} from 'discord.js';
import type {
  CrashSummary,
  DiscordChannelSummary,
  DiscordDiscoveryStatus,
  DiscordGuildSummary,
  DiscordRoleSummary,
  ServerInstance,
} from '@serverforge/shared';
import type { CatalogService } from '../catalog/catalog-service.js';
import type { AppConfig } from '../config.js';
import type { AppDatabase } from '../db/database.js';
import { redactSecrets } from '../services/diagnostics-service.js';
import type { ServerOrchestrator } from '../services/orchestrator.js';
import {
  DiscordCommandHandler,
  formatPlayerActivityMessage,
  hasDiscordAdminAccess,
  type CommandOutcome,
  type DiscordActorContext,
  type StatusPanelButtonSpec,
} from './discord-handlers.js';

/**
 * Least-privilege Discord bot permissions:
 * ViewChannel (1024) + SendMessages (2048) + EmbedLinks (16384) + ReadMessageHistory (65536) = 84992
 */
export const DISCORD_BOT_PERMISSIONS_BITMASK = '84992';

export interface CrashAlertEmbedPayload {
  title: string;
  description: string;
  color: number;
  fields: Array<{ name: string; value: string; inline?: boolean }>;
}

export interface VerifiedDiscordTokenInfo {
  botId: string;
  botTag: string;
  applicationId: string;
  inviteUrl: string;
}

/**
 * Cleans up a pasted Discord Bot Token (trims whitespace, quotes, and accidental `Bot ` prefix).
 */
export function normalizeDiscordToken(raw: string): string {
  let token = raw.trim();
  if (
    (token.startsWith('"') && token.endsWith('"')) ||
    (token.startsWith("'") && token.endsWith("'"))
  ) {
    token = token.slice(1, -1).trim();
  }
  if (/^bot\s+/i.test(token)) {
    token = token.replace(/^bot\s+/i, '').trim();
  }
  return token;
}

/**
 * Generates a least-privilege Discord OAuth2 Bot Invite URL with slash commands enabled.
 */
export function buildBotInviteUrl(applicationId: string): string {
  return `https://discord.com/oauth2/authorize?client_id=${encodeURIComponent(applicationId)}&permissions=${DISCORD_BOT_PERMISSIONS_BITMASK}&scope=bot%20applications.commands`;
}

/**
 * Validates a Discord Bot Token against Discord's REST API and extracts its Bot Tag & Application ID.
 */
export async function verifyDiscordBotToken(
  rawToken: string,
  fetchImpl: typeof fetch = fetch
): Promise<VerifiedDiscordTokenInfo> {
  const token = normalizeDiscordToken(rawToken);
  if (!token || token.length < 30) {
    throw new Error(
      'Discord Bot Token looks empty or too short. Copy the full token from Discord Developer Portal -> Bot -> Reset Token.'
    );
  }

  const headers = {
    Authorization: `Bot ${token}`,
    'User-Agent': 'ServerForge (+https://github.com/StriderVR/serverforge)',
  };

  const userRes = await fetchImpl('https://discord.com/api/v10/users/@me', {
    headers,
    signal: AbortSignal.timeout(10_000),
  });

  if (userRes.status === 401) {
    throw new Error(
      'Invalid Discord Bot Token (HTTP 401 Unauthorized). Generate a fresh token in Discord Developer Portal -> Bot -> Reset Token.'
    );
  }
  if (!userRes.ok) {
    throw new Error(`Discord API returned HTTP ${userRes.status} while verifying the bot token.`);
  }

  const user = (await userRes.json()) as {
    id?: string;
    username?: string;
    discriminator?: string;
    bot?: boolean;
  };
  if (!user.id || !user.username) {
    throw new Error('Discord API returned an unexpected bot profile response.');
  }

  const botTag =
    user.discriminator && user.discriminator !== '0'
      ? `${user.username}#${user.discriminator}`
      : user.username;

  let applicationId = user.id;
  try {
    const appRes = await fetchImpl('https://discord.com/api/v10/oauth2/applications/@me', {
      headers,
      signal: AbortSignal.timeout(8_000),
    });
    if (appRes.ok) {
      const app = (await appRes.json()) as { id?: string };
      if (app.id) applicationId = app.id;
    }
  } catch {
    // Fallback to bot user ID (identical to Application ID on modern Discord bots)
  }

  return {
    botId: user.id,
    botTag,
    applicationId,
    inviteUrl: buildBotInviteUrl(applicationId),
  };
}

/**
 * Formats a sanitized Discord embed for unexpected server crashes and crash-loop halts.
 */
export function buildCrashAlertEmbedData(
  instance: Pick<ServerInstance, 'name' | 'slug' | 'runtime' | 'autoRestartOnCrash'>,
  crash: CrashSummary
): CrashAlertEmbedPayload {
  const title = crash.halted
    ? `Server Crash-Loop Halted — ${instance.name}`
    : `Server Crash Detected — ${instance.name}`;

  const description = crash.halted
    ? instance.autoRestartOnCrash === false
      ? `**${instance.name}** crashed unexpectedly and auto-restart is disabled. Manual review is required.`
      : `**${instance.name}** crashed repeatedly (**${crash.attemptCount}/${crash.maxAttempts}** attempts). ServerForge halted automatic restarts to prevent a crash loop.`
    : `**${instance.name}** exited unexpectedly. ServerForge is automatically restarting it (attempt **${crash.attemptCount}/${crash.maxAttempts}**).`;

  const tailLines = crash.logTail.slice(-12).map((line) => redactSecrets(line));
  let tailBlock = tailLines.length > 0 ? tailLines.join('\n') : '(no recent console lines captured)';
  if (tailBlock.length > 950) {
    tailBlock = '...\n' + tailBlock.slice(-940);
  }

  const nextAction = crash.halted
    ? 'Halted (status: ERROR)'
    : crash.nextRestartAt
      ? `Restart scheduled at ${crash.nextRestartAt.slice(11, 19)} UTC`
      : 'Restarting shortly';

  return {
    title,
    description,
    color: crash.halted ? 0xef4444 : 0xf59e0b,
    fields: [
      { name: 'Exit Code', value: `\`${crash.exitCode ?? 'unknown'}\``, inline: true },
      { name: 'Attempts', value: `${crash.attemptCount}/${crash.maxAttempts}`, inline: true },
      { name: 'Watchdog Status', value: nextAction, inline: true },
      { name: 'Recent Console Tail', value: `\`\`\`text\n${tailBlock}\n\`\`\`` },
    ],
  };
}

export function buildServerSlashCommands() {
  return [
    new SlashCommandBuilder()
      .setName('server')
      .setDescription('Manage and temporarily boot game servers on ServerForge')
      .addSubcommand((sub) => sub.setName('list').setDescription('List available game servers and status'))
      .addSubcommand((sub) =>
        sub
          .setName('start')
          .setDescription('Temporarily boot a game server')
          .addStringOption((opt) =>
            opt.setName('name').setDescription('Server to boot').setRequired(true).setAutocomplete(true)
          )
          .addNumberOption((opt) =>
            opt
              .setName('hours')
              .setDescription('Temporary lease duration in hours (e.g. 2, 3, 4)')
              .setMinValue(0.5)
              .setMaxValue(12)
          )
      )
      .addSubcommand((sub) =>
        sub
          .setName('extend')
          .setDescription('Extend an active temporary server lease')
          .addStringOption((opt) =>
            opt.setName('name').setDescription('Running server').setRequired(true).setAutocomplete(true)
          )
          .addIntegerOption((opt) =>
            opt
              .setName('minutes')
              .setDescription('Minutes to add (default: 60)')
              .setMinValue(15)
              .setMaxValue(240)
          )
      )
      .addSubcommand((sub) =>
        sub
          .setName('stop')
          .setDescription('Gracefully save and stop a running game server')
          .addStringOption((opt) =>
            opt.setName('name').setDescription('Running server').setRequired(true).setAutocomplete(true)
          )
      )
      .addSubcommand((sub) =>
        sub
          .setName('status')
          .setDescription('Check live status, players, and lease countdown for a server')
          .addStringOption((opt) =>
            opt.setName('name').setDescription('Server name').setRequired(true).setAutocomplete(true)
          )
      )
      .addSubcommand((sub) =>
        sub
          .setName('guide')
          .setDescription('Show how to connect, live status, join address, and game-specific setup steps')
          .addStringOption((opt) =>
            opt.setName('name').setDescription('Server name').setRequired(true).setAutocomplete(true)
          )
      )
      .addSubcommand((sub) =>
        sub
          .setName('panel')
          .setDescription('Post or refresh the live auto-updating ServerForge status panel in this channel (Admin)')
      )
      .addSubcommand((sub) =>
        sub
          .setName('backup')
          .setDescription('Create a world backup snapshot for a server (Admin)')
          .addStringOption((opt) =>
            opt.setName('name').setDescription('Server to back up').setRequired(true).setAutocomplete(true)
          )
          .addStringOption((opt) =>
            opt.setName('note').setDescription('Optional backup label/note').setMaxLength(120)
          )
      )
      .addSubcommand((sub) =>
        sub
          .setName('say')
          .setDescription('Broadcast an in-game announcement to a running server (Admin)')
          .addStringOption((opt) =>
            opt.setName('name').setDescription('Running server').setRequired(true).setAutocomplete(true)
          )
          .addStringOption((opt) =>
            opt.setName('message').setDescription('Announcement text').setRequired(true).setMaxLength(200)
          )
      )
      .addSubcommand((sub) =>
        sub
          .setName('whitelist')
          .setDescription('Manage a Minecraft server whitelist via RCON (Admin)')
          .addStringOption((opt) =>
            opt.setName('name').setDescription('Running Minecraft server').setRequired(true).setAutocomplete(true)
          )
          .addStringOption((opt) =>
            opt
              .setName('action')
              .setDescription('Whitelist action')
              .setRequired(true)
              .addChoices(
                { name: 'Add player', value: 'add' },
                { name: 'Remove player', value: 'remove' },
                { name: 'List whitelisted players', value: 'list' }
              )
          )
          .addStringOption((opt) =>
            opt.setName('player').setDescription('Minecraft username (required for add/remove)').setMaxLength(32)
          )
      )
      .toJSON(),
  ];
}

export function buildGuideActionRow(instanceId: string): ActionRowBuilder<ButtonBuilder> {
  return new ActionRowBuilder<ButtonBuilder>().addComponents(
    new ButtonBuilder()
      .setCustomId(`sf:guide:${instanceId}`)
      .setLabel('How to Connect')
      .setStyle(ButtonStyle.Secondary)
  );
}

export function buildServerActionRow(instanceId: string, includeGuide = true): ActionRowBuilder<ButtonBuilder> {
  const row = new ActionRowBuilder<ButtonBuilder>().addComponents(
    new ButtonBuilder()
      .setCustomId(`sf:extend:${instanceId}`)
      .setLabel('Extend +1h')
      .setStyle(ButtonStyle.Primary),
    new ButtonBuilder()
      .setCustomId(`sf:stop:${instanceId}`)
      .setLabel('Save & Stop')
      .setStyle(ButtonStyle.Danger)
  );
  if (includeGuide) {
    row.addComponents(
      new ButtonBuilder()
        .setCustomId(`sf:guide:${instanceId}`)
        .setLabel('How to Connect')
        .setStyle(ButtonStyle.Secondary)
    );
  }
  return row;
}

export class DiscordBotService {
  private client: Client | null = null;
  private connected = false;
  private connecting = false;
  private botTag: string | null = null;
  private botId: string | null = null;
  private applicationId: string | null = null;
  private lastError: string | null = null;
  private panelDebounceTimer: NodeJS.Timeout | null = null;
  private panelRefreshInterval: NodeJS.Timeout | null = null;
  private playerPollInterval: NodeJS.Timeout | null = null;
  private readonly lastKnownPlayers = new Map<string, Set<string>>();
  public readonly handler: DiscordCommandHandler;

  constructor(
    private readonly config: AppConfig,
    private readonly db: AppDatabase,
    catalog: CatalogService,
    private readonly orchestrator: ServerOrchestrator,
    private readonly fetchImpl: typeof fetch = fetch
  ) {
    this.handler = new DiscordCommandHandler(config, db, catalog, orchestrator);
    this.bindOrchestratorEvents();
  }

  getStatus(): { connected: boolean; botTag: string | null } {
    return { connected: this.connected, botTag: this.botTag };
  }

  getEffectiveToken(): { token: string; source: 'settings' | 'env' | 'none' } {
    try {
      const settings = this.db.getSettings(this.config.publicHost);
      const saved = normalizeDiscordToken(settings.discordBotToken ?? '');
      if (saved) return { token: saved, source: 'settings' };
    } catch {
      // ignore if DB unavailable during teardown
    }
    const envToken = normalizeDiscordToken(this.config.discordToken ?? '');
    if (envToken) return { token: envToken, source: 'env' };
    return { token: '', source: 'none' };
  }

  getEffectiveGuildId(): string {
    try {
      const settings = this.db.getSettings(this.config.publicHost);
      if (settings.discordGuildId.trim()) return settings.discordGuildId.trim();
    } catch {
      // ignore
    }
    if (this.config.discordGuildId.trim()) return this.config.discordGuildId.trim();
    if (this.client && this.connected && this.client.guilds.cache.size === 1) {
      return this.client.guilds.cache.first()!.id;
    }
    return '';
  }

  async getDiscoveryStatus(): Promise<DiscordDiscoveryStatus> {
    const { token, source } = this.getEffectiveToken();
    const settings = this.db.getSettings(this.config.publicHost);
    const effectiveAppId = this.applicationId || this.config.discordClientId || null;

    const guilds: DiscordGuildSummary[] = [];
    let channels: DiscordChannelSummary[] = [];
    let roles: DiscordRoleSummary[] = [];
    let selectedGuildId = this.getEffectiveGuildId();

    if (this.client && this.connected) {
      const cachedGuilds = Array.from(this.client.guilds.cache.values()).sort((a, b) =>
        a.name.localeCompare(b.name)
      );
      for (const g of cachedGuilds) {
        guilds.push({
          id: g.id,
          name: g.name,
          iconUrl: g.iconURL({ size: 64 }) ?? null,
          memberCount: g.memberCount ?? null,
        });
      }

      if (!selectedGuildId && cachedGuilds.length > 0) {
        selectedGuildId = cachedGuilds[0].id;
      }

      const activeGuild: Guild | undefined =
        cachedGuilds.find((g) => g.id === selectedGuildId) ?? cachedGuilds[0];

      if (activeGuild) {
        selectedGuildId = activeGuild.id;
        try {
          const fetchedChannels = await activeGuild.channels.fetch();
          const me = activeGuild.members.me ?? (await activeGuild.members.fetchMe().catch(() => null));
          const list: DiscordChannelSummary[] = [];
          for (const ch of fetchedChannels.values()) {
            if (!ch) continue;
            if (ch.type !== ChannelType.GuildText && ch.type !== ChannelType.GuildAnnouncement) continue;
            const perms = me ? ch.permissionsFor(me) : null;
            const canSend = perms
              ? perms.has(PermissionFlagsBits.ViewChannel) &&
                perms.has(PermissionFlagsBits.SendMessages) &&
                perms.has(PermissionFlagsBits.EmbedLinks)
              : true;
            list.push({
              id: ch.id,
              name: ch.name,
              categoryName: ch.parent?.name ?? null,
              canSend,
            });
          }
          channels = list.sort((a, b) => {
            const catCmp = (a.categoryName ?? '').localeCompare(b.categoryName ?? '');
            return catCmp !== 0 ? catCmp : a.name.localeCompare(b.name);
          });
        } catch (err) {
          console.error('[DiscordBot] Failed to fetch guild channels:', err);
        }

        try {
          const fetchedRoles = await activeGuild.roles.fetch();
          const list: DiscordRoleSummary[] = [];
          for (const role of fetchedRoles.values()) {
            if (role.id === activeGuild.id) continue; // skip @everyone
            if (role.managed) continue; // skip bot-managed integration roles
            list.push({
              id: role.id,
              name: role.name,
              colorHex: role.hexColor === '#000000' ? '#94a3b8' : role.hexColor,
              position: role.position,
            });
          }
          roles = list.sort((a, b) => b.position - a.position);
        } catch (err) {
          console.error('[DiscordBot] Failed to fetch guild roles:', err);
        }
      }
    }

    return {
      connected: this.connected,
      connecting: this.connecting,
      hasToken: Boolean(token),
      tokenSource: source,
      botTag: this.botTag,
      botId: this.botId,
      applicationId: effectiveAppId,
      inviteUrl: effectiveAppId ? buildBotInviteUrl(effectiveAppId) : null,
      lastError: this.lastError,
      selectedGuildId,
      guilds,
      channels,
      roles,
      statusPanelActive: Boolean(
        settings.discordStatusPanelChannelId && settings.discordStatusPanelMessageId
      ),
    };
  }

  async sendChannelNotice(title: string, description: string, color = 0xf59e0b): Promise<void> {
    if (!this.client || !this.connected) return;
    const settings = this.db.getSettings(this.config.publicHost);
    if (!settings.discordNotifyChannelId) return;
    try {
      const ch = (await this.client.channels.fetch(settings.discordNotifyChannelId)) as TextBasedChannel | null;
      if (!ch || !('send' in ch)) return;
      const embed = new EmbedBuilder()
        .setTitle(title)
        .setDescription(description)
        .setColor(color)
        .setTimestamp();
      await ch.send({ embeds: [embed] });
    } catch (err) {
      console.error('[DiscordBot] Failed to send channel notice:', err);
    }
  }

  async sendTestNotification(channelId?: string): Promise<{ ok: boolean; channelName: string }> {
    if (!this.client || !this.connected) {
      throw new Error('Discord bot is not connected. Connect your bot first.');
    }
    const settings = this.db.getSettings(this.config.publicHost);
    const targetId = (channelId ?? settings.discordNotifyChannelId).trim();
    if (!targetId) {
      throw new Error('Select a Notification Channel first before sending a test message.');
    }

    const ch = (await this.client.channels.fetch(targetId)) as TextBasedChannel | null;
    if (!ch || !('send' in ch)) {
      throw new Error(`Channel ${targetId} was not found or cannot receive messages.`);
    }

    const embed = new EmbedBuilder()
      .setTitle('ServerForge Discord Connected')
      .setDescription(
        `Test alert succeeded! **ServerForge v${this.config.appVersion}** can post auto-shutdown warnings, crash alerts, daily reboot notices, and player activity here.`
      )
      .setColor(0x10b981)
      .addFields(
        { name: 'Bot Account', value: this.botTag ?? 'Connected', inline: true },
        { name: 'Slash Commands', value: '`/server list`, `/server guide`, `/server start`, `/server panel`', inline: true }
      )
      .setTimestamp();

    await ch.send({ embeds: [embed] });
    const channelName = 'name' in ch && typeof ch.name === 'string' ? `#${ch.name}` : targetId;
    return { ok: true, channelName };
  }

  private buildEmbed(outcome: CommandOutcome): EmbedBuilder {
    const embed = new EmbedBuilder()
      .setTitle(outcome.title)
      .setDescription(outcome.description)
      .setColor(outcome.color)
      .setTimestamp();
    if (outcome.fields && outcome.fields.length > 0) {
      embed.addFields(outcome.fields);
    }
    return embed;
  }

  private buildActionRow(instanceId: string, includeGuide = true): ActionRowBuilder<ButtonBuilder> {
    return buildServerActionRow(instanceId, includeGuide);
  }

  private buildOutcomeComponents(outcome: CommandOutcome): ActionRowBuilder<ButtonBuilder>[] {
    if (outcome.instanceIdForButtons) {
      return [this.buildActionRow(outcome.instanceIdForButtons, true)];
    }
    if (outcome.guideInstanceId) {
      return [buildGuideActionRow(outcome.guideInstanceId)];
    }
    return [];
  }

  private buildStatusPanelComponents(rows: StatusPanelButtonSpec[][]): ActionRowBuilder<ButtonBuilder>[] {
    const styleMap: Record<StatusPanelButtonSpec['style'], ButtonStyle> = {
      primary: ButtonStyle.Primary,
      secondary: ButtonStyle.Secondary,
      success: ButtonStyle.Success,
      danger: ButtonStyle.Danger,
    };

    return rows.slice(0, 5).map((row) =>
      new ActionRowBuilder<ButtonBuilder>().addComponents(
        ...row.slice(0, 5).map((btn) =>
          new ButtonBuilder()
            .setCustomId(btn.customId)
            .setLabel(btn.label.slice(0, 80))
            .setStyle(styleMap[btn.style])
        )
      )
    );
  }

  async postOrUpdateStatusPanel(
    channelIdOverride?: string,
    forceNewMessage = false
  ): Promise<{ ok: boolean; channelId: string; messageId: string; updatedExisting: boolean }> {
    if (!this.client || !this.connected) {
      throw new Error('Discord bot is not connected. Connect your bot first.');
    }

    const settings = this.db.getSettings(this.config.publicHost);
    const targetChannelId = (channelIdOverride ?? settings.discordStatusPanelChannelId).trim();
    if (!targetChannelId) {
      throw new Error('Select a Live Status Panel Channel first.');
    }

    const ch = (await this.client.channels.fetch(targetChannelId)) as TextBasedChannel | null;
    if (!ch || !('send' in ch)) {
      throw new Error(`Channel ${targetChannelId} was not found or cannot receive messages.`);
    }

    const payload = this.handler.buildStatusPanelPayload();
    const embed = new EmbedBuilder()
      .setTitle(payload.title)
      .setDescription(payload.description)
      .setColor(payload.color)
      .setFooter({ text: `ServerForge v${this.config.appVersion} • Auto-updates live` })
      .setTimestamp();
    if (payload.fields.length > 0) {
      embed.addFields(payload.fields);
    }
    const components = this.buildStatusPanelComponents(payload.buttonRows);

    const canTryEdit =
      !forceNewMessage &&
      settings.discordStatusPanelMessageId &&
      settings.discordStatusPanelChannelId === targetChannelId &&
      'messages' in ch;

    if (canTryEdit) {
      try {
        const existingMsg = await ch.messages.fetch(settings.discordStatusPanelMessageId);
        await existingMsg.edit({ embeds: [embed], components });
        return {
          ok: true,
          channelId: targetChannelId,
          messageId: existingMsg.id,
          updatedExisting: true,
        };
      } catch {
        // Message was deleted in Discord — fall through and post a fresh panel
      }
    }

    const sent = await ch.send({ embeds: [embed], components });
    this.db.saveSettings(
      {
        discordStatusPanelChannelId: targetChannelId,
        discordStatusPanelMessageId: sent.id,
      },
      this.config.publicHost
    );
    return {
      ok: true,
      channelId: targetChannelId,
      messageId: sent.id,
      updatedExisting: false,
    };
  }

  scheduleStatusPanelUpdate(): void {
    if (!this.client || !this.connected) return;
    const settings = this.db.getSettings(this.config.publicHost);
    if (!settings.discordStatusPanelChannelId || !settings.discordStatusPanelMessageId) return;

    if (this.panelDebounceTimer) {
      clearTimeout(this.panelDebounceTimer);
    }
    this.panelDebounceTimer = setTimeout(() => {
      this.panelDebounceTimer = null;
      void this.postOrUpdateStatusPanel(undefined, false).catch((err) => {
        console.error('[DiscordBot] Auto-updating status panel failed:', err);
      });
    }, 2500);
    this.panelDebounceTimer.unref?.();
  }

  private startBackgroundTimers(): void {
    this.stopBackgroundTimers();

    // Refresh live status panel every 60s for player counts & lease countdowns
    this.panelRefreshInterval = setInterval(() => {
      if (!this.client || !this.connected) return;
      const settings = this.db.getSettings(this.config.publicHost);
      if (settings.discordStatusPanelChannelId && settings.discordStatusPanelMessageId) {
        void this.postOrUpdateStatusPanel(undefined, false).catch(() => {});
      }
    }, 60_000);
    this.panelRefreshInterval.unref?.();

    // Optional player join/leave notification polling every 30s
    this.playerPollInterval = setInterval(() => {
      void this.pollPlayerActivity();
    }, 30_000);
    this.playerPollInterval.unref?.();
  }

  private stopBackgroundTimers(): void {
    if (this.panelDebounceTimer) {
      clearTimeout(this.panelDebounceTimer);
      this.panelDebounceTimer = null;
    }
    if (this.panelRefreshInterval) {
      clearInterval(this.panelRefreshInterval);
      this.panelRefreshInterval = null;
    }
    if (this.playerPollInterval) {
      clearInterval(this.playerPollInterval);
      this.playerPollInterval = null;
    }
    this.lastKnownPlayers.clear();
  }

  private async pollPlayerActivity(): Promise<void> {
    if (!this.client || !this.connected) return;
    const settings = this.db.getSettings(this.config.publicHost);
    if (!settings.discordPlayerActivityEnabled || !settings.discordNotifyChannelId) return;

    const runningInstances = this.orchestrator
      .listInstances()
      .filter((inst) => inst.discordEnabled && inst.status === 'running');
    const activeIds = new Set(runningInstances.map((i) => i.id));
    for (const id of this.lastKnownPlayers.keys()) {
      if (!activeIds.has(id)) {
        this.lastKnownPlayers.delete(id);
      }
    }

    for (const inst of runningInstances) {
      try {
        const stats = await this.orchestrator.refreshInstanceStats(inst.id);
        if (!stats || !Array.isArray(stats.players)) continue;
        const currentSet = new Set(stats.players.map((p) => p.trim()).filter(Boolean));
        const previousSet = this.lastKnownPlayers.get(inst.id);
        this.lastKnownPlayers.set(inst.id, currentSet);

        // Skip the very first snapshot so booting or connecting doesn't emit false join spam
        if (!previousSet) continue;

        const joined = [...currentSet].filter((p) => !previousSet.has(p));
        const left = [...previousSet].filter((p) => !currentSet.has(p));
        const notice = formatPlayerActivityMessage(
          inst.name,
          joined,
          left,
          stats.playerCount,
          stats.maxPlayers
        );
        if (notice) {
          await this.sendChannelNotice(notice.title, notice.description, notice.color);
        }
      } catch {
        // non-fatal per-instance query error
      }
    }
  }

  private extractActor(interaction: Interaction): DiscordActorContext {
    const member = interaction.member;
    let roleIds: string[] = [];
    let isGuildAdmin = false;

    if (member && 'roles' in member) {
      if (Array.isArray(member.roles)) {
        roleIds = member.roles;
      } else if ('cache' in member.roles) {
        roleIds = Array.from(member.roles.cache.keys());
      }
    }
    if (interaction.memberPermissions?.has(PermissionFlagsBits.Administrator)) {
      isGuildAdmin = true;
    }

    return {
      userId: interaction.user.id,
      username: interaction.user.username,
      roleIds,
      isGuildAdmin,
      channelId: interaction.channelId,
    };
  }

  private bindOrchestratorEvents(): void {
    this.orchestrator.on('instance:update', () => {
      this.scheduleStatusPanelUpdate();
    });

    this.orchestrator.on('lease:warning', async ({ lease, instance, reason, minutesRemaining }) => {
      if (!this.client || !this.connected) return;
      const settings = this.db.getSettings(this.config.publicHost);
      const targetChannelId = lease.channelId || settings.discordNotifyChannelId;
      if (!targetChannelId) return;

      try {
        const ch = (await this.client.channels.fetch(targetChannelId)) as TextBasedChannel | null;
        if (!ch || !('send' in ch)) return;

        const reasonText =
          reason === 'idle'
            ? `No players have been detected on **${instance.name}**.`
            : `The temporary lease for **${instance.name}** is almost up.`;

        const embed = new EmbedBuilder()
          .setTitle(`Auto-Shutdown Warning — ${instance.name}`)
          .setDescription(
            `${reasonText} The world will automatically save and shut down in **${minutesRemaining} minute(s)** unless extended.`
          )
          .setColor(0xf59e0b)
          .setTimestamp();

        await ch.send({
          embeds: [embed],
          components: [this.buildActionRow(instance.id, false)],
        });
      } catch (err) {
        console.error('[DiscordBot] Failed to send lease warning:', err);
      }
    });

    this.orchestrator.on('lease:expired', async ({ lease, instance, reason }) => {
      if (!this.client || !this.connected) return;
      const settings = this.db.getSettings(this.config.publicHost);
      const targetChannelId = lease.channelId || settings.discordNotifyChannelId;
      if (!targetChannelId) return;

      try {
        const ch = (await this.client.channels.fetch(targetChannelId)) as TextBasedChannel | null;
        if (!ch || !('send' in ch)) return;

        const embed = new EmbedBuilder()
          .setTitle(`Auto-Shutdown Complete — ${instance.name}`)
          .setDescription(
            reason === 'idle'
              ? `**${instance.name}** was empty past the idle timeout, so ServerForge saved the world and shut it down.`
              : `Temporary lease for **${instance.name}** expired. ServerForge saved the world and shut it down.`
          )
          .setColor(0x475569)
          .setTimestamp();

        await ch.send({ embeds: [embed] });
      } catch (err) {
        console.error('[DiscordBot] Failed to send shutdown confirmation:', err);
      }
    });

    this.orchestrator.on('instance:crash', async ({ instance, crash, channelId }) => {
      if (!this.client || !this.connected) return;
      const settings = this.db.getSettings(this.config.publicHost);
      const targetChannelId = channelId || settings.discordNotifyChannelId;
      if (!targetChannelId) return;

      try {
        const ch = (await this.client.channels.fetch(targetChannelId)) as TextBasedChannel | null;
        if (!ch || !('send' in ch)) return;

        const payload = buildCrashAlertEmbedData(instance, crash);
        const embed = new EmbedBuilder()
          .setTitle(payload.title)
          .setDescription(payload.description)
          .setColor(payload.color)
          .addFields(payload.fields)
          .setTimestamp();

        await ch.send({ embeds: [embed] });
      } catch (err) {
        console.error('[DiscordBot] Failed to send crash alert:', err);
      }
    });
  }

  private buildCommandDefinitions() {
    return buildServerSlashCommands();
  }

  private async loginClient(token: string, waitForReady = false): Promise<void> {
    await this.stop();
    this.connecting = true;
    this.lastError = null;

    const client = new Client({
      intents: [GatewayIntentBits.Guilds],
    });
    this.client = client;

    const readyPromise = new Promise<void>((resolve, reject) => {
      const timeout = setTimeout(() => {
        reject(new Error('Timed out waiting for Discord Gateway connection (15s).'));
      }, 15_000);
      timeout.unref?.();

      client.once('ready', async (readyClient) => {
        clearTimeout(timeout);
        this.connected = true;
        this.connecting = false;
        this.botTag = readyClient.user.tag;
        this.botId = readyClient.user.id;
        this.applicationId = readyClient.application?.id ?? readyClient.user.id;
        this.lastError = null;
        console.log(`[DiscordBot] Connected as ${this.botTag}`);
        this.startBackgroundTimers();
        await this.registerSlashCommands(this.applicationId, token);
        this.scheduleStatusPanelUpdate();
        resolve();
      });

      client.once('error', (err) => {
        clearTimeout(timeout);
        this.lastError = err.message;
        reject(err);
      });
    });

    client.on('guildCreate', async (guild) => {
      console.log(`[DiscordBot] Joined Discord server "${guild.name}" (${guild.id})`);
      if (this.applicationId) {
        await this.registerSlashCommands(this.applicationId, token, guild.id);
      }
    });

    client.on('interactionCreate', async (interaction) => {
      try {
        if (interaction.isAutocomplete()) {
          const focused = interaction.options.getFocused();
          await interaction.respond(this.handler.getAutocompleteChoices(focused));
          return;
        }

        if (interaction.isButton()) {
          await this.handleButtonInteraction(interaction);
          return;
        }

        if (interaction.isChatInputCommand() && interaction.commandName === 'server') {
          await this.handleSlashCommand(interaction);
        }
      } catch (err) {
        console.error('[DiscordBot] Interaction error:', err);
      }
    });

    try {
      await client.login(token);
      if (waitForReady) {
        await readyPromise;
      } else {
        void readyPromise.catch((err) => {
          this.connecting = false;
          this.lastError = err instanceof Error ? err.message : String(err);
          console.error('[DiscordBot] Gateway ready error:', err);
        });
      }
    } catch (err) {
      this.connecting = false;
      this.connected = false;
      this.lastError = err instanceof Error ? err.message : String(err);
      await this.stop();
      throw err;
    }
  }

  async handleButtonInteraction(interaction: ButtonInteraction): Promise<void> {
    const [, action, instanceId] = interaction.customId.split(':');
    const actor = this.extractActor(interaction);

    if (action === 'panel_refresh') {
      await interaction.deferUpdate();
      await this.postOrUpdateStatusPanel(interaction.channelId, false);
      return;
    }

    if (action === 'guide' && instanceId) {
      await interaction.deferReply({ ephemeral: true });
      const outcome = await this.handler.handleGuide(instanceId);
      await interaction.editReply({
        embeds: [this.buildEmbed(outcome)],
      });
      return;
    }

    if (action === 'panel_start' && instanceId) {
      await interaction.deferReply({ ephemeral: true });
      const outcome = await this.handler.handleStart(actor, instanceId);
      await interaction.editReply({
        embeds: [this.buildEmbed(outcome)],
        components: this.buildOutcomeComponents(outcome),
      });
      this.scheduleStatusPanelUpdate();
      return;
    }

    if (action === 'extend' && instanceId) {
      const outcome = this.handler.handleExtend(actor, instanceId, 60);
      await interaction.reply({
        embeds: [this.buildEmbed(outcome)],
        ephemeral: outcome.ephemeral ?? false,
      });
      this.scheduleStatusPanelUpdate();
      return;
    }

    if (action === 'stop' && instanceId) {
      await interaction.deferReply();
      const outcome = await this.handler.handleStop(actor, instanceId);
      await interaction.editReply({ embeds: [this.buildEmbed(outcome)] });
      this.scheduleStatusPanelUpdate();
    }
  }

  async start(): Promise<void> {
    const { token } = this.getEffectiveToken();
    if (!token) {
      console.log('[DiscordBot] Discord bot token not configured — running in Web Dashboard-only mode.');
      return;
    }
    try {
      await this.loginClient(token, false);
    } catch (err) {
      console.error('[DiscordBot] Startup login failed (Web Dashboard remains available):', err);
    }
  }

  /**
   * Validates a Discord Bot Token, saves it to SQLite Settings, connects live, and returns discovery status.
   */
  async connectWithToken(rawToken?: string): Promise<DiscordDiscoveryStatus> {
    const incoming = rawToken !== undefined ? normalizeDiscordToken(rawToken) : this.getEffectiveToken().token;
    const verified = await verifyDiscordBotToken(incoming, this.fetchImpl);

    if (rawToken !== undefined) {
      this.db.saveSettings({ discordBotToken: incoming }, this.config.publicHost);
    }

    this.applicationId = verified.applicationId;
    this.botId = verified.botId;
    this.botTag = verified.botTag;

    await this.loginClient(incoming, true);
    return this.getDiscoveryStatus();
  }

  async disconnect(clearSavedToken = false): Promise<DiscordDiscoveryStatus> {
    await this.stop();
    this.lastError = null;
    if (clearSavedToken) {
      this.db.saveSettings({ discordBotToken: '' }, this.config.publicHost);
      this.applicationId = null;
      this.botId = null;
    }
    return this.getDiscoveryStatus();
  }

  async resyncSlashCommands(): Promise<{ ok: boolean; scope: string }> {
    const { token } = this.getEffectiveToken();
    const appId = this.applicationId || this.config.discordClientId;
    if (!token || !appId) {
      throw new Error('Connect your Discord bot first before syncing slash commands.');
    }
    const guildId = this.getEffectiveGuildId();
    await this.registerSlashCommands(appId, token, guildId || undefined);
    return {
      ok: true,
      scope: guildId ? `guild:${guildId}` : 'global',
    };
  }

  async handleSlashCommand(interaction: ChatInputCommandInteraction): Promise<void> {
    const sub = interaction.options.getSubcommand();
    const actor = this.extractActor(interaction);

    if (sub === 'list') {
      const outcome = this.handler.handleList();
      await interaction.reply({ embeds: [this.buildEmbed(outcome)] });
      return;
    }

    if (sub === 'panel') {
      const settings = this.db.getSettings(this.config.publicHost);
      if (!hasDiscordAdminAccess(actor, settings)) {
        await interaction.reply({
          embeds: [
            this.buildEmbed({
              ok: false,
              title: 'Admin Permission Required',
              description: 'Only Discord admins or configured Admin Roles can post the live status panel.',
              color: 0xef4444,
              ephemeral: true,
            }),
          ],
          ephemeral: true,
        });
        return;
      }
      await interaction.deferReply({ ephemeral: true });
      const res = await this.postOrUpdateStatusPanel(interaction.channelId, true);
      await interaction.editReply({
        content: `Live auto-updating ServerForge Status Panel posted in <#${res.channelId}>.`,
      });
      return;
    }

    const serverName = interaction.options.getString('name', true);

    if (sub === 'start') {
      await interaction.deferReply();
      const hours = interaction.options.getNumber('hours') ?? undefined;
      const outcome = await this.handler.handleStart(actor, serverName, hours);
      await interaction.editReply({
        embeds: [this.buildEmbed(outcome)],
        components: this.buildOutcomeComponents(outcome),
      });
      this.scheduleStatusPanelUpdate();
      return;
    }

    if (sub === 'extend') {
      const mins = interaction.options.getInteger('minutes') ?? 60;
      const outcome = this.handler.handleExtend(actor, serverName, mins);
      await interaction.reply({
        embeds: [this.buildEmbed(outcome)],
        ephemeral: outcome.ephemeral ?? false,
      });
      this.scheduleStatusPanelUpdate();
      return;
    }

    if (sub === 'stop') {
      await interaction.deferReply();
      const outcome = await this.handler.handleStop(actor, serverName);
      await interaction.editReply({ embeds: [this.buildEmbed(outcome)] });
      this.scheduleStatusPanelUpdate();
      return;
    }

    if (sub === 'status') {
      await interaction.deferReply();
      const outcome = await this.handler.handleStatus(serverName);
      await interaction.editReply({
        embeds: [this.buildEmbed(outcome)],
        components: this.buildOutcomeComponents(outcome),
      });
      return;
    }

    if (sub === 'guide') {
      await interaction.deferReply();
      const outcome = await this.handler.handleGuide(serverName);
      await interaction.editReply({
        embeds: [this.buildEmbed(outcome)],
      });
      return;
    }

    if (sub === 'backup') {
      await interaction.deferReply();
      const note = interaction.options.getString('note') ?? undefined;
      const outcome = await this.handler.handleBackup(actor, serverName, note);
      await interaction.editReply({ embeds: [this.buildEmbed(outcome)] });
      return;
    }

    if (sub === 'say') {
      await interaction.deferReply();
      const message = interaction.options.getString('message', true);
      const outcome = await this.handler.handleSay(actor, serverName, message);
      await interaction.editReply({ embeds: [this.buildEmbed(outcome)] });
      return;
    }

    if (sub === 'whitelist') {
      await interaction.deferReply();
      const action = interaction.options.getString('action', true) as 'add' | 'remove' | 'list';
      const player = interaction.options.getString('player') ?? undefined;
      const outcome = await this.handler.handleWhitelist(actor, serverName, action, player);
      await interaction.editReply({ embeds: [this.buildEmbed(outcome)] });
    }
  }

  private async registerSlashCommands(appId: string, token: string, explicitGuildId?: string): Promise<void> {
    try {
      const rest = new REST({ version: '10' }).setToken(token);
      const body = this.buildCommandDefinitions();
      const clientId = this.config.discordClientId || appId;
      const targetGuildId = explicitGuildId ?? this.getEffectiveGuildId();

      if (targetGuildId) {
        await rest.put(Routes.applicationGuildCommands(clientId, targetGuildId), { body });
        console.log(`[DiscordBot] Registered /server slash commands for guild ${targetGuildId}`);
      } else {
        await rest.put(Routes.applicationCommands(clientId), { body });
        console.log('[DiscordBot] Registered global /server slash commands');
      }
    } catch (err) {
      console.error('[DiscordBot] Failed to register slash commands:', err);
    }
  }

  async stop(): Promise<void> {
    this.stopBackgroundTimers();
    if (this.client) {
      await this.client.destroy();
      this.client = null;
    }
    this.connected = false;
    this.connecting = false;
    this.botTag = null;
  }
}
