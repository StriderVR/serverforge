import fs from 'node:fs';
import path from 'node:path';
import type {
  AddonFolder,
  AddonUpdateCandidate,
  InstalledAddonEntry,
  InstalledAddonsResponse,
  ModrinthProjectSummary,
  ModrinthProjectType,
  ModrinthVersionSummary,
  ServerInstance,
} from '@serverforge/shared';
import { recommendJavaTag } from './curseforge-service.js';
import { extractZipSafely } from './backup-scheduler.js';
import { resolveSandboxedPath } from './file-service.js';

const MODRINTH_API_BASE = 'https://api.modrinth.com/v2';
const TRACKING_MANIFEST_NAME = '.serverforge-modrinth.json';

interface ModrinthSearchHit {
  project_id: string;
  slug: string;
  title: string;
  description?: string;
  project_type?: string;
  icon_url?: string | null;
  downloads?: number;
  categories?: string[];
  versions?: string[];
}

interface ModrinthVersionApi {
  id: string;
  project_id: string;
  name: string;
  version_number: string;
  date_published: string;
  game_versions?: string[];
  loaders?: string[];
  files?: Array<{
    url: string;
    filename: string;
    primary?: boolean;
    size?: number;
  }>;
  dependencies?: Array<{
    project_id?: string | null;
    version_id?: string | null;
    dependency_type: 'required' | 'optional' | 'incompatible' | 'embedded';
  }>;
}

interface TrackedModrinthAddon {
  filename: string;
  folder: AddonFolder;
  projectId: string;
  slug?: string;
  title: string;
  versionId: string;
  versionNumber: string;
  installedAt: string;
}

interface TrackedModrinthManifest {
  addons: TrackedModrinthAddon[];
}

export interface ModrinthIndexJson {
  formatVersion: number;
  game: string;
  versionId?: string;
  name?: string;
  files: Array<{
    path: string;
    hashes?: Record<string, string>;
    env?: { client?: string; server?: string };
    downloads: string[];
    fileSize?: number;
  }>;
  dependencies: Record<string, string>;
}

const KNOWN_LOADERS = new Set([
  'fabric',
  'forge',
  'neoforge',
  'quilt',
  'paper',
  'purpur',
  'spigot',
  'bukkit',
  'folia',
  'velocity',
  'datapack',
]);

const PLUGIN_LOADERS = new Set(['paper', 'spigot', 'purpur', 'bukkit', 'folia']);

/**
 * Safely resolves `level-name` from `<serverDir>/server.properties` to determine
 * `<level-name>/datapacks`, strictly sandboxed inside `serverDir` (fallback: `'world'`).
 */
export function resolveWorldDatapacksDir(serverDir: string): { worldName: string; datapacksRelDir: string } {
  let rawLevelName = '';
  const propsPath = path.join(serverDir, 'server.properties');
  if (fs.existsSync(propsPath)) {
    try {
      const content = fs.readFileSync(propsPath, 'utf8');
      for (const rawLine of content.split(/\r?\n/)) {
        const line = rawLine.trim();
        if (!line || line.startsWith('#') || line.startsWith('!')) continue;
        const eqIdx = line.indexOf('=');
        if (eqIdx === -1) continue;
        const key = line.slice(0, eqIdx).trim();
        if (key === 'level-name') {
          rawLevelName = line.slice(eqIdx + 1).trim();
          break;
        }
      }
    } catch {
      rawLevelName = '';
    }
  }

  let worldName = 'world';
  if (rawLevelName) {
    const normalized = rawLevelName.replace(/\\/g, '/').replace(/^\/+|\/+$/g, '');
    const hasUnsafe =
      !normalized ||
      normalized.includes('..') ||
      normalized.includes(':') ||
      normalized.includes('\0') ||
      path.isAbsolute(rawLevelName);

    if (!hasUnsafe) {
      try {
        const resolved = resolveSandboxedPath(serverDir, `${normalized}/datapacks`);
        if (resolved.relPosix && !resolved.relPosix.startsWith('..') && !resolved.relPosix.includes('..')) {
          worldName = normalized;
        }
      } catch {
        worldName = 'world';
      }
    }
  }

  return {
    worldName,
    datapacksRelDir: `${worldName}/datapacks`,
  };
}

