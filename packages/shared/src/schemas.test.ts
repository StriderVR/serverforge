import { describe, expect, it } from 'vitest';
import { CreateInstanceInputSchema, GameTemplateSchema, SystemSettingsSchema } from './index.js';

describe('Shared Zod Schemas', () => {
  it('requires at least one runtime in GameTemplateSchema', () => {
    const res = GameTemplateSchema.safeParse({
      id: 'broken-game',
      name: 'Broken Game',
      shortName: 'Broken',
      description: 'Missing runtimes',
      resources: { minRamGb: 2, recommendedRamGb: 4, minDiskGb: 5 },
      ports: [{ key: 'game', label: 'Game', defaultPort: 7777, protocol: 'udp' }],
      runtimes: { preferred: 'docker' },
    });
    expect(res.success).toBe(false);
  });

  it('validates CreateInstanceInputSchema defaults cleanly', () => {
    const parsed = CreateInstanceInputSchema.parse({
      name: 'Friends Minecraft',
      gameId: 'minecraft',
    });
    expect(parsed.discordEnabled).toBe(true);
    expect(parsed.startImmediately).toBe(false);
    expect(parsed.config).toEqual({});
  });

  it('applies sensible defaults in SystemSettingsSchema', () => {
    const settings = SystemSettingsSchema.parse({});
    expect(settings.maxConcurrentServers).toBe(2);
    expect(settings.hostRamReserveGb).toBe(4);
    expect(settings.defaultIdleTimeoutMinutes).toBe(30);
    expect(settings.warningBeforeStopMinutes).toBe(10);
  });

  it('accepts GameTemplateSchema with and without optional connectSteps', () => {
    const baseTemplate = {
      id: 'sample-game',
      name: 'Sample Game',
      shortName: 'Sample',
      description: 'Test game template',
      resources: { minRamGb: 2, recommendedRamGb: 4, minDiskGb: 5 },
      ports: [{ key: 'game', label: 'Game', defaultPort: 7777, protocol: 'udp' as const }],
      runtimes: { preferred: 'docker' as const, docker: { image: 'example/game:latest' } },
    };

    const withoutSteps = GameTemplateSchema.parse(baseTemplate);
    expect(withoutSteps.connectSteps).toBeUndefined();

    const withSteps = GameTemplateSchema.parse({
      ...baseTemplate,
      connectSteps: ['  Open game  ', 'Connect to {address} (host {host}, port {port})'],
    });
    expect(withSteps.connectSteps).toEqual([
      'Open game',
      'Connect to {address} (host {host}, port {port})',
    ]);
  });

  it('rejects invalid connectSteps entries in GameTemplateSchema', () => {
    const baseTemplate = {
      id: 'sample-game',
      name: 'Sample Game',
      shortName: 'Sample',
      description: 'Test game template',
      resources: { minRamGb: 2, recommendedRamGb: 4, minDiskGb: 5 },
      ports: [{ key: 'game', label: 'Game', defaultPort: 7777, protocol: 'udp' as const }],
      runtimes: { preferred: 'docker' as const, docker: { image: 'example/game:latest' } },
    };

    expect(GameTemplateSchema.safeParse({ ...baseTemplate, connectSteps: ['Open game', ''] }).success).toBe(false);
    expect(GameTemplateSchema.safeParse({ ...baseTemplate, connectSteps: ['   '] }).success).toBe(false);
    expect(GameTemplateSchema.safeParse({ ...baseTemplate, connectSteps: 'Open game' }).success).toBe(false);
    expect(GameTemplateSchema.safeParse({ ...baseTemplate, connectSteps: [123] }).success).toBe(false);
  });
});
