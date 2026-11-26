import type { CurseForgeModpackFile, CurseForgeModpackSummary } from '@serverforge/shared';

const CURSEFORGE_API_BASE = 'https://api.curseforge.com/v1';
const MINECRAFT_GAME_ID = 432;
const MODPACKS_CLASS_ID = 4471;

export type JavaImageTag = 'java25' | 'java21' | 'java17' | 'java8' | 'latest';

const UUID_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Normalizes a pasted CurseForge API key by trimming whitespace, stripping
 * accidental surrounding quotes, and unescaping Docker Compose / shell escapes
 * (e.g. `$$2a$$10$$...` or `\$2a\$10\$...` -> `$2a$10$...`).
 */
export function normalizeCurseForgeApiKey(raw: string): string {
  let key = raw.trim();
  if (
    (key.startsWith('"') && key.endsWith('"')) ||
    (key.startsWith("'") && key.endsWith("'"))
  ) {
    key = key.slice(1, -1).trim();
  }
  if (key.includes('\\$')) {
    key = key.replace(/\\\$/g, '$');
  }
  if (key.startsWith('$$2a$$') || key.startsWith('$$2b$$') || key.startsWith('$$2y$$')) {
    key = key.replace(/\$\$/g, '$');
  }
  return key;
}

export function maskApiKey(key: string): string {
  if (!key) return '(empty)';
  if (key.length <= 12) return `${key.slice(0, 3)}... (${key.length} chars)`;
  return `${key.slice(0, 7)}...${key.slice(-4)} (${key.length} chars)`;
}

export function validateCurseForgeKeyFormat(key: string): string | null {
  if (!key) {
    return 'CurseForge API key is empty. Generate a free Core API Key at https://console.curseforge.com/ (API keys tab).';
  }
  if (UUID_REGEX.test(key)) {
    return 'That looks like a CurseForge Author Upload Token (UUID from legacy/author settings). Modpack search & downloads require a Core API Key starting with "$2a$10$..." from https://console.curseforge.com/ -> API keys.';
  }
  if (!key.startsWith('$2a$') && !key.startsWith('$2b$') && !key.startsWith('$2y$')) {
    return `Key does not start with "$2a$10$..." (got ${maskApiKey(key)}). Copy the full Core API Key from https://console.curseforge.com/ -> API keys.`;
  }
  if (key.length < 55 || key.length > 65) {
    return `Key length looks truncated (${key.length} chars; standard CurseForge Core API keys are 60 characters starting with "$2a$10$"). Make sure the entire key was copied.`;
  }
  return null;
}

/**
 * Selects the optimal itzg/minecraft-server Java Docker image tag for a given list
 * of CurseForge gameVersions (e.g., ["26.1.2", "NeoForge"], ["1.21.1", "NeoForge"], or ["1.12.2", "Forge"]).
 */