function assertSafeAddonFilename(filename: string): string {
  const trimmed = filename.trim();
  if (
    !trimmed ||
    trimmed.includes('/') ||
    trimmed.includes('\\') ||
    trimmed.includes('..') ||
    trimmed.includes('\0') ||
    path.basename(trimmed) !== trimmed
  ) {
    throw new Error('Invalid addon filename: path separators and traversal segments are not allowed.');
  }
  return trimmed;
}

function detectPluginLoaderFromDisk(serverDir: string): string | null {
  if (!fs.existsSync(serverDir)) return null;
  try {
    const entries = fs.readdirSync(serverDir, { withFileTypes: true });
    const filesLower = entries.filter((e) => e.isFile()).map((e) => e.name.toLowerCase());

    if (filesLower.some((f) => f.startsWith('purpur') && f.endsWith('.jar')) || filesLower.includes('purpur.yml')) {
      return 'purpur';
    }
    if (filesLower.some((f) => f.startsWith('folia') && f.endsWith('.jar'))) {
      return 'folia';
    }
    if (
      filesLower.some((f) => f.startsWith('paper') && f.endsWith('.jar')) ||
      filesLower.includes('paper.yml') ||
      fs.existsSync(path.join(serverDir, 'config', 'paper-global.yml'))
    ) {
      return 'paper';
    }
    if (filesLower.some((f) => f.startsWith('spigot') && f.endsWith('.jar')) || filesLower.includes('spigot.yml')) {
      return 'spigot';
    }
    if (
      filesLower.some((f) => (f.startsWith('craftbukkit') || f.startsWith('bukkit')) && f.endsWith('.jar')) ||
      filesLower.includes('bukkit.yml')
    ) {
      return 'bukkit';
    }
  } catch {
    // ignore read errors
  }
  return null;
}

export function detectMinecraftAddonEnvironment(
  serverDir: string,
  instance: ServerInstance
): {
  defaultFolder: AddonFolder;
  availableFolders: AddonFolder[];
  loader: string | null;
  mcVersion: string | null;
  worldName: string;
  datapacksRelDir: string;
} {
  const serverType = String(instance.config.SERVER_TYPE ?? '').trim().toUpperCase();
  const hasPlugins = fs.existsSync(path.join(serverDir, 'plugins'));
  const hasMods = fs.existsSync(path.join(serverDir, 'mods'));
  const diskPluginLoader = detectPluginLoaderFromDisk(serverDir);
  const { worldName, datapacksRelDir } = resolveWorldDatapacksDir(serverDir);

  let defaultFolder: AddonFolder = 'mods';
  let loader: string | null = null;

  if (instance.gameId === 'minecraft') {
    if (serverType === 'PAPER' || serverType === 'PURPUR' || serverType === 'SPIGOT' || serverType === 'BUKKIT' || serverType === 'FOLIA') {
      defaultFolder = 'plugins';
      loader = diskPluginLoader ?? serverType.toLowerCase();
    } else if (serverType === 'FABRIC') {
      defaultFolder = 'mods';
      loader = 'fabric';
    } else if (serverType === 'FORGE') {
      defaultFolder = 'mods';
      loader = 'forge';
    } else if (serverType === 'NEOFORGE') {
      defaultFolder = 'mods';
      loader = 'neoforge';
    } else if (diskPluginLoader) {
      defaultFolder = 'plugins';
      loader = diskPluginLoader;
    } else if (hasPlugins && !hasMods) {
      defaultFolder = 'plugins';
      loader = 'paper';
    } else if (fs.existsSync(path.join(serverDir, '.fabric'))) {
      defaultFolder = 'mods';
      loader = 'fabric';
    } else if (fs.existsSync(path.join(serverDir, 'libraries', 'net', 'neoforged'))) {
      defaultFolder = 'mods';
      loader = 'neoforge';
    } else if (fs.existsSync(path.join(serverDir, 'libraries', 'net', 'minecraftforge'))) {
      defaultFolder = 'mods';
      loader = 'forge';
    }
  } else {
    if (diskPluginLoader) {
      defaultFolder = 'plugins';
      loader = diskPluginLoader;
    } else {
      defaultFolder = hasPlugins && !hasMods ? 'plugins' : 'mods';
      if (fs.existsSync(path.join(serverDir, '.fabric'))) {
        loader = 'fabric';
      } else if (fs.existsSync(path.join(serverDir, 'libraries', 'net', 'neoforged'))) {
        loader = 'neoforge';
      } else if (fs.existsSync(path.join(serverDir, 'libraries', 'net', 'minecraftforge'))) {
        loader = 'forge';
      } else if (defaultFolder === 'plugins') {
        loader = 'paper';
      }
    }
  }

  const folders = new Set<AddonFolder>([defaultFolder]);
  if (hasMods) folders.add('mods');
  if (hasPlugins) folders.add('plugins');
  folders.add('datapacks');
  const availableFolders: AddonFolder[] = Array.from(folders);

  const rawMcVer = String(instance.config.MC_VERSION ?? '').trim();
  const mcVersion = rawMcVer && rawMcVer.toUpperCase() !== 'LATEST' ? rawMcVer : null;

  return { defaultFolder, availableFolders, loader, mcVersion, worldName, datapacksRelDir };
}

