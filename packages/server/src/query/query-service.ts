import type { GameTemplate, ServerInstance } from '@serverforge/shared';
import { queryMinecraftSlp } from './minecraft-slp.js';
import { queryPalworldRestPlayers, saveAndShutdownPalworldRest } from './palworld-rest.js';
import { parseRconPlayerCount, sendSourceRconCommand } from './rcon-client.js';
import { querySatisfactoryLightweight } from './satisfactory-query.js';

export interface PlayerQueryResult {
  playerCount: number | null;
  maxPlayers: number | null;
  players: string[];
}

export class QueryService {
  async queryPlayers(instance: ServerInstance, template: GameTemplate): Promise<PlayerQueryResult> {
    const query = template.query;
    const maxPlayers =
      typeof instance.config.MAX_PLAYERS === 'number'
        ? instance.config.MAX_PLAYERS
        : Number(instance.config.MAX_PLAYERS) || null;

    if (!query || query.protocol === 'none') {
      return { playerCount: null, maxPlayers, players: [] };
    }

    const host = '127.0.0.1';
    const port = query.portKey ? instance.ports[query.portKey] : undefined;
    if (!port) {
      return { playerCount: null, maxPlayers, players: [] };
    }

    try {
      if (query.protocol === 'minecraft-slp') {
        const res = await queryMinecraftSlp(host, port);
        return {
          playerCount: res.online,
          maxPlayers: res.max || maxPlayers,
          players: res.players,
        };
      }

      if (query.protocol === 'palworld-rest') {
        const password = query.passwordField ? String(instance.config[query.passwordField] ?? '') : '';
        if (!password) return { playerCount: null, maxPlayers, players: [] };
        const res = await queryPalworldRestPlayers({
          host,
          port,
          username: query.username || 'admin',
          password,
        });
        return { playerCount: res.count, maxPlayers, players: res.players };
      }

      if (query.protocol === 'rcon') {
        const password = query.passwordField ? String(instance.config[query.passwordField] ?? '') : '';
        if (!password || !query.listPlayersCommand) {
          return { playerCount: null, maxPlayers, players: [] };
        }
        const output = await sendSourceRconCommand({
          host,
          port,
          password,
          command: query.listPlayersCommand,
        });
        const parsed = parseRconPlayerCount(output, {
          listPlayersCountRegex: query.listPlayersCountRegex,
          listPlayersPattern: query.listPlayersPattern,
        });
        return { playerCount: parsed.count, maxPlayers, players: parsed.players };
      }

      if (query.protocol === 'satisfactory-api') {
        await querySatisfactoryLightweight(host, port);
        return { playerCount: null, maxPlayers, players: [] };
      }
    } catch {
      return { playerCount: null, maxPlayers, players: [] };
    }

    return { playerCount: null, maxPlayers, players: [] };
  }

  async sendRcon(instance: ServerInstance, template: GameTemplate, command: string): Promise<string | null> {
    const rconPortKey = template.query.rconPortKey || (template.query.protocol === 'rcon' ? template.query.portKey : undefined);
    const port = rconPortKey ? instance.ports[rconPortKey] : undefined;
    const password = template.query.passwordField ? String(instance.config[template.query.passwordField] ?? '') : '';
    if (!port || !password) return null;

    return sendSourceRconCommand({
      host: '127.0.0.1',
      port,
      password,
      command,
      timeoutMs: 6000,
    });
  }

  async performGracefulSave(instance: ServerInstance, template: GameTemplate): Promise<boolean> {
    const { saveMethod, saveCommand, stopCommand } = template.lifecycle;
    if (saveMethod === 'none') return false;

    try {
      if (saveMethod === 'palworld-rest') {
        const port = template.query.portKey ? instance.ports[template.query.portKey] : undefined;
        const password = template.query.passwordField ? String(instance.config[template.query.passwordField] ?? '') : '';
        if (!port || !password) return false;
        await saveAndShutdownPalworldRest({
          host: '127.0.0.1',
          port,
          username: template.query.username || 'admin',
          password,
          waittimeSeconds: 3,
        });
        return true;
      }

      if (saveMethod === 'rcon') {
        if (saveCommand) {
          await this.sendRcon(instance, template, saveCommand);
          await new Promise((r) => setTimeout(r, 1500));
        }
        if (stopCommand) {
          await this.sendRcon(instance, template, stopCommand);
        }
        return true;
      }
    } catch {
      return false;
    }

    return false;
  }
}
