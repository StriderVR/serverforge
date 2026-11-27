import fs from 'node:fs';
import path from 'node:path';
import type {
  MinecraftCrashAnalysis,
  MinecraftCrashMissingDependency,
  MinecraftCrashSuspectedMod,
} from '@serverforge/shared';
import { parseRequiredJavaFromCrashLogs } from '../runtimes/java-helper.js';
import { redactSecrets } from './diagnostics-service.js';

export const DEFAULT_MAX_CRASH_LOG_BYTES = 64 * 1024;

export interface AnalyzeMinecraftCrashTextInput {
  crashReportText?: string;
  crashReportFile?: string | null;
  latestLogText?: string;
  consoleTail?: string[];
  extraSecrets?: string[];
}

export interface AnalyzeMinecraftCrashDirOptions {
  consoleTail?: string[];
  extraSecrets?: string[];
  maxBytes?: number;
}

/**
 * Reads at most `maxBytes` from the end of a file without loading the entire file into memory.
 */
export function readBoundedTail(filePath: string, maxBytes = DEFAULT_MAX_CRASH_LOG_BYTES): string {
  let fd: number | null = null;
  try {
    fd = fs.openSync(filePath, 'r');
    const stat = fs.fstatSync(fd);
    if (!stat.isFile() || stat.size === 0) return '';
    const bytesToRead = Math.min(stat.size, maxBytes);
    const startOffset = Math.max(0, stat.size - bytesToRead);
    const buf = Buffer.allocUnsafe(bytesToRead);
    const bytesRead = fs.readSync(fd, buf, 0, bytesToRead, startOffset);
    let text = buf.subarray(0, bytesRead).toString('utf8');
    // Drop partial leading line when truncated from the front
    if (startOffset > 0) {
      const nl = text.indexOf('\n');
      if (nl !== -1 && nl < 512) {
        text = text.slice(nl + 1);
      }
    }
    return text;
  } catch {
    return '';
  } finally {
    if (fd !== null) {
      try {
        fs.closeSync(fd);
      } catch {
        // ignore close failure
      }
    }
  }
}

/**
 * Reads a crash report with a bounded budget (header + tail if oversized so both the
 * exception summary at the top and stack/details at the bottom are preserved).
 */
export function readBoundedCrashReport(filePath: string, maxBytes = DEFAULT_MAX_CRASH_LOG_BYTES): string {
  let fd: number | null = null;
  try {
    fd = fs.openSync(filePath, 'r');
    const stat = fs.fstatSync(fd);
    if (!stat.isFile() || stat.size === 0) return '';
    if (stat.size <= maxBytes) {
      const buf = Buffer.allocUnsafe(stat.size);
      const n = fs.readSync(fd, buf, 0, stat.size, 0);
      return buf.subarray(0, n).toString('utf8');
    }
    const headSize = Math.floor(maxBytes * 0.75);
    const tailSize = maxBytes - headSize;
    const headBuf = Buffer.allocUnsafe(headSize);
    const tailBuf = Buffer.allocUnsafe(tailSize);
    const headRead = fs.readSync(fd, headBuf, 0, headSize, 0);
    const tailRead = fs.readSync(fd, tailBuf, 0, tailSize, Math.max(0, stat.size - tailSize));
    return `${headBuf.subarray(0, headRead).toString('utf8')}\n...\n${tailBuf.subarray(0, tailRead).toString('utf8')}`;
  } catch {
    return '';
  } finally {
    if (fd !== null) {
      try {
        fs.closeSync(fd);
      } catch {
        // ignore
      }
    }
  }
}

/**
 * Finds the most recently modified `crash-reports/*.txt` file in a Minecraft server directory.
 */