export function recommendJavaTag(gameVersions: string[]): JavaImageTag {
  const mcVersions = gameVersions
    .map((v) => v.trim())
    .map((v) => {
      const m = v.match(/^(\d+)\.(\d+)(?:\.(\d+))?$/);
      if (!m) return null;
      const major = Number(m[1]);
      if (major !== 1 && major < 26) return null;
      return { major, minor: Number(m[2]), patch: Number(m[3] ?? 0) };
    })
    .filter((v): v is { major: number; minor: number; patch: number } => v !== null);

  if (mcVersions.length === 0) return 'java21';

  mcVersions.sort((a, b) =>
    b.major !== a.major
      ? b.major - a.major
      : b.minor !== a.minor
        ? b.minor - a.minor
        : b.patch - a.patch
  );
  const latest = mcVersions[0];

  if (latest.major >= 26 || (latest.major === 1 && latest.minor >= 22)) {
    return 'java25';
  }
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
  constructor(
    private readonly fetchImpl: typeof fetch = fetch,
    private readonly retryDelayMs = 1200
  ) {}

  private assertApiKey(rawKey: string): string {
    const key = normalizeCurseForgeApiKey(rawKey);
    if (!key) {
      throw new Error(
        'CurseForge API key is not configured. Add your free key in Settings (from console.curseforge.com) or paste a direct CurseForge URL / Server Pack ZIP.'
      );
    }
    if (UUID_REGEX.test(key)) {
      throw new Error(validateCurseForgeKeyFormat(key)!);
    }
    return key;
  }

  private buildHeaders(key: string): Record<string, string> {
    return {
      Accept: 'application/json',
      'User-Agent': 'ServerForge/1.1.2 (+https://github.com/StriderVR/serverforge)',
      'x-api-key': key,
    };
  }

  private async fetchWithRetry(url: string, key: string): Promise<Response> {
    let lastRes: Response | null = null;
    for (let attempt = 0; attempt < 2; attempt++) {
      const res = await this.fetchImpl(url, {
        headers: this.buildHeaders(key),
        signal: AbortSignal.timeout(10_000),
      });
      if (res.ok) return res;
      lastRes = res;
      // Retry once on transient Cloudflare 403/429/5xx responses
      if (attempt === 0 && (res.status === 403 || res.status === 429 || res.status >= 500)) {
        if (this.retryDelayMs > 0) {
          await new Promise((r) => setTimeout(r, this.retryDelayMs));
        }
        continue;
      }
      break;
    }
    return lastRes!;
  }

  private async buildHttpError(res: Response, key: string): Promise<Error> {
    const bodyText = await res.text().catch(() => '');
    const keyInfo = maskApiKey(key);
    if (res.status === 403 || res.status === 401) {
      const formatHint = validateCurseForgeKeyFormat(key);
      if (formatHint) {
        return new Error(`CurseForge rejected the key (HTTP ${res.status}): ${formatHint}`);
      }
      if (/cloudflare|just a moment/i.test(bodyText)) {
        return new Error(
          `Request was temporarily blocked by Cloudflare WAF (HTTP ${res.status}). Click Retry or paste the CurseForge modpack URL directly.`
        );
      }
      return new Error(
        `CurseForge rejected the saved API key [${keyInfo}] (HTTP ${res.status}). Open Settings -> Verify & Save Key to confirm the active key from console.curseforge.com.`
      );
    }
    return new Error(`CurseForge API returned HTTP ${res.status}${bodyText ? `: ${bodyText.slice(0, 140)}` : ''}`);
  }

  /**
   * Tests the exact `/v1/mods/search` endpoint used by the Modpack Browser so
   * verification guarantees modpack browsing works immediately.
   */
  async testApiKey(rawKey: string): Promise<{ ok: boolean; message: string; normalizedKey: string }> {
    const key = normalizeCurseForgeApiKey(rawKey);
    const formatIssue = validateCurseForgeKeyFormat(key);
    if (formatIssue) {
      return { ok: false, message: formatIssue, normalizedKey: key };
    }

    const params = new URLSearchParams({
      gameId: String(MINECRAFT_GAME_ID),
      classId: String(MODPACKS_CLASS_ID),
      sortField: '2',
      sortOrder: 'desc',
      pageSize: '1',
    });

    const res = await this.fetchWithRetry(`${CURSEFORGE_API_BASE}/mods/search?${params.toString()}`, key);

    if (!res.ok) {
      const err = await this.buildHttpError(res, key);
      return { ok: false, message: err.message, normalizedKey: key };
    }

    const payload = (await res.json().catch(() => ({}))) as CfSearchResponse;
    const samplePack = payload.data?.[0]?.name;

    return {
      ok: true,
      message: samplePack
        ? `CurseForge API key verified & saved! Modpack search confirmed (e.g., "${samplePack}").`
        : 'CurseForge API key verified & saved! Modpack search and Docker auto-downloads are ready.',
      normalizedKey: key,
    };
  }

  async searchModpacks(
    query: string,
    rawKey: string,
    pageSize = 12
  ): Promise<CurseForgeModpackSummary[]> {
    const key = this.assertApiKey(rawKey);
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

    const res = await this.fetchWithRetry(`${CURSEFORGE_API_BASE}/mods/search?${params.toString()}`, key);

    if (!res.ok) {
      throw await this.buildHttpError(res, key);
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

  async getModpackFiles(modId: number, rawKey: string, pageSize = 20): Promise<CurseForgeModpackFile[]> {
    const key = this.assertApiKey(rawKey);
    const params = new URLSearchParams({
      pageSize: String(Math.min(Math.max(pageSize, 1), 50)),
    });

    const res = await this.fetchWithRetry(`${CURSEFORGE_API_BASE}/mods/${modId}/files?${params.toString()}`, key);

    if (!res.ok) {
      throw await this.buildHttpError(res, key);
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

  async getServerPackDownloadUrl(modId: number, serverPackFileId: number, rawKey: string): Promise<string | null> {
    const key = this.assertApiKey(rawKey);
    const res = await this.fetchWithRetry(
      `${CURSEFORGE_API_BASE}/mods/${modId}/files/${serverPackFileId}/download-url`,
      key
    );
    if (!res.ok) return null;
    const payload = (await res.json()) as { data?: string };
    return payload.data ?? null;
  }

  /**
   * Resolves a CurseForge modpack (by slug, page URL, and optional file ID) into a direct
   * Server Pack ZIP download URL and recommended Java tag for Native deployments.
   */
  async resolveServerPackForNative(options: {
    slug?: string;
    fileId?: string;
    pageUrl?: string;
    apiKey: string;
  }): Promise<ResolvedNativeServerPack> {
    let slug = (options.slug ?? '').trim().toLowerCase();
    let fileId = (options.fileId ?? '').trim();
    const pageUrl = (options.pageUrl ?? '').trim();

    if ((!slug || !fileId) && pageUrl) {
      const parsed = parseCurseForgeUrl(pageUrl);
      if (!slug && parsed.slug) slug = parsed.slug;
      if (!fileId && parsed.fileId) fileId = parsed.fileId;
    }

    if (!slug) {
      throw new Error(
        'No CurseForge modpack slug, URL, or Server Pack ZIP was configured. Pick a modpack from the CurseForge browser or set SERVER_PACK_ZIP to a direct URL or local .zip path.'
      );
    }

    const key = this.assertApiKey(options.apiKey);

    // 1. Resolve modpack by exact slug
    const slugParams = new URLSearchParams({
      gameId: String(MINECRAFT_GAME_ID),
      classId: String(MODPACKS_CLASS_ID),
      slug,
    });
    const modRes = await this.fetchWithRetry(`${CURSEFORGE_API_BASE}/mods/search?${slugParams.toString()}`, key);
    if (!modRes.ok) {
      throw await this.buildHttpError(modRes, key);
    }
    const modPayload = (await modRes.json()) as CfSearchResponse;
    let mod: NonNullable<CfSearchResponse['data']>[number] | undefined =
      (modPayload.data ?? []).find((m) => m.slug.toLowerCase() === slug) ??
      (modPayload.data ?? [])[0];

    if (!mod) {
      const fallbackParams = new URLSearchParams({
        gameId: String(MINECRAFT_GAME_ID),
        classId: String(MODPACKS_CLASS_ID),
        searchFilter: slug,
        pageSize: '10',
      });
      const fbRes = await this.fetchWithRetry(
        `${CURSEFORGE_API_BASE}/mods/search?${fallbackParams.toString()}`,
        key
      );
      if (fbRes.ok) {
        const fbPayload = (await fbRes.json()) as CfSearchResponse;
        mod = (fbPayload.data ?? []).find((m) => m.slug.toLowerCase() === slug);
      }
    }

    if (!mod) {
      throw new Error(
        `Could not find CurseForge modpack "${slug}". Verify the modpack slug or provide a direct/local SERVER_PACK_ZIP.`
      );
    }

    const websiteUrl = mod.links?.websiteUrl ?? `https://www.curseforge.com/minecraft/modpacks/${mod.slug}`;
    const modDefaultVersions = (mod.latestFilesIndexes ?? [])
      .map((i) => i.gameVersion)
      .filter((v): v is string => Boolean(v));

    // 2. Locate target file and its associated serverPackFileId
    let chosenFile: CurseForgeModpackFile | null = null;
    const requestedFileIdNum = fileId ? Number.parseInt(fileId, 10) : NaN;

    if (Number.isFinite(requestedFileIdNum) && requestedFileIdNum > 0) {
      const singleRes = await this.fetchWithRetry(
        `${CURSEFORGE_API_BASE}/mods/${mod.id}/files/${requestedFileIdNum}`,
        key
      );
      if (singleRes.ok) {
        const singlePayload = (await singleRes.json()) as {
          data?: NonNullable<CfFilesResponse['data']>[number];
        };
        if (singlePayload.data) {
          const f = singlePayload.data;
          const versions = f.gameVersions ?? [];
          chosenFile = {
            id: f.id,
            displayName: f.displayName,
            fileName: f.fileName,
            fileDate: f.fileDate,
            gameVersions: versions,
            isServerPack: Boolean(f.isServerPack),
            serverPackFileId: f.serverPackFileId ?? null,
            downloadUrl: f.downloadUrl ?? null,
            recommendedJavaTag: recommendJavaTag(versions.length > 0 ? versions : modDefaultVersions),
          };
        }
      }
    }

    if (!chosenFile) {
      const files = await this.getModpackFiles(mod.id, key, 25);
      if (Number.isFinite(requestedFileIdNum) && requestedFileIdNum > 0) {
        chosenFile = files.find((f) => f.id === requestedFileIdNum) ?? null;
      } else {
        chosenFile =
          files.find((f) => Boolean(f.serverPackFileId) || f.isServerPack) ??
          files[0] ??
          null;
      }
    }

    if (!chosenFile) {
      throw new Error(
        `No downloadable files found on CurseForge for "${mod.name}". Check ${websiteUrl}/files or provide SERVER_PACK_ZIP manually.`
      );
    }

    const serverPackFileId = chosenFile.isServerPack ? chosenFile.id : chosenFile.serverPackFileId;
    if (!serverPackFileId) {
      throw new Error(
        `"${mod.name}" (${chosenFile.displayName}) does not publish a separate CurseForge Server Pack ZIP for native installs. Download a server pack from ${websiteUrl}/files and paste the local .zip path into SERVER_PACK_ZIP, or deploy this modpack with the Docker runtime (AUTO_CURSEFORGE).`
      );
    }

    // 3. Resolve direct Server Pack CDN download URL
    let downloadUrl = await this.getServerPackDownloadUrl(mod.id, serverPackFileId, key);
    let packFileName = chosenFile.fileName;

    if (!downloadUrl) {
      const packMetaRes = await this.fetchWithRetry(
        `${CURSEFORGE_API_BASE}/mods/${mod.id}/files/${serverPackFileId}`,
        key
      );
      if (packMetaRes.ok) {
        const packMeta = (await packMetaRes.json()) as {
          data?: { downloadUrl?: string | null; fileName?: string };
        };
        if (packMeta.data?.downloadUrl) {
          downloadUrl = packMeta.data.downloadUrl;
        }
        if (packMeta.data?.fileName) {
          packFileName = packMeta.data.fileName;
        }
      }
    }

    if (!downloadUrl) {
      throw new Error(
        `CurseForge did not provide a direct download URL for "${mod.name}" Server Pack (file #${serverPackFileId}) — the modpack author may have disabled third-party API downloads. Download the Server Pack ZIP manually from ${websiteUrl}/files/${serverPackFileId} and paste the local .zip path into "Native Server Pack ZIP URL or Path".`
      );
    }

    return {
      modId: mod.id,
      modName: mod.name,
      slug: mod.slug,
      fileId: chosenFile.id,
      serverPackFileId,
      downloadUrl,
      fileName: packFileName,
      recommendedJavaTag: chosenFile.recommendedJavaTag,
      websiteUrl,
    };
  }
}

export interface ResolvedNativeServerPack {
  modId: number;
  modName: string;
  slug: string;
  fileId: number;
  serverPackFileId: number;
  downloadUrl: string;
  fileName: string;
  recommendedJavaTag: JavaImageTag;
  websiteUrl: string;
}
