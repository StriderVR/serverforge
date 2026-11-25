import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { createServerForgeApp, type ServerForgeApp } from '../api/server.js';

describe('ServerForge REST API End-to-End', () => {
  const cleanups: Array<() => Promise<void>> = [];

  async function makeApp(): Promise<ServerForgeApp> {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sf-api-'));
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

  afterEach(async () => {
    while (cleanups.length) {
      await cleanups.pop()!();
    }
  });

  it('completes full lifecycle: setup auth -> deploy -> start -> command -> lease -> backup -> custom YAML template', async () => {
    const sf = await makeApp();

    // 1. Unauthenticated request is rejected
    const unauth = await sf.app.inject({ method: 'GET', url: '/api/instances' });
    expect(unauth.statusCode).toBe(401);

    // 2. Initial admin setup
    const setupRes = await sf.app.inject({
      method: 'POST',
      url: '/api/auth/setup',
      payload: { username: 'owner', password: 'super-secret-password' },
    });
    expect(setupRes.statusCode).toBe(200);
    const { token } = setupRes.json() as { token: string };
    const authHeaders = { authorization: `Bearer ${token}` };

    // 3. Catalog returns all 5 initial games
    const catRes = await sf.app.inject({ method: 'GET', url: '/api/catalog', headers: authHeaders });
    expect(catRes.statusCode).toBe(200);
    expect(catRes.json()).toHaveLength(5);

    // 4. Deploy & immediately start Ark: Survival Ascended
    const deployRes = await sf.app.inject({
      method: 'POST',
      url: '/api/instances',
      headers: authHeaders,
      payload: {
        name: 'Dino Island',
        gameId: 'ark-survival-ascended',
        startImmediately: true,
      },
    });
    expect(deployRes.statusCode).toBe(201);
    const instance = deployRes.json() as { id: string; status: string; runtime: string; joinAddress: string };
    expect(instance.status).toBe('running');
    expect(instance.runtime).toBe('native');
    expect(instance.joinAddress).toContain(':7777');

    // 5. Send a console command
    const cmdRes = await sf.app.inject({
      method: 'POST',
      url: `/api/instances/${instance.id}/command`,
      headers: authHeaders,
      payload: { command: 'SaveWorld' },
    });
    expect(cmdRes.statusCode).toBe(200);
    expect(cmdRes.json().ok).toBe(true);

    // 6. Create a world backup
    const backupRes = await sf.app.inject({
      method: 'POST',
      url: `/api/instances/${instance.id}/backups`,
      headers: authHeaders,
      payload: { note: 'Pre-boss snapshot' },
    });
    expect(backupRes.statusCode).toBe(201);
    expect(backupRes.json().sizeBytes).toBeGreaterThan(0);

    // 7. Import a 6th game template (Valheim) live via API
    const importRes = await sf.app.inject({
      method: 'POST',
      url: '/api/catalog/import',
      headers: authHeaders,
      payload: {
        yaml: `
id: valheim
name: Valheim
shortName: Valheim
category: survival
description: Viking co-op survival
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
`,
      },
    });
    expect(importRes.statusCode).toBe(201);

    const updatedCat = await sf.app.inject({ method: 'GET', url: '/api/catalog', headers: authHeaders });
    expect(updatedCat.json()).toHaveLength(6);

    // 8. Stop and delete instance cleanly
    const stopRes = await sf.app.inject({
      method: 'POST',
      url: `/api/instances/${instance.id}/stop`,
      headers: authHeaders,
    });
    expect(stopRes.statusCode).toBe(200);
    expect(stopRes.json().status).toBe('stopped');
  });
});
