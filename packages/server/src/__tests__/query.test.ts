import { describe, expect, it } from 'vitest';
import { readVarInt, writeVarInt } from '../query/minecraft-slp.js';
import {
  decodeRconPackets,
  encodeRconPacket,
  parseRconPlayerCount,
  RCON_TYPE_EXEC,
} from '../query/rcon-client.js';
import { splitArgs } from '../runtimes/runtime-adapter.js';

describe('Protocol Parsers & RCON Framing', () => {
  it('encodes and decodes multiple Source RCON packets cleanly', () => {
    const p1 = encodeRconPacket(10, RCON_TYPE_EXEC, 'SaveWorld');
    const p2 = encodeRconPacket(11, RCON_TYPE_EXEC, 'ListPlayers');
    const combined = Buffer.concat([p1, p2]);

    const { packets, remainder } = decodeRconPackets(combined);
    expect(remainder.length).toBe(0);
    expect(packets).toHaveLength(2);
    expect(packets[0]).toEqual({ id: 10, type: RCON_TYPE_EXEC, body: 'SaveWorld' });
    expect(packets[1]).toEqual({ id: 11, type: RCON_TYPE_EXEC, body: 'ListPlayers' });
  });

  it('parses player counts for Ark ASA, Factorio, and Minecraft RCON responses', () => {
    const asaOutput = '0. Alex, 00024a8bc1234\n1. Jordan, 00024a8bc9999\n';
    expect(
      parseRconPlayerCount(asaOutput, { listPlayersPattern: '^\\d+\\.\\s+.+,' })
    ).toEqual({
      count: 2,
      players: ['0. Alex, 00024a8bc1234', '1. Jordan, 00024a8bc9999'],
    });

    expect(
      parseRconPlayerCount('No Players Connected', { listPlayersPattern: '^\\d+\\.\\s+.+,' })
    ).toEqual({ count: 0, players: [] });

    expect(
      parseRconPlayerCount('Online players (3):\n  Engineer1\n  Engineer2\n  Engineer3', {
        listPlayersCountRegex: 'Online players \\((\\d+)\\)',
      })
    ).toEqual({ count: 3, players: [] });

    expect(
      parseRconPlayerCount('There are 4 of a max of 20 players online: a, b, c, d', {
        listPlayersCountRegex: 'There are (\\d+) of a max',
      })
    ).toEqual({ count: 4, players: [] });
  });

  it('encodes and decodes Minecraft VarInts accurately', () => {
    for (const value of [0, 1, 127, 128, 765, 25565, 2097151]) {
      const encoded = writeVarInt(value);
      const decoded = readVarInt(encoded, 0);
      expect(decoded?.value).toBe(value);
      expect(decoded?.bytesRead).toBe(encoded.length);
    }
  });

  it('splits Windows/Linux launch arguments while preserving quoted strings', () => {
    const args = splitArgs('TheIsland_WP?SessionName="My Dino Server" -WinLiveMaxPlayers=10 -NoBattlEye');
    expect(args).toEqual([
      'TheIsland_WP?SessionName=My Dino Server',
      '-WinLiveMaxPlayers=10',
      '-NoBattlEye',
    ]);
  });
});
