export interface PalworldPlayerInfo {
  name: string;
  playerId?: string;
}

function buildBasicAuthHeader(username: string, password: string): string {
  return `Basic ${Buffer.from(`${username}:${password}`).toString('base64')}`;
}

export async function queryPalworldRestPlayers(options: {
  host: string;
  port: number;
  username?: string;
  password: string;
  timeoutMs?: number;
}): Promise<{ count: number; players: string[] }> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), options.timeoutMs ?? 4000);
  try {
    const res = await fetch(`http://${options.host}:${options.port}/v1/api/players`, {
      headers: {
        Accept: 'application/json',
        Authorization: buildBasicAuthHeader(options.username || 'admin', options.password),
      },
      signal: controller.signal,
    });
    if (!res.ok) {
      throw new Error(`Palworld REST API returned HTTP ${res.status}`);
    }
    const data = (await res.json()) as { players?: PalworldPlayerInfo[] };
    const players = (data.players ?? []).map((p) => p.name).filter(Boolean);
    return { count: players.length, players };
  } finally {
    clearTimeout(timer);
  }
}

export async function saveAndShutdownPalworldRest(options: {
  host: string;
  port: number;
  username?: string;
  password: string;
  waittimeSeconds?: number;
}): Promise<void> {
  const headers = {
    'Content-Type': 'application/json',
    Authorization: buildBasicAuthHeader(options.username || 'admin', options.password),
  };

  await fetch(`http://${options.host}:${options.port}/v1/api/save`, {
    method: 'POST',
    headers,
    signal: AbortSignal.timeout(8000),
  });

  await fetch(`http://${options.host}:${options.port}/v1/api/shutdown`, {
    method: 'POST',
    headers,
    body: JSON.stringify({
      waittime: options.waittimeSeconds ?? 5,
      message: 'ServerForge is saving and shutting down the server.',
    }),
    signal: AbortSignal.timeout(8000),
  });
}
