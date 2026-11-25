import dgram from 'node:dgram';

export interface SatisfactoryQueryResult {
  online: boolean;
  serverState: number;
}

/**
 * Satisfactory 1.0+ Lightweight Query API (UDP Poll Server State)
 * Sends a 11-byte PollServerState packet:
 *   - 2 bytes magic: 0xF6D5 (little-endian)
 *   - 1 byte message type: 0x00 (PollServerState)
 *   - 1 byte protocol version: 0x01
 *   - 8 bytes client cookie (timestamp)
 *   - 1 byte terminator: 0x01
 */
export async function querySatisfactoryLightweight(
  host: string,
  port: number,
  timeoutMs = 3000
): Promise<SatisfactoryQueryResult> {
  return new Promise((resolve, reject) => {
    const socket = dgram.createSocket('udp4');
    let done = false;

    const finish = (err?: Error, res?: SatisfactoryQueryResult) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      try {
        socket.close();
      } catch {
        // ignore close error
      }
      if (err) reject(err);
      else resolve(res!);
    };

    const timer = setTimeout(() => {
      finish(new Error(`Satisfactory UDP query timeout (${host}:${port})`));
    }, timeoutMs);

    socket.on('error', (err) => finish(err));

    socket.on('message', (msg) => {
      if (msg.length < 14) {
        finish(new Error('Invalid Satisfactory query response length'));
        return;
      }
      const magic = msg.readUInt16LE(0);
      const msgType = msg.readUInt8(2);
      if (magic !== 0xf6d5 || msgType !== 1) {
        finish(new Error('Unexpected Satisfactory query response header'));
        return;
      }
      const serverState = msg.readUInt8(12);
      finish(undefined, { online: true, serverState });
    });

    const packet = Buffer.alloc(13);
    packet.writeUInt16LE(0xf6d5, 0);
    packet.writeUInt8(0, 2); // PollServerState
    packet.writeUInt8(1, 3); // Protocol version 1
    packet.writeBigUInt64LE(BigInt(Date.now()), 4);
    packet.writeUInt8(1, 12); // Terminator

    socket.send(packet, port, host, (err) => {
      if (err) finish(err);
    });
  });
}
