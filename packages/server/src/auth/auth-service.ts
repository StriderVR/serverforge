import crypto from 'node:crypto';
import type { AuthSessionSummary, TotpEnrollmentPayload, TotpStatus } from '@serverforge/shared';
import type { AppDatabase, UserRecord } from '../db/database.js';
import {
  LoginRateLimiter,
  buildOtpAuthUri,
  consumeRecoveryCode,
  generateRecoveryCodes,
  generateTotpSecret,
  hashRecoveryCode,
  verifyTotpCode,
} from './totp.js';

export interface AuthTokenPayload {
  sub: string;
  username: string;
  role: 'admin';
  jti?: string;
  iat: number;
  exp: number;
}

export interface AuthRequestMeta {
  ip?: string;
  userAgent?: string;
  totpCode?: string;
}

export type AuthenticateResult =
  | {
      ok: true;
      user: UserRecord;
      token: string;
      sessionId: string;
      isNewIp: boolean;
      usedRecoveryCode: boolean;
      recoveryCodesRemaining: number;
    }
  | {
      ok: false;
      reason: 'rate_limited';
      retryAfterSeconds: number;
      failures: number;
    }
  | {
      ok: false;
      reason: 'totp_required';
      user: UserRecord;
    }
  | {
      ok: false;
      reason: 'invalid_totp' | 'invalid_credentials';
      failures: number;
      locked: boolean;
      retryAfterSeconds: number;
      newlyLocked: boolean;
    };

const TOKEN_TTL_SECONDS = 60 * 60 * 24 * 7; // 7 days
const SESSION_TOUCH_INTERVAL_MS = 60_000;
const PENDING_TOTP_TTL_MS = 15 * 60_000;

interface PendingTotpEnrollment {
  secret: string;
  recoveryCodes: string[];
  createdAtMs: number;
}

export class AuthService {
  public readonly rateLimiter = new LoginRateLimiter();
  private readonly pendingEnrollments = new Map<string, PendingTotpEnrollment>();
  private recentFailureTimestamps: number[] = [];

  constructor(
    private readonly db: AppDatabase,
    private readonly jwtSecret: string
  ) {}

  needsInitialSetup(): boolean {
    return this.db.countUsers() === 0;
  }

  getRecentFailedLoginCount(windowMs = 24 * 60 * 60_000): number {
    const cutoff = Date.now() - windowMs;
    this.recentFailureTimestamps = this.recentFailureTimestamps.filter((ts) => ts >= cutoff);
    return this.recentFailureTimestamps.length;
  }

  private trackFailureTimestamp(): void {
    const now = Date.now();
    this.recentFailureTimestamps.push(now);
    const cutoff = now - 24 * 60 * 60_000;
    if (this.recentFailureTimestamps.length > 500) {
      this.recentFailureTimestamps = this.recentFailureTimestamps.filter((ts) => ts >= cutoff);
    }
  }

  hashPassword(password: string): string {
    const salt = crypto.randomBytes(16).toString('hex');
    const derived = crypto.scryptSync(password, salt, 64).toString('hex');
    return `${salt}:${derived}`;
  }

  verifyPassword(password: string, storedHash: string): boolean {
    const [salt, keyHex] = storedHash.split(':');
    if (!salt || !keyHex) return false;
    const derived = crypto.scryptSync(password, salt, 64);
    const keyBuf = Buffer.from(keyHex, 'hex');
    if (derived.length !== keyBuf.length) return false;
    return crypto.timingSafeEqual(derived, keyBuf);
  }

  private createSessionAndToken(
    user: UserRecord,
    meta?: Pick<AuthRequestMeta, 'ip' | 'userAgent'>
  ): { token: string; sessionId: string } {
    const expiresAt = new Date(Date.now() + TOKEN_TTL_SECONDS * 1000).toISOString();
    const session = this.db.createSession({
      userId: user.id,
      ip: (meta?.ip ?? '').trim() || '127.0.0.1',
      userAgent: (meta?.userAgent ?? '').trim() || 'Unknown client',
      expiresAt,
    });
    const token = this.signToken(user, session.id);
    return { token, sessionId: session.id };
  }

  setupInitialAdmin(
    username: string,
    password: string,
    meta?: Pick<AuthRequestMeta, 'ip' | 'userAgent'>
  ): { user: UserRecord; token: string; sessionId: string } {
    if (!this.needsInitialSetup()) {
      throw new Error('Initial admin account is already configured.');
    }
    const trimmed = username.trim();
    if (trimmed.length < 3 || trimmed.length > 32) {
      throw new Error('Username must be between 3 and 32 characters.');
    }
    if (password.length < 8) {
      throw new Error('Password must be at least 8 characters long.');
    }
    const user = this.db.createUser(trimmed, this.hashPassword(password));
    const { token, sessionId } = this.createSessionAndToken(user, meta);
    return { user, token, sessionId };
  }

