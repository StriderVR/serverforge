import fs from 'node:fs';
import path from 'node:path';
import type { MinecraftLoaderKind, MinecraftLoaderVersionsResponse } from '@serverforge/shared';
import { recommendJavaMajorForMcVersion } from '../runtimes/java-helper.js';

export const SUPPORTED_MINECRAFT_LOADERS: readonly MinecraftLoaderKind[] = [
  'VANILLA',
  'PAPER',
  'FABRIC',
  'FORGE',
  'NEOFORGE',
] as const;

export interface ResolvedLoaderDownload {
  loader: MinecraftLoaderKind;
  mcVersion: string;
  loaderVersion: string | null;
  downloadUrl: string;
  filename: string;
  installerKind: 'direct_jar' | 'modloader_installer';
  requiredJavaMajor: number;
}

export function parseMinecraftLoaderKind(raw: string | undefined | null): MinecraftLoaderKind | null {
  const upper = (raw ?? '').trim().toUpperCase();
  if (
    upper === 'VANILLA' ||
    upper === 'PAPER' ||
    upper === 'FABRIC' ||
    upper === 'FORGE' ||
    upper === 'NEOFORGE'
  ) {
    return upper;
  }
  return null;
}

function compareSemverDesc(a: string, b: string): number {
  const pa = a.split(/[^0-9]+/).filter(Boolean).map((n) => Number.parseInt(n, 10));
  const pb = b.split(/[^0-9]+/).filter(Boolean).map((n) => Number.parseInt(n, 10));
  const len = Math.max(pa.length, pb.length);
  for (let i = 0; i < len; i++) {
    const da = pa[i] ?? 0;
    const db = pb[i] ?? 0;
    if (da !== db) return db - da;
  }
  return b.localeCompare(a);
}

function parseXmlTagValues(xml: string, tag: string): string[] {
  const values: string[] = [];
  const re = new RegExp(`<${tag}>([^<]+)</${tag}>`, 'gi');
  for (const match of xml.matchAll(re)) {
    const val = match[1].trim();
    if (val) values.push(val);
  }
  return values;
}

/**
 * Infers the Minecraft version corresponding to a NeoForge version string:
 * - "21.1.110" -> "1.21.1"
 * - "20.4.237" -> "1.20.4"
 * - "21.4.85-beta" -> "1.21.4"
 * - "26.1.2" -> "26.1" (Mojang 2026+ year-based versioning)
 */
export function inferMcVersionFromNeoForgeVersion(nfVersion: string): string | null {
  const m = nfVersion.trim().match(/^(\d+)\.(\d+)\./);
  if (!m) return null;
  const first = Number.parseInt(m[1], 10);
  const second = Number.parseInt(m[2], 10);
  if (first >= 26) {
    return `${first}.${second}`;
  }
  return second === 0 ? `1.${first}` : `1.${first}.${second}`;
}

export function neoForgeVersionMatchesMc(nfVersion: string, mcVersion: string): boolean {
  const cleanMc = mcVersion.trim();
  const cleanNf = nfVersion.trim();
  if (/^1\./.test(cleanMc)) {
    const parts = cleanMc.split('.');
    const minor = parts[1];
    const patch = parts[2] ?? '0';
    return cleanNf.startsWith(`${minor}.${patch}.`);
  }
  return cleanNf.startsWith(`${cleanMc}.`);
}

/**
 * Safely removes ONLY stale Minecraft loader files/directories while preserving worlds
 * (`<level-name>`, `world*`), `server.properties`, `whitelist.json`, `ops.json`, `banned-*.json`,
 * `mods/`, `plugins/`, `config/`, `logs/`, `crash-reports/`, and `.serverforge-modrinth.json`.
 */
