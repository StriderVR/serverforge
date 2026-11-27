import crypto from 'node:crypto';

const BASE32_ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';

export function base32Encode(buf: Buffer): string {
  let bits = 0;
  let value = 0;
  let out = '';
  for (const byte of buf) {
    value = (value << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      out += BASE32_ALPHABET[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  if (bits > 0) {
    out += BASE32_ALPHABET[(value << (5 - bits)) & 31];
  }
  return out;
}

export function base32Decode(input: string): Buffer {
  const cleaned = input.toUpperCase().replace(/[^A-Z2-7]/g, '');
  let bits = 0;
  let value = 0;
  const bytes: number[] = [];

  for (const ch of cleaned) {
    const idx = BASE32_ALPHABET.indexOf(ch);
    if (idx === -1) continue;
    value = (value << 5) | idx;
    bits += 5;
    if (bits >= 8) {
      bytes.push((value >>> (bits - 8)) & 0xff);
      bits -= 8;
    }
  }
  return Buffer.from(bytes);
}

/**
 * Generates a 160-bit Base32 TOTP secret compatible with Google Authenticator, Authy, 1Password, Bitwarden, etc.
 */
export function generateTotpSecret(): string {
  return base32Encode(crypto.randomBytes(20));
}

/**
 * Generates a 6-digit RFC 6238 TOTP code (HMAC-SHA1, 30-second step).
 */
export function generateTotpCode(
  secretBase32: string,
  timestampMs = Date.now(),
  stepSeconds = 30,
  digits = 6
): string {
  const key = base32Decode(secretBase32);
  const counter = Math.floor(timestampMs / 1000 / stepSeconds);
  const counterBuf = Buffer.alloc(8);
  counterBuf.writeBigUInt64BE(BigInt(counter), 0);

  const hmac = crypto.createHmac('sha1', key).update(counterBuf).digest();
  const offset = hmac[hmac.length - 1] & 0x0f;
  const binary =
    ((hmac[offset] & 0x7f) << 24) |
    ((hmac[offset + 1] & 0xff) << 16) |
    ((hmac[offset + 2] & 0xff) << 8) |
    (hmac[offset + 3] & 0xff);

  const otp = binary % 10 ** digits;
  return String(otp).padStart(digits, '0');
}

/**
 * Verifies a 6-digit RFC 6238 TOTP code with ±windowSteps clock skew tolerance using constant-time comparison.
 */
export function verifyTotpCode(
  secretBase32: string,
  rawCode: string,
  timestampMs = Date.now(),
  windowSteps = 1
): boolean {
  const code = rawCode.replace(/[\s-]+/g, '').trim();
  if (!/^\d{6}$/.test(code)) return false;
  const codeBuf = Buffer.from(code, 'utf8');

  for (let delta = -windowSteps; delta <= windowSteps; delta++) {
    const candidate = generateTotpCode(secretBase32, timestampMs + delta * 30_000);
    const candBuf = Buffer.from(candidate, 'utf8');
    if (candBuf.length === codeBuf.length && crypto.timingSafeEqual(candBuf, codeBuf)) {
      return true;
    }
  }
  return false;
}

export function buildOtpAuthUri(username: string, secretBase32: string, issuer = 'ServerForge'): string {
  const label = encodeURIComponent(`${issuer}:${username}`);
  return `otpauth://totp/${label}?secret=${encodeURIComponent(secretBase32)}&issuer=${encodeURIComponent(issuer)}&algorithm=SHA1&digits=6&period=30`;
}

export function generateRecoveryCodes(count = 8): string[] {
  const codes: string[] = [];
  for (let i = 0; i < count; i++) {
    const raw = crypto.randomBytes(4).toString('hex').toUpperCase();
    codes.push(`${raw.slice(0, 4)}-${raw.slice(4, 8)}`);
  }
  return codes;
}

export function hashRecoveryCode(code: string): string {
  const normalized = code.toUpperCase().replace(/[^A-Z0-9]/g, '');
  const salt = crypto.randomBytes(8).toString('hex');
  const hash = crypto.createHash('sha256').update(`${salt}:${normalized}`).digest('hex');
  return `${salt}:${hash}`;
}

export function consumeRecoveryCode(
  rawCode: string,
  hashedCodes: string[]
): { matched: boolean; remaining: string[] } {
  const normalized = rawCode.toUpperCase().replace(/[^A-Z0-9]/g, '');
  if (normalized.length < 6) {
    return { matched: false, remaining: hashedCodes };
  }

  for (let i = 0; i < hashedCodes.length; i++) {
    const [salt, storedHash] = hashedCodes[i].split(':');
    if (!salt || !storedHash) continue;
    const computed = crypto.createHash('sha256').update(`${salt}:${normalized}`).digest('hex');
    const a = Buffer.from(storedHash, 'utf8');
    const b = Buffer.from(computed, 'utf8');
    if (a.length === b.length && crypto.timingSafeEqual(a, b)) {
      const remaining = [...hashedCodes.slice(0, i), ...hashedCodes.slice(i + 1)];
      return { matched: true, remaining };
    }
  }

  return { matched: false, remaining: hashedCodes };
}

interface RateLimitBucket {
  failures: number;
  lockedUntilMs: number;
  lastAttemptMs: number;
}

export interface RateLimitCheckResult {
  allowed: boolean;
  retryAfterSeconds: number;
  failures: number;
}

/**
 * Progressive brute-force login rate limiter keyed by client IP + username.
 * 5 failures -> 60s cooldown; 10 failures -> 300s; 15+ failures -> 900s.
 */
export class LoginRateLimiter {
  private readonly buckets = new Map<string, RateLimitBucket>();

  private key(ip: string, username: string): string {
    return `${ip.trim().toLowerCase()}|${username.trim().toLowerCase()}`;
  }

  check(ip: string, username: string, nowMs = Date.now()): RateLimitCheckResult {
    const b = this.buckets.get(this.key(ip, username));
    if (!b) return { allowed: true, retryAfterSeconds: 0, failures: 0 };

    // Expire stale buckets after 30 minutes of inactivity
    if (nowMs - b.lastAttemptMs > 30 * 60_000 && nowMs >= b.lockedUntilMs) {
      this.buckets.delete(this.key(ip, username));
      return { allowed: true, retryAfterSeconds: 0, failures: 0 };
    }

    if (nowMs < b.lockedUntilMs) {
      return {
        allowed: false,
        retryAfterSeconds: Math.max(1, Math.ceil((b.lockedUntilMs - nowMs) / 1000)),
        failures: b.failures,
      };
    }

    return { allowed: true, retryAfterSeconds: 0, failures: b.failures };
  }

  recordFailure(
    ip: string,
    username: string,
    nowMs = Date.now()
  ): { failures: number; locked: boolean; retryAfterSeconds: number; newlyLocked: boolean } {
    const k = this.key(ip, username);
    const existing = this.buckets.get(k) ?? { failures: 0, lockedUntilMs: 0, lastAttemptMs: nowMs };
    existing.failures += 1;
    existing.lastAttemptMs = nowMs;

    let cooldownSec = 0;
    if (existing.failures >= 15) cooldownSec = 900;
    else if (existing.failures >= 10) cooldownSec = 300;
    else if (existing.failures >= 5) cooldownSec = 60;

    const newlyLocked = cooldownSec > 0 && (existing.failures === 5 || existing.failures === 10 || existing.failures === 15);
    if (cooldownSec > 0) {
      existing.lockedUntilMs = nowMs + cooldownSec * 1000;
    }

    this.buckets.set(k, existing);
    return {
      failures: existing.failures,
      locked: cooldownSec > 0,
      retryAfterSeconds: cooldownSec,
      newlyLocked,
    };
  }

  recordSuccess(ip: string, username: string): void {
    this.buckets.delete(this.key(ip, username));
  }
}