  authenticate(username: string, password: string, meta?: AuthRequestMeta): AuthenticateResult {
    const trimmedUser = username.trim();
    const clientIp = (meta?.ip ?? '').trim() || '127.0.0.1';

    const limitCheck = this.rateLimiter.check(clientIp, trimmedUser);
    if (!limitCheck.allowed) {
      return {
        ok: false,
        reason: 'rate_limited',
        retryAfterSeconds: limitCheck.retryAfterSeconds,
        failures: limitCheck.failures,
      };
    }

    const user = this.db.findUserByUsername(trimmedUser);
    if (!user || !this.verifyPassword(password, user.passwordHash)) {
      this.trackFailureTimestamp();
      const recorded = this.rateLimiter.recordFailure(clientIp, trimmedUser);
      return {
        ok: false,
        reason: 'invalid_credentials',
        failures: recorded.failures,
        locked: recorded.locked,
        retryAfterSeconds: recorded.retryAfterSeconds,
        newlyLocked: recorded.newlyLocked,
      };
    }

    let usedRecoveryCode = false;
    let recoveryCodesRemaining = user.recoveryCodes.length;

    if (user.totpEnabled && user.totpSecret) {
      const code = (meta?.totpCode ?? '').trim();
      if (!code) {
        return { ok: false, reason: 'totp_required', user };
      }

      const totpOk = verifyTotpCode(user.totpSecret, code);
      if (!totpOk) {
        const recovery = consumeRecoveryCode(code, user.recoveryCodes);
        if (recovery.matched) {
          usedRecoveryCode = true;
          recoveryCodesRemaining = recovery.remaining.length;
          this.db.updateUserTotp(user.id, user.totpSecret, true, recovery.remaining);
        } else {
          this.trackFailureTimestamp();
          const recorded = this.rateLimiter.recordFailure(clientIp, trimmedUser);
          return {
            ok: false,
            reason: 'invalid_totp',
            failures: recorded.failures,
            locked: recorded.locked,
            retryAfterSeconds: recorded.retryAfterSeconds,
            newlyLocked: recorded.newlyLocked,
          };
        }
      }
    }

    this.rateLimiter.recordSuccess(clientIp, trimmedUser);
    const hasPriorSessions = this.db.listActiveSessions(user.id).length > 0;
    const isNewIp = hasPriorSessions && !this.db.hasSeenUserIp(user.id, clientIp);
    const { token, sessionId } = this.createSessionAndToken(user, meta);

    return {
      ok: true,
      user,
      token,
      sessionId,
      isNewIp,
      usedRecoveryCode,
      recoveryCodesRemaining,
    };
  }

  login(
    username: string,
    password: string,
    meta?: AuthRequestMeta
  ): { user: UserRecord; token: string } | null {
    const res = this.authenticate(username, password, meta);
    if (!res.ok) return null;
    return { user: res.user, token: res.token };
  }

  logout(sessionId?: string): void {
    if (sessionId) {
      this.db.revokeSession(sessionId);
    }
  }

  listSessions(userId: string, currentSessionId?: string): AuthSessionSummary[] {
    return this.db.listActiveSessions(userId).map((s) => ({
      id: s.id,
      ip: s.ip,
      userAgent: s.userAgent,
      createdAt: s.createdAt,
      lastSeenAt: s.lastSeenAt,
      expiresAt: s.expiresAt,
      isCurrent: Boolean(currentSessionId && s.id === currentSessionId),
    }));
  }

  revokeSession(userId: string, sessionId: string): boolean {
    return this.db.revokeSession(sessionId, userId);
  }

  revokeAllSessions(userId: string, exceptSessionId?: string): number {
    return this.db.revokeAllSessionsForUser(userId, exceptSessionId);
  }

  changePassword(
    userId: string,
    currentPassword: string,
    newPassword: string,
    keepSessionId?: string
  ): { revokedOtherSessions: number } {
    const user = this.db.findUserById(userId);
    if (!user) {
      throw new Error('User account not found.');
    }
    if (!this.verifyPassword(currentPassword, user.passwordHash)) {
      throw new Error('Current password is incorrect.');
    }
    if (newPassword.length < 8) {
      throw new Error('New password must be at least 8 characters long.');
    }
    if (newPassword === currentPassword) {
      throw new Error('New password must be different from your current password.');
    }
    this.db.updateUserPassword(userId, this.hashPassword(newPassword));
    const revokedOtherSessions = this.db.revokeAllSessionsForUser(userId, keepSessionId);
    return { revokedOtherSessions };
  }