export function findNewestCrashReport(serverDir: string): { fullPath: string; relativePath: string } | null {
  const crashDir = path.join(serverDir, 'crash-reports');
  if (!fs.existsSync(crashDir)) return null;
  try {
    const entries = fs.readdirSync(crashDir, { withFileTypes: true });
    let best: { fullPath: string; relativePath: string; mtimeMs: number; name: string } | null = null;
    for (const entry of entries) {
      if (!entry.isFile() || !entry.name.toLowerCase().endsWith('.txt')) continue;
      const fullPath = path.join(crashDir, entry.name);
      try {
        const stat = fs.statSync(fullPath);
        if (
          !best ||
          stat.mtimeMs > best.mtimeMs ||
          (stat.mtimeMs === best.mtimeMs && entry.name > best.name)
        ) {
          best = {
            fullPath,
            relativePath: `crash-reports/${entry.name}`,
            mtimeMs: stat.mtimeMs,
            name: entry.name,
          };
        }
      } catch {
        // skip unreadable file
      }
    }
    return best ? { fullPath: best.fullPath, relativePath: best.relativePath } : null;
  } catch {
    return null;
  }
}

function addUniqueMod(
  list: MinecraftCrashSuspectedMod[],
  mod: MinecraftCrashSuspectedMod,
  preferExplicitModId = false
): void {
  const key = `${(mod.modId ?? '').toLowerCase()}|${(mod.jarFile ?? '').toLowerCase()}|${(mod.modName ?? '').toLowerCase()}`;
  if (key === '||') return;
  const existing = list.find(
    (m) =>
      (mod.modId && m.modId && m.modId.toLowerCase() === mod.modId.toLowerCase()) ||
      (mod.jarFile && m.jarFile && m.jarFile.toLowerCase() === mod.jarFile.toLowerCase()) ||
      (mod.modName && m.modName && m.modName.toLowerCase() === mod.modName.toLowerCase())
  );
  if (existing) {
    if (mod.modId && (!existing.modId || preferExplicitModId)) existing.modId = mod.modId;
    if (!existing.modName && mod.modName) existing.modName = mod.modName;
    if (!existing.jarFile && mod.jarFile) existing.jarFile = mod.jarFile;
    if (!existing.reason && mod.reason) existing.reason = mod.reason;
    return;
  }
  list.push(mod);
}

function addUniqueDep(list: MinecraftCrashMissingDependency[], dep: MinecraftCrashMissingDependency): void {
  const normalized = dep.modId.trim();
  if (!normalized) return;
  const existing = list.find((d) => d.modId.toLowerCase() === normalized.toLowerCase());
  if (existing) {
    if (!existing.requiredBy && dep.requiredBy) existing.requiredBy = dep.requiredBy;
    if (!existing.versionRange && dep.versionRange) existing.versionRange = dep.versionRange;
    return;
  }
  list.push({
    modId: normalized,
    ...(dep.requiredBy ? { requiredBy: dep.requiredBy.trim() } : {}),
    ...(dep.versionRange ? { versionRange: dep.versionRange.trim() } : {}),
  });
}

function inferModIdFromJar(jarFile: string): string | undefined {
  const base = path.basename(jarFile).replace(/\.jar(?:\.disabled)?$/i, '');
  const match = base.match(
    /^([a-zA-Z][a-zA-Z0-9_-]{1,32}?)(?:[-_](?:mc|forge|neoforge|fabric|quilt|bukkit|spigot|paper|v)(?:[-_.\d]|$)|[-_]\d|$)/i
  );
  return match?.[1]?.toLowerCase() || (base.length <= 32 ? base.toLowerCase() : undefined);
}

