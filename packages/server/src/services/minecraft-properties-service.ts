import fs from 'node:fs';
import path from 'node:path';
import type { MinecraftPropertiesResponse, ServerInstance } from '@serverforge/shared';
import { parsePropertiesFile } from './import-service.js';

export const MANAGED_MINECRAFT_PROPERTY_KEYS = [
  'server-port',
  'rcon.port',
  'rcon.password',
  'enable-rcon',
] as const;

const MANAGED_KEY_SET = new Set<string>(MANAGED_MINECRAFT_PROPERTY_KEYS);

export function isMinecraftInstance(instance: Pick<ServerInstance, 'gameId' | 'config'>): boolean {
  return (
    instance.gameId === 'minecraft' ||
    instance.gameId === 'minecraft-curseforge' ||
    instance.gameId === 'minecraft-modrinth' ||
    'SERVER_TYPE' in instance.config ||
    'CF_SLUG' in instance.config ||
    'MR_PROJECT_ID' in instance.config
  );
}

/**
 * Updates `server.properties` text in-place, preserving comments, blank lines,
 * key ordering, and unknown/mod-added keys.
 */
export function updatePropertiesContentPreservingComments(
  existingContent: string,
  updates: Record<string, string>,
  options?: { allowManagedOverride?: boolean }
): string {
  const allowManaged = Boolean(options?.allowManagedOverride);
  const filteredUpdates: Record<string, string> = {};
  for (const [rawKey, rawVal] of Object.entries(updates)) {
    const key = rawKey.trim();
    if (!key || key.includes('\n') || key.includes('\r') || key.includes('=')) continue;
    if (!allowManaged && MANAGED_KEY_SET.has(key)) continue;
    const cleanVal = String(rawVal ?? '').replace(/[\r\n]+/g, ' ');
    filteredUpdates[key] = cleanVal;
  }

  const hasContent = existingContent.length > 0;
  const lines = hasContent ? existingContent.split(/\r?\n/) : ['#Minecraft server properties'];
  const seen = new Set<string>();

  const out = lines.map((line) => {
    const trimmed = line.trimStart();
    if (!trimmed || trimmed.startsWith('#') || trimmed.startsWith('!')) return line;
    const eqIdx = line.indexOf('=');
    if (eqIdx <= 0) return line;
    const key = line.slice(0, eqIdx).trim();
    if (key in filteredUpdates) {
      seen.add(key);
      return `${key}=${filteredUpdates[key]}`;
    }
    return line;
  });

  // Trim trailing blank lines before appending newly added keys
  while (out.length > 0 && out[out.length - 1] === '') {
    out.pop();
  }

  for (const [key, value] of Object.entries(filteredUpdates)) {
    if (!seen.has(key)) {
      out.push(`${key}=${value}`);
    }
  }

  return `${out.join('\n')}\n`;
}

export function buildDefaultMinecraftProperties(instance: ServerInstance): Record<string, string> {
  return {
    motd: String(instance.config.MOTD ?? `${instance.name} — ServerForge`),
    gamemode: String(instance.config.GAMEMODE ?? 'survival'),
    difficulty: String(instance.config.DIFFICULTY ?? 'normal'),
    hardcore: 'false',
    pvp: 'true',
    'force-gamemode': 'false',
    'allow-flight': 'true',
    'allow-nether': 'true',
    'enable-command-block': 'false',
    'spawn-monsters': 'true',
    'spawn-animals': 'true',
    'spawn-npcs': 'true',
    'level-name': 'world',
    'level-seed': '',
    'max-players': String(instance.config.MAX_PLAYERS ?? 10),
    'spawn-protection': '16',
    'online-mode': String(instance.config.ONLINE_MODE ?? true),
    'white-list': 'false',
    'enforce-whitelist': 'false',
    'view-distance': String(instance.config.VIEW_DISTANCE ?? 10),
    'simulation-distance': '10',
    'max-tick-time': '60000',
    'entity-broadcast-range-percentage': '100',
    'server-port': String(instance.ports.game ?? 25565),
    'enable-rcon': 'true',
    'rcon.port': String(instance.ports.rcon ?? 25575),
    'rcon.password': String(instance.config.RCON_PASSWORD ?? ''),
  };
}

export class MinecraftPropertiesService {
  read(serverDir: string, instance: ServerInstance): MinecraftPropertiesResponse {
    const propsPath = path.join(serverDir, 'server.properties');
    const exists = fs.existsSync(propsPath);
    const rawContent = exists ? fs.readFileSync(propsPath, 'utf8') : '';
    const properties = exists ? parsePropertiesFile(rawContent) : {};

    return {
      exists,
      path: 'server.properties',
      properties,
      rawContent,
      managedKeys: [...MANAGED_MINECRAFT_PROPERTY_KEYS],
      restartRequired: instance.status === 'running',
    };
  }

  write(
    serverDir: string,
    instance: ServerInstance,
    input: {
      properties?: Record<string, string>;
      rawContent?: string;
      createIfMissing?: boolean;
      allowManagedOverride?: boolean;
    }
  ): MinecraftPropertiesResponse {
    fs.mkdirSync(serverDir, { recursive: true });
    const propsPath = path.join(serverDir, 'server.properties');
    const exists = fs.existsSync(propsPath);

    if (!exists && !input.createIfMissing && input.rawContent === undefined) {
      throw new Error(
        'server.properties does not exist yet. Start the server once or click "Create Default server.properties".'
      );
    }

    let nextContent: string;
    if (typeof input.rawContent === 'string') {
      // If raw edit is submitted without allowManagedOverride, preserve ServerForge-managed keys safely
      if (!input.allowManagedOverride) {
        const existingManaged = exists
          ? parsePropertiesFile(fs.readFileSync(propsPath, 'utf8'))
          : buildDefaultMinecraftProperties(instance);
        const lockedValues: Record<string, string> = {};
        for (const key of MANAGED_MINECRAFT_PROPERTY_KEYS) {
          if (existingManaged[key] !== undefined) {
            lockedValues[key] = existingManaged[key];
          }
        }
        nextContent = updatePropertiesContentPreservingComments(input.rawContent, lockedValues, {
          allowManagedOverride: true,
        });
      } else {
        nextContent = input.rawContent.endsWith('\n') ? input.rawContent : `${input.rawContent}\n`;
      }
    } else {
      const baseContent = exists
        ? fs.readFileSync(propsPath, 'utf8')
        : updatePropertiesContentPreservingComments('', buildDefaultMinecraftProperties(instance), {
            allowManagedOverride: true,
          });
      nextContent = updatePropertiesContentPreservingComments(baseContent, input.properties ?? {}, {
        allowManagedOverride: Boolean(input.allowManagedOverride),
      });
    }

    fs.writeFileSync(propsPath, nextContent, 'utf8');
    return this.read(serverDir, instance);
  }
}