export function cleanStaleLoaderArtifacts(serverDir: string): string[] {
  if (!fs.existsSync(serverDir)) return [];
  const removed: string[] = [];

  const removeIfExists = (relPath: string) => {
    const full = path.join(serverDir, relPath);
    if (!fs.existsSync(full)) return;
    fs.rmSync(full, { recursive: true, force: true });
    removed.push(relPath.replace(/\\/g, '/'));
  };

  // Explicit known loader startup/artifact files
  for (const rel of [
    'server.jar',
    'run.bat',
    'run.sh',
    '.serverforge-start.bat',
    '.fabric',
    path.join('libraries', 'net', 'minecraftforge'),
    path.join('libraries', 'net', 'neoforged'),
  ]) {
    removeIfExists(rel);
  }

  // Root installer / loader JARs (never touch mods/, plugins/, worlds, configs, etc.)
  try {
    for (const entry of fs.readdirSync(serverDir, { withFileTypes: true })) {
      if (!entry.isFile()) continue;
      const lower = entry.name.toLowerCase();
      const isStaleJar =
        lower.endsWith('-installer.jar') ||
        /^(?:paper|purpur|folia|spigot|craftbukkit|fabric-server|forge|neoforge|minecraft_server).*\.jar$/i.test(
          entry.name
        );
      if (isStaleJar) {
        removeIfExists(entry.name);
      }
    }
  } catch {
    // ignore read error
  }

  return removed;
}

export class MinecraftLoaderService {
  constructor(
    private readonly fetchImpl: typeof fetch = globalThis.fetch,
    private readonly appVersion = '1.5.0'
  ) {}

  private buildHeaders(accept = 'application/json'): Record<string, string> {
    return {
      Accept: accept,
      'User-Agent': `StriderVR/serverforge/${this.appVersion} (https://github.com/StriderVR/serverforge)`,
    };
  }

  private async fetchJson<T>(url: string, label: string): Promise<T> {
    const res = await this.fetchImpl(url, {
      headers: this.buildHeaders('application/json'),
      signal: AbortSignal.timeout(15_000),
    });
    if (!res.ok) {
      throw new Error(`${label} API error (HTTP ${res.status})`);
    }
    return (await res.json()) as T;
  }

  private async fetchText(url: string, label: string): Promise<string> {
    const res = await this.fetchImpl(url, {
      headers: this.buildHeaders('application/xml, text/xml, text/plain'),
      signal: AbortSignal.timeout(15_000),
    });
    if (!res.ok) {
      throw new Error(`${label} API error (HTTP ${res.status})`);
    }
    return await res.text();
  }

  async listMinecraftVersions(loader: MinecraftLoaderKind): Promise<string[]> {
    switch (loader) {
      case 'VANILLA': {
        const manifest = await this.fetchJson<{
          versions?: Array<{ id: string; type?: string }>;
        }>('https://piston-meta.mojang.com/mc/game/version_manifest_v2.json', 'Mojang');
        const releases = (manifest.versions ?? [])
          .filter((v) => !v.type || v.type === 'release')
          .map((v) => v.id);
        return releases.sort(compareSemverDesc);
      }
      case 'PAPER': {
        const proj = await this.fetchJson<{ versions?: string[] }>(
          'https://api.papermc.io/v2/projects/paper',
          'PaperMC'
        );
        return [...(proj.versions ?? [])].reverse();
      }
      case 'FABRIC': {
        const games = await this.fetchJson<Array<{ version: string; stable?: boolean }>>(
          'https://meta.fabricmc.net/v2/versions/game',
          'Fabric Meta'
        );
        return games.filter((g) => g.stable !== false).map((g) => g.version);
      }
      case 'FORGE': {
        const promos = await this.fetchJson<{ promos?: Record<string, string> }>(
          'https://files.minecraftforge.net/net/minecraftforge/forge/promotions_slim.json',
          'Forge Promotions'
        );
        const mcSet = new Set<string>();
        for (const key of Object.keys(promos.promos ?? {})) {
          const mc = key.replace(/-(?:latest|recommended)$/i, '');
          if (mc) mcSet.add(mc);
        }
        return Array.from(mcSet).sort(compareSemverDesc);
      }
      case 'NEOFORGE': {
        const xml = await this.fetchText(
          'https://maven.neoforged.net/releases/net/neoforged/neoforge/maven-metadata.xml',
          'NeoForge Maven'
        );
        const versions = parseXmlTagValues(xml, 'version');
        const mcSet = new Set<string>();
        for (const v of versions) {
          const mc = inferMcVersionFromNeoForgeVersion(v);
          if (mc) mcSet.add(mc);
        }
        return Array.from(mcSet).sort(compareSemverDesc);
      }
    }
  }

