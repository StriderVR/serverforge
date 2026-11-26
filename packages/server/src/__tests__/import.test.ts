import { execFile, spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { createServerForgeApp, type ServerForgeApp } from '../api/server.js';
import {
  buildWindowsFolderPickerScript,
  buildWindowsPebCwdProbeScript,
  encodePowerShellCommand,
  extractWorkingDirFromAncestorCommands,
  extractWorkingDirFromCommandLine,
  normalizeDiscoveredProcesses,
  normalizeServerRootDir,
  parseJavaUserDirFromProperties,
  parsePropertiesFile,
  parseXmxMemoryMb,
} from '../services/import-service.js';

describe('SmartImportService — Modded Minecraft & Existing Server Import', () => {
  const cleanups: Array<() => Promise<void>> = [];

  async function makeApp(): Promise<ServerForgeApp> {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sf-imp-'));
    const sf = await createServerForgeApp({
      dataDir: tmpDir,
      runtimeMode: 'mock',
      discordToken: '',
    });
    sf.telemetry.setMemoryOverrideForTesting({ totalGb: 64, usedGb: 8, freeGb: 56 });
    cleanups.push(async () => {
      await sf.close();
      fs.rmSync(tmpDir, { recursive: true, force: true });
    });
    return sf;
  }

  function populateModdedMinecraftDir(dir: string): void {
    fs.mkdirSync(path.join(dir, 'mods'), { recursive: true });
    fs.writeFileSync(path.join(dir, 'mods', 'create.jar'), 'jar1');
    fs.writeFileSync(path.join(dir, 'mods', 'mekanism.jar'), 'jar2');
    fs.writeFileSync(path.join(dir, 'mods', 'ae2.jar'), 'jar3');

    fs.mkdirSync(path.join(dir, 'libraries', 'net', 'neoforged'), { recursive: true });
    fs.mkdirSync(path.join(dir, 'world'), { recursive: true });
    fs.writeFileSync(path.join(dir, 'world', 'level.dat'), 'world-data');

    fs.writeFileSync(
      path.join(dir, 'user_jvm_args.txt'),
      '# Custom ATM10 JVM args\n-Xms4G\n-Xmx10G\n',
      'utf8'
    );

    fs.writeFileSync(
      path.join(dir, 'run.bat'),
      '@echo off\njava @user_jvm_args.txt @libraries/net/neoforged/win_args.txt nogui\npause\n',
      'utf8'
    );

    fs.writeFileSync(
      path.join(dir, 'server.properties'),
      [
        '# Existing modded properties',
        'motd=Our Existing ATM10 World',
        'server-port=25565',
        'max-players=12',
        'difficulty=hard',
        'enable-rcon=false',
        'allow-flight=true',
      ].join('\n') + '\n',
      'utf8'
    );
  }

  function makeMockModdedMinecraftDir(): string {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'atm10-existing-'));
    cleanups.push(async () => {
      fs.rmSync(dir, { recursive: true, force: true });
    });
    populateModdedMinecraftDir(dir);
    return dir;
  }

  afterEach(async () => {
    while (cleanups.length) {
      await cleanups.pop()!();
    }
  });

  it('parses -Xmx memory flags accurately across G and M units', () => {
    expect(parseXmxMemoryMb('-Xms4G -Xmx10G')).toBe(10240);
    expect(parseXmxMemoryMb('-Xmx8192M')).toBe(8192);
    expect(parseXmxMemoryMb('MAX_RAM="12G"')).toBe(12288);
  });

  it('deduplicates Windows javapath shim -> JDK java.exe parent/child pair and resolves PEB workingDir', () => {
    const raw = [
      {
        pid: 13904,
        parentPid: 9012,
        processName: 'java.exe',
        executablePath: 'C:\\Program Files\\Common Files\\Oracle\\Java\\javapath\\java.exe',
        commandLine: '"java" @user_jvm_args.txt @libraries\\net\\neoforged\\neoforge\\21.1.249\\win_args.txt nogui',
        processCwd: 'C:\\Users\\penhe\\Desktop\\Minecraft Servers\\ATM 10\\Server-Files-2.47\\',
        ancestorCommandLines: [
          'cmd.exe /c ""C:\\Users\\penhe\\Desktop\\Minecraft Servers\\ATM 10\\Server-Files-2.47\\startserver.bat""',
        ],
      },
      {
        pid: 13924,
        parentPid: 13904,
        processName: 'java.exe',
        executablePath: 'C:\\Program Files\\Java\\jdk-21\\bin\\java.exe',
        commandLine:
          '"C:\\Program Files\\Java\\jdk-21\\bin\\java.exe" @user_jvm_args.txt @libraries\\net\\neoforged\\neoforge\\21.1.249\\win_args.txt nogui',
        processCwd: 'C:\\Users\\penhe\\Desktop\\Minecraft Servers\\ATM 10\\Server-Files-2.47\\',
        ancestorCommandLines: [
          '"java" @user_jvm_args.txt @libraries\\net\\neoforged\\neoforge\\21.1.249\\win_args.txt nogui',
        ],
      },
    ];

    const result = normalizeDiscoveredProcesses(raw);
    expect(result).toHaveLength(1);
    expect(result[0].pid).toBe(13924);
    expect(result[0].detectedGameId).toBe('minecraft-curseforge');
    expect(result[0].workingDir).toBe('C:\\Users\\penhe\\Desktop\\Minecraft Servers\\ATM 10\\Server-Files-2.47');
  });

  it('keeps two independent Minecraft servers running concurrently while collapsing each shim pair', () => {
    const result = normalizeDiscoveredProcesses([
      {
        pid: 100,
        parentPid: 50,
        processName: 'java.exe',
        commandLine: '"java" @user_jvm_args.txt @libraries\\net\\neoforged\\win_args.txt nogui',
        processCwd: 'D:\\Servers\\ATM10\\',
      },
      {
        pid: 101,
        parentPid: 100,
        processName: 'java.exe',
        commandLine: '"C:\\Program Files\\Java\\jdk-21\\bin\\java.exe" @user_jvm_args.txt @libraries\\net\\neoforged\\win_args.txt nogui',
        processCwd: 'D:\\Servers\\ATM10\\',
      },
      {
        pid: 200,
        parentPid: 60,
        processName: 'java.exe',
        commandLine: '"java" -Xmx8G -jar fabric-server-launch.jar nogui',
        processCwd: 'D:\\Servers\\BetterMC\\',
      },
      {
        pid: 201,
        parentPid: 200,
        processName: 'java.exe',
        commandLine: '"C:\\Program Files\\Java\\jdk-21\\bin\\java.exe" -Xmx8G -jar fabric-server-launch.jar nogui',
        processCwd: 'D:\\Servers\\BetterMC\\',
      },
    ]);

    expect(result).toHaveLength(2);
    expect(result.map((r) => ({ pid: r.pid, workingDir: r.workingDir }))).toEqual([
      { pid: 101, workingDir: 'D:\\Servers\\ATM10' },
      { pid: 201, workingDir: 'D:\\Servers\\BetterMC' },
    ]);
  });

  it('deduplicates Palworld wrapper and normalizes nested Ark/Palworld/Factorio binary folders to server roots', () => {
    const result = normalizeDiscoveredProcesses([
      {
        pid: 300,
        parentPid: 10,
        processName: 'PalServer.exe',
        executablePath: 'D:\\Games\\Palworld\\PalServer.exe',
        commandLine: '"D:\\Games\\Palworld\\PalServer.exe"',
      },
      {
        pid: 301,
        parentPid: 300,
        processName: 'PalServer-Win64-Shipping-Cmd.exe',
        executablePath: 'D:\\Games\\Palworld\\Pal\\Binaries\\Win64\\PalServer-Win64-Shipping-Cmd.exe',
        commandLine: '"D:\\Games\\Palworld\\Pal\\Binaries\\Win64\\PalServer-Win64-Shipping-Cmd.exe"',
      },
      {
        pid: 400,
        parentPid: 10,
        processName: 'ArkAscendedServer.exe',
        executablePath: 'E:\\Servers\\ArkASA\\ShooterGame\\Binaries\\Win64\\ArkAscendedServer.exe',
        commandLine: 'ArkAscendedServer.exe TheIsland_WP?listen',
      },
      {
        pid: 500,
        parentPid: 10,
        processName: 'factorio.exe',
        executablePath: 'E:\\Servers\\Factorio\\bin\\x64\\factorio.exe',
        commandLine: 'factorio.exe --start-server save.zip',
      },
    ]);

    expect(result).toHaveLength(3);
    expect(result.find((r) => r.pid === 301)?.workingDir).toBe('D:\\Games\\Palworld');
    expect(result.find((r) => r.pid === 400)?.workingDir).toBe('E:\\Servers\\ArkASA');
    expect(result.find((r) => r.pid === 500)?.workingDir).toBe('E:\\Servers\\Factorio');
  });

  it('resolves workingDir fallbacks: ignores System32, parses ancestor .bat/.ps1, quoted paths with spaces, -Duser.dir, and jcmd properties', () => {
    expect(normalizeServerRootDir('C:\\Windows\\System32')).toBeNull();
    expect(
      extractWorkingDirFromAncestorCommands([
        'C:\\WINDOWS\\system32\\cmd.exe /c ""C:\\Users\\penhe\\Desktop\\Minecraft Servers\\ATM 10\\startserver.bat""',
      ])
    ).toBe('C:\\Users\\penhe\\Desktop\\Minecraft Servers\\ATM 10');

    expect(
      extractWorkingDirFromCommandLine(
        '"C:\\Program Files\\Java\\jdk-21\\bin\\java.exe" -Duser.dir="D:\\Game Servers\\ATM 10" -jar server.jar'
      )
    ).toBe('D:\\Game Servers\\ATM 10');

    expect(
      extractWorkingDirFromCommandLine(
        '"C:\\Program Files\\Java\\jdk-21\\bin\\java.exe" -Xmx10G -jar "D:\\Game Servers\\Better MC\\server.jar" nogui'
      )
    ).toBe('D:\\Game Servers\\Better MC');

    expect(
      parseJavaUserDirFromProperties(
        'java.version=21.0.4\nuser.dir=C\\:\\\\Users\\\\penhe\\\\Desktop\\\\Minecraft Servers\\\\ATM 10\nos.name=Windows 11\n'
      )
    ).toBe('C:\\Users\\penhe\\Desktop\\Minecraft Servers\\ATM 10');

    // System32 processCwd falls back cleanly to ancestor cmd.exe script path
    const fallbackResult = normalizeDiscoveredProcesses([
      {
        pid: 700,
        parentPid: 699,
        processName: 'java.exe',
        commandLine: '"C:\\Program Files\\Java\\jdk-21\\bin\\java.exe" @user_jvm_args.txt @libraries\\net\\neoforged\\win_args.txt nogui',
        processCwd: 'C:\\Windows\\System32',
        ancestorCommandLines: [
          'cmd.exe /c ""C:\\Users\\penhe\\Desktop\\Minecraft Servers\\ATM 10\\run.bat""',
        ],
      },
    ]);
    expect(fallbackResult[0].workingDir).toBe('C:\\Users\\penhe\\Desktop\\Minecraft Servers\\ATM 10');
  });

  it('auto-descends into a single nested server subfolder (e.g. ATM 10/Server-Files-2.47) and preserves the parent display name', async () => {
    const sf = await makeApp();
    const { token } = sf.auth.setupInitialAdmin('owner', 'password1234');
    const headers = { authorization: `Bearer ${token}` };

    const wrapperRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'sf-wrap-'));
    cleanups.push(async () => {
      fs.rmSync(wrapperRoot, { recursive: true, force: true });
    });

    const atmWrapper = path.join(wrapperRoot, 'ATM 10');
    const nestedPack = path.join(atmWrapper, 'Server-Files-2.47');
    fs.mkdirSync(nestedPack, { recursive: true });
    populateModdedMinecraftDir(nestedPack);

    const inspectRes = await sf.app.inject({
      method: 'POST',
      url: '/api/import/inspect',
      headers,
      payload: { folderPath: atmWrapper },
    });

    expect(inspectRes.statusCode).toBe(200);
    const info = inspectRes.json();
    expect(info.folderPath).toBe(nestedPack);
    expect(info.autoResolvedFrom).toBe(atmWrapper);
    expect(info.suggestedName).toBe('ATM 10');
    expect(info.modloader).toBe('NeoForge');
    expect(info.modCount).toBe(3);
    expect(info.detectedMemoryMb).toBe(10240);
  });

  it('lists detectedSubfolders when inspecting a parent directory with multiple servers and omits false RCON warnings when server.properties is absent', async () => {
    const sf = await makeApp();
    const { token } = sf.auth.setupInitialAdmin('owner', 'password1234');
    const headers = { authorization: `Bearer ${token}` };

    const parentRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'sf-multi-'));
    cleanups.push(async () => {
      fs.rmSync(parentRoot, { recursive: true, force: true });
    });

    const s1 = path.join(parentRoot, 'ATM 10');
    const s2 = path.join(parentRoot, 'BetterMC');
    const emptyDir = path.join(parentRoot, 'EmptyFolder');
    fs.mkdirSync(s1, { recursive: true });
    fs.mkdirSync(s2, { recursive: true });
    fs.mkdirSync(emptyDir, { recursive: true });
    populateModdedMinecraftDir(s1);
    populateModdedMinecraftDir(s2);

    const multiRes = await sf.app.inject({
      method: 'POST',
      url: '/api/import/inspect',
      headers,
      payload: { folderPath: parentRoot },
    });
    expect(multiRes.statusCode).toBe(200);
    const multiInfo = multiRes.json();
    expect(multiInfo.detectedSubfolders).toHaveLength(2);
    expect(multiInfo.warnings.some((w: string) => w.includes('RCON is currently disabled'))).toBe(false);

    const emptyRes = await sf.app.inject({
      method: 'POST',
      url: '/api/import/inspect',
      headers,
      payload: { folderPath: emptyDir },
    });
    expect(emptyRes.statusCode).toBe(200);
    const emptyInfo = emptyRes.json();
    expect(emptyInfo.warnings.some((w: string) => w.includes('RCON is currently disabled'))).toBe(false);
  });

  it('detects PowerShell .ps1 launch scripts (e.g. ATM 10 startserver.ps1) and exposes folder browser server hints', async () => {
    const sf = await makeApp();
    const { token } = sf.auth.setupInitialAdmin('owner', 'password1234');
    const headers = { authorization: `Bearer ${token}` };

    const parentRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'sf-ps1-'));
    cleanups.push(async () => {
      fs.rmSync(parentRoot, { recursive: true, force: true });
    });

    const ps1Server = path.join(parentRoot, 'ATM10-PS1');
    fs.mkdirSync(path.join(ps1Server, 'libraries', 'net', 'neoforged'), { recursive: true });
    fs.writeFileSync(path.join(ps1Server, 'user_jvm_args.txt'), '-Xmx12G\n', 'utf8');
    fs.writeFileSync(
      path.join(ps1Server, 'startserver.ps1'),
      'java @user_jvm_args.txt @libraries/net/neoforged/win_args.txt nogui\nRead-Host "Press Enter"\n',
      'utf8'
    );

    const inspectRes = await sf.app.inject({
      method: 'POST',
      url: '/api/import/inspect',
      headers,
      payload: { folderPath: ps1Server },
    });
    expect(inspectRes.statusCode).toBe(200);
    const info = inspectRes.json();
    expect(info.modloader).toBe('NeoForge');
    expect(info.detectedMemoryMb).toBe(12288);
    expect(info.launchCandidates.some((c: { script: string; containsPause?: boolean }) => c.script === 'startserver.ps1' && c.containsPause)).toBe(true);

    // Browse parent folder reports server badge on child folder
    const browseParent = await sf.app.inject({
      method: 'GET',
      url: `/api/import/browse?dir=${encodeURIComponent(parentRoot)}`,
      headers,
    });
    expect(browseParent.statusCode).toBe(200);
    const childEntry = browseParent.json().directories.find((d: { name: string }) => d.name === 'ATM10-PS1');
    expect(childEntry?.isServerFolder).toBe(true);
    expect(childEntry?.serverHint).toBe('NeoForge');

    // Browse server folder itself includes currentFolderHint and previewFiles
    const browseChild = await sf.app.inject({
      method: 'GET',
      url: `/api/import/browse?dir=${encodeURIComponent(ps1Server)}`,
      headers,
    });
    expect(browseChild.statusCode).toBe(200);
    expect(browseChild.json().currentFolderHint).toContain('NeoForge');
    expect(browseChild.json().previewFiles).toContain('startserver.ps1');
  });

  it('exposes POST /api/import/pick-folder cleanly (reports unsupported on non-Windows)', async () => {
    if (process.platform === 'win32') return;
    const sf = await makeApp();
    const { token } = sf.auth.setupInitialAdmin('owner', 'password1234');
    const headers = { authorization: `Bearer ${token}` };

    const res = await sf.app.inject({
      method: 'POST',
      url: '/api/import/pick-folder',
      headers,
      payload: {},
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().supported).toBe(false);
    expect(res.json().folderPath).toBeNull();
  });

  it.runIf(process.platform === 'win32')(
    'reads a real Windows process CWD (with spaces in path) via Win32 PEB helper',
    async () => {
      const baseTmp = fs.mkdtempSync(path.join(os.tmpdir(), 'sf-peb-'));
      const spacedDir = path.join(baseTmp, 'Minecraft Servers', 'ATM 10');
      fs.mkdirSync(spacedDir, { recursive: true });
      const child = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 20000)'], {
        cwd: spacedDir,
        windowsHide: true,
        stdio: 'ignore',
      });
      cleanups.push(async () => {
        if (child.exitCode === null && !child.killed) {
          const exited = new Promise<void>((resolve) => {
            const timer = setTimeout(resolve, 3000);
            child.once('exit', () => {
              clearTimeout(timer);
              resolve();
            });
          });
          child.kill();
          await exited;
        }
        try {
          fs.rmSync(baseTmp, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
        } catch {
          // Best-effort temp cleanup on Windows
        }
      });

      expect(child.pid).toBeTruthy();
      const script = buildWindowsPebCwdProbeScript(child.pid!);
      const encoded = encodePowerShellCommand(script);

      const stdout = await new Promise<string>((resolve, reject) => {
        execFile(
          'powershell.exe',
          ['-NoProfile', '-NonInteractive', '-EncodedCommand', encoded],
          { timeout: 15_000, windowsHide: true },
          (err, out) => {
            if (err) reject(err);
            else resolve(out.trim());
          }
        );
      });

      const parsed = JSON.parse(stdout) as { cwd: string | null };
      expect(normalizeServerRootDir(parsed.cwd)?.toLowerCase()).toBe(path.resolve(spacedDir).toLowerCase());
    },
    20_000
  );

  it.runIf(process.platform === 'win32')(
    'compiles and instantiates the native Windows IFileOpenDialog folder picker COM helper cleanly (dry-run)',
    async () => {
      const baseTmp = fs.mkdtempSync(path.join(os.tmpdir(), 'sf-picker-'));
      cleanups.push(async () => {
        fs.rmSync(baseTmp, { recursive: true, force: true });
      });

      const script = buildWindowsFolderPickerScript(baseTmp, true);
      const encoded = encodePowerShellCommand(script);

      const stdout = await new Promise<string>((resolve, reject) => {
        execFile(
          'powershell.exe',
          ['-STA', '-NoProfile', '-NonInteractive', '-EncodedCommand', encoded],
          { timeout: 15_000, windowsHide: true },
          (err, out) => {
            if (err) reject(err);
            else resolve(out.trim());
          }
        );
      });

      const parsed = JSON.parse(stdout) as { supported: boolean; cancelled: boolean; folderPath: string | null; reason?: string };
      expect(parsed.reason).toBeUndefined();
      expect(parsed.supported).toBe(true);
      expect(parsed.cancelled).toBe(false);
      expect(parsed.folderPath).toBe('__DRY_RUN_OK__');
    },
    20_000
  );

  it('smart-inspects a modded NeoForge Minecraft server, links in-place, enables RCON without losing custom properties, backs up, and safely unlinks without deleting files', async () => {
    const sf = await makeApp();
    const { token } = sf.auth.setupInitialAdmin('owner', 'password1234');
    const headers = { authorization: `Bearer ${token}` };

    const existingDir = makeMockModdedMinecraftDir();

    // 1. Browse parent directory works
    const browseRes = await sf.app.inject({
      method: 'GET',
      url: `/api/import/browse?dir=${encodeURIComponent(path.dirname(existingDir))}`,
      headers,
    });
    expect(browseRes.statusCode).toBe(200);
    expect(browseRes.json().directories.some((d: { path: string }) => d.path === existingDir)).toBe(true);

    // 2. Smart Inspect detects NeoForge, 3 mods, 10 GB RAM, run.bat, world, port 25565, and RCON disabled
    const inspectRes = await sf.app.inject({
      method: 'POST',
      url: '/api/import/inspect',
      headers,
      payload: { folderPath: existingDir },
    });
    expect(inspectRes.statusCode).toBe(200);
    const info = inspectRes.json();
    expect(info.detectedGameId).toBe('minecraft-curseforge');
    expect(info.modloader).toBe('NeoForge');
    expect(info.modCount).toBe(3);
    expect(info.worldFolders).toContain('world');
    expect(info.detectedMemoryMb).toBe(10240);
    expect(info.detectedPorts.game).toBe(25565);
    expect(info.rconCurrentlyEnabled).toBe(false);
    expect(info.launchCandidates.some((c: { script: string; containsPause?: boolean }) => c.script === 'run.bat' && c.containsPause)).toBe(true);

    // 3. Execute Link In-Place import with auto-enable RCON
    const importRes = await sf.app.inject({
      method: 'POST',
      url: '/api/import/execute',
      headers,
      payload: {
        folderPath: existingDir,
        mode: 'link',
        name: 'Existing ATM10',
        gameId: info.detectedGameId,
        runtime: 'native',
        launchScript: 'run.bat',
        ports: info.detectedPorts,
        memoryLimitMb: info.detectedMemoryMb,
        config: info.detectedConfig,
        enableRcon: true,
        autoStart: true,
        discordEnabled: true,
      },
    });
    expect(importRes.statusCode).toBe(201);
    const imported = importRes.json();
    expect(imported.externalDir).toBe(existingDir);
    expect(imported.launchScript).toBe('run.bat');
    expect(imported.autoStart).toBe(true);

    // Verify server.properties enabled RCON while preserving custom properties (allow-flight=true, difficulty=hard)
    const updatedProps = parsePropertiesFile(
      fs.readFileSync(path.join(existingDir, 'server.properties'), 'utf8')
    );
    expect(updatedProps['enable-rcon']).toBe('true');
    expect(updatedProps['rcon.port']).toBe('25575');
    expect(updatedProps['rcon.password']).toBeTruthy();
    expect(updatedProps['allow-flight']).toBe('true');
    expect(updatedProps['difficulty']).toBe('hard');

    // 4. Backup archives the linked external folder
    const backupRes = await sf.app.inject({
      method: 'POST',
      url: `/api/instances/${imported.id}/backups`,
      headers,
      payload: { note: 'Linked server snapshot' },
    });
    expect(backupRes.statusCode).toBe(201);
    expect(backupRes.json().sizeBytes).toBeGreaterThan(0);

    // 5. Unlinking (DELETE) removes the ServerForge instance but NEVER deletes original files!
    const delRes = await sf.app.inject({
      method: 'DELETE',
      url: `/api/instances/${imported.id}`,
      headers,
    });
    expect(delRes.statusCode).toBe(200);
    expect(fs.existsSync(path.join(existingDir, 'world', 'level.dat'))).toBe(true);
    expect(fs.existsSync(path.join(existingDir, 'mods', 'create.jar'))).toBe(true);
  });

  it('supports Copy import mode isolating files into ServerForge managed storage', async () => {
    const sf = await makeApp();
    const existingDir = makeMockModdedMinecraftDir();

    const imported = sf.orchestrator.importInstance({
      folderPath: existingDir,
      mode: 'copy',
      name: 'Copied ATM10',
      gameId: 'minecraft-curseforge',
      runtime: 'native',
      launchScript: 'run.bat',
      config: {},
      enableRcon: true,
    });

    expect(imported.externalDir).toBeNull();
    const managedMod = path.join(sf.orchestrator.getInstanceDir(imported.id), 'server', 'mods', 'create.jar');
    expect(fs.existsSync(managedMod)).toBe(true);
  });

  it('defaults newly created servers to local native runtime and allows switching an existing docker server to native', async () => {
    const sf = await makeApp();
    const { token } = sf.auth.setupInitialAdmin('owner', 'password1234');
    const headers = { authorization: `Bearer ${token}` };

    // Creating a CurseForge server without specifying runtime defaults to local native
    const defaultInst = sf.orchestrator.createInstance({
      name: 'Local ATM10',
      gameId: 'minecraft-curseforge',
      config: {},
      discordEnabled: true,
      startImmediately: false,
    });
    expect(defaultInst.runtime).toBe('native');

    // Existing server created under docker can be switched to native via PUT /api/instances/:id
    const dockerInst = sf.orchestrator.createInstance({
      name: 'Legacy Docker MC',
      gameId: 'minecraft-curseforge',
      runtime: 'docker',
      config: {},
      discordEnabled: true,
      startImmediately: false,
    });
    expect(dockerInst.runtime).toBe('docker');

    const switchRes = await sf.app.inject({
      method: 'PATCH',
      url: `/api/instances/${dockerInst.id}/config`,
      headers,
      payload: { runtime: 'native' },
    });
    expect(switchRes.statusCode).toBe(200);
    expect(switchRes.json().runtime).toBe('native');
    expect(sf.orchestrator.getInstance(dockerInst.id)?.runtime).toBe('native');
  });
});
