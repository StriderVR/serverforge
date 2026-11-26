import { execFile } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import archiver from 'archiver';
import { afterEach, describe, expect, it } from 'vitest';
import type { ServerInstance } from '@serverforge/shared';
import { CatalogService } from '../catalog/catalog-service.js';
import { QueryService } from '../query/query-service.js';
import {
  buildFactorioWin64DownloadUrl,
  parseSteamLibraryFoldersVdf,
  toWslPath,
  writeFactorioConfigFiles,
} from '../runtimes/factorio-helper.js';
import { NativeProcessRuntimeAdapter } from '../runtimes/native-runtime.js';
import {
  buildArkAsaNativeLaunchPlan,
  buildPalworldNativeLaunchPlan,
  buildSatisfactoryNativeLaunchPlan,
  buildSteamCmdDownloadUrl,
  ensureSteamCmd,
  writePalworldSettingsIni,
} from '../runtimes/steamcmd-helper.js';

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

async function createTarArchiveBuffer(dirToPack: string, ext: '.tar.gz' | '.tar.xz'): Promise<Buffer> {
  const outTar = path.join(os.tmpdir(), `sf-archive-${Date.now()}-${Math.random().toString(16).slice(2)}${ext}`);
  const flag = ext === '.tar.xz' ? '-cJf' : '-czf';
  await new Promise<void>((resolve, reject) => {
    execFile('tar', [flag, outTar, '-C', path.dirname(dirToPack), path.basename(dirToPack)], (err) => {
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
    id: 'inst-native-1',
    slug: 'test-native-server',
    name: 'Test Native Server',
    gameId: 'satisfactory',
    runtime: 'native',
    status: 'stopped',
    ports: { game: 7777 },
    config: {},
    memoryLimitMb: 8192,
    autoStart: false,
    autoRestartOnCrash: true,
    discordEnabled: true,
    containerId: null,
    externalDir: null,
    launchScript: null,
    lastError: null,
    lastCrash: null,
    createdAt: now,
    updatedAt: now,
    lastStartedAt: null,
    ...overrides,
  };
}

describe('Native SteamCMD & Factorio Auto-Provisioning (Issues #38, #39, #40, #41)', () => {
  const tempDirs: string[] = [];

  function makeTempDir(prefix: string): string {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
    tempDirs.push(dir);
    return dir;
  }

  afterEach(() => {
    while (tempDirs.length) {
      fs.rmSync(tempDirs.pop()!, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
    }
  });

  it('auto-downloads and caches portable Valve SteamCMD when missing (Issues #38, #40, #41)', async () => {
    expect(buildSteamCmdDownloadUrl('win32')).toBe('https://steamcdn-a.akamaihd.net/client/installer/steamcmd.zip');
    expect(buildSteamCmdDownloadUrl('linux')).toBe(
      'https://steamcdn-a.akamaihd.net/client/installer/steamcmd_linux.tar.gz'
    );

    const toolsDir = makeTempDir('sf-steamcmd-tools-');
    const isWin = process.platform === 'win32';
    const archiveBuf = isWin
      ? await createZipBuffer({ 'steamcmd.exe': 'fake-steamcmd-binary' })
      : await (async () => {
          const stage = makeTempDir('sf-steamcmd-stage-');
          fs.writeFileSync(path.join(stage, 'steamcmd.sh'), '#!/bin/sh\necho ok\n', { mode: 0o755 });
          // Pack files directly at archive root
          const outTar = path.join(os.tmpdir(), `sf-sc-${Date.now()}-${Math.random().toString(16).slice(2)}.tar.gz`);
          await new Promise<void>((resolve, reject) => {
            execFile('tar', ['-czf', outTar, '-C', stage, 'steamcmd.sh'], (err) => (err ? reject(err) : resolve()));
          });
          const buf = fs.readFileSync(outTar);
          fs.rmSync(outTar, { force: true });
          return buf;
        })();

    let fetchCount = 0;
    let requestedUrl = '';
    const mockFetch = (async (url: string | URL) => {
      fetchCount++;
      requestedUrl = String(url);
      return new Response(new Uint8Array(archiveBuf), {
        status: 200,
        headers: { 'content-length': String(archiveBuf.length) },
      });
    }) as unknown as typeof fetch;

    const logs: string[] = [];
    const binPath = await ensureSteamCmd(toolsDir, (l) => logs.push(l), {
      fetchImpl: mockFetch,
      platform: process.platform,
    });

    expect(fs.existsSync(binPath)).toBe(true);
    if (fetchCount > 0) {
      expect(requestedUrl).toContain('steamcdn-a.akamaihd.net/client/installer/steamcmd');
      expect(binPath).toContain(path.join('steamcmd', isWin ? 'steamcmd.exe' : 'steamcmd.sh'));
      expect(logs.some((l) => l.includes('Auto-downloading official portable Valve SteamCMD'))).toBe(true);

      // Second invocation reuses the cached portable binary without fetching again
      const cachedBin = await ensureSteamCmd(toolsDir, (l) => logs.push(l), {
        fetchImpl: mockFetch,
        platform: process.platform,
      });
      expect(cachedBin).toBe(binPath);
      expect(fetchCount).toBe(1);
    }
  }, 30_000);

  it('builds direct Satisfactory Windows Shipping-Cmd launch plan instead of exiting wrapper stub (Issue #38)', () => {
    const serverDir = makeTempDir('sf-sat-');
    const directExe = path.join(serverDir, 'Engine', 'Binaries', 'Win64', 'FactoryServer-Win64-Shipping-Cmd.exe');
    fs.mkdirSync(path.dirname(directExe), { recursive: true });
    fs.writeFileSync(directExe, 'exe');
    fs.writeFileSync(path.join(serverDir, 'FactoryServer.exe'), 'stub');

    const inst = makeInstance({
      gameId: 'satisfactory',
      ports: { game: 7780 },
    });

    const plan = buildSatisfactoryNativeLaunchPlan(serverDir, inst, 'win32');
    expect(plan).not.toBeNull();
    expect(plan!.exe).toBe(directExe);
    expect(plan!.args).toEqual(['FactoryGame', '-Port=7780', '-ReliablePort=8888', '-multihome=0.0.0.0', '-log', '-unattended']);

    const customInst = makeInstance({
      gameId: 'satisfactory',
      ports: { game: 27777, reliable: 25577 },
    });
    const customPlan = buildSatisfactoryNativeLaunchPlan(serverDir, customInst, 'win32');
    expect(customPlan).not.toBeNull();
    expect(customPlan!.args).toEqual(['FactoryGame', '-Port=27777', '-ReliablePort=25577', '-multihome=0.0.0.0', '-log', '-unattended']);
  });

  it('writes PalWorldSettings.ini preserving custom gameplay rates and launches PalServer-Win64-Shipping-Cmd.exe (Issue #40)', () => {
    const serverDir = makeTempDir('sf-pal-');
    fs.writeFileSync(
      path.join(serverDir, 'DefaultPalWorldSettings.ini'),
      '; Default config\n[/Script/Pal.PalGameWorldSettings]\nOptionSettings=(Difficulty=None,ExpRate=2.500000,ServerPlayerMaxNum=32,ServerName="Default Palworld Server",ServerDescription="",AdminPassword="",ServerPassword="",PublicPort=8211,RCONEnabled=False,RCONPort=25575,RESTAPIEnabled=False,RESTAPIPort=8212)\n',
      'utf8'
    );
    const directExe = path.join(serverDir, 'Pal', 'Binaries', 'Win64', 'PalServer-Win64-Shipping-Cmd.exe');
    fs.mkdirSync(path.dirname(directExe), { recursive: true });
    fs.writeFileSync(directExe, 'exe');

    const inst = makeInstance({
      gameId: 'palworld',
      name: 'Friends Palworld',
      ports: { game: 8215, query: 27016, rest: 8216, rcon: 25576 },
      config: {
        SERVER_NAME: 'Friends Palworld',
        SERVER_DESCRIPTION: 'Cozy server',
        MAX_PLAYERS: 12,
        SERVER_PASSWORD: 'join-secret',
        ADMIN_PASSWORD: 'admin-secret',
      },
    });

    const iniPath = writePalworldSettingsIni(serverDir, inst, 'win32');
    expect(fs.existsSync(iniPath)).toBe(true);
    const ini = fs.readFileSync(iniPath, 'utf8');
    expect(ini).toContain('ExpRate=2.500000');
    expect(ini).toContain('ServerName="Friends Palworld"');
    expect(ini).toContain('ServerDescription="Cozy server"');
    expect(ini).toContain('ServerPlayerMaxNum=12');
    expect(ini).toContain('ServerPassword="join-secret"');
    expect(ini).toContain('AdminPassword="admin-secret"');
    expect(ini).toContain('PublicPort=8215');
    expect(ini).toContain('RCONEnabled=True');
    expect(ini).toContain('RCONPort=25576');
    expect(ini).toContain('RESTAPIEnabled=True');
    expect(ini).toContain('RESTAPIPort=8216');

    const plan = buildPalworldNativeLaunchPlan(serverDir, inst, 'win32');
    expect(plan).not.toBeNull();
    expect(plan!.exe).toBe(directExe);
    expect(plan!.args).toContain('-port=8215');
    expect(plan!.args).toContain('-queryport=27016');
    expect(plan!.args).toContain('-players=12');
  });

  it('builds clean Ark: ASA native launch arguments and omits blank password/mods flags (Issue #41)', () => {
    const serverDir = makeTempDir('sf-ark-');
    const exePath = path.join(serverDir, 'ShooterGame', 'Binaries', 'Win64', 'ArkAscendedServer.exe');
    fs.mkdirSync(path.dirname(exePath), { recursive: true });
    fs.writeFileSync(exePath, 'exe');

    const blankInst = makeInstance({
      gameId: 'ark-survival-ascended',
      ports: { game: 7777, peer: 7778, rcon: 27020 },
      config: {
        MAP: 'TheIsland_WP',
        SESSION_NAME: 'ServerForge ASA',
        MAX_PLAYERS: 10,
        MOD_IDS: '',
        SERVER_PASSWORD: '',
        RCON_PASSWORD: 'adminpass',
      },
    });

    const planBlank = buildArkAsaNativeLaunchPlan(serverDir, blankInst)!;
    expect(planBlank.exe).toBe(exePath);
    expect(planBlank.args[0]).toBe(
      'TheIsland_WP?listen?SessionName=ServerForge ASA?Port=7777?RCONEnabled=True?RCONPort=27020?ServerAdminPassword=adminpass'
    );
    expect(planBlank.args[0]).not.toContain('ServerPassword=');
    expect(planBlank.args.some((a) => a.startsWith('-mods='))).toBe(false);
    expect(planBlank.args).toContain('-WinLiveMaxPlayers=10');
    expect(planBlank.args).toContain('-server');
    expect(planBlank.args).toContain('-log');

    const moddedInst = makeInstance({
      ...blankInst,
      config: {
        ...blankInst.config,
        MOD_IDS: '928793,935408',
        SERVER_PASSWORD: 'dinopassword',
      },
    });
    const planModded = buildArkAsaNativeLaunchPlan(serverDir, moddedInst)!;
    expect(planModded.args[0]).toContain('?ServerPassword=dinopassword');
    expect(planModded.args).toContain('-mods=928793,935408');
  });

  it('parses Steam libraryfolders.vdf, converts WSL paths, and writes isolated Factorio config & settings (Issue #39)', () => {
    const vdf = `"libraryfolders"
{
  "0"
  {
    "path"		"C:\\\\Program Files (x86)\\\\Steam"
  }
  "1"
  {
    "path"		"D:\\\\SteamLibrary"
  }
}`;
    expect(parseSteamLibraryFoldersVdf(vdf)).toEqual(['C:\\Program Files (x86)\\Steam', 'D:\\SteamLibrary']);
    expect(toWslPath('C:\\ServerForge\\data\\instances\\abc\\server')).toBe(
      '/mnt/c/ServerForge/data/instances/abc/server'
    );
    expect(buildFactorioWin64DownloadUrl('engineer', 'secret-tok')).toBe(
      'https://www.factorio.com/get-download/stable/alpha/win64-manual?username=engineer&token=secret-tok'
    );

    const serverDir = makeTempDir('sf-fac-cfg-');
    const inst = makeInstance({
      gameId: 'factorio',
      name: 'Factory Friends',
      ports: { game: 34197, rcon: 27015 },
      config: {
        SAVE_NAME: 'my-factory',
        MAX_PLAYERS: 12,
        SERVER_PASSWORD: 'iron',
        RCON_PASSWORD: 'rcon-secret',
      },
    });
    const { configIniPath, serverSettingsPath, saveFilePath } = writeFactorioConfigFiles(serverDir, inst);
    expect(fs.readFileSync(configIniPath, 'utf8')).toContain(`write-data=${serverDir}`);
    const settings = JSON.parse(fs.readFileSync(serverSettingsPath, 'utf8')) as Record<string, unknown>;
    expect(settings.max_players).toBe(12);
    expect(settings.game_password).toBe('iron');
    expect(saveFilePath).toBe(path.join(serverDir, 'saves', 'my-factory.zip'));
  });

  it('auto-detects local Steam Factorio on Windows and supports Factorio.com Windows ZIP & WSL2 fallback (Issue #39)', async () => {
    const toolsDir = makeTempDir('sf-fac-tools-');

    // Case 1: Auto-detected local Steam Factorio installation on Windows
    const steamFactorioDir = makeTempDir('sf-fac-steam-');
    const steamExe = path.join(steamFactorioDir, 'bin', 'x64', 'factorio.exe');
    fs.mkdirSync(path.dirname(steamExe), { recursive: true });
    fs.writeFileSync(steamExe, 'fake-exe');

    const serverDirLocal = makeTempDir('sf-fac-srv-local-');
    const adapter = new NativeProcessRuntimeAdapter(toolsDir, new QueryService());
    const inst = makeInstance({
      gameId: 'factorio',
      name: 'Factorio Server',
      ports: { game: 34197, rcon: 27015 },
      config: {
        SAVE_NAME: 'serverforge-factory',
        MAX_PLAYERS: 8,
        SERVER_PASSWORD: '',
        RCON_PASSWORD: 'rcon-password',
      },
    });

    const localLogs: string[] = [];
    const localPlan = await adapter.prepareFactorioServer(inst, serverDirLocal, (l) => localLogs.push(l), undefined, {
      platform: 'win32',
      searchDirs: [steamFactorioDir],
      steamVdfPaths: [],
      wslAvailableOverride: false,
      skipCreateSaveExec: true,
    });
    expect(localPlan.exe).toBe(steamExe);
    expect(localPlan.args).toContain('--start-server-load-latest');
    expect(localPlan.args).toContain('--config');
    expect(localPlan.args).toContain('--server-settings');
    expect(localLogs.some((l) => l.includes('Auto-detected local Factorio installation'))).toBe(true);

    // Case 2: Windows Factorio.com Username + Token auto-downloads Windows 64-bit ZIP
    const zipBuf = await createZipBuffer({
      'Factorio_2.0/bin/x64/factorio.exe': 'fake-win64-exe',
      'Factorio_2.0/data/base/info.json': '{}',
    });
    let winDownloadUrl = '';
    const mockFetchWin = (async (url: string | URL) => {
      winDownloadUrl = String(url);
      return new Response(new Uint8Array(zipBuf), {
        status: 200,
        headers: { 'content-length': String(zipBuf.length) },
      });
    }) as unknown as typeof fetch;

    const serverDirZip = makeTempDir('sf-fac-srv-zip-');
    const zipAdapter = new NativeProcessRuntimeAdapter(toolsDir, new QueryService(), undefined, () => ({}), mockFetchWin);
    const zipPlan = await zipAdapter.prepareFactorioServer(
      makeInstance({
        ...inst,
        config: {
          ...inst.config,
          FACTORIO_USERNAME: 'engineer',
          FACTORIO_TOKEN: 'tok123',
        },
      }),
      serverDirZip,
      () => {},
      undefined,
      {
        platform: 'win32',
        searchDirs: [],
        steamVdfPaths: [],
        wslAvailableOverride: false,
        skipCreateSaveExec: true,
      }
    );
    expect(winDownloadUrl).toContain('win64-manual?username=engineer&token=tok123');
    expect(zipPlan.exe).toBe(path.join(serverDirZip, 'bin', 'x64', 'factorio.exe'));

    // Case 3: Windows WSL2 fallback with already-present Linux headless binary runs via wsl.exe
    const serverDirWsl = makeTempDir('sf-fac-srv-wsl-');
    const wslLinuxBin = path.join(serverDirWsl, 'bin', 'x64', 'factorio');
    fs.mkdirSync(path.dirname(wslLinuxBin), { recursive: true });
    fs.writeFileSync(wslLinuxBin, '#!/bin/sh\n', { mode: 0o755 });

    const wslPlan = await adapter.prepareFactorioServer(inst, serverDirWsl, () => {}, undefined, {
      platform: 'win32',
      searchDirs: [],
      steamVdfPaths: [],
      wslAvailableOverride: true,
      skipCreateSaveExec: true,
    });
    expect(wslPlan.exe).toBe('wsl.exe');
    expect(wslPlan.args[0]).toBe('-e');
    expect(wslPlan.args[1]).toContain('/bin/x64/factorio');
    expect(wslPlan.args).toContain('--start-server-load-latest');

    // Case 4: Windows with no local Factorio, no credentials, and no WSL2 produces clear actionable error
    const serverDirEmpty = makeTempDir('sf-fac-srv-empty-');
    await expect(
      adapter.prepareFactorioServer(inst, serverDirEmpty, () => {}, undefined, {
        platform: 'win32',
        searchDirs: [],
        steamVdfPaths: [],
        wslAvailableOverride: false,
        skipCreateSaveExec: true,
      })
    ).rejects.toThrow(/Install Factorio via Steam|FACTORIO_SOURCE|WSL2/i);
  }, 30_000);

  it('auto-downloads official free Factorio Linux Headless tarball on Linux (Issue #39)', async () => {
    if (process.platform === 'win32') return;
    const toolsDir = makeTempDir('sf-fac-lin-tools-');
    const serverDir = makeTempDir('sf-fac-lin-srv-');
    const stageDir = makeTempDir('sf-fac-lin-stage-');
    const facRoot = path.join(stageDir, 'factorio');
    fs.mkdirSync(path.join(facRoot, 'bin', 'x64'), { recursive: true });
    fs.writeFileSync(path.join(facRoot, 'bin', 'x64', 'factorio'), '#!/bin/sh\nexit 0\n', { mode: 0o755 });
    const tarXzBuf = await createTarArchiveBuffer(facRoot, '.tar.xz');

    let requestedUrl = '';
    const mockFetch = (async (url: string | URL) => {
      requestedUrl = String(url);
      return new Response(new Uint8Array(tarXzBuf), {
        status: 200,
        headers: { 'content-length': String(tarXzBuf.length) },
      });
    }) as unknown as typeof fetch;

    const adapter = new NativeProcessRuntimeAdapter(toolsDir, new QueryService(), undefined, () => ({}), mockFetch);
    const plan = await adapter.prepareFactorioServer(
      makeInstance({
        gameId: 'factorio',
        ports: { game: 34197, rcon: 27015 },
        config: { SAVE_NAME: 'linux-world', RCON_PASSWORD: 'pass' },
      }),
      serverDir,
      () => {},
      undefined,
      { platform: 'linux', skipCreateSaveExec: true }
    );

    expect(requestedUrl).toBe('https://factorio.com/get-download/stable/headless/linux64');
    expect(plan.exe).toBe(path.join(serverDir, 'bin', 'x64', 'factorio'));
    expect(fs.existsSync(plan.exe)).toBe(true);
  }, 30_000);

  it('normalizes legacy factorio.yaml on disk to expose FACTORIO_SOURCE, FACTORIO_USERNAME, and FACTORIO_TOKEN (Issue #39)', () => {
    const builtInDir = makeTempDir('sf-cat-fac-builtin-');
    const customDir = makeTempDir('sf-cat-fac-custom-');
    const fullYaml = fs.readFileSync(path.resolve(process.cwd(), '../../catalog/games/factorio.yaml'), 'utf8');
    const legacyYaml = fullYaml.slice(0, fullYaml.indexOf('  - key: FACTORIO_SOURCE'));
    fs.writeFileSync(path.join(builtInDir, 'factorio.yaml'), legacyYaml, 'utf8');

    const catalog = new CatalogService(builtInDir, customDir);
    const tpl = catalog.getTemplate('factorio')!;
    const keys = tpl.configFields.map((f) => f.key);
    expect(keys).toContain('FACTORIO_SOURCE');
    expect(keys).toContain('FACTORIO_USERNAME');
    expect(keys).toContain('FACTORIO_TOKEN');
  });
});