function extractModAndPluginMentions(text: string): {
  suspectedMods: MinecraftCrashSuspectedMod[];
  suspectedPlugins: MinecraftCrashSuspectedMod[];
} {
  const suspectedMods: MinecraftCrashSuspectedMod[] = [];
  const suspectedPlugins: MinecraftCrashSuspectedMod[] = [];

  // Forge / NeoForge: "Mod File: foo-1.20.1.jar"
  for (const match of text.matchAll(/Mod File:\s*([^\s\r\n]+\.jar)/gi)) {
    const jarFile = path.basename(match[1].trim());
    addUniqueMod(suspectedMods, {
      jarFile,
      modId: inferModIdFromJar(jarFile),
    });
  }

  // Forge / NeoForge ModLoadingException: "ModLoadingException: Create (create) encountered an error"
  for (const match of text.matchAll(
    /ModLoadingException:\s*([A-Za-z0-9 _.'-]{2,50}?)\s*\(([a-z0-9_.-]+)\)\s*encountered/gi
  )) {
    addUniqueMod(
      suspectedMods,
      {
        modName: match[1].trim(),
        modId: match[2].trim(),
      },
      true
    );
  }

  // InvalidDistException: "in mod sodium (sodium-neoforge-0.6.0.jar)"
  for (const match of text.matchAll(/in mod\s+([a-z0-9_.-]+)\s*\(([^)\s]+\.jar)\)/gi)) {
    addUniqueMod(
      suspectedMods,
      {
        modId: match[1].trim(),
        jarFile: path.basename(match[2].trim()),
      },
      true
    );
  }

  // Mixin errors: "Mixin apply for mod <modid> failed" or "from mod <modid>"
  for (const match of text.matchAll(/(?:Mixin apply for mod|from mod)\s+([a-z0-9_.-]+)/gi)) {
    addUniqueMod(suspectedMods, { modId: match[1].trim() });
  }

  // Paper / Spigot / Bukkit plugin load & enable errors
  for (const match of text.matchAll(/Error occurred while enabling\s+([A-Za-z0-9_.-]+)(?:\s+v([^\s(]+))?/gi)) {
    addUniqueMod(suspectedPlugins, {
      modName: match[1].trim(),
      modId: match[1].trim().toLowerCase(),
      reason: match[2] ? `Failed while enabling v${match[2]}` : 'Failed while enabling plugin',
    });
  }

  for (const match of text.matchAll(/Could not load 'plugins\/([^']+\.jar)'/gi)) {
    const jarFile = path.basename(match[1].trim());
    addUniqueMod(suspectedPlugins, {
      jarFile,
      modName: jarFile.replace(/\.jar$/i, ''),
      modId: inferModIdFromJar(jarFile),
      reason: 'Plugin failed to load',
    });
  }

  return { suspectedMods, suspectedPlugins };
}

function pickEvidenceLines(lines: string[], patterns: RegExp[], maxLines = 6): string[] {
  const picked: string[] = [];
  const seen = new Set<string>();
  for (const raw of lines) {
    const line = raw.trim();
    if (!line) continue;
    if (patterns.some((re) => re.test(line))) {
      const clipped = line.length > 260 ? `${line.slice(0, 257)}...` : line;
      if (!seen.has(clipped)) {
        seen.add(clipped);
        picked.push(clipped);
        if (picked.length >= maxLines) break;
      }
    }
  }
  return picked;
}

function analyzeSingleSource(text: string, crashReportFile: string | null): MinecraftCrashAnalysis | null {
  if (!text.trim()) return null;
  const lines = text.split(/\r?\n/);

  // 1. Java version mismatch
  const requiredJavaMajor = parseRequiredJavaFromCrashLogs(lines);
  if (
    requiredJavaMajor !== null ||
    /UnsupportedClassVersionError|class file version \d+\.\d+/i.test(text)
  ) {
    const evidenceLines = pickEvidenceLines(lines, [
      /UnsupportedClassVersionError/i,
      /class file version/i,
      /Failed to start the minecraft server/i,
    ]);
    const javaLabel = requiredJavaMajor ? `Java ${requiredJavaMajor}` : 'a newer Java runtime';
    return {
      category: 'java_version_mismatch',
      headline: requiredJavaMajor
        ? `Java ${requiredJavaMajor} required by server/mods`
        : 'Incompatible Java runtime version',
      summary: `The server or one of its mods was compiled for ${javaLabel}, which is newer than the Java runtime currently configured for this instance.`,
      recommendedFix: requiredJavaMajor
        ? `Switch this instance to Java ${requiredJavaMajor} (JAVA_IMAGE_TAG=java${requiredJavaMajor}) in Config or the Version & Updates tab, then start the server again.`
        : 'Upgrade the configured Java runtime for this instance and restart.',
      suspectedMods: [],
      missingDependencies: [],
      requiredJavaMajor: requiredJavaMajor ?? null,
      crashReportFile,
      evidenceLines,
    };
  }

  const { suspectedMods, suspectedPlugins } = extractModAndPluginMentions(text);

  // 2. Client-only mod loaded on dedicated server
  const isClientOnly =
    /InvalidDistException|RuntimeDistCleaner|Attempted to load class net\/minecraft\/client|NoClassDefFoundError:\s*net\/minecraft\/client|invalid dist DEDICATED_SERVER|for dist DEDICATED_SERVER|environment:\s*client/i.test(
      text
    );
  if (isClientOnly) {
    const culpritList = suspectedMods.map((m) => ({
      ...m,
      reason: m.reason ?? 'Attempted to load Minecraft client-only class on dedicated server',
    }));
    const culpritLabel =
      culpritList[0]?.jarFile ?? culpritList[0]?.modName ?? culpritList[0]?.modId ?? 'a client-only mod';
    const evidenceLines = pickEvidenceLines(lines, [
      /InvalidDistException/i,
      /net\/minecraft\/client/i,
      /DEDICATED_SERVER/i,
      /Mod File:/i,
      /EarlyLoadingException/i,
    ]);
    return {
      category: 'client_only_mod',
      headline: `Client-only mod crashed dedicated server (${culpritLabel})`,
      summary: `${culpritLabel} tried to load Minecraft client rendering/UI classes (net.minecraft.client) on a headless dedicated server.`,
      recommendedFix: `Remove or disable ${culpritLabel} in the server's Mods tab (client-only mods like shaders/HUDs should stay on players' PCs only, not the server).`,
      suspectedMods: culpritList,
      missingDependencies: [],
      requiredJavaMajor: null,
      crashReportFile,
      evidenceLines,
    };
  }

  // 3. Missing dependencies (Forge / NeoForge / Fabric / Paper-Spigot)
  const missingDependencies: MinecraftCrashMissingDependency[] = [];

  // Forge / NeoForge: "Mod create requires flywheel 0.6.10 or above" + "Currently, flywheel is not installed"
  for (const match of text.matchAll(
    /Mod\s+([a-zA-Z0-9_.-]+)\s+requires\s+([a-zA-Z0-9_.-]+)(?:\s+([^\r\n]+))?/gi
  )) {
    const requiredBy = match[1].trim();
    const depId = match[2].trim();
    const versionRange = match[3]?.trim();
    if (depId.toLowerCase() === 'minecraft' || depId.toLowerCase() === 'java') continue;
    addUniqueDep(missingDependencies, { modId: depId, requiredBy, versionRange });
    addUniqueMod(suspectedMods, { modId: requiredBy, reason: `Requires missing dependency '${depId}'` });
  }
  for (const match of text.matchAll(/Currently,\s+([a-zA-Z0-9_.-]+)\s+is not installed/gi)) {
    addUniqueDep(missingDependencies, { modId: match[1].trim() });
  }

  // Fabric: "Mod 'Lithium' (lithium) 0.14.2 requires any version of fabric-api, which is missing!"
  for (const match of text.matchAll(
    /Mod\s+'([^']+)'\s+\(([^)]+)\)\s+[^\r\n]*?requires\s+(.+?)\s+of\s+([a-zA-Z0-9_.-]+),\s*which is missing/gi
  )) {
    const modName = match[1].trim();
    const modId = match[2].trim();
    const versionRange = match[3].trim();
    const depId = match[4].trim();
    addUniqueDep(missingDependencies, { modId: depId, requiredBy: modId, versionRange });
    addUniqueMod(suspectedMods, {
      modId,
      modName,
      reason: `Requires missing dependency '${depId}'`,
    });
  }
  // Fabric solution line: "- Install fabric-api, any version."
  for (const match of text.matchAll(/-\s+Install\s+([a-zA-Z0-9_.-]+)(?:,\s*([^.\r\n]+))?/gi)) {
    addUniqueDep(missingDependencies, { modId: match[1].trim(), versionRange: match[2]?.trim() });
  }

  // Paper / Spigot / Bukkit: "UnknownDependencyException: Unknown/missing dependency plugins: [Vault]. Please download and install these plugins to run 'BrokenPlugin'."
  for (const match of text.matchAll(
    /UnknownDependencyException:\s*Unknown\/missing dependency plugins:\s*\[([^\]]+)\](?:[^\r\n]*?to run\s+'([^']+)')?/gi
  )) {
    const requiredBy = match[2]?.trim();
    const deps = match[1]
      .split(',')
      .map((d) => d.trim())
      .filter(Boolean);
    for (const depId of deps) {
      addUniqueDep(missingDependencies, { modId: depId, requiredBy });
    }
    if (requiredBy) {
      addUniqueMod(suspectedPlugins, {
        modName: requiredBy,
        modId: requiredBy.toLowerCase(),
        reason: `Missing required plugin dependency: ${deps.join(', ')}`,
      });
    }
  }

  if (missingDependencies.length > 0) {
    const combinedSuspects = [...suspectedMods];
    for (const p of suspectedPlugins) addUniqueMod(combinedSuspects, p);
    const depNames = missingDependencies.map((d) => d.modId).join(', ');
    const isPluginContext = suspectedPlugins.length > 0 && suspectedMods.length === 0;
    const evidenceLines = pickEvidenceLines(lines, [
      /requires/i,
      /is not installed/i,
      /which is missing/i,
      /Install\s+[a-z0-9_.-]+/i,
      /UnknownDependencyException/i,
      /Could not load 'plugins\//i,
      /Mod File:/i,
    ]);
    return {
      category: 'missing_dependency',
      headline: `Missing required ${isPluginContext ? 'plugin' : 'mod'} ${missingDependencies.length === 1 ? 'dependency' : 'dependencies'}: ${depNames}`,
      summary: `One or more ${isPluginContext ? 'plugins' : 'mods'} could not load because required ${missingDependencies.length === 1 ? 'dependency' : 'dependencies'} (${depNames}) ${missingDependencies.length === 1 ? 'is' : 'are'} missing.`,
      recommendedFix: isPluginContext
        ? `Install the missing plugin(s) (${depNames}) from the Plugins & Datapacks tab, or disable the plugin that requires them.`
        : `Install the missing dependency mod(s) (${depNames}) matching your Minecraft version & loader in the Mods tab, or disable the mod that requires them.`,
      suspectedMods: combinedSuspects,
      missingDependencies,
      requiredJavaMajor: null,
      crashReportFile,
      evidenceLines,
    };
  }

  // 4. Out of memory
  if (/java\.lang\.OutOfMemoryError|Java heap space|GC overhead limit exceeded|Metaspace/i.test(text)) {
    const evidenceLines = pickEvidenceLines(lines, [
      /OutOfMemoryError/i,
      /Java heap space/i,
      /GC overhead limit/i,
      /Metaspace/i,
    ]);
    return {
      category: 'out_of_memory',
      headline: 'Server ran out of memory (OutOfMemoryError)',
      summary: 'The Minecraft JVM exhausted its allocated RAM heap while loading chunks, mods, or entities.',
      recommendedFix:
        'Increase the RAM Limit in the Config tab (e.g., +2 GB), or reduce view-distance / simulation-distance in server.properties.',
      suspectedMods,
      missingDependencies: [],
      requiredJavaMajor: null,
      crashReportFile,
      evidenceLines,
    };
  }

  // 5. Port already in use
  if (/FAILED TO BIND TO PORT|BindException:\s*Address already in use|Address already in use:\s*bind/i.test(text)) {
    const evidenceLines = pickEvidenceLines(lines, [
      /FAILED TO BIND TO PORT/i,
      /BindException/i,
      /Address already in use/i,
    ]);
    return {
      category: 'port_in_use',
      headline: 'Server port is already in use',
      summary: 'Another running server or process is already listening on the configured Minecraft game or RCON port.',
      recommendedFix:
        'Stop the other server using this port, or assign a different port in the Config tab and restart.',
      suspectedMods: [],
      missingDependencies: [],
      requiredJavaMajor: null,
      crashReportFile,
      evidenceLines,
    };
  }

  // 6. Paper / Spigot / Bukkit plugin crash
  if (
    suspectedPlugins.length > 0 ||
    /org\.bukkit\.plugin\.InvalidPluginException|Error occurred while enabling /i.test(text)
  ) {
    const pluginLabel =
      suspectedPlugins[0]?.modName ?? suspectedPlugins[0]?.jarFile ?? 'a server plugin';
    const evidenceLines = pickEvidenceLines(lines, [
      /Error occurred while enabling/i,
      /Could not load 'plugins\//i,
      /InvalidPluginException/i,
      /NoClassDefFoundError/i,
      /Exception|Error/i,
    ]);
    return {
      category: 'plugin_error',
      headline: `Plugin error in ${pluginLabel}`,
      summary: `${pluginLabel} threw an unhandled error while loading or enabling on the server.`,
      recommendedFix: `Update ${pluginLabel} to a version compatible with your Paper/Spigot build, or disable it in the Plugins tab to isolate the crash.`,
      suspectedMods: suspectedPlugins,
      missingDependencies: [],
      requiredJavaMajor: null,
      crashReportFile,
      evidenceLines,
    };
  }

  // 7. Generic mod error
  if (
    suspectedMods.length > 0 ||
    /ModLoadingException|MixinApplyError|Incompatible mods found/i.test(text)
  ) {
    const modLabel =
      suspectedMods[0]?.modName ?? suspectedMods[0]?.jarFile ?? suspectedMods[0]?.modId ?? 'a mod';
    const evidenceLines = pickEvidenceLines(lines, [
      /ModLoadingException/i,
      /MixinApplyError/i,
      /Mod File:/i,
      /Incompatible mods found/i,
      /Caused by:/i,
    ]);
    return {
      category: 'mod_error',
      headline: `Mod loading or runtime error (${modLabel})`,
      summary: `A mod (${modLabel}) encountered an error during server startup or runtime.`,
      recommendedFix: `Update or temporarily disable ${modLabel} in the Mods tab, then restart to confirm the server boots cleanly.`,
      suspectedMods,
      missingDependencies: [],
      requiredJavaMajor: null,
      crashReportFile,
      evidenceLines,
    };
  }

  // 8. Unknown crash (only if crash report or clear error signal exists)
  const hasErrorSignal =
    Boolean(crashReportFile) ||
    /---- Minecraft Crash Report ----|Encountered an unexpected exception|\bFATAL\b|Exception:|Error:/i.test(text);
  if (!hasErrorSignal) return null;

  const evidenceLines = pickEvidenceLines(lines, [
    /Description:/i,
    /Caused by:/i,
    /Exception|Error|\bFATAL\b/i,
  ]);
  return {
    category: 'unknown',
    headline: 'Unexpected Minecraft server crash',
    summary: 'The server crashed, but no single culprit mod or known error pattern could be conclusively matched.',
    recommendedFix:
      'Review the Crash Tail and newest crash-reports/*.txt file, or copy the Debug Report to inspect the full stack trace.',
    suspectedMods: [],
    missingDependencies: [],
    requiredJavaMajor: null,
    crashReportFile,
    evidenceLines,
  };
}