export class ModrinthService {
  constructor(
    private readonly fetchImpl: typeof fetch = globalThis.fetch,
    private readonly appVersion = '1.5.0'
  ) {}

  private buildHeaders(): Record<string, string> {
    return {
      Accept: 'application/json',
      'User-Agent': `StriderVR/serverforge/${this.appVersion} (https://github.com/StriderVR/serverforge)`,
    };
  }

  private async fetchJson<T>(url: string): Promise<T> {
    const res = await this.fetchImpl(url, {
      headers: this.buildHeaders(),
      signal: AbortSignal.timeout(15_000),
    });
    if (!res.ok) {
      const text = await res.text().catch(() => '');
      throw new Error(`Modrinth API error (HTTP ${res.status})${text ? `: ${text.slice(0, 140)}` : ''}`);
    }
    return (await res.json()) as T;
  }

  async searchProjects(options: {
    query?: string;
    projectType: ModrinthProjectType;
    loader?: string;
    gameVersion?: string;
    limit?: number;
  }): Promise<ModrinthProjectSummary[]> {
    const facets: string[][] = [];
    if (options.projectType === 'plugin') {
      facets.push(['project_type:mod']);
      const loader = options.loader?.trim().toLowerCase();
      if (loader && PLUGIN_LOADERS.has(loader)) {
        facets.push([`categories:${loader}`]);
      } else {
        facets.push(['categories:paper', 'categories:spigot', 'categories:purpur', 'categories:bukkit']);
      }
    } else if (options.projectType === 'datapack') {
      facets.push(['project_type:datapack']);
    } else {
      facets.push([`project_type:${options.projectType}`]);
      if (options.loader?.trim()) {
        facets.push([`categories:${options.loader.trim().toLowerCase()}`]);
      }
    }
    if (options.gameVersion?.trim() && options.gameVersion.trim().toUpperCase() !== 'LATEST') {
      facets.push([`versions:${options.gameVersion.trim()}`]);
    }

    const params = new URLSearchParams({
      limit: String(Math.min(Math.max(options.limit ?? 15, 1), 30)),
      index: 'relevance',
      facets: JSON.stringify(facets),
    });
    if (options.query?.trim()) {
      params.set('query', options.query.trim());
    }

    const payload = await this.fetchJson<{ hits?: ModrinthSearchHit[] }>(
      `${MODRINTH_API_BASE}/search?${params.toString()}`
    );

    return (payload.hits ?? []).map((hit) => {
      const cats = hit.categories ?? [];
      const loaders = cats.filter((c) => KNOWN_LOADERS.has(c.toLowerCase()));
      const versions = (hit.versions ?? []).slice(-8).reverse();
      const urlKind =
        options.projectType === 'modpack'
          ? 'modpack'
          : options.projectType === 'datapack'
            ? 'datapack'
            : options.projectType === 'plugin'
              ? 'plugin'
              : 'mod';
      return {
        projectId: hit.project_id,
        slug: hit.slug,
        title: hit.title,
        description: hit.description ?? '',
        projectType: options.projectType,
        iconUrl: hit.icon_url ?? null,
        downloads: hit.downloads ?? 0,
        categories: cats,
        loaders,
        gameVersions: versions,
        websiteUrl: `https://modrinth.com/${urlKind}/${hit.slug}`,
        recommendedJavaTag: recommendJavaTag(versions),
      };
    });
  }