  async listLoaderVersions(loader: MinecraftLoaderKind, mcVersion: string): Promise<string[]> {
    const targetMc = mcVersion.trim();
    if (!targetMc || targetMc.toUpperCase() === 'LATEST') return [];

    switch (loader) {
      case 'VANILLA':
        return [];
      case 'PAPER': {
        const res = await this.fetchImpl(
          `https://api.papermc.io/v2/projects/paper/versions/${encodeURIComponent(targetMc)}/builds`,
          { headers: this.buildHeaders('application/json'), signal: AbortSignal.timeout(15_000) }
        );
        if (res.status === 404) return [];
        if (!res.ok) throw new Error(`PaperMC builds API error (HTTP ${res.status})`);
        const data = (await res.json()) as { builds?: Array<{ build: number }> };
        return (data.builds ?? [])
          .map((b) => String(b.build))
          .reverse();
      }
      case 'FABRIC': {
        const res = await this.fetchImpl(
          `https://meta.fabricmc.net/v2/versions/loader/${encodeURIComponent(targetMc)}`,
          { headers: this.buildHeaders('application/json'), signal: AbortSignal.timeout(15_000) }
        );
        if (res.status === 404) return [];
        if (!res.ok) throw new Error(`Fabric Meta loader API error (HTTP ${res.status})`);
        const rows = (await res.json()) as Array<{ loader?: { version?: string } }>;
        return rows.map((r) => r.loader?.version ?? '').filter(Boolean);
      }
      case 'FORGE': {
        const collected = new Set<string>();
        try {
          const xml = await this.fetchText(
            'https://maven.minecraftforge.net/net/minecraftforge/forge/maven-metadata.xml',
            'Forge Maven'
          );
          const allVersions = parseXmlTagValues(xml, 'version');
          const prefix = `${targetMc}-`;
          for (const entry of allVersions) {
            if (entry.startsWith(prefix)) {
              collected.add(entry.slice(prefix.length));
            }
          }
        } catch {
          // Fall back to promotions_slim.json if Maven metadata is unavailable
        }
        if (collected.size === 0) {
          const promos = await this.fetchJson<{ promos?: Record<string, string> }>(
            'https://files.minecraftforge.net/net/minecraftforge/forge/promotions_slim.json',
            'Forge Promotions'
          );
          const map = promos.promos ?? {};
          for (const key of [`${targetMc}-latest`, `${targetMc}-recommended`]) {
            if (map[key]) collected.add(map[key]);
          }
        }
        return Array.from(collected).sort(compareSemverDesc);
      }
      case 'NEOFORGE': {
        const xml = await this.fetchText(
          'https://maven.neoforged.net/releases/net/neoforged/neoforge/maven-metadata.xml',
          'NeoForge Maven'
        );
        const versions = parseXmlTagValues(xml, 'version');
        return versions.filter((v) => neoForgeVersionMatchesMc(v, targetMc)).reverse();
      }
    }
  }

  async getLoaderVersions(
    loader: MinecraftLoaderKind,
    mcVersion?: string
  ): Promise<MinecraftLoaderVersionsResponse> {
    const mcVersions = await this.listMinecraftVersions(loader);
    const trimmed = mcVersion?.trim() ?? '';
    const resolvedMc = trimmed && trimmed.toUpperCase() !== 'LATEST' ? trimmed : (mcVersions[0] ?? null);
    const loaderVersions = resolvedMc ? await this.listLoaderVersions(loader, resolvedMc) : [];
    const recommendedJavaMajor = recommendJavaMajorForMcVersion(resolvedMc ?? undefined);

    return {
      loader,
      mcVersion: resolvedMc,
      mcVersions,
      loaderVersions,
      recommendedJavaMajor,
    };
  }

