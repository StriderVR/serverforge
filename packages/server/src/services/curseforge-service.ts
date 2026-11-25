import type { CurseForgeModpackFile, CurseForgeModpackSummary } from '@serverforge/shared';

const CURSEFORGE_API_BASE = 'https://api.curseforge.com/v1';
const MINECRAFT_GAME_ID = 432;
const MODPACKS_CLASS_ID = 4471;

export type JavaImageTag = 'java21' | 'java17' | 'java8' | 'latest';

/**
 * Selects the optimal itzg/minecraft-server Java Docker image tag for a given list
 * of CurseForge gameVersions (e.g., ["1.21.1", "NeoForge"] or ["1.12.2", "Forge"]).
 */
export function recommendJavaTag(gameVersions: string[]): JavaImageTag {
  const mcVersions = gameVersions
    .map((v) => v.trim())
    .map((v) => {
      const m = v.match(/^1\.(\d+)(?:\.(\d+))?$/);
      if (!m) return null;
      return { minor: Number(m[1]), patch: Number(m[2] ?? 0) };
    })
    .filter((v): v is { minor: number; patch: number } => v !== null);

  if (mcVersions.length === 0) return 'java21';

  // Sort highest Minecraft version first
  mcVersions.sort((a, b) => (b.minor !== a.minor ? b.minor - a.minor : b.patch - a.patch));
  const latest = mcVersions[0];

  if (latest.minor > 20 || (latest.minor === 20 && latest.patch >= 5)) {
    return 'java21';
  }
  if (latest.minor >= 17) {
    return 'java17';
  }
  return 'java8';
}

/**
 * Extracts a CurseForge modpack slug and optional numeric file ID from a CurseForge URL.
 */
export function parseCurseForgeUrl(rawUrl: string): { slug: string | null; fileId: string | null } {
  const trimmed = rawUrl.trim();
  const match = trimmed.match(
    /curseforge\.com\/minecraft\/modpacks\/([a-z0-9-]+)(?:\/(?:files|download)\/(\d+))?/i
  );
  if (!match) {
    return { slug: null, fileId: null };
  }
  return {
    slug: match[1].toLowerCase(),
    fileId: match[2] ?? null,
  };
}

interface CfSearchResponse {
  data?: Array<{
    id: number;
    name: string;
    slug: string;
    summary?: string;
    downloadCount?: number;
    logo?: { thumbnailUrl?: string; url?: string } | null;
    links?: { websiteUrl?: string } | null;
    latestFilesIndexes?: Array<{ gameVersion?: string }>;
  }>;
}

interface CfFilesResponse {
  data?: Array<{
    id: number;
    displayName: string;
    fileName: string;
    fileDate: string;
    gameVersions?: string[];
    isServerPack?: boolean;
    serverPackFileId?: number | null;
    downloadUrl?: string | null;
  }>;
}

export class CurseForgeService {
  constructor(private readonly fetchImpl: typeof fetch = fetch) {}

  private assertApiKey(apiKey: string): string {
    const key = apiKey.trim();
    if (!key) {
      throw new Error(
        'CurseForge API key is not configured. Add your free key in Settings (from console.curseforge.com) or paste a direct CurseForge URL / Server Pack ZIP.'
      );
    }
    return key;
  }

  async searchModpacks(
    query: string,
    apiKey: string,
    pageSize = 12
  ): Promise<CurseForgeModpackSummary[]> {
    const key = this.assertApiKey(apiKey);
    const params = new URLSearchParams({
      gameId: String(MINECRAFT_GAME_ID),
      classId: String(MODPACKS_CLASS_ID),
      sortField: '2', // Popularity
      sortOrder: 'desc',
      pageSize: String(Math.min(Math.max(pageSize, 1), 25)),
    });
    if (query.trim()) {
      params.set('searchFilter', query.trim());
    }

    const res = await this.fetchImpl(`${CURSEFORGE_API_BASE}/mods/search?${params.toString()}`, {
      headers: {
        Accept: 'application/json',
        'x-api-key': key,
      },
      signal: AbortSignal.timeout(10_000),
    });

    if (res.status === 403 || res.status === 401) {
      throw new Error('CurseForge rejected the API key (HTTP 403). Double-check your key in Settings.');
    }
    if (!res.ok) {
      throw new Error(`CurseForge API returned HTTP ${res.status}`);
    }

    const payload = (await res.json()) as CfSearchResponse;
    return (payload.data ?? []).map((mod) => {
      const versions = Array.from(
        new Set(
          (mod.latestFilesIndexes ?? [])
            .map((idx) => idx.gameVersion)
            .filter((v): v is string => Boolean(v))
        )
      ).slice(0, 5);

      return {
        id: mod.id,
        name: mod.name,
        slug: mod.slug,
        summary: mod.summary ?? '',
        downloadCount: mod.downloadCount ?? 0,
        logoUrl: mod.logo?.thumbnailUrl ?? mod.logo?.url ?? null,
        websiteUrl: mod.links?.websiteUrl ?? `https://www.curseforge.com/minecraft/modpacks/${mod.slug}`,
        latestGameVersions: versions,
        recommendedJavaTag: recommendJavaTag(versions),
      };
    });
  }

  async getModpackFiles(modId: number, apiKey: string, pageSize = 20): Promise<CurseForgeModpackFile[]> {
    const key = this.assertApiKey(apiKey);
    const params = new URLSearchParams({
      pageSize: String(Math.min(Math.max(pageSize, 1), 50)),
    });

    const res = await this.fetchImpl(`${CURSEFORGE_API_BASE}/mods/${modId}/files?${params.toString()}`, {
      headers: {
        Accept: 'application/json',
        'x-api-key': key,
      },
      signal: AbortSignal.timeout(10_000),
    });

    if (res.status === 403 || res.status === 401) {
      throw new Error('CurseForge rejected the API key (HTTP 403). Double-check your key in Settings.');
    }
    if (!res.ok) {
      throw new Error(`CurseForge API returned HTTP ${res.status}`);
    }

    const payload = (await res.json()) as CfFilesResponse;
    return (payload.data ?? []).map((file) => {
      const versions = file.gameVersions ?? [];
      return {
        id: file.id,
        displayName: file.displayName,
        fileName: file.fileName,
        fileDate: file.fileDate,
        gameVersions: versions,
        isServerPack: Boolean(file.isServerPack),
        serverPackFileId: file.serverPackFileId ?? null,
        downloadUrl: file.downloadUrl ?? null,
        recommendedJavaTag: recommendJavaTag(versions),
      };
    });
  }

  async getServerPackDownloadUrl(modId: number, serverPackFileId: number, apiKey: string): Promise<string | null> {
    const key = this.assertApiKey(apiKey);
    const res = await this.fetchImpl(
      `${CURSEFORGE_API_BASE}/mods/${modId}/files/${serverPackFileId}/download-url`,
      {
        headers: {
          Accept: 'application/json',
          'x-api-key': key,
        },
        signal: AbortSignal.timeout(10_000),
      }
    );
    if (!res.ok) return null;
    const payload = (await res.json()) as { data?: string };
    return payload.data ?? null;
  }
}