  async getProject(idOrSlug: string): Promise<{ id: string; slug: string; title: string; project_type: string }> {
    return this.fetchJson<{ id: string; slug: string; title: string; project_type: string }>(
      `${MODRINTH_API_BASE}/project/${encodeURIComponent(idOrSlug.trim())}`
    );
  }

  async getProjectVersions(
    idOrSlug: string,
    options?: { loader?: string; gameVersion?: string }
  ): Promise<ModrinthVersionSummary[]> {
    const params = new URLSearchParams();
    if (options?.loader?.trim()) {
      params.set('loaders', JSON.stringify([options.loader.trim().toLowerCase()]));
    }
    if (options?.gameVersion?.trim() && options.gameVersion.trim().toUpperCase() !== 'LATEST') {
      params.set('game_versions', JSON.stringify([options.gameVersion.trim()]));
    }
    const qs = params.toString();
    const raw = await this.fetchJson<ModrinthVersionApi[]>(
      `${MODRINTH_API_BASE}/project/${encodeURIComponent(idOrSlug.trim())}/version${qs ? `?${qs}` : ''}`
    );

    return raw.map((v) => {
      const files = v.files ?? [];
      const primary = files.find((f) => f.primary) ?? files[0] ?? null;
      const gameVersions = v.game_versions ?? [];
      return {
        id: v.id,
        projectId: v.project_id,
        name: v.name,
        versionNumber: v.version_number,
        datePublished: v.date_published,
        gameVersions,
        loaders: v.loaders ?? [],
        primaryFile: primary
          ? { url: primary.url, filename: primary.filename, size: primary.size ?? 0 }
          : null,
        dependencies: (v.dependencies ?? []).map((d) => ({
          projectId: d.project_id ?? null,
          versionId: d.version_id ?? null,
          dependencyType: d.dependency_type,
        })),
        recommendedJavaTag: recommendJavaTag(gameVersions),
      };
    });
  }

  async getVersionById(versionId: string): Promise<ModrinthVersionSummary> {
    const v = await this.fetchJson<ModrinthVersionApi>(
      `${MODRINTH_API_BASE}/version/${encodeURIComponent(versionId.trim())}`
    );
    const files = v.files ?? [];
    const primary = files.find((f) => f.primary) ?? files[0] ?? null;
    const gameVersions = v.game_versions ?? [];
    return {
      id: v.id,
      projectId: v.project_id,
      name: v.name,
      versionNumber: v.version_number,
      datePublished: v.date_published,
      gameVersions,
      loaders: v.loaders ?? [],
      primaryFile: primary
        ? { url: primary.url, filename: primary.filename, size: primary.size ?? 0 }
        : null,
      dependencies: (v.dependencies ?? []).map((d) => ({
        projectId: d.project_id ?? null,
        versionId: d.version_id ?? null,
        dependencyType: d.dependency_type,
      })),
      recommendedJavaTag: recommendJavaTag(gameVersions),
    };
  }

  private readManifest(serverDir: string): TrackedModrinthManifest {
    const manifestPath = path.join(serverDir, TRACKING_MANIFEST_NAME);
    if (!fs.existsSync(manifestPath)) return { addons: [] };
    try {
      const parsed = JSON.parse(fs.readFileSync(manifestPath, 'utf8')) as Partial<TrackedModrinthManifest>;
      return { addons: Array.isArray(parsed.addons) ? parsed.addons : [] };
    } catch {
      return { addons: [] };
    }
  }

  private writeManifest(serverDir: string, manifest: TrackedModrinthManifest): void {
    fs.mkdirSync(serverDir, { recursive: true });
    fs.writeFileSync(path.join(serverDir, TRACKING_MANIFEST_NAME), JSON.stringify(manifest, null, 2), 'utf8');
  }

  private resolveFolderRelDir(serverDir: string, folder: AddonFolder): string {
    if (folder === 'datapacks') {
      return resolveWorldDatapacksDir(serverDir).datapacksRelDir;
    }
    return folder;
  }

