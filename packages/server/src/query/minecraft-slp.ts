import net from 'node:net';

export function writeVarInt(value: number): Buffer {
  const bytes: number[] = [];
  let v = value >>> 0;
  do {
    let temp = v & 0x7f;
    v >>>= 7;
    if (v !== 0) {
      temp |= 0x80;
    }
    bytes.push(temp);
  } while (v !== 0);
  return Buffer.from(bytes);
}

export function readVarInt(buffer: Buffer, offset = 0): { value: number; bytesRead: number } | null {
  let numRead = 0;
  let result = 0;
  let byte = 0;

  do {
    if (offset + numRead >= buffer.length) return null;
    byte = buffer[offset + numRead];
    result |= (byte & 0x7f) << (7 * numRead);
    numRead += 1;
    if (numRead > 5) {
      throw new Error('VarInt exceeds 5 bytes');
    }
  } while ((byte & 0x80) !== 0);

  return { value: result, bytesRead: numRead };
}

export interface MinecraftSlpResult {
  online: number;
  max: number;
  players: string[];
  version?: string;
}

export async function queryMinecraftSlp(
  host: string,
  port: number,
  timeoutMs = 4000
): Promise<MinecraftSlpResult> {
  return new Promise((resolve, reject) => {
    const socket = new net.Socket();
    let buffer: Buffer = Buffer.alloc(0);
    let done = false;

    const finish = (err?: Error, result?: MinecraftSlpResult) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      socket.destroy();
      if (err) reject(err);
      else resolve(result!);
    };

    const timer = setTimeout(() => {
      finish(new Error(`Minecraft SLP timeout (${host}:${port})`));
    }, timeoutMs);

    socket.on('error', (err) => finish(err));

    socket.on('data', (chunk: Buffer) => {
      buffer = Buffer.concat([buffer, chunk]);
      try {
        const packetLen = readVarInt(buffer, 0);
        if (!packetLen) return;
        const totalRequired = packetLen.bytesRead + packetLen.value;
        if (buffer.length < totalRequired) return;

        let cursor = packetLen.bytesRead;
        const packetId = readVarInt(buffer, cursor);
        if (!packetId) return;
        cursor += packetId.bytesRead;

        const strLen = readVarInt(buffer, cursor);
        if (!strLen) return;
        cursor += strLen.bytesRead;

        const jsonStr = buffer.toString('utf8', cursor, cursor + strLen.value);
        const payload = JSON.parse(jsonStr) as {
          players?: { online?: number; max?: number; sample?: Array<{ name: string }> };
          version?: { name?: string };
        };

        finish(undefined, {
          online: payload.players?.online ?? 0,
          max: payload.players?.max ?? 0,
          players: (payload.players?.sample ?? []).map((p) => p.name),
          version: payload.version?.name,
        });
      } catch (err) {
        finish(err instanceof Error ? err : new Error(String(err)));
      }
    });

    socket.connect(port, host, () => {
      const hostBuf = Buffer.from(host, 'utf8');
      const portBuf = Buffer.alloc(2);
      portBuf.writeUInt16BE(port, 0);

      const handshakeData = Buffer.concat([
        writeVarInt(0x00), // Packet ID: Handshake
        writeVarInt(765), // Protocol version (1.20.4+, compatible with modern SLP)
        writeVarInt(hostBuf.length),
        hostBuf,
        portBuf,
        writeVarInt(0x01), // Next state: Status
      ]);
      const handshakePacket = Buffer.concat([writeVarInt(handshakeData.length), handshakeData]);
      const statusRequestPacket = Buffer.from([0x01, 0x00]);

      socket.write(Buffer.concat([handshakePacket, statusRequestPacket]));
    });
  });
}
