import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { groupCatalogTemplates } from '@serverforge/shared';
import {
  buildTemplateVariables,
  CatalogService,
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

  it('loads and validates all 6 built-in game YAML manifests', () => {
    const customDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sf-cat-'));
    tempDirs.push(customDir);

    const catalog = new CatalogService(path.join(WORKSPACE_ROOT, 'catalog', 'games'), customDir);
    const ids = catalog.listTemplates().map((t) => t.id).sort();

    expect(ids).toEqual([
      'ark-survival-ascended',
      'factorio',
      'minecraft',
      'minecraft-curseforge',
      'palworld',
      'satisfactory',
    ]);

    const asa = catalog.getTemplate('ark-survival-ascended');
    expect(asa?.runtimes.preferred).toBe('native');
    expect(asa?.runtimes.native?.steamAppId).toBe(2430930);
    expect(asa?.lifecycle.saveCommand).toBe('SaveWorld');
  });

  it('unifies minecraft and minecraft-curseforge into a single deploy tile and supports custom template groups (Issue #37)', () => {
    const customDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sf-cat-group-'));
    tempDirs.push(customDir);

    const catalog = new CatalogService(path.join(WORKSPACE_ROOT, 'catalog', 'games'), customDir);
    const tiles = groupCatalogTemplates(catalog.listTemplates());

    // 6 templates collapse cleanly into 5 deploy tiles
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
    expect(mcTile.variants.map((v) => v.id)).toEqual(['minecraft', 'minecraft-curseforge']);
    expect(mcTile.variants[0].variantLabel).toContain('Standard');
    expect(mcTile.variants[1].variantLabel).toBe('CurseForge Modpack');

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
});