  listInstalledAddons(serverDir: string, instance: ServerInstance): InstalledAddonsResponse {
    const env = detectMinecraftAddonEnvironment(serverDir, instance);
    const manifest = this.readManifest(serverDir);
    const trackedByKey = new Map<string, TrackedModrinthAddon>();
    for (const item of manifest.addons) {
      trackedByKey.set(`${item.folder}:${item.filename.toLowerCase()}`, item);
    }

    const addons: InstalledAddonEntry[] = [];

    // 1. Scan mods/ and plugins/ for .jar / .jar.disabled
    for (const folder of ['mods', 'plugins'] as const) {
      const dirPath = path.join(serverDir, folder);
      if (!fs.existsSync(dirPath)) continue;
      for (const entry of fs.readdirSync(dirPath, { withFileTypes: true })) {
        if (!entry.isFile()) continue;
        const lower = entry.name.toLowerCase();
        const isEnabledJar = lower.endsWith('.jar');
        const isDisabledJar = lower.endsWith('.jar.disabled');
        if (!isEnabledJar && !isDisabledJar) continue;
        const st = fs.statSync(path.join(dirPath, entry.name));
        const baseName = isDisabledJar ? entry.name.slice(0, -'.disabled'.length) : entry.name;
        const tracked =
          trackedByKey.get(`${folder}:${entry.name.toLowerCase()}`) ??
          trackedByKey.get(`${folder}:${baseName.toLowerCase()}`);

        addons.push({
          filename: entry.name,
          baseName,
          folder,
          enabled: isEnabledJar,
          sizeBytes: st.size,
          updatedAt: st.mtime.toISOString(),
          modrinthProjectId: tracked?.projectId ?? null,
          modrinthVersionId: tracked?.versionId ?? null,
          modrinthTitle: tracked?.title ?? null,
          modrinthVersionNumber: tracked?.versionNumber ?? null,
        });
      }
    }

    // 2. Scan <level-name>/datapacks/ for .zip / .zip.disabled
    const { absPath: datapacksDir } = resolveSandboxedPath(serverDir, env.datapacksRelDir);
    if (fs.existsSync(datapacksDir)) {
      for (const entry of fs.readdirSync(datapacksDir, { withFileTypes: true })) {
        if (!entry.isFile()) continue;
        const lower = entry.name.toLowerCase();
        const isEnabledZip = lower.endsWith('.zip');
        const isDisabledZip = lower.endsWith('.zip.disabled');
        if (!isEnabledZip && !isDisabledZip) continue;
        const st = fs.statSync(path.join(datapacksDir, entry.name));
        const baseName = isDisabledZip ? entry.name.slice(0, -'.disabled'.length) : entry.name;
        const tracked =
          trackedByKey.get(`datapacks:${entry.name.toLowerCase()}`) ??
          trackedByKey.get(`datapacks:${baseName.toLowerCase()}`);

        addons.push({
          filename: entry.name,
          baseName,
          folder: 'datapacks',
          enabled: isEnabledZip,
          sizeBytes: st.size,
          updatedAt: st.mtime.toISOString(),
          modrinthProjectId: tracked?.projectId ?? null,
          modrinthVersionId: tracked?.versionId ?? null,
          modrinthTitle: tracked?.title ?? null,
          modrinthVersionNumber: tracked?.versionNumber ?? null,
        });
      }
    }

    addons.sort((a, b) => a.baseName.localeCompare(b.baseName, undefined, { sensitivity: 'base' }));

    return {
      defaultFolder: env.defaultFolder,
      availableFolders: env.availableFolders,
      detectedLoader: env.loader,
      detectedMcVersion: env.mcVersion,
      worldName: env.worldName,
      datapacksRelDir: env.datapacksRelDir,
      addons,
    };
  }

