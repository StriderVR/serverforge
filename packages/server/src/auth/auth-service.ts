import crypto from 'node:crypto';
import type { AppDatabase, UserRecord } from '../db/database.js';

export interface AuthTokenPayload {
  sub: string;
  username: string;
  role: 'admin';
  iat: number;
  exp: number;
}

const TOKEN_TTL_SECONDS = 60 * 60 * 24 * 7; // 7 days

export class AuthService {
  constructor(
    private readonly db: AppDatabase,
    private readonly jwtSecret: string
  ) {}

  needsInitialSetup(): boolean {
    return this.db.countUsers() === 0;
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

  setupInitialAdmin(username: string, password: string): { user: UserRecord; token: string } {
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
    const token = this.signToken(user);
    return { user, token };
  }

  login(username: string, password: string): { user: UserRecord; token: string } | null {
    const user = this.db.findUserByUsername(username.trim());
    if (!user) return null;
    if (!this.verifyPassword(password, user.passwordHash)) return null;
    return { user, token: this.signToken(user) };
  }

  signToken(user: UserRecord): string {
    const header = Buffer.from(JSON.stringify({ alg: 'HS256', typ: 'JWT' })).toString('base64url');
    const now = Math.floor(Date.now() / 1000);
    const payload: AuthTokenPayload = {
      sub: user.id,
      username: user.username,
      role: user.role,
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
      return payload;
    } catch {
      return null;
    }
  }
}
