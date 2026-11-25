import { execFile } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import archiver from 'archiver';
import { afterEach, describe, expect, it } from 'vitest';
import type { GameTemplate, ServerInstance } from '@serverforge/shared';
import { QueryService } from '../query/query-service.js';
import {
  buildJavaEnv,
  ensureJavaRuntime,
  javaTagToMajor,
  parseJavaMajorVersion,
  recommendJavaMajorForMcVersion,
} from '../runtimes/java-helper.js';
import {
  createPauseSafeBatchWrapper,
  findForgeOrNeoForgeInstallerJar,
  findNativeMinecraftLauncher,
  flattenSingleRootSubdir,
  NativeProcessRuntimeAdapter,
} from '../runtimes/native-runtime.js';
import { CurseForgeService } from '../services/curseforge-service.js';

async function createZipBuffer(files: Record<string, string>): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    const archive = archiver('zip', { zlib: { level: 6 } });
    archive.on('data', (chunk: Buffer) => chunks.push(chunk));
    archive.on('end', () => resolve(Buffer.concat(chunks)));
    archive.on('error', reject);
    for (const [name, content] of Object.entries(files)) {
      archive.append(content, { name });
    }
    void archive.finalize();
  });
}

async function createTarGzBuffer(dirToPack: string): Promise<Buffer> {
  const outTar = path.join(os.tmpdir(), `sf-jre-test-${Date.now()}-${Math.random().toString(16).slice(2)}.tar.gz`);
  await new Promise<void>((resolve, reject) => {
    execFile('tar', ['-czf', outTar, '-C', path.dirname(dirToPack), path.basename(dirToPack)], (err) => {
      if (err) reject(err);
      else resolve();
    });
  });
  const buf = fs.readFileSync(outTar);
  fs.rmSync(outTar, { force: true });
  return buf;
}

function makeInstance(overrides: Partial<ServerInstance> = {}): ServerInstance {
  const now = new Date().toISOString();
  return {
    id: 'inst-1',
    slug: 'atm10-native',
    name: 'ATM10 Native',
    gameId: 'minecraft-curseforge',
    runtime: 'native',
    status: 'stopped',
    ports: { game: 25565, rcon: 25575 },
    config: {
      CF_SLUG: 'all-the-mods-10',
      CF_FILE_ID: '',
      CF_PAGE_URL: '',
      SERVER_PACK_ZIP: '',
      JAVA_IMAGE_TAG: 'java21',
      MOTD: 'ATM10 Native Test',
      MAX_PLAYERS: 12,
      RCON_PASSWORD: 'test-rcon-password',
      ONLINE_MODE: true,
    },
    memoryLimitMb: 8192,
    autoStart: false,
    discordEnabled: true,
    containerId: null,
    externalDir: null,
    launchScript: null,
    lastError: null,
    createdAt: now,
    updatedAt: now,
    lastStartedAt: null,
    ...overrides,
  };
}

