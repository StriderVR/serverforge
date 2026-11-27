import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import YAML from 'yaml';
import { groupCatalogTemplates } from '@serverforge/shared';
import {
  buildTemplateVariables,
  CatalogService,
  DEFAULT_BUILTIN_CONNECT_STEPS,
  renderTemplateString,
} from '../catalog/catalog-service.js';
import { WORKSPACE_ROOT } from '../config.js';

describe('CatalogService & Built-in Game Templates', () => {
  const tempDirs: string[] = [];

  afterEach(() => {
    for (const dir of tempDirs.splice(0)) {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('loads and validates all 7 built-in game YAML manifests', () => {
    const customDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sf-cat-'));
    tempDirs.push(customDir);

    const catalog = new CatalogService(path.join(WORKSPACE_ROOT, 'catalog', 'games'), customDir);
    const ids = catalog.listTemplates().map((t) => t.id).sort();

    expect(ids).toEqual([
      'ark-survival-ascended',
      'factorio',
      'minecraft',
      'minecraft-curseforge',
      'minecraft-modrinth',
      'palworld',
      'satisfactory',
    ]);

    const asa = catalog.getTemplate('ark-survival-ascended');
    expect(asa?.runtimes.preferred).toBe('native');
    expect(asa?.runtimes.native?.steamAppId).toBe(2430930);
    expect(asa?.lifecycle.saveCommand).toBe('SaveWorld');
  });

  it('unifies minecraft, minecraft-curseforge, and minecraft-modrinth into a single deploy tile (Issues #14, #37)', () => {
    const customDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sf-cat-group-'));
    tempDirs.push(customDir);

    const catalog = new CatalogService(path.join(WORKSPACE_ROOT, 'catalog', 'games'), customDir);
    const tiles = groupCatalogTemplates(catalog.listTemplates());

    // 7 templates collapse cleanly into 5 deploy tiles
    expect(tiles.map((t) => t.key)).toEqual([
      'ark-survival-ascended',
      'factorio',
      'minecraft',
      'palworld',
      'satisfactory',
    ]);

    const mcTile = tiles.find((t) => t.key === 'minecraft')!;
    expect(mcTile.name).toBe('Minecraft');
    expect(mcTile.minRamGb).toBe(2);
    expect(mcTile.hasNative).toBe(true);
    expect(mcTile.variants.map((v) => v.id)).toEqual([
      'minecraft',
      'minecraft-curseforge',
      'minecraft-modrinth',
    ]);
    expect(mcTile.variants[0].variantLabel).toContain('Standard');
    expect(mcTile.variants[1].variantLabel).toBe('CurseForge Modpack');
    expect(mcTile.variants[2].variantLabel).toBe('Modrinth Modpack');

    // Backwards compatibility: both underlying template IDs remain independently resolvable
    expect(catalog.getTemplate('minecraft')).not.toBeNull();
    expect(catalog.getTemplate('minecraft-curseforge')).not.toBeNull();

    // Verify legacy YAML files on disk without group metadata are auto-normalized
    const legacyDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sf-cat-legacy-'));
    tempDirs.push(legacyDir);
    for (const filename of ['minecraft.yaml', 'minecraft-curseforge.yaml']) {
      const stripped = fs
        .readFileSync(path.join(WORKSPACE_ROOT, 'catalog', 'games', filename), 'utf8')
        .replace(/^(group|groupName|groupDescription|variantLabel|variantDescription|variantOrder):.*\n/gm, '');
      fs.writeFileSync(path.join(legacyDir, filename), stripped, 'utf8');
    }
    const legacyCatalog = new CatalogService(legacyDir, customDir);
    const legacyTiles = groupCatalogTemplates(legacyCatalog.listTemplates());
    expect(legacyTiles).toHaveLength(1);
    expect(legacyTiles[0].key).toBe('minecraft');
    expect(legacyTiles[0].variants.map((v) => v.id)).toEqual(['minecraft', 'minecraft-curseforge']);

    // Verify legacy satisfactory.yaml without the 1.1+ reliable TCP port is auto-upgraded
    const staleSatYaml = fs
      .readFileSync(path.join(WORKSPACE_ROOT, 'catalog', 'games', 'satisfactory.yaml'), 'utf8')
      .replace(/\s+- key: reliable[\s\S]*?protocol: tcp\n/, '\n');
    fs.writeFileSync(path.join(legacyDir, 'satisfactory.yaml'), staleSatYaml, 'utf8');
    legacyCatalog.reload();
    const migratedSat = legacyCatalog.getTemplate('satisfactory')!;
    expect(migratedSat.ports.map((p) => p.key)).toEqual(['game', 'reliable']);
    expect(migratedSat.ports.find((p) => p.key === 'reliable')).toMatchObject({
      defaultPort: 8888,
      protocol: 'tcp',
    });
  });

  it('interpolates config, ports, and memory template placeholders', () => {
    const vars = buildTemplateVariables({
      config: { MAP: 'TheIsland_WP', MAX_PLAYERS: 12 },
      ports: { game: 7777, rcon: 27020 },
      memoryLimitMb: 16384,
      publicHost: '100.64.0.10',
    });

    const rendered = renderTemplateString(
      '{{MAP}}?Port={{PORT_GAME}}?RCONPort={{PORT_RCON}} -Max={{MAX_PLAYERS}} -Mem={{MEMORY_MB}}',
      vars
    );
    expect(rendered).toBe('TheIsland_WP?Port=7777?RCONPort=27020 -Max=12 -Mem=16384');
  });

  it('validates, imports, and deletes custom YAML game templates', () => {
    const customDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sf-cat-'));
    tempDirs.push(customDir);
    const catalog = new CatalogService(path.join(WORKSPACE_ROOT, 'catalog', 'games'), customDir);

    const invalid = catalog.validateYaml('id: bad\nname: Missing Ports');
    expect(invalid.valid).toBe(false);

    const valheimYaml = `
id: valheim
name: Valheim
shortName: Valheim
category: survival
description: Viking co-op survival server
resources:
  minRamGb: 4
  recommendedRamGb: 6
  minDiskGb: 5
ports:
  - key: game
    label: Game Port
    defaultPort: 2456
    protocol: udp
    primary: true
runtimes:
  preferred: docker
  docker:
    image: lloesche/valheim-server:latest
`;
    const imported = catalog.importCustomTemplate(valheimYaml);
    expect(imported.id).toBe('valheim');
    expect(imported.isCustom).toBe(true);
    expect(catalog.getTemplate('valheim')).not.toBeNull();

    // Built-in templates cannot be deleted
    expect(catalog.deleteCustomTemplate('minecraft')).toBe(false);
    // Custom templates can be deleted
    expect(catalog.deleteCustomTemplate('valheim')).toBe(true);
    expect(catalog.getTemplate('valheim')).toBeNull();
  });

  it('populates valid connectSteps for all 7 built-in game templates', () => {
    const customDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sf-cat-steps-'));
    tempDirs.push(customDir);

    const catalog = new CatalogService(path.join(WORKSPACE_ROOT, 'catalog', 'games'), customDir);
    const builtInIds = [
      'ark-survival-ascended',
      'factorio',
      'minecraft',
      'minecraft-curseforge',
      'minecraft-modrinth',
      'palworld',
      'satisfactory',
    ];

    for (const id of builtInIds) {
      const tpl = catalog.getTemplate(id);
      expect(tpl, `Missing template ${id}`).not.toBeNull();
      expect(tpl!.connectSteps).toBeDefined();
      expect(tpl!.connectSteps!.length).toBeGreaterThanOrEqual(2);
      for (const step of tpl!.connectSteps!) {
        expect(step.trim().length).toBeGreaterThan(0);
        expect(step).not.toMatch(/RCON_PASSWORD|ADMIN_PASSWORD|SERVER_PASSWORD/i);
        expect(step.toLowerCase()).not.toContain('localhost');
        expect(step.toLowerCase()).not.toContain('dashboard');
      }
      const joined = tpl!.connectSteps!.join(' ');
      expect(joined.includes('{address}') || (joined.includes('{host}') && joined.includes('{port}'))).toBe(true);
      expect(tpl!.connectSteps).toEqual([...DEFAULT_BUILTIN_CONNECT_STEPS[id]]);
    }
  });

  it('backfills default connectSteps for legacy built-in YAMLs without overwriting custom built-in steps', () => {
    const legacyDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sf-cat-legacy-steps-'));
    const customDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sf-cat-custom-steps-'));
    tempDirs.push(legacyDir, customDir);

    const builtInDir = path.join(WORKSPACE_ROOT, 'catalog', 'games');
    const yamlFiles = fs.readdirSync(builtInDir).filter((f) => f.endsWith('.yaml'));
    for (const file of yamlFiles) {
      const doc = YAML.parse(fs.readFileSync(path.join(builtInDir, file), 'utf8')) as Record<string, unknown>;
      delete doc.connectSteps;
      fs.writeFileSync(path.join(legacyDir, file), YAML.stringify(doc), 'utf8');
    }

    const legacyCatalog = new CatalogService(legacyDir, customDir);
    for (const [id, expectedSteps] of Object.entries(DEFAULT_BUILTIN_CONNECT_STEPS)) {
      const tpl = legacyCatalog.getTemplate(id);
      expect(tpl?.connectSteps).toEqual([...expectedSteps]);
    }

    // Mutating returned array must not mutate DEFAULT_BUILTIN_CONNECT_STEPS
    const mcSteps = legacyCatalog.getTemplate('minecraft')!.connectSteps!;
    const originalLen = DEFAULT_BUILTIN_CONNECT_STEPS.minecraft.length;
    mcSteps.push('mutated step');
    expect(DEFAULT_BUILTIN_CONNECT_STEPS.minecraft).toHaveLength(originalLen);

    // User-edited built-in YAML with custom connectSteps must be preserved verbatim
    const customBuiltInDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sf-cat-edited-builtin-'));
    tempDirs.push(customBuiltInDir);
    const mcDoc = YAML.parse(fs.readFileSync(path.join(builtInDir, 'minecraft.yaml'), 'utf8')) as Record<string, unknown>;
    mcDoc.connectSteps = ['Custom server step for {address}'];
    fs.writeFileSync(path.join(customBuiltInDir, 'minecraft.yaml'), YAML.stringify(mcDoc), 'utf8');

    const editedCatalog = new CatalogService(customBuiltInDir, customDir);
    expect(editedCatalog.getTemplate('minecraft')?.connectSteps).toEqual(['Custom server step for {address}']);
  });

  it('preserves custom or omitted connectSteps on custom templates and rejects invalid connectSteps YAML', () => {
    const customDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sf-cat-custom-cs-'));
    tempDirs.push(customDir);
    const catalog = new CatalogService(path.join(WORKSPACE_ROOT, 'catalog', 'games'), customDir);

    const valheimNoSteps = `
id: valheim
name: Valheim
shortName: Valheim
category: survival
description: Viking co-op survival server
resources:
  minRamGb: 4
  recommendedRamGb: 6
  minDiskGb: 5
ports:
  - key: game
    label: Game Port
    defaultPort: 2456
    protocol: udp
    primary: true
runtimes:
  preferred: docker
  docker:
    image: lloesche/valheim-server:latest
`;
    const importedValheim = catalog.importCustomTemplate(valheimNoSteps);
    expect(importedValheim.connectSteps).toBeUndefined();
    catalog.reload();
    expect(catalog.getTemplate('valheim')?.connectSteps).toBeUndefined();

    const terrariaWithSteps = `
id: terraria
name: Terraria
shortName: Terraria
category: sandbox
description: Terraria server
connectSteps:
  - "Open Terraria -> Multiplayer -> Join via IP"
  - "Enter {host} and port {port}"
resources:
  minRamGb: 1
  recommendedRamGb: 2
  minDiskGb: 2
ports:
  - key: game
    label: Game Port
    defaultPort: 7777
    protocol: tcp
    primary: true
runtimes:
  preferred: docker
  docker:
    image: ryshe/terraria:latest
`;
    const importedTerraria = catalog.importCustomTemplate(terrariaWithSteps);
    expect(importedTerraria.connectSteps).toEqual([
      'Open Terraria -> Multiplayer -> Join via IP',
      'Enter {host} and port {port}',
    ]);
    catalog.reload();
    expect(catalog.getTemplate('terraria')?.connectSteps).toEqual([
      'Open Terraria -> Multiplayer -> Join via IP',
      'Enter {host} and port {port}',
    ]);

    const invalidStepsYaml = terrariaWithSteps.replace(
      '  - "Open Terraria -> Multiplayer -> Join via IP"',
      '  - ""'
    );
    const validation = catalog.validateYaml(invalidStepsYaml);
    expect(validation.valid).toBe(false);
    if (!validation.valid) {
      expect(validation.errors.some((e) => e.includes('connectSteps'))).toBe(true);
    }
  });
});