  toggleAddon(serverDir: string, folder: AddonFolder, filename: string): { filename: string; enabled: boolean } {
    const clean = assertSafeAddonFilename(filename);
    const relDir = this.resolveFolderRelDir(serverDir, folder);
    const { absPath } = resolveSandboxedPath(serverDir, `${relDir}/${clean}`);
    if (!fs.existsSync(absPath)) {
      throw new Error(`Addon file not found: ${relDir}/${clean}`);
    }
    const lower = clean.toLowerCase();
    let nextName: string;
    let enabled: boolean;

    if (folder === 'datapacks') {
      if (lower.endsWith('.zip.disabled')) {
        nextName = clean.slice(0, -'.disabled'.length);
        enabled = true;
      } else if (lower.endsWith('.zip')) {
        nextName = `${clean}.disabled`;
        enabled = false;
      } else {
        throw new Error('Only .zip and .zip.disabled datapack files can be toggled.');
      }
    } else {
      if (lower.endsWith('.jar.disabled')) {
        nextName = clean.slice(0, -'.disabled'.length);
        enabled = true;
      } else if (lower.endsWith('.jar')) {
        nextName = `${clean}.disabled`;
        enabled = false;
      } else {
        throw new Error('Only .jar and .jar.disabled files can be toggled.');
      }
    }

    const { absPath: nextPath } = resolveSandboxedPath(serverDir, `${relDir}/${nextName}`);
    fs.renameSync(absPath, nextPath);

    const manifest = this.readManifest(serverDir);
    const entry = manifest.addons.find(
      (a) => a.folder === folder && a.filename.toLowerCase() === clean.toLowerCase()
    );
    if (entry) {
      entry.filename = nextName;
      this.writeManifest(serverDir, manifest);
    }

    return { filename: nextName, enabled };
  }

  removeAddon(serverDir: string, folder: AddonFolder, filename: string): void {
    const clean = assertSafeAddonFilename(filename);
    const relDir = this.resolveFolderRelDir(serverDir, folder);
    const { absPath } = resolveSandboxedPath(serverDir, `${relDir}/${clean}`);
    if (!fs.existsSync(absPath)) {
      throw new Error(`Addon file not found: ${relDir}/${clean}`);
    }
    fs.rmSync(absPath, { force: true });

    const manifest = this.readManifest(serverDir);
    const filtered = manifest.addons.filter(
      (a) => !(a.folder === folder && a.filename.toLowerCase() === clean.toLowerCase())
    );
    if (filtered.length !== manifest.addons.length) {
      this.writeManifest(serverDir, { addons: filtered });
    }
  }

  private async downloadFile(url: string, destPath: string): Promise<void> {
    const res = await this.fetchImpl(url, {
      headers: { 'User-Agent': this.buildHeaders()['User-Agent'] },
      redirect: 'follow',
      signal: AbortSignal.timeout(120_000),
    });
    if (!res.ok) {
      throw new Error(`Failed to download ${url} (HTTP ${res.status})`);
    }
    const buf = Buffer.from(await res.arrayBuffer());
    fs.mkdirSync(path.dirname(destPath), { recursive: true });
    fs.writeFileSync(destPath, buf);
  }

