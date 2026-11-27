import net from 'node:net';
import type { DashboardAccessMode } from '@serverforge/shared';

export const SECURITY_HEADERS: Readonly<Record<string, string>> = Object.freeze({
  'X-Frame-Options': 'DENY',
  'X-Content-Type-Options': 'nosniff',
  'Referrer-Policy': 'no-referrer',
  'Permissions-Policy': 'camera=(), microphone=(), geolocation=(), payment=()',
  'Content-Security-Policy': [
    "default-src 'self'",
    "script-src 'self'",
    "style-src 'self' 'unsafe-inline'",
    "img-src 'self' data: https:",
    "connect-src 'self' ws: wss:",
    "font-src 'self' data:",
    "frame-ancestors 'none'",
    "base-uri 'self'",
    "form-action 'self'",
  ].join('; '),
});

const STATE_CHANGING_METHODS = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);
const DEV_ALLOWED_ORIGINS = new Set([
  'http://localhost:5173',
  'http://127.0.0.1:5173',
  'http://[::1]:5173',
]);

/**
 * Strips IPv4-mapped IPv6 prefix (`::ffff:`) and surrounding brackets.
 */
export function normalizeRemoteIp(rawIp: string | undefined | null): string {
  const trimmed = String(rawIp ?? '').trim().replace(/^\[|\]$/g, '');
  if (!trimmed) return '';
  if (trimmed.toLowerCase().startsWith('::ffff:')) {
    const v4 = trimmed.slice('::ffff:'.length);
    if (net.isIP(v4) === 4) return v4;
  }
  return trimmed.toLowerCase();
}

export function isLoopbackIp(rawIp: string): boolean {
  const ip = normalizeRemoteIp(rawIp);
  if (!ip) return false;
  if (ip === '::1') return true;
  if (net.isIP(ip) === 4) {
    return ip.startsWith('127.');
  }
  return false;
}

function ipv4ToUint32(ip: string): number | null {
  if (net.isIP(ip) !== 4) return null;
  const parts = ip.split('.').map(Number);
  if (parts.length !== 4 || parts.some((p) => !Number.isInteger(p) || p < 0 || p > 255)) return null;
  return (((parts[0] << 24) | (parts[1] << 16) | (parts[2] << 8) | parts[3]) >>> 0);
}

/**
 * Checks whether `rawIp` matches a single IP or IPv4 CIDR string (e.g. `192.168.1.0/24` or `100.64.0.12`).
 */
export function ipMatchesCidr(rawIp: string, rawRule: string): boolean {
  const ip = normalizeRemoteIp(rawIp);
  const rule = rawRule.trim().toLowerCase();
  if (!ip || !rule) return false;

  if (!rule.includes('/')) {
    return ip === normalizeRemoteIp(rule);
  }

  const [networkStr, prefixStr] = rule.split('/');
  const prefix = Number.parseInt(prefixStr, 10);
  const ipNum = ipv4ToUint32(ip);
  const netNum = ipv4ToUint32(normalizeRemoteIp(networkStr));
  if (ipNum === null || netNum === null) return false;
  if (!Number.isInteger(prefix) || prefix < 0 || prefix > 32) return false;
  if (prefix === 0) return true;

  const mask = (0xffffffff << (32 - prefix)) >>> 0;
  return ((ipNum & mask) >>> 0) === ((netNum & mask) >>> 0);
}

/**
 * Returns true for Loopback, RFC1918 private LAN, link-local, IPv6 ULA, and Tailscale CGNAT (100.64.0.0/10).
 * Public WAN IPs always return false.
 */
export function isLanOrTailscaleIp(rawIp: string): boolean {
  const ip = normalizeRemoteIp(rawIp);
  if (!ip) return false;
  if (isLoopbackIp(ip)) return true;

  const ver = net.isIP(ip);
  if (ver === 4) {
    return (
      ipMatchesCidr(ip, '10.0.0.0/8') ||
      ipMatchesCidr(ip, '172.16.0.0/12') ||
      ipMatchesCidr(ip, '192.168.0.0/16') ||
      ipMatchesCidr(ip, '169.254.0.0/16') ||
      ipMatchesCidr(ip, '100.64.0.0/10')
    );
  }
  if (ver === 6) {
    return ip.startsWith('fe80:') || ip.startsWith('fc') || ip.startsWith('fd');
  }
  return false;
}

/**
 * Evaluates whether a client IP is permitted to access the ServerForge control plane (:3000).
 * Loopback (127.0.0.0/8, ::1) is always allowed so the host admin can never lock themselves out.
 */
export function isIpAllowedByPolicy(
  rawIp: string,
  mode: DashboardAccessMode,
  trustedCidrs: string[] = []
): boolean {
  const ip = normalizeRemoteIp(rawIp);
  if (!ip) return false;
  if (isLoopbackIp(ip)) return true;

  if (mode === 'localhost_only') {
    return false;
  }

  if (mode === 'lan_and_tailscale' && isLanOrTailscaleIp(ip)) {
    return true;
  }

  for (const cidr of trustedCidrs) {
    if (cidr.trim() && ipMatchesCidr(ip, cidr)) {
      return true;
    }
  }

  return false;
}

/**
 * Strict same-origin check matching an HTTP `Origin` header against the request `Host` header.
 * Allows Vite dev server origin ONLY when `isDev` (`NODE_ENV === 'development'`) is true.
 */
export function isOriginAllowedForHost(
  originHeader: string | undefined,
  hostHeader: string | undefined,
  isDev = false
): boolean {
  if (!originHeader) return true;
  const trimmed = originHeader.trim();
  if (!trimmed || trimmed.toLowerCase() === 'null') return false;

  if (isDev && DEV_ALLOWED_ORIGINS.has(trimmed.toLowerCase())) {
    return true;
  }

  if (!hostHeader) return false;

  let parsedOrigin: URL;
  try {
    parsedOrigin = new URL(trimmed);
  } catch {
    return false;
  }

  if (parsedOrigin.protocol !== 'http:' && parsedOrigin.protocol !== 'https:') {
    return false;
  }

  const normalizedOriginHost = parsedOrigin.host.toLowerCase();
  const normalizedReqHost = hostHeader.trim().toLowerCase();
  return normalizedOriginHost === normalizedReqHost;
}

/**
 * CSRF Origin/Referer guard for state-changing HTTP methods (`POST`, `PUT`, `PATCH`, `DELETE`).
 * Browsers always attach `Origin` (or `Referer`) on cross-origin state-changing requests.
 */
export function isCsrfOriginValid(
  method: string,
  originHeader: string | undefined,
  refererHeader: string | undefined,
  hostHeader: string | undefined,
  isDev = false
): boolean {
  if (!STATE_CHANGING_METHODS.has(method.toUpperCase())) {
    return true;
  }

  if (originHeader !== undefined) {
    return isOriginAllowedForHost(originHeader, hostHeader, isDev);
  }

  if (refererHeader !== undefined && refererHeader.trim()) {
    try {
      const refUrl = new URL(refererHeader.trim());
      return isOriginAllowedForHost(refUrl.origin, hostHeader, isDev);
    } catch {
      return false;
    }
  }

  // Non-browser API clients (CLI/curl) without Origin/Referer
  return true;
}
