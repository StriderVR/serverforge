import {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  Client,
  EmbedBuilder,
  GatewayIntentBits,
  PermissionFlagsBits,
  REST,
  Routes,
  SlashCommandBuilder,
  type ChatInputCommandInteraction,
  type Interaction,
  type TextBasedChannel,
} from 'discord.js';
import type { CrashSummary, ServerInstance } from '@serverforge/shared';
import type { CatalogService } from '../catalog/catalog-service.js';
import type { AppConfig } from '../config.js';
import type { AppDatabase } from '../db/database.js';
import { redactSecrets } from '../services/diagnostics-service.js';
import type { ServerOrchestrator } from '../services/orchestrator.js';
import {
  DiscordCommandHandler,
  type CommandOutcome,
  type DiscordActorContext,
} from './discord-handlers.js';

export interface CrashAlertEmbedPayload {
  title: string;
  description: string;
  color: number;
  fields: Array<{ name: string; value: string; inline?: boolean }>;
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

export class DiscordBotService {
  private client: Client | null = null;
  private connected = false;
  private botTag: string | null = null;
  public readonly handler: DiscordCommandHandler;

  constructor(
    private readonly config: AppConfig,
    private readonly db: AppDatabase,
    catalog: CatalogService,
    private readonly orchestrator: ServerOrchestrator
  ) {
    this.handler = new DiscordCommandHandler(config, db, catalog, orchestrator);
    this.bindOrchestratorEvents();
  }

  getStatus(): { connected: boolean; botTag: string | null } {
    return { connected: this.connected, botTag: this.botTag };
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

  private buildActionRow(instanceId: string): ActionRowBuilder<ButtonBuilder> {
    return new ActionRowBuilder<ButtonBuilder>().addComponents(
      new ButtonBuilder()
        .setCustomId(`sf:extend:${instanceId}`)
        .setLabel('Extend +1h')
        .setStyle(ButtonStyle.Primary),
      new ButtonBuilder()
        .setCustomId(`sf:stop:${instanceId}`)
        .setLabel('Save & Stop')
        .setStyle(ButtonStyle.Danger)
    );
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
          components: [this.buildActionRow(instance.id)],
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
        .toJSON(),
    ];
  }

  async start(): Promise<void> {
    if (!this.config.discordToken) {
      console.log('[DiscordBot] DISCORD_TOKEN not set — running in Web Dashboard-only mode.');
      return;
    }

    const client = new Client({
      intents: [GatewayIntentBits.Guilds],
    });
    this.client = client;

    client.once('ready', async (readyClient) => {
      this.connected = true;
      this.botTag = readyClient.user.tag;
      console.log(`[DiscordBot] Connected as ${this.botTag}`);
      await this.registerSlashCommands(readyClient.user.id);
    });

    client.on('interactionCreate', async (interaction) => {
      try {
        if (interaction.isAutocomplete()) {
          const focused = interaction.options.getFocused();
          await interaction.respond(this.handler.getAutocompleteChoices(focused));
          return;
        }

        if (interaction.isButton()) {
          const [, action, instanceId] = interaction.customId.split(':');
          const actor = this.extractActor(interaction);
          if (action === 'extend' && instanceId) {
            const outcome = this.handler.handleExtend(actor, instanceId, 60);
            await interaction.reply({
              embeds: [this.buildEmbed(outcome)],
              ephemeral: outcome.ephemeral ?? false,
            });
          } else if (action === 'stop' && instanceId) {
            await interaction.deferReply();
            const outcome = await this.handler.handleStop(actor, instanceId);
            await interaction.editReply({ embeds: [this.buildEmbed(outcome)] });
          }
          return;
        }

        if (interaction.isChatInputCommand() && interaction.commandName === 'server') {
          await this.handleSlashCommand(interaction);
        }
      } catch (err) {
        console.error('[DiscordBot] Interaction error:', err);
      }
    });

    await client.login(this.config.discordToken);
  }

  private async handleSlashCommand(interaction: ChatInputCommandInteraction): Promise<void> {
    const sub = interaction.options.getSubcommand();
    const actor = this.extractActor(interaction);

    if (sub === 'list') {
      const outcome = this.handler.handleList();
      await interaction.reply({ embeds: [this.buildEmbed(outcome)] });
      return;
    }

    const serverName = interaction.options.getString('name', true);

    if (sub === 'start') {
      await interaction.deferReply();
      const hours = interaction.options.getNumber('hours') ?? undefined;
      const outcome = await this.handler.handleStart(actor, serverName, hours);
      await interaction.editReply({
        embeds: [this.buildEmbed(outcome)],
        components: outcome.instanceIdForButtons ? [this.buildActionRow(outcome.instanceIdForButtons)] : [],
      });
      return;
    }

    if (sub === 'extend') {
      const mins = interaction.options.getInteger('minutes') ?? 60;
      const outcome = this.handler.handleExtend(actor, serverName, mins);
      await interaction.reply({
        embeds: [this.buildEmbed(outcome)],
        ephemeral: outcome.ephemeral ?? false,
      });
      return;
    }

    if (sub === 'stop') {
      await interaction.deferReply();
      const outcome = await this.handler.handleStop(actor, serverName);
      await interaction.editReply({ embeds: [this.buildEmbed(outcome)] });
      return;
    }

    if (sub === 'status') {
      await interaction.deferReply();
      const outcome = await this.handler.handleStatus(serverName);
      await interaction.editReply({
        embeds: [this.buildEmbed(outcome)],
        components: outcome.instanceIdForButtons ? [this.buildActionRow(outcome.instanceIdForButtons)] : [],
      });
    }
  }

  private async registerSlashCommands(appId: string): Promise<void> {
    try {
      const rest = new REST({ version: '10' }).setToken(this.config.discordToken);
      const body = this.buildCommandDefinitions();
      const clientId = this.config.discordClientId || appId;

      if (this.config.discordGuildId) {
        await rest.put(Routes.applicationGuildCommands(clientId, this.config.discordGuildId), { body });
        console.log(`[DiscordBot] Registered /server slash commands for guild ${this.config.discordGuildId}`);
      } else {
        await rest.put(Routes.applicationCommands(clientId), { body });
        console.log('[DiscordBot] Registered global /server slash commands');
      }
    } catch (err) {
      console.error('[DiscordBot] Failed to register slash commands:', err);
    }
  }

  async stop(): Promise<void> {
    if (this.client) {
      await this.client.destroy();
      this.client = null;
      this.connected = false;
      this.botTag = null;
    }
  }
}