  async resolveLoaderDownload(
    loader: MinecraftLoaderKind,
    mcVersion: string,
    loaderVersion?: string
  ): Promise<ResolvedLoaderDownload> {
    const rawMc = mcVersion.trim() || 'LATEST';
    const requestedLoader = loaderVersion?.trim() || undefined;

    switch (loader) {
      case 'VANILLA': {
        const manifest = await this.fetchJson<{
          latest?: { release?: string };
          versions?: Array<{ id: string; url: string }>;
        }>('https://piston-meta.mojang.com/mc/game/version_manifest_v2.json', 'Mojang');
        const targetId = rawMc.toUpperCase() === 'LATEST' ? manifest.latest?.release : rawMc;
        const entry = (manifest.versions ?? []).find((v) => v.id === targetId);
        if (!entry) throw new Error(`Vanilla Minecraft version "${rawMc}" was not found.`);

        const verMeta = await this.fetchJson<{
          javaVersion?: { majorVersion?: number };
          downloads?: { server?: { url?: string } };
        }>(entry.url, 'Mojang version metadata');
        const serverUrl = verMeta.downloads?.server?.url;
        if (!serverUrl) throw new Error(`No server JAR download available for Vanilla ${entry.id}.`);
        const requiredJavaMajor =
          verMeta.javaVersion?.majorVersion ?? recommendJavaMajorForMcVersion(entry.id);

        return {
          loader: 'VANILLA',
          mcVersion: entry.id,
          loaderVersion: null,
          downloadUrl: serverUrl,
          filename: 'server.jar',
          installerKind: 'direct_jar',
          requiredJavaMajor,
        };
      }

      case 'PAPER': {
        const proj = await this.fetchJson<{ versions?: string[] }>(
          'https://api.papermc.io/v2/projects/paper',
          'PaperMC'
        );
        const versions = proj.versions ?? [];
        const targetVer = rawMc.toUpperCase() === 'LATEST' ? versions[versions.length - 1] : rawMc;
        if (!targetVer || !versions.includes(targetVer)) {
          throw new Error(`PaperMC version "${rawMc}" was not found.`);
        }
        const buildsData = await this.fetchJson<{
          builds?: Array<{ build: number; downloads?: { application?: { name?: string } } }>;
        }>(`https://api.papermc.io/v2/projects/paper/versions/${encodeURIComponent(targetVer)}/builds`, 'PaperMC builds');
        const builds = buildsData.builds ?? [];
        const chosen = requestedLoader
          ? builds.find((b) => String(b.build) === requestedLoader) ?? builds[builds.length - 1]
          : builds[builds.length - 1];
        const jarName = chosen?.downloads?.application?.name;
        if (!chosen || !jarName) {
          throw new Error(`No downloadable PaperMC JAR found for Minecraft ${targetVer}.`);
        }
        return {
          loader: 'PAPER',
          mcVersion: targetVer,
          loaderVersion: String(chosen.build),
          downloadUrl: `https://api.papermc.io/v2/projects/paper/versions/${encodeURIComponent(targetVer)}/builds/${chosen.build}/downloads/${encodeURIComponent(jarName)}`,
          filename: 'server.jar',
          installerKind: 'direct_jar',
          requiredJavaMajor: recommendJavaMajorForMcVersion(targetVer),
        };
      }

      case 'FABRIC': {
        const [games, loaders, installers] = await Promise.all([
          this.fetchJson<Array<{ version: string; stable: boolean }>>(
            'https://meta.fabricmc.net/v2/versions/game',
            'Fabric Meta game'
          ),
          this.fetchJson<Array<{ version: string; stable: boolean }>>(
            'https://meta.fabricmc.net/v2/versions/loader',
            'Fabric Meta loader'
          ),
          this.fetchJson<Array<{ version: string; stable: boolean }>>(
            'https://meta.fabricmc.net/v2/versions/installer',
            'Fabric Meta installer'
          ),
        ]);
        const targetMc =
          rawMc.toUpperCase() === 'LATEST'
            ? (games.find((g) => g.stable)?.version ?? games[0]?.version)
            : rawMc;
        const targetLoader =
          requestedLoader ?? loaders.find((l) => l.stable)?.version ?? loaders[0]?.version;
        const targetInstaller = installers.find((i) => i.stable)?.version ?? installers[0]?.version;

        if (!targetMc || !targetLoader || !targetInstaller) {
          throw new Error(`Could not resolve Fabric loader/installer versions for Minecraft ${rawMc}.`);
        }
        return {
          loader: 'FABRIC',
          mcVersion: targetMc,
          loaderVersion: targetLoader,
          downloadUrl: `https://meta.fabricmc.net/v2/versions/loader/${encodeURIComponent(targetMc)}/${encodeURIComponent(targetLoader)}/${encodeURIComponent(targetInstaller)}/server/jar`,
          filename: 'server.jar',
          installerKind: 'direct_jar',
          requiredJavaMajor: recommendJavaMajorForMcVersion(targetMc),
        };
      }

      case 'FORGE': {
        const mcVersions = await this.listMinecraftVersions('FORGE');
        const targetMc = rawMc.toUpperCase() === 'LATEST' ? mcVersions[0] : rawMc;
        if (!targetMc) throw new Error('Could not resolve Minecraft version for Forge.');

        const available = await this.listLoaderVersions('FORGE', targetMc);
        const chosenForge = requestedLoader
          ? requestedLoader.replace(new RegExp(`^${targetMc.replace(/\./g, '\\.')}-`), '')
          : available[0];
        if (!chosenForge) {
          throw new Error(`No Forge builds found for Minecraft ${targetMc}.`);
        }
        const fullVer = `${targetMc}-${chosenForge}`;
        const filename = `forge-${fullVer}-installer.jar`;
        return {
          loader: 'FORGE',
          mcVersion: targetMc,
          loaderVersion: chosenForge,
          downloadUrl: `https://maven.minecraftforge.net/net/minecraftforge/forge/${encodeURIComponent(fullVer)}/${encodeURIComponent(filename)}`,
          filename,
          installerKind: 'modloader_installer',
          requiredJavaMajor: recommendJavaMajorForMcVersion(targetMc),
        };
      }

      case 'NEOFORGE': {
        const mcVersions = await this.listMinecraftVersions('NEOFORGE');
        const targetMc = rawMc.toUpperCase() === 'LATEST' ? mcVersions[0] : rawMc;
        if (!targetMc) throw new Error('Could not resolve Minecraft version for NeoForge.');

        const available = await this.listLoaderVersions('NEOFORGE', targetMc);
        const chosenNf = requestedLoader ?? available[0];
        if (!chosenNf) {
          throw new Error(`No NeoForge builds found for Minecraft ${targetMc}.`);
        }
        const filename = `neoforge-${chosenNf}-installer.jar`;
        return {
          loader: 'NEOFORGE',
          mcVersion: targetMc,
          loaderVersion: chosenNf,
          downloadUrl: `https://maven.neoforged.net/releases/net/neoforged/neoforge/${encodeURIComponent(chosenNf)}/${encodeURIComponent(filename)}`,
          filename,
          installerKind: 'modloader_installer',
          requiredJavaMajor: recommendJavaMajorForMcVersion(targetMc),
        };
      }
    }
  }

  async downloadResolvedLoader(resolved: ResolvedLoaderDownload, serverDir: string): Promise<string> {
    const res = await this.fetchImpl(resolved.downloadUrl, {
      headers: { 'User-Agent': this.buildHeaders()['User-Agent'] },
      redirect: 'follow',
      signal: AbortSignal.timeout(120_000),
    });
    if (!res.ok) {
      throw new Error(`Failed to download ${resolved.loader} ${resolved.mcVersion} (HTTP ${res.status})`);
    }
    const buf = Buffer.from(await res.arrayBuffer());
    fs.mkdirSync(serverDir, { recursive: true });
    const destPath = path.join(serverDir, resolved.filename);
    fs.writeFileSync(destPath, buf);
    return destPath;
  }
}