export function redactCrashAnalysis(
  analysis: MinecraftCrashAnalysis,
  extraSecrets: string[] = []
): MinecraftCrashAnalysis {
  const clean = (s: string): string => redactSecrets(s, extraSecrets);
  return {
    ...analysis,
    headline: clean(analysis.headline),
    summary: clean(analysis.summary),
    recommendedFix: clean(analysis.recommendedFix),
    crashReportFile: analysis.crashReportFile ? clean(analysis.crashReportFile) : null,
    suspectedMods: analysis.suspectedMods.map((m) => ({
      ...(m.modId ? { modId: clean(m.modId) } : {}),
      ...(m.modName ? { modName: clean(m.modName) } : {}),
      ...(m.jarFile ? { jarFile: clean(m.jarFile) } : {}),
      ...(m.reason ? { reason: clean(m.reason) } : {}),
    })),
    missingDependencies: analysis.missingDependencies.map((d) => ({
      modId: clean(d.modId),
      ...(d.requiredBy ? { requiredBy: clean(d.requiredBy) } : {}),
      ...(d.versionRange ? { versionRange: clean(d.versionRange) } : {}),
    })),
    evidenceLines: analysis.evidenceLines.map(clean),
  };
}

/**
 * Pure text analyzer: prioritizes dedicated crash report text first, then logs/latest.log,
 * then console tail. Always redacts known secrets and sensitive tokens from outputs.
 */