  async installAddonWithDependencies(
    serverDir: string,
    instance: ServerInstance,
    options: {
      projectId: string;
      versionId?: string;
      folder?: AddonFolder;
      loader?: string;
      gameVersion?: string;
    }
  ): Promise<{ installed: InstalledAddonEntry[]; dependenciesInstalled: string[] }> {
    const env = detectMinecraftAddonEnvironment(serverDir, instance);
    const targetFolder: AddonFolder = options.folder ?? env.defaultFolder;
    const targetRelDir = this.resolveFolderRelDir(serverDir, targetFolder);
    const loader =
      targetFolder === 'datapacks'
        ? 'datapack'
        : (options.loader ?? (targetFolder === 'plugins' ? (env.loader && PLUGIN_LOADERS.has(env.loader) ? env.loader : 'paper') : env.loader) ?? undefined);
    const gameVersion = options.gameVersion ?? env.mcVersion ?? undefined;

    const manifest = this.readManifest(serverDir);
    const installedProjectIds = new Set(manifest.addons.map((a) => a.projectId));
    const visited = new Set<string>();
    const installedFiles: InstalledAddonEntry[] = [];
    const depsInstalled: string[] = [];

    const installRecursive = async (projId: string, explicitVersionId: string | undefined, isDependency: boolean) => {
      if (visited.has(projId)) return;
      visited.add(projId);
      if (isDependency && installedProjectIds.has(projId)) return;

      const project = await this.getProject(projId);
      let version: ModrinthVersionSummary | undefined;
      if (explicitVersionId) {
        version = await this.getVersionById(explicitVersionId);
      } else {
        let versions = await this.getProjectVersions(project.id, { loader, gameVersion });
        if (versions.length === 0 && (loader || gameVersion)) {
          versions = await this.getProjectVersions(project.id, { loader });
        }
        if (versions.length === 0) {
          versions = await this.getProjectVersions(project.id);
        }
        version = versions[0];
      }

      if (!version || !version.primaryFile) {
        throw new Error(`No downloadable file found on Modrinth for "${project.title}".`);
      }

      // Remove any older tracked file for this same projectId in targetFolder before installing the new one
      const previous = manifest.addons.find((a) => a.folder === targetFolder && a.projectId === project.id);
      if (previous && previous.filename !== version.primaryFile.filename) {
        const { absPath: oldPath } = resolveSandboxedPath(
          serverDir,
          `${targetRelDir}/${path.basename(previous.filename)}`
        );
        if (fs.existsSync(oldPath)) {
          fs.rmSync(oldPath, { force: true });
        }
      }

      const safeFilename = path.basename(version.primaryFile.filename);
      const { absPath: destPath } = resolveSandboxedPath(serverDir, `${targetRelDir}/${safeFilename}`);
      await this.downloadFile(version.primaryFile.url, destPath);
      const st = fs.statSync(destPath);

      manifest.addons = manifest.addons.filter(
        (a) => !(a.folder === targetFolder && (a.projectId === project.id || a.filename === safeFilename))
      );
      manifest.addons.push({
        filename: safeFilename,
        folder: targetFolder,
        projectId: project.id,
        slug: project.slug,
        title: project.title,
        versionId: version.id,
        versionNumber: version.versionNumber,
        installedAt: new Date().toISOString(),
      });
      installedProjectIds.add(project.id);

      installedFiles.push({
        filename: safeFilename,
        baseName: safeFilename,
        folder: targetFolder,
        enabled: true,
        sizeBytes: st.size,
        updatedAt: st.mtime.toISOString(),
        modrinthProjectId: project.id,
        modrinthVersionId: version.id,
        modrinthTitle: project.title,
        modrinthVersionNumber: version.versionNumber,
      });

      if (isDependency) {
        depsInstalled.push(project.title);
      }

      // Install required Modrinth dependencies automatically
      for (const dep of version.dependencies) {
        if (dep.dependencyType !== 'required') continue;
        if (dep.projectId) {
          await installRecursive(dep.projectId, dep.versionId ?? undefined, true);
        }
      }
    };

    await installRecursive(options.projectId, options.versionId, false);
    this.writeManifest(serverDir, manifest);
    return { installed: installedFiles, dependenciesInstalled: depsInstalled };
  }

  async checkAddonUpdates(serverDir: string, instance: ServerInstance): Promise<AddonUpdateCandidate[]> {
    const env = detectMinecraftAddonEnvironment(serverDir, instance);
    const manifest = this.readManifest(serverDir);
    const updates: AddonUpdateCandidate[] = [];

    for (const item of manifest.addons) {
      try {
        const loader =
          item.folder === 'datapacks'
            ? 'datapack'
            : item.folder === 'plugins'
              ? env.loader && PLUGIN_LOADERS.has(env.loader)
                ? env.loader
                : 'paper'
              : (env.loader ?? undefined);
        const versions = await this.getProjectVersions(item.projectId, {
          loader,
          gameVersion: env.mcVersion ?? undefined,
        });
        const latest = versions[0];
        if (latest && latest.id !== item.versionId) {
          updates.push({
            filename: item.filename,
            folder: item.folder,
            projectId: item.projectId,
            title: item.title,
            currentVersionId: item.versionId,
            currentVersionNumber: item.versionNumber,
            latestVersionId: latest.id,
            latestVersionNumber: latest.versionNumber,
            latestVersionName: latest.name,
          });
        }
      } catch {
        // Ignore transient per-addon errors
      }
    }

    return updates;
  }