  getTotpStatus(userId: string): TotpStatus {
    const user = this.db.findUserById(userId);
    if (!user) {
      return { enabled: false, recoveryCodesRemaining: 0 };
    }
    return {
      enabled: user.totpEnabled,
      recoveryCodesRemaining: user.recoveryCodes.length,
    };
  }

  beginTotpEnrollment(userId: string): TotpEnrollmentPayload {
    const user = this.db.findUserById(userId);
    if (!user) {
      throw new Error('User account not found.');
    }
    const secret = generateTotpSecret();
    const recoveryCodes = generateRecoveryCodes(8);
    this.pendingEnrollments.set(userId, {
      secret,
      recoveryCodes,
      createdAtMs: Date.now(),
    });
    return {
      secret,
      otpAuthUri: buildOtpAuthUri(user.username, secret),
      recoveryCodes,
    };
  }

  confirmTotpEnrollment(userId: string, code: string): TotpStatus {
    const pending = this.pendingEnrollments.get(userId);
    if (!pending || Date.now() - pending.createdAtMs > PENDING_TOTP_TTL_MS) {
      this.pendingEnrollments.delete(userId);
      throw new Error('2FA setup session expired. Click "Set Up 2FA" to generate a new secret.');
    }
    if (!verifyTotpCode(pending.secret, code)) {
      throw new Error('Invalid 6-digit authenticator code. Check your device clock and try again.');
    }
    const hashedCodes = pending.recoveryCodes.map((c) => hashRecoveryCode(c));
    this.db.updateUserTotp(userId, pending.secret, true, hashedCodes);
    this.pendingEnrollments.delete(userId);
    return {
      enabled: true,
      recoveryCodesRemaining: hashedCodes.length,
    };
  }

  disableTotp(userId: string, currentPassword: string): void {
    const user = this.db.findUserById(userId);
    if (!user) {
      throw new Error('User account not found.');
    }
    if (!this.verifyPassword(currentPassword, user.passwordHash)) {
      throw new Error('Current password is incorrect.');
    }
    this.pendingEnrollments.delete(userId);
    this.db.updateUserTotp(userId, null, false, []);
  }

  signToken(user: UserRecord, sessionId?: string): string {
    const header = Buffer.from(JSON.stringify({ alg: 'HS256', typ: 'JWT' })).toString('base64url');
    const now = Math.floor(Date.now() / 1000);
    const payload: AuthTokenPayload = {
      sub: user.id,
      username: user.username,
      role: user.role,
      ...(sessionId ? { jti: sessionId } : {}),
      iat: now,
      exp: now + TOKEN_TTL_SECONDS,
    };
    const body = Buffer.from(JSON.stringify(payload)).toString('base64url');
    const signature = crypto
      .createHmac('sha256', this.jwtSecret)
      .update(`${header}.${body}`)
      .digest('base64url');
    return `${header}.${body}.${signature}`;
  }

  verifyToken(token: string): AuthTokenPayload | null {
    const parts = token.split('.');
    if (parts.length !== 3) return null;
    const [header, body, sig] = parts;
    const expected = crypto
      .createHmac('sha256', this.jwtSecret)
      .update(`${header}.${body}`)
      .digest('base64url');

    const sigBuf = Buffer.from(sig);
    const expectedBuf = Buffer.from(expected);
    if (sigBuf.length !== expectedBuf.length || !crypto.timingSafeEqual(sigBuf, expectedBuf)) {
      return null;
    }

    try {
      const payload = JSON.parse(Buffer.from(body, 'base64url').toString('utf8')) as AuthTokenPayload;
      if (payload.exp < Math.floor(Date.now() / 1000)) {
        return null;
      }
      const user = this.db.findUserById(payload.sub);
      if (!user) return null;

      if (payload.jti) {
        const session = this.db.getSessionById(payload.jti);
        if (!session || session.revoked || session.userId !== user.id) {
          return null;
        }
        if (Date.parse(session.expiresAt) <= Date.now()) {
          return null;
        }
        const lastSeenMs = Date.parse(session.lastSeenAt);
        if (!Number.isFinite(lastSeenMs) || Date.now() - lastSeenMs > SESSION_TOUCH_INTERVAL_MS) {
          this.db.touchSession(session.id);
        }
      }

      return payload;
    } catch {
      return null;
    }
  }
}
