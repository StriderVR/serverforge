import net from 'node:net';

export const RCON_TYPE_AUTH = 3;
export const RCON_TYPE_AUTH_RESPONSE = 2;
export const RCON_TYPE_EXEC = 2;
export const RCON_TYPE_RESPONSE = 0;

export interface RconPacket {
  id: number;
  type: number;
  body: string;
}

export function encodeRconPacket(id: number, type: number, body: string): Buffer {
  const bodyBuf = Buffer.from(body, 'utf8');
  const packetLength = 4 + 4 + bodyBuf.length + 2; // id + type + body + 2 null terminators
  const buf = Buffer.alloc(4 + packetLength);
  buf.writeInt32LE(packetLength, 0);
  buf.writeInt32LE(id, 4);
  buf.writeInt32LE(type, 8);
  bodyBuf.copy(buf, 12);
  buf.writeInt16LE(0, 12 + bodyBuf.length);
  return buf;
}

export function decodeRconPackets(buffer: Buffer): { packets: RconPacket[]; remainder: Buffer } {
  const packets: RconPacket[] = [];
  let offset = 0;

  while (offset + 4 <= buffer.length) {
    const length = buffer.readInt32LE(offset);
    if (length < 10 || length > 65536) {
      throw new Error(`Invalid RCON packet length: ${length}`);
    }
    if (offset + 4 + length > buffer.length) {
      break;
    }
    const id = buffer.readInt32LE(offset + 4);
    const type = buffer.readInt32LE(offset + 8);
    const body = buffer.toString('utf8', offset + 12, offset + 4 + length - 2);
    packets.push({ id, type, body });
    offset += 4 + length;
  }

  return { packets, remainder: buffer.subarray(offset) };
}

export async function sendSourceRconCommand(options: {
  host: string;
  port: number;
  password: string;
  command: string;
  timeoutMs?: number;
}): Promise<string> {
  const timeoutMs = options.timeoutMs ?? 5000;

  return new Promise((resolve, reject) => {
    const socket = new net.Socket();
    let buffer: Buffer = Buffer.alloc(0);
    let authenticated = false;
    let finished = false;
    let responseBody = '';
    const authId = 1001;
    const cmdId = 1002;

    const cleanup = (err?: Error) => {
      if (finished) return;
      finished = true;
      clearTimeout(timer);
      socket.destroy();
      if (err) reject(err);
      else resolve(responseBody.trim());
    };

    const timer = setTimeout(() => {
      cleanup(new Error(`RCON timeout after ${timeoutMs}ms (${options.host}:${options.port})`));
    }, timeoutMs);

    socket.on('error', (err) => cleanup(err));
    socket.on('close', () => {
      if (!finished) {
        if (authenticated) cleanup();
        else cleanup(new Error('RCON connection closed before authentication completed'));
      }
    });

    socket.on('data', (chunk: Buffer) => {
      buffer = Buffer.concat([buffer, chunk]);
      try {
        const { packets, remainder } = decodeRconPackets(buffer);
        buffer = remainder;
        for (const pkt of packets) {
          if (!authenticated) {
            if (pkt.type === RCON_TYPE_AUTH_RESPONSE) {
              if (pkt.id === -1) {
                cleanup(new Error('RCON authentication failed (invalid password)'));
                return;
              }
              if (pkt.id === authId) {
                authenticated = true;
                socket.write(encodeRconPacket(cmdId, RCON_TYPE_EXEC, options.command));
              }
            }
          } else if (pkt.id === cmdId) {
            responseBody += pkt.body;
            // Most game servers reply with a single packet; close shortly after receiving body
            setTimeout(() => cleanup(), 60);
          }
        }
      } catch (err) {
        cleanup(err instanceof Error ? err : new Error(String(err)));
      }
    });

    socket.connect(options.port, options.host, () => {
      socket.write(encodeRconPacket(authId, RCON_TYPE_AUTH, options.password));
    });
  });
}

export function parseRconPlayerCount(
  output: string,
  opts: { listPlayersCountRegex?: string; listPlayersPattern?: string }
): { count: number; players: string[] } {
  const trimmed = output.trim();
  if (!trimmed || /no players connected/i.test(trimmed)) {
    return { count: 0, players: [] };
  }

  if (opts.listPlayersCountRegex) {
    const regex = new RegExp(opts.listPlayersCountRegex, 'i');
    const match = trimmed.match(regex);
    if (match && match[1]) {
      return { count: Number.parseInt(match[1], 10) || 0, players: [] };
    }
  }

  if (opts.listPlayersPattern) {
    const lineRegex = new RegExp(opts.listPlayersPattern);
    const lines = trimmed
      .split(/\r?\n/)
      .map((l) => l.trim())
      .filter((l) => lineRegex.test(l));
    return { count: lines.length, players: lines };
  }

  return { count: 0, players: [] };
}