  /**
   * Resolves & installs a Modrinth `.mrpack` modpack archive into `targetDir` (downloads server-side
   * files from `modrinth.index.json` and copies `overrides/` + `server-overrides/`).
   * Returns the parsed `modrinth.index.json` metadata (MC version & loader version).
   */
  async installMrpackArchive(
    options: {
      projectIdOrSlug?: string;
      versionId?: string;
      packUrlOrPath?: string;
    },
    targetDir: string,
    onLog: (line: string) => void
  ): Promise<{ index: ModrinthIndexJson; resolvedVersionId: string | null }> {
    fs.mkdirSync(targetDir, { recursive: true });
    const stageDir = path.join(targetDir, `.mrpack-stage-${Date.now()}`);
    const archivePath = path.join(stageDir, 'pack.mrpack');
    fs.mkdirSync(stageDir, { recursive: true });

    let resolvedVersionId: string | null = options.versionId?.trim() || null;

    try {
      const explicitSource = options.packUrlOrPath?.trim() ?? '';
      if (explicitSource) {
        if (/^https?:\/\//i.test(explicitSource)) {
          onLog(`[Modrinth] Downloading .mrpack from ${explicitSource}...`);
          await this.downloadFile(explicitSource, archivePath);
        } else {
          const resolvedLocal = path.resolve(explicitSource);
          if (!fs.existsSync(resolvedLocal)) {
            throw new Error(`Local .mrpack file not found: ${resolvedLocal}`);
          }
          fs.copyFileSync(resolvedLocal, archivePath);
        }
      } else {
        const slug = options.projectIdOrSlug?.trim();
        if (!slug) {
          throw new Error(
            'No Modrinth modpack configured. Pick a pack from the Modrinth browser or provide MR_PROJECT_ID / MR_PACK_URL.'
          );
        }
        let ver: ModrinthVersionSummary | undefined;
        if (resolvedVersionId) {
          ver = await this.getVersionById(resolvedVersionId);
        } else {
          const versions = await this.getProjectVersions(slug);
          ver = versions[0];
        }
        if (!ver || !ver.primaryFile) {
          throw new Error(`No downloadable .mrpack version found on Modrinth for "${slug}".`);
        }
        resolvedVersionId = ver.id;
        onLog(`[Modrinth] Downloading ${ver.name} (${ver.primaryFile.filename})...`);
        await this.downloadFile(ver.primaryFile.url, archivePath);
      }

      const extractDir = path.join(stageDir, 'extracted');
      fs.mkdirSync(extractDir, { recursive: true });
      extractZipSafely(archivePath, extractDir);

      const indexPath = path.join(extractDir, 'modrinth.index.json');
      if (!fs.existsSync(indexPath)) {
        throw new Error('Invalid .mrpack archive: modrinth.index.json was not found.');
      }

      const index = JSON.parse(fs.readFileSync(indexPath, 'utf8')) as ModrinthIndexJson;
      const serverFiles = (index.files ?? []).filter((f) => f.env?.server !== 'unsupported');
      onLog(`[Modrinth] Downloading ${serverFiles.length} server mod/config file(s) from modrinth.index.json...`);

      for (let i = 0; i < serverFiles.length; i++) {
        const entry = serverFiles[i];
        const url = entry.downloads?.[0];
        if (!url || !entry.path) continue;
        const { absPath } = resolveSandboxedPath(targetDir, entry.path);
        await this.downloadFile(url, absPath);
        if ((i + 1) % 15 === 0 || i + 1 === serverFiles.length) {
          const pct = Math.round(((i + 1) / Math.max(serverFiles.length, 1)) * 100);
          onLog(`[Download] Modrinth pack files: ${i + 1}/${serverFiles.length} (${pct}%)`);
        }
      }

      for (const overrideFolder of ['overrides', 'server-overrides']) {
        const src = path.join(extractDir, overrideFolder);
        if (fs.existsSync(src) && fs.statSync(src).isDirectory()) {
          onLog(`[Modrinth] Applying ${overrideFolder}/...`);
          fs.cpSync(src, targetDir, { recursive: true, force: true });
        }
      }

      return { index, resolvedVersionId };
    } finally {
      fs.rmSync(stageDir, { recursive: true, force: true, maxRetries: 3, retryDelay: 150 });
    }
  }
}