describe('Native Modded Minecraft & Java Auto-Provisioning (Issue #1)', () => {
  const tempDirs: string[] = [];

  function makeTempDir(prefix: string): string {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
    tempDirs.push(dir);
    return dir;
  }

  afterEach(() => {
    while (tempDirs.length) {
      fs.rmSync(tempDirs.pop()!, { recursive: true, force: true });
    }
  });

  it('parses Java 8, 17, and 21 version output and maps MC versions accurately', () => {
    expect(parseJavaMajorVersion('java version "1.8.0_412"\nJava(TM) SE Runtime Environment')).toBe(8);
    expect(parseJavaMajorVersion('openjdk version "17.0.12" 2024-07-16')).toBe(17);
    expect(parseJavaMajorVersion('openjdk version "21.0.5" 2024-10-15 LTS')).toBe(21);
    expect(parseJavaMajorVersion('openjdk 21.0.5 2024-10-15')).toBe(21);
    expect(parseJavaMajorVersion('not java')).toBeNull();

    expect(javaTagToMajor('java8')).toBe(8);
    expect(javaTagToMajor('java17')).toBe(17);
    expect(javaTagToMajor('java21')).toBe(21);
    expect(javaTagToMajor('latest')).toBe(21);

    expect(recommendJavaMajorForMcVersion('1.21.4')).toBe(21);
    expect(recommendJavaMajorForMcVersion('1.20.5')).toBe(21);
    expect(recommendJavaMajorForMcVersion('1.20.1')).toBe(17);
    expect(recommendJavaMajorForMcVersion('1.16.5')).toBe(8);
    expect(recommendJavaMajorForMcVersion('LATEST')).toBe(21);
  });

  it('preserves existing PATH entries while prepending managed Java bin dir', () => {
    const envWin = buildJavaEnv(
      { Path: 'C:\\Windows\\System32;C:\\Windows' },
      { javaBin: 'C:\\SF\\tools\\java\\jre-21\\bin\\java.exe', javaHome: 'C:\\SF\\tools\\java\\jre-21', major: 21, source: 'managed' },
      'win32'
    );
    expect(envWin.JAVA_HOME).toBe('C:\\SF\\tools\\java\\jre-21');
    expect(envWin.Path).toContain('C:\\Windows\\System32');
    expect(envWin.Path!.startsWith('C:\\SF\\tools\\java\\jre-21\\bin;')).toBe(true);

    const envLinux = buildJavaEnv(
      { PATH: '/usr/bin:/bin' },
      { javaBin: '/opt/jre-21/bin/java', javaHome: '/opt/jre-21', major: 21, source: 'managed' },
      'linux'
    );
    expect(envLinux.JAVA_HOME).toBe('/opt/jre-21');
    expect(envLinux.PATH).toBe('/opt/jre-21/bin:/usr/bin:/bin');
  });

  it('auto-downloads portable Adoptium JRE when required Java major version is missing', async () => {
    const toolsDir = makeTempDir('sf-java-tools-');
    const stagingDir = makeTempDir('sf-java-stage-');
    const fakeJreRoot = path.join(stagingDir, 'jdk-21.0.5+11-jre');
    fs.mkdirSync(path.join(fakeJreRoot, 'bin'), { recursive: true });
    fs.writeFileSync(path.join(fakeJreRoot, 'bin', 'java'), '#!/bin/sh\necho "openjdk 21.0.5"\n', { mode: 0o755 });

    const tarGzBuf = await createTarGzBuffer(fakeJreRoot);
    let requestedUrl = '';
    const mockFetch = (async (url: string | URL) => {
      requestedUrl = String(url);
      return new Response(new Uint8Array(tarGzBuf), {
        status: 200,
        headers: { 'content-length': String(tarGzBuf.length) },
      });
    }) as unknown as typeof fetch;

    const logs: string[] = [];
    const java = await ensureJavaRuntime(21, toolsDir, (l) => logs.push(l), {
      fetchImpl: mockFetch,
      platform: 'linux',
      arch: 'x64',
      installedJavas: [],
    });

    expect(requestedUrl).toContain('api.adoptium.net/v3/binary/latest/21/ga/linux/x64/jre');
    expect(java.major).toBe(21);
    expect(java.source).toBe('managed');
    expect(fs.existsSync(java.javaBin)).toBe(true);
    expect(logs.some((l) => l.includes('Auto-downloading portable Eclipse Temurin Java 21'))).toBe(true);
  });

  it('resolves CurseForge Server Pack download URL from slug, URL, and errors cleanly when unavailable', async () => {
    const validKey = '$2a$10$' + 'a'.repeat(53);
    const mockFetch = (async (url: string | URL) => {
      const u = String(url);
      if (u.includes('slug=all-the-mods-10')) {
        return new Response(
          JSON.stringify({
            data: [
              {
                id: 925200,
                name: 'All the Mods 10',
                slug: 'all-the-mods-10',
                links: { websiteUrl: 'https://www.curseforge.com/minecraft/modpacks/all-the-mods-10' },
                latestFilesIndexes: [{ gameVersion: '1.21.1' }],
              },
            ],
          }),
          { status: 200 }
        );
      }
      if (u.includes('/mods/925200/files/5900124/download-url')) {
        return new Response(
          JSON.stringify({ data: 'https://edge.forgecdn.net/files/5900/124/Server-Files-2.14.zip' }),
          { status: 200 }
        );
      }
      if (u.includes('/mods/925200/files')) {
        return new Response(
          JSON.stringify({
            data: [
              {
                id: 5900200,
                displayName: 'ATM10-2.15-client-only.zip',
                fileName: 'ATM10-2.15.zip',
                fileDate: '2026-11-02T00:00:00Z',
                gameVersions: ['1.21.1', 'NeoForge'],
                isServerPack: false,
                serverPackFileId: null,
              },
              {
                id: 5900123,
                displayName: 'ATM10-2.14.zip',
                fileName: 'ATM10-2.14.zip',
                fileDate: '2026-11-01T00:00:00Z',
                gameVersions: ['1.21.1', 'NeoForge'],
                isServerPack: false,
                serverPackFileId: 5900124,
              },
            ],
          }),
          { status: 200 }
        );
      }
      if (u.includes('slug=no-server-pack')) {
        return new Response(
          JSON.stringify({
            data: [{ id: 111, name: 'Client Only Pack', slug: 'no-server-pack' }],
          }),
          { status: 200 }
        );
      }
      if (u.includes('/mods/111/files')) {
        return new Response(
          JSON.stringify({
            data: [
              {
                id: 222,
                displayName: 'ClientOnly-1.0.zip',
                fileName: 'ClientOnly-1.0.zip',
                fileDate: '2026-11-01T00:00:00Z',
                gameVersions: ['1.20.1'],
                isServerPack: false,
                serverPackFileId: null,
              },
            ],
          }),
          { status: 200 }
        );
      }
      return new Response('{}', { status: 404 });
    }) as unknown as typeof fetch;

    const cf = new CurseForgeService(mockFetch, 0);

    // Picks newest file that has a serverPackFileId even when latest client file does not
    const resolved = await cf.resolveServerPackForNative({
      pageUrl: 'https://www.curseforge.com/minecraft/modpacks/all-the-mods-10',
      apiKey: validKey,
    });
    expect(resolved.modId).toBe(925200);
    expect(resolved.serverPackFileId).toBe(5900124);
    expect(resolved.downloadUrl).toBe('https://edge.forgecdn.net/files/5900/124/Server-Files-2.14.zip');
    expect(resolved.recommendedJavaTag).toBe('java21');

    // Clear error when modpack has no Server Pack ZIP
    await expect(
      cf.resolveServerPackForNative({ slug: 'no-server-pack', apiKey: validKey })
    ).rejects.toThrow(/does not publish a separate CurseForge Server Pack ZIP/i);
  });

  it('flattens single nested root directories, creates pause-safe Windows batch wrappers, and detects launchers', () => {
    const dir = makeTempDir('sf-flatten-');
    fs.mkdirSync(path.join(dir, '__MACOSX'), { recursive: true });
    const nested = path.join(dir, 'Simple-Server-Files-2.43');
    fs.mkdirSync(nested, { recursive: true });
    fs.writeFileSync(path.join(nested, 'StartServer.bat'), '@echo off\njava -jar forge.jar\npause\n', 'utf8');
    fs.writeFileSync(path.join(nested, 'user_jvm_args.txt'), '-XX:+UseG1GC\n-Xmx4G\n', 'utf8');

    expect(flattenSingleRootSubdir(dir)).toBe(true);
    expect(fs.existsSync(path.join(dir, 'StartServer.bat'))).toBe(true);
    expect(fs.existsSync(nested)).toBe(false);

    // Pause-safe batch wrapper on Windows (uses relative script name with /d /c)
    const winLauncher = findNativeMinecraftLauncher(dir, 'C:\\Java\\bin\\java.exe', 8192, 'win32');
    expect(winLauncher).toEqual({ exe: 'cmd.exe', args: ['/d', '/c', '.serverforge-start.bat'] });
    const wrapperContent = fs.readFileSync(path.join(dir, '.serverforge-start.bat'), 'utf8');
    expect(wrapperContent).toContain('rem [ServerForge] disabled interactive pause');
    expect(createPauseSafeBatchWrapper(dir, 'StartServer.bat')).toBe('.serverforge-start.bat');

    // Forge/NeoForge win_args.txt detection when no startup script exists
    const argsDir = makeTempDir('sf-args-');
    const nfVerDir = path.join(argsDir, 'libraries', 'net', 'neoforged', 'neoforge', '21.1.72');
    fs.mkdirSync(nfVerDir, { recursive: true });
    fs.writeFileSync(path.join(nfVerDir, 'win_args.txt'), '-cp ...', 'utf8');
    fs.writeFileSync(path.join(argsDir, 'user_jvm_args.txt'), '-Xmx8192M\n', 'utf8');
    const nfLauncher = findNativeMinecraftLauncher(argsDir, 'java.exe', 8192, 'win32');
    expect(nfLauncher?.exe).toBe('java.exe');
    expect(nfLauncher?.args).toContain('@user_jvm_args.txt');
    expect(nfLauncher?.args.some((a) => a.includes('win_args.txt'))).toBe(true);

    // Skips *-installer.jar as a direct server launcher and detects it via findForgeOrNeoForgeInstallerJar
    const instDir = makeTempDir('sf-inst-jar-');
    fs.writeFileSync(path.join(instDir, 'forge-1.20.1-47.3.0-installer.jar'), 'fake', 'utf8');
    expect(findNativeMinecraftLauncher(instDir, 'java', 4096, 'linux')).toBeNull();
    expect(findForgeOrNeoForgeInstallerJar(instDir)).toBe('forge-1.20.1-47.3.0-installer.jar');
  });

  it('auto-resolves, downloads, extracts, flattens, and configures a Native CurseForge pack with blank SERVER_PACK_ZIP', async () => {
    const toolsDir = makeTempDir('sf-cf-tools-');
    const serverDir = makeTempDir('sf-cf-server-');
    const validKey = '$2a$10$' + 'b'.repeat(53);

    const zipBuf = await createZipBuffer({
      'ATM10-Server-Files/startserver.sh': '#!/usr/bin/env bash\necho "Booting ATM10"\n',
      'ATM10-Server-Files/user_jvm_args.txt': '# Custom flags\n-XX:+UseG1GC\n-Xmx4G\n',
      'ATM10-Server-Files/server.properties': 'level-name=world\nserver-port=25565\n',
    });

    const mockFetch = (async (url: string | URL) => {
      const u = String(url);
      if (u.includes('/mods/search')) {
        return new Response(
          JSON.stringify({
            data: [{ id: 925200, name: 'All the Mods 10', slug: 'all-the-mods-10' }],
          }),
          { status: 200 }
        );
      }
      if (u.includes('/mods/925200/files/5900124/download-url')) {
        return new Response(JSON.stringify({ data: 'https://cdn.example.com/atm10-server.zip' }), { status: 200 });
      }
      if (u.includes('/mods/925200/files')) {
        return new Response(
          JSON.stringify({
            data: [
              {
                id: 5900123,
                displayName: 'ATM10-2.14.zip',
                fileName: 'ATM10-2.14.zip',
                fileDate: '2026-11-01T00:00:00Z',
                gameVersions: ['1.21.1', 'NeoForge'],
                isServerPack: false,
                serverPackFileId: 5900124,
              },
            ],
          }),
          { status: 200 }
        );
      }
      if (u === 'https://cdn.example.com/atm10-server.zip') {
        return new Response(new Uint8Array(zipBuf), {
          status: 200,
          headers: { 'content-length': String(zipBuf.length) },
        });
      }
      return new Response('{}', { status: 404 });
    }) as unknown as typeof fetch;

    const cf = new CurseForgeService(mockFetch, 0);
    const adapter = new NativeProcessRuntimeAdapter(
      toolsDir,
      new QueryService(),
      cf,
      () => ({ CF_API_KEY: validKey }),
      mockFetch
    );

    const logs: string[] = [];
    const statuses: string[] = [];
    const inst = makeInstance({
      ports: { game: 25566, rcon: 25576 },
      memoryLimitMb: 10240,
    });

    const launchPlan = await adapter.prepareCurseForgeServerPack(
      inst,
      serverDir,
      (line) => logs.push(line),
      (st) => statuses.push(st),
      { javaBin: '/opt/jre-21/bin/java', javaHome: '/opt/jre-21', major: 21, source: 'managed' }
    );

    expect(statuses).toEqual(['installing', 'starting']);
    expect(launchPlan.exe).toBe('bash');
    expect(launchPlan.args).toEqual(['startserver.sh']);
    expect(launchPlan.extraEnv?.JAVA_HOME).toBe('/opt/jre-21');
    expect(fs.readFileSync(path.join(serverDir, 'eula.txt'), 'utf8')).toContain('eula=true');

    const props = fs.readFileSync(path.join(serverDir, 'server.properties'), 'utf8');
    expect(props).toContain('server-port=25566');
    expect(props).toContain('enable-rcon=true');
    expect(props).toContain('rcon.port=25576');
    expect(props).toContain('rcon.password=test-rcon-password');
    expect(props).toContain('level-name=world');

    const jvmArgs = fs.readFileSync(path.join(serverDir, 'user_jvm_args.txt'), 'utf8');
    expect(jvmArgs).toContain('-XX:+UseG1GC');
    expect(jvmArgs).toContain('-Xmx10240M');
    expect(jvmArgs).not.toContain('-Xmx4G');
  });

  it('downloads Paper server.jar natively via prepareJavaMinecraftServer', async () => {
    const toolsDir = makeTempDir('sf-paper-tools-');
    const serverDir = makeTempDir('sf-paper-server-');

    const mockFetch = (async (url: string | URL) => {
      const u = String(url);
      if (u === 'https://api.papermc.io/v2/projects/paper') {
        return new Response(JSON.stringify({ versions: ['1.21.1', '1.21.4'] }), { status: 200 });
      }
      if (u.endsWith('/versions/1.21.4/builds')) {
        return new Response(
          JSON.stringify({
            builds: [{ build: 150, downloads: { application: { name: 'paper-1.21.4-150.jar' } } }],
          }),
          { status: 200 }
        );
      }
      if (u.endsWith('/downloads/paper-1.21.4-150.jar')) {
        return new Response(new Uint8Array(Buffer.from('PK\x03\x04fake-paper-jar')), { status: 200 });
      }
      return new Response('{}', { status: 404 });
    }) as unknown as typeof fetch;

    const adapter = new NativeProcessRuntimeAdapter(toolsDir, new QueryService(), undefined, () => ({}), mockFetch);
    const inst = makeInstance({
      gameId: 'minecraft',
      config: {
        SERVER_TYPE: 'PAPER',
        MC_VERSION: 'LATEST',
        MOTD: 'Native Paper Test',
        MAX_PLAYERS: 10,
        RCON_PASSWORD: 'secret',
      },
      memoryLimitMb: 4096,
    });

    const plan = await adapter.prepareJavaMinecraftServer(
      inst,
      serverDir,
      () => {},
      () => {},
      { javaBin: '/opt/jre-21/bin/java', javaHome: '/opt/jre-21', major: 21, source: 'managed' }
    );

    expect(fs.existsSync(path.join(serverDir, 'server.jar'))).toBe(true);
    expect(fs.readFileSync(path.join(serverDir, 'eula.txt'), 'utf8')).toContain('eula=true');
    expect(plan.exe).toBe('/opt/jre-21/bin/java');
    expect(plan.args).toEqual(['-Xms2048M', '-Xmx4096M', '-jar', 'server.jar', 'nogui']);
  });

  it('rejects cleanly when spawning a non-existent native executable instead of leaving instance running', async () => {
    const toolsDir = makeTempDir('sf-missing-exe-');
    const instDir = makeTempDir('sf-missing-inst-');
    const adapter = new NativeProcessRuntimeAdapter(toolsDir, new QueryService());
    const inst = makeInstance({
      gameId: 'custom-test',
      launchScript: null,
    });
    const fakeTemplate = {
      id: 'custom-test',
      name: 'Custom Test',
      shortName: 'Test',
      category: 'sandbox',
      description: 'Test',
      accentColor: '#fff',
      joinHint: '',
      resources: { minRamGb: 1, recommendedRamGb: 2, minDiskGb: 1 },
      ports: [{ key: 'game', label: 'Game', defaultPort: 25565, protocol: 'tcp', primary: true }],
      runtimes: {
        preferred: 'native',
        native: {
          installer: 'custom',
          executableWindows: 'definitely-nonexistent-binary-xyz',
          executableLinux: 'definitely-nonexistent-binary-xyz',
          argsTemplate: '',
          envTemplate: {},
        },
      },
      query: { protocol: 'none' },
      lifecycle: { bootGraceSeconds: 30, gracefulStopTimeoutSeconds: 10, saveMethod: 'none' },
      configFields: [],
    } as unknown as GameTemplate;

    await expect(
      adapter.start(inst, fakeTemplate, instDir, () => {}, () => {})
    ).rejects.toThrow(/Failed to spawn native server binary/);
  });
});
