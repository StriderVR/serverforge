import { execFile, spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';

export interface DetectedJava {
  javaBin: string;
  javaHome: string;
  major: number;
  source: 'managed' | 'system';
}

export interface EnsureJavaOptions {
  fetchImpl?: typeof fetch;
  platform?: NodeJS.Platform;
  arch?: string;
  installedJavas?: DetectedJava[];
}

/**
 * Parses the Java major version number from `java -version` output.
 * Handles legacy Java 8 ("1.8.0_412" -> 8) and modern JDKs ("17.0.12" -> 17, "21.0.5" -> 21).
 */
export function parseJavaMajorVersion(versionOutput: string): number | null {
  const quoted = versionOutput.match(/version\s+"(\d+)(?:\.(\d+))?/i);
  if (quoted) {
    const first = Number.parseInt(quoted[1], 10);
    const second = quoted[2] ? Number.parseInt(quoted[2], 10) : 0;
    if (first === 1 && second > 0) return second;
    if (Number.isFinite(first) && first > 0) return first;
  }
  const bare = versionOutput.match(/(?:openjdk|java)\s+(\d+)(?:\.(\d+))?/i);
  if (bare) {
    const first = Number.parseInt(bare[1], 10);
    const second = bare[2] ? Number.parseInt(bare[2], 10) : 0;
    if (first === 1 && second > 0) return second;
    if (Number.isFinite(first) && first > 0) return first;
  }
  return null;
}

/**
 * Maps a ServerForge Java image tag ("java8", "java17", "java21", "latest") to a major Java version.
 */
export function javaTagToMajor(tag: string | undefined): number {
  const normalized = (tag ?? '').trim().toLowerCase();
  if (normalized === 'java8' || normalized === '8') return 8;
  if (normalized === 'java17' || normalized === '17') return 17;
  return 21;
}

/**
 * Recommends the required Java major version for a Minecraft version string (e.g., "1.21.4", "1.20.1", "LATEST").
 */
export function recommendJavaMajorForMcVersion(mcVersion: string | undefined): number {
  const trimmed = (mcVersion ?? '').trim();
  if (!trimmed || trimmed.toUpperCase() === 'LATEST') return 21;
  const m = trimmed.match(/^1\.(\d+)(?:\.(\d+))?/);
  if (!m) return 21;
  const minor = Number.parseInt(m[1], 10);
  const patch = m[2] ? Number.parseInt(m[2], 10) : 0;
  if (minor > 20 || (minor === 20 && patch >= 5)) return 21;
  if (minor >= 17) return 17;
  return 8;
}

export function buildAdoptiumJreUrl(
  major: number,
  platform: NodeJS.Platform = process.platform,
  arch: string = process.arch
): string {
  const osName = platform === 'win32' ? 'windows' : platform === 'darwin' ? 'mac' : 'linux';
  const archName = arch === 'arm64' ? 'aarch64' : 'x64';
  return `https://api.adoptium.net/v3/binary/latest/${major}/ga/${osName}/${archName}/jre/hotspot/normal/eclipse`;
}

export function findJavaExecutableInDir(
  rootDir: string,
  platform: NodeJS.Platform = process.platform
): { javaBin: string; javaHome: string } | null {
  if (!fs.existsSync(rootDir)) return null;
  const binName = platform === 'win32' ? 'java.exe' : 'java';

  const direct = path.join(rootDir, 'bin', binName);
  if (fs.existsSync(direct)) {
    return { javaBin: direct, javaHome: rootDir };
  }

  let entries: fs.Dirent[] = [];
  try {
    entries = fs.readdirSync(rootDir, { withFileTypes: true });
  } catch {
    return null;
  }

  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const subDir = path.join(rootDir, entry.name);
    const candidate = path.join(subDir, 'bin', binName);
    if (fs.existsSync(candidate)) {
      return { javaBin: candidate, javaHome: subDir };
    }
    const macCandidate = path.join(subDir, 'Contents', 'Home', 'bin', binName);
    if (fs.existsSync(macCandidate)) {
      return { javaBin: macCandidate, javaHome: path.join(subDir, 'Contents', 'Home') };
    }
  }

  return null;
}

export async function probeJavaVersion(javaBin: string): Promise<number | null> {
  return new Promise((resolve) => {
    execFile(javaBin, ['-version'], { timeout: 5000, windowsHide: true }, (err, stdout, stderr) => {
      if (err) return resolve(null);
      const combined = `${stderr || ''}\n${stdout || ''}`;
      resolve(parseJavaMajorVersion(combined));
    });
  });
}

export async function detectInstalledJavas(
  toolsDir: string,
  platform: NodeJS.Platform = process.platform
): Promise<DetectedJava[]> {
  const binName = platform === 'win32' ? 'java.exe' : 'java';
  const candidates: Array<{ javaBin: string; javaHome: string; source: 'managed' | 'system' }> = [];
  const seenBins = new Set<string>();

  const addCandidate = (javaBin: string, javaHome: string, source: 'managed' | 'system') => {
    const key = platform === 'win32' ? javaBin.toLowerCase() : javaBin;
    if (seenBins.has(key)) return;
    seenBins.add(key);
    candidates.push({ javaBin, javaHome, source });
  };

  // 1. ServerForge-managed portable JREs in data/tools/java/
  const managedRoot = path.join(toolsDir, 'java');
  if (fs.existsSync(managedRoot)) {
    try {
      for (const entry of fs.readdirSync(managedRoot, { withFileTypes: true })) {
        if (!entry.isDirectory()) continue;
        const found = findJavaExecutableInDir(path.join(managedRoot, entry.name), platform);
        if (found) addCandidate(found.javaBin, found.javaHome, 'managed');
      }
    } catch {
      // ignore unreadable tools dir
    }
  }

  // 2. JAVA_HOME
  if (process.env.JAVA_HOME) {
    const found = findJavaExecutableInDir(process.env.JAVA_HOME, platform);
    if (found) addCandidate(found.javaBin, found.javaHome, 'system');
  }

  // 3. System default PATH `java`
  addCandidate(binName, '', 'system');

  // 4. Standard OS JDK/JRE install roots
  const scanRoots =
    platform === 'win32'
      ? [
          'C:\\Program Files\\Eclipse Adoptium',
          'C:\\Program Files\\Java',
          'C:\\Program Files\\Microsoft',
          'C:\\Program Files\\Zulu',
          'C:\\Program Files\\BellSoft',
          'C:\\Program Files\\Amazon Corretto',
        ]
      : ['/usr/lib/jvm', '/Library/Java/JavaVirtualMachines'];

  for (const root of scanRoots) {
    if (!fs.existsSync(root)) continue;
    try {
      for (const entry of fs.readdirSync(root, { withFileTypes: true })) {
        if (!entry.isDirectory()) continue;
        const found = findJavaExecutableInDir(path.join(root, entry.name), platform);
        if (found) addCandidate(found.javaBin, found.javaHome, 'system');
      }
    } catch {
      // ignore permission errors
    }
  }

  const detected: DetectedJava[] = [];
  for (const c of candidates) {
    const major = await probeJavaVersion(c.javaBin);
    if (major !== null) {
      detected.push({
        javaBin: c.javaBin,
        javaHome: c.javaHome,
        major,
        source: c.source,
      });
    }
  }
  return detected;
}

async function extractArchive(
  archivePath: string,
  destDir: string,
  platform: NodeJS.Platform
): Promise<void> {
  fs.mkdirSync(destDir, { recursive: true });
  await new Promise<void>((resolve, reject) => {
    const proc =
      platform === 'win32'
        ? spawn(
            'powershell.exe',
            [
              '-NoProfile',
              '-Command',
              `Expand-Archive -Path '${archivePath.replace(/'/g, "''")}' -DestinationPath '${destDir.replace(/'/g, "''")}' -Force`,
            ],
            { windowsHide: true }
          )
        : archivePath.endsWith('.zip')
          ? spawn('unzip', ['-o', archivePath, '-d', destDir])
          : spawn('tar', ['-xzf', archivePath, '-C', destDir]);

    let errOut = '';
    proc.stderr?.on('data', (d: Buffer) => {
      errOut += d.toString('utf8');
    });
    proc.on('error', (err) => reject(err));
    proc.on('close', (code) => {
      if (code === 0) resolve();
      else reject(new Error(`Archive extraction failed (code ${code})${errOut ? `: ${errOut.slice(0, 200)}` : ''}`));
    });
  });
}

/**
 * Ensures a Java runtime matching `requiredMajor` (8, 17, or 21) is available.
 * If missing, automatically downloads a portable Eclipse Temurin (Adoptium) JRE into `toolsDir/java/jre-<major>`.
 */
export async function ensureJavaRuntime(
  requiredMajor: number,
  toolsDir: string,
  onLog: (line: string) => void,
  options: EnsureJavaOptions = {}
): Promise<DetectedJava> {
  const platform = options.platform ?? process.platform;
  const arch = options.arch ?? process.arch;
  const fetchImpl = options.fetchImpl ?? fetch;

  // Check if already installed (managed or system)
  const installed = options.installedJavas ?? (await detectInstalledJavas(toolsDir, platform));
  const exactMatch =
    installed.find((j) => j.major === requiredMajor && j.source === 'managed') ??
    installed.find((j) => j.major === requiredMajor);

  if (exactMatch) {
    onLog(
      `[Java] Using ${exactMatch.source === 'managed' ? 'ServerForge portable' : 'system'} Java ${exactMatch.major} (${exactMatch.javaBin}).`
    );
    return exactMatch;
  }

  // Auto-provision portable Eclipse Temurin JRE into toolsDir/java/jre-<major>
  const targetDir = path.join(toolsDir, 'java', `jre-${requiredMajor}`);
  fs.mkdirSync(targetDir, { recursive: true });

  const url = buildAdoptiumJreUrl(requiredMajor, platform, arch);
  const ext = platform === 'win32' ? '.zip' : '.tar.gz';
  const archivePath = path.join(targetDir, `temurin-jre-${requiredMajor}${ext}`);

  onLog(
    `[Java] Java ${requiredMajor} was not found on this machine. Auto-downloading portable Eclipse Temurin Java ${requiredMajor} JRE...`
  );

  const res = await fetchImpl(url, {
    headers: { 'User-Agent': 'ServerForge/1.1.6 (+https://github.com/StriderVR/serverforge)' },
    redirect: 'follow',
    signal: AbortSignal.timeout(300_000),
  });

  if (!res.ok) {
    throw new Error(
      `Failed to auto-download Java ${requiredMajor} from Adoptium (HTTP ${res.status}). Install Eclipse Temurin Java ${requiredMajor} manually from https://adoptium.net/.`
    );
  }

  if (res.body) {
    const totalBytes = Number(res.headers.get('content-length') || 0);
    let downloaded = 0;
    let lastLoggedPct = 0;

    const webReader = res.body.getReader();
    const nodeStream = new Readable({
      async read() {
        try {
          const { done, value } = await webReader.read();
          if (done) {
            this.push(null);
            return;
          }
          downloaded += value.byteLength;
          if (totalBytes > 0) {
            const pct = Math.floor((downloaded / totalBytes) * 100);
            if (pct >= lastLoggedPct + 25) {
              lastLoggedPct = pct;
              onLog(`[Java] Downloading Java ${requiredMajor} JRE... ${pct}%`);
            }
          }
          this.push(Buffer.from(value));
        } catch (err) {
          this.destroy(err instanceof Error ? err : new Error(String(err)));
        }
      },
    });
    await pipeline(nodeStream, fs.createWriteStream(archivePath));
  } else {
    const buf = Buffer.from(await res.arrayBuffer());
    fs.writeFileSync(archivePath, buf);
  }

  onLog(`[Java] Extracting portable Java ${requiredMajor} JRE...`);
  await extractArchive(archivePath, targetDir, platform);
  fs.rmSync(archivePath, { force: true });

  const found = findJavaExecutableInDir(targetDir, platform);
  if (!found) {
    throw new Error(
      `Portable Java ${requiredMajor} archive extracted, but no java executable was found under ${targetDir}.`
    );
  }

  if (platform !== 'win32') {
    try {
      fs.chmodSync(found.javaBin, 0o755);
    } catch {
      // ignore chmod errors
    }
  }

  onLog(`[Java] Portable Java ${requiredMajor} JRE installed at ${found.javaHome}.`);
  return {
    javaBin: found.javaBin,
    javaHome: found.javaHome,
    major: requiredMajor,
    source: 'managed',
  };
}

/**
 * Returns a copy of `baseEnv` with JAVA_HOME and PATH updated so both direct `java`
 * invocations and modpack .bat/.ps1/.sh scripts resolve the selected Java runtime first.
 */
export function buildJavaEnv(
  baseEnv: NodeJS.ProcessEnv,
  java: DetectedJava,
  platform: NodeJS.Platform = process.platform
): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...baseEnv };
  if (!java.javaHome) return env;

  env.JAVA_HOME = java.javaHome;
  const pathLib = platform === 'win32' ? path.win32 : path.posix;
  const binDir = pathLib.dirname(java.javaBin);
  const sep = platform === 'win32' ? ';' : ':';

  // On Windows, process.env frequently stores PATH as `Path`
  const pathKey =
    platform === 'win32'
      ? (Object.keys(env).find((k) => k.toLowerCase() === 'path') ?? 'Path')
      : 'PATH';

  const existingPath = env[pathKey] ?? '';
  env[pathKey] = existingPath ? `${binDir}${sep}${existingPath}` : binDir;
  return env;
}
