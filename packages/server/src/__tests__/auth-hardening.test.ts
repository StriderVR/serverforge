import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { createServerForgeApp, type ServerForgeApp } from '../api/server.js';
import { generateTotpCode } from '../auth/totp.js';

const tmpDirs: string[] = [];
const apps: ServerForgeApp[] = [];

async function makeApp(): Promise<ServerForgeApp> {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sf-auth-hardening-'));
  tmpDirs.push(dir);
  const sf = await createServerForgeApp({
    dataDir: dir,
    runtimeMode: 'mock',
    publicHost: '127.0.0.1',
  });
  apps.push(sf);
  return sf;
}

afterEach(async () => {
  while (apps.length > 0) {
    await apps.pop()!.close();
  }
  while (tmpDirs.length > 0) {
    fs.rmSync(tmpDirs.pop()!, { recursive: true, force: true });
  }
});

describe('Auth Hardening — Rate Limiting, Sessions, Password Rotation & TOTP 2FA (#62)', () => {
  it('enforces progressive login rate-limiting with HTTP 429 and Retry-After', async () => {
    const sf = await makeApp();

    const setup = await sf.app.inject({
      method: 'POST',
      url: '/api/auth/setup',
      payload: { username: 'admin', password: 'initial-password-123' },
    });
    expect(setup.statusCode).toBe(200);

    // 4 wrong attempts -> 401
    for (let i = 0; i < 4; i++) {
      const res = await sf.app.inject({
        method: 'POST',
        url: '/api/auth/login',
        payload: { username: 'admin', password: 'wrong-password' },
      });
      expect(res.statusCode).toBe(401);
    }

    // 5th wrong attempt triggers 60s lockout -> 429 + Retry-After
    const fifth = await sf.app.inject({
      method: 'POST',
      url: '/api/auth/login',
      payload: { username: 'admin', password: 'wrong-password' },
    });
    expect(fifth.statusCode).toBe(429);
    expect(Number(fifth.headers['retry-after'])).toBeGreaterThanOrEqual(55);

    // Even a valid password is rejected while locked out
    const lockedAttempt = await sf.app.inject({
      method: 'POST',
      url: '/api/auth/login',
      payload: { username: 'admin', password: 'initial-password-123' },
    });
    expect(lockedAttempt.statusCode).toBe(429);
    expect(Number(lockedAttempt.headers['retry-after'])).toBeGreaterThanOrEqual(50);
  });

  it('tracks active SQLite sessions and immediately invalidates revoked sessions', async () => {
    const sf = await makeApp();

    const setup = await sf.app.inject({
      method: 'POST',
      url: '/api/auth/setup',
      headers: { 'user-agent': 'Chrome/120 Windows' },
      payload: { username: 'admin', password: 'initial-password-123' },
    });
    const token1 = (setup.json() as { token: string }).token;

    const login2 = await sf.app.inject({
      method: 'POST',
      url: '/api/auth/login',
      headers: { 'user-agent': 'Firefox/122 Linux' },
      payload: { username: 'admin', password: 'initial-password-123' },
    });
    const token2 = (login2.json() as { token: string }).token;

    const listRes = await sf.app.inject({
      method: 'GET',
      url: '/api/auth/sessions',
      headers: { authorization: `Bearer ${token1}` },
    });
    expect(listRes.statusCode).toBe(200);
    const sessions = listRes.json() as Array<{ id: string; isCurrent: boolean; userAgent: string }>;
    expect(sessions).toHaveLength(2);
    const other = sessions.find((s) => !s.isCurrent)!;
    expect(other).toBeDefined();

    // Revoke session 2
    const revokeRes = await sf.app.inject({
      method: 'DELETE',
      url: `/api/auth/sessions/${other.id}`,
      headers: { authorization: `Bearer ${token1}` },
    });
    expect(revokeRes.statusCode).toBe(200);

    // Token 2 is now immediately rejected
    const check2 = await sf.app.inject({
      method: 'GET',
      url: '/api/settings',
      headers: { authorization: `Bearer ${token2}` },
    });
    expect(check2.statusCode).toBe(401);

    // Token 1 is still valid
    const check1 = await sf.app.inject({
      method: 'GET',
      url: '/api/settings',
      headers: { authorization: `Bearer ${token1}` },
    });
    expect(check1.statusCode).toBe(200);

    // Sign out all devices (including current)
    const revokeAll = await sf.app.inject({
      method: 'POST',
      url: '/api/auth/sessions/revoke-all',
      headers: { authorization: `Bearer ${token1}` },
      payload: { keepCurrent: false },
    });
    expect(revokeAll.statusCode).toBe(200);

    const check1After = await sf.app.inject({
      method: 'GET',
      url: '/api/settings',
      headers: { authorization: `Bearer ${token1}` },
    });
    expect(check1After.statusCode).toBe(401);
  });

  it('rotates admin password and revokes all other sessions', async () => {
    const sf = await makeApp();

    const setup = await sf.app.inject({
      method: 'POST',
      url: '/api/auth/setup',
      payload: { username: 'admin', password: 'old-password-123' },
    });
    const token1 = (setup.json() as { token: string }).token;

    const login2 = await sf.app.inject({
      method: 'POST',
      url: '/api/auth/login',
      payload: { username: 'admin', password: 'old-password-123' },
    });
    const token2 = (login2.json() as { token: string }).token;

    // Reject wrong current password
    const badChange = await sf.app.inject({
      method: 'POST',
      url: '/api/auth/change-password',
      headers: { authorization: `Bearer ${token1}` },
      payload: { currentPassword: 'wrong', newPassword: 'new-password-456' },
    });
    expect(badChange.statusCode).toBe(400);

    // Valid password change keeps token1 and revokes token2
    const goodChange = await sf.app.inject({
      method: 'POST',
      url: '/api/auth/change-password',
      headers: { authorization: `Bearer ${token1}` },
      payload: { currentPassword: 'old-password-123', newPassword: 'new-password-456' },
    });
    expect(goodChange.statusCode).toBe(200);
    expect((goodChange.json() as { revokedOtherSessions: number }).revokedOtherSessions).toBe(1);

    expect(
      (await sf.app.inject({ method: 'GET', url: '/api/settings', headers: { authorization: `Bearer ${token2}` } }))
        .statusCode
    ).toBe(401);
    expect(
      (await sf.app.inject({ method: 'GET', url: '/api/settings', headers: { authorization: `Bearer ${token1}` } }))
        .statusCode
    ).toBe(200);

    // Can log in with new password
    const loginNew = await sf.app.inject({
      method: 'POST',
      url: '/api/auth/login',
      payload: { username: 'admin', password: 'new-password-456' },
    });
    expect(loginNew.statusCode).toBe(200);
  });

  it('supports opt-in TOTP 2FA enrollment, verification, single-use recovery codes, and disable', async () => {
    const sf = await makeApp();

    const setup = await sf.app.inject({
      method: 'POST',
      url: '/api/auth/setup',
      payload: { username: 'admin', password: 'totp-password-123' },
    });
    const token = (setup.json() as { token: string }).token;

    // Begin enrollment
    const enrollRes = await sf.app.inject({
      method: 'POST',
      url: '/api/auth/totp/enroll',
      headers: { authorization: `Bearer ${token}` },
      payload: {},
    });
    expect(enrollRes.statusCode).toBe(200);
    const enrollment = enrollRes.json() as {
      secret: string;
      otpAuthUri: string;
      recoveryCodes: string[];
    };
    expect(enrollment.secret.length).toBeGreaterThanOrEqual(16);
    expect(enrollment.otpAuthUri).toContain('otpauth://totp/');
    expect(enrollment.recoveryCodes).toHaveLength(8);

    // Reject invalid code during enable
    const badEnable = await sf.app.inject({
      method: 'POST',
      url: '/api/auth/totp/enable',
      headers: { authorization: `Bearer ${token}` },
      payload: { code: '000000' },
    });
    // Extremely rare 1-in-1M collision check only if 000000 isn't current code
    if (generateTotpCode(enrollment.secret) !== '000000') {
      expect(badEnable.statusCode).toBe(400);
    }

    // Enable with valid TOTP code
    const validCode = generateTotpCode(enrollment.secret);
    const enableRes = await sf.app.inject({
      method: 'POST',
      url: '/api/auth/totp/enable',
      headers: { authorization: `Bearer ${token}` },
      payload: { code: validCode },
    });
    expect(enableRes.statusCode).toBe(200);
    expect((enableRes.json() as { enabled: boolean; recoveryCodesRemaining: number })).toEqual({
      enabled: true,
      recoveryCodesRemaining: 8,
    });

    // Login without TOTP code prompts requiresTotp: true
    const step1 = await sf.app.inject({
      method: 'POST',
      url: '/api/auth/login',
      payload: { username: 'admin', password: 'totp-password-123' },
    });
    expect(step1.statusCode).toBe(200);
    expect((step1.json() as { requiresTotp?: boolean }).requiresTotp).toBe(true);

    // Login with valid TOTP code succeeds
    const step2 = await sf.app.inject({
      method: 'POST',
      url: '/api/auth/login',
      payload: {
        username: 'admin',
        password: 'totp-password-123',
        totpCode: generateTotpCode(enrollment.secret),
      },
    });
    expect(step2.statusCode).toBe(200);
    expect((step2.json() as { token?: string }).token).toBeTruthy();

    // Login with single-use recovery code succeeds once and consumes it
    const recoveryCode = enrollment.recoveryCodes[0];
    const rec1 = await sf.app.inject({
      method: 'POST',
      url: '/api/auth/login',
      payload: {
        username: 'admin',
        password: 'totp-password-123',
        totpCode: recoveryCode,
      },
    });
    expect(rec1.statusCode).toBe(200);
    expect((rec1.json() as { usedRecoveryCode: boolean; recoveryCodesRemaining: number })).toMatchObject({
      usedRecoveryCode: true,
      recoveryCodesRemaining: 7,
    });

    // Reusing the same recovery code fails
    const rec2 = await sf.app.inject({
      method: 'POST',
      url: '/api/auth/login',
      payload: {
        username: 'admin',
        password: 'totp-password-123',
        totpCode: recoveryCode,
      },
    });
    expect(rec2.statusCode).toBe(401);

    // Disable 2FA with current password
    const disableRes = await sf.app.inject({
      method: 'POST',
      url: '/api/auth/totp/disable',
      headers: { authorization: `Bearer ${token}` },
      payload: { currentPassword: 'totp-password-123' },
    });
    expect(disableRes.statusCode).toBe(200);
    expect((disableRes.json() as { enabled: boolean }).enabled).toBe(false);

    // Login now succeeds without TOTP code
    const plainLogin = await sf.app.inject({
      method: 'POST',
      url: '/api/auth/login',
      payload: { username: 'admin', password: 'totp-password-123' },
    });
    expect(plainLogin.statusCode).toBe(200);
    expect((plainLogin.json() as { token?: string; requiresTotp?: boolean }).token).toBeTruthy();
  });
});