export function analyzeMinecraftCrashText(
  input: AnalyzeMinecraftCrashTextInput
): MinecraftCrashAnalysis | null {
  const extraSecrets = input.extraSecrets ?? [];
  const crashReportFile = input.crashReportFile ?? null;

  // 1. Dedicated crash report is highest-signal when present
  if (input.crashReportText && input.crashReportText.trim()) {
    const fromReport = analyzeSingleSource(input.crashReportText, crashReportFile);
    if (fromReport && fromReport.category !== 'unknown') {
      return redactCrashAnalysis(fromReport, extraSecrets);
    }
    // If crash report was inconclusive, check latest.log + console tail too
    const fallbackText = [input.latestLogText ?? '', (input.consoleTail ?? []).join('\n')].filter(Boolean).join('\n');
    const fromFallback = analyzeSingleSource(fallbackText, crashReportFile);
    if (fromFallback && fromFallback.category !== 'unknown') {
      return redactCrashAnalysis(fromFallback, extraSecrets);
    }
    if (fromReport) {
      return redactCrashAnalysis(fromReport, extraSecrets);
    }
  }

  // 2. logs/latest.log
  if (input.latestLogText && input.latestLogText.trim()) {
    const fromLatest = analyzeSingleSource(input.latestLogText, crashReportFile);
    if (fromLatest && fromLatest.category !== 'unknown') {
      return redactCrashAnalysis(fromLatest, extraSecrets);
    }
    if (input.consoleTail && input.consoleTail.length > 0) {
      const fromConsole = analyzeSingleSource(input.consoleTail.join('\n'), crashReportFile);
      if (fromConsole && fromConsole.category !== 'unknown') {
        return redactCrashAnalysis(fromConsole, extraSecrets);
      }
    }
    if (fromLatest) {
      return redactCrashAnalysis(fromLatest, extraSecrets);
    }
  }

  // 3. Console tail alone
  if (input.consoleTail && input.consoleTail.length > 0) {
    const fromConsole = analyzeSingleSource(input.consoleTail.join('\n'), crashReportFile);
    if (fromConsole) {
      return redactCrashAnalysis(fromConsole, extraSecrets);
    }
  }

  return null;
}

/**
 * Inspects a Minecraft server directory for the newest `crash-reports/*.txt`, bounded tail
 * (<= 64 KB) of `logs/latest.log`, and optional console tail to diagnose crashes safely.
 */
export function analyzeMinecraftCrashDir(
  serverDir: string,
  options: AnalyzeMinecraftCrashDirOptions = {}
): MinecraftCrashAnalysis | null {
  const maxBytes = options.maxBytes ?? DEFAULT_MAX_CRASH_LOG_BYTES;
  const newestReport = findNewestCrashReport(serverDir);
  const crashReportText = newestReport ? readBoundedCrashReport(newestReport.fullPath, maxBytes) : '';
  const latestLogPath = path.join(serverDir, 'logs', 'latest.log');
  const latestLogText = fs.existsSync(latestLogPath) ? readBoundedTail(latestLogPath, maxBytes) : '';

  return analyzeMinecraftCrashText({
    crashReportText,
    crashReportFile: newestReport?.relativePath ?? null,
    latestLogText,
    consoleTail: options.consoleTail,
    extraSecrets: options.extraSecrets,
  });
}
