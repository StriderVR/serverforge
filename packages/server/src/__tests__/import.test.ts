import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { createServerForgeApp, type ServerForgeApp } from '../api/server.js';
import { parsePropertiesFile, parseXmxMemoryMb } from '../services/import-service.js';

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

  function makeMockModdedMinecraftDir(): string {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'atm10-existing-'));
    cleanups.push(async () => {
      fs.rmSync(dir, { recursive: true, force: true });
    });

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
});
