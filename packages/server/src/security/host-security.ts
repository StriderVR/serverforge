import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import type {
  SecretVaultStatus,
  SecurityHealthCheckItem,
  SecurityHealthReport,
  SystemSettings,
  TotpStatus,
} from '@serverforge/shared';

export interface ElevationCheckOptions {
  platform?: NodeJS.Platform;
  disableOsExec?: boolean;
  elevatedOverride?: boolean;
}

/**
 * Detects whether the ServerForge process is running with elevated Administrator/root privileges.
 * Never spawns OS processes when `disableOsExec` is true (mock test mode).
 */
export function detectProcessElevation(options: ElevationCheckOptions = {}): boolean {
  if (typeof options.elevatedOverride === 'boolean') {
    return options.elevatedOverride;
  }
  const platform = options.platform ?? process.platform;
  if (platform !== 'win32') {
    return typeof process.getuid === 'function' ? process.getuid() === 0 : false;
  }
  if (options.disableOsExec) {
    return false;
  }
  try {
    execFileSync('net.exe', ['session'], {
      stdio: 'ignore',
      timeout: 3_000,
      windowsHide: true,
    });
    return true;
  } catch {
    return false;
  }
}

/**
 * Returns true if `candidatePath` resolves inside `rootDir` (or equals `rootDir`).
 */
export function isPathInsideDir(rootDir: string, candidatePath: string): boolean {
  if (!candidatePath.trim()) return false;
  const resolvedRoot = path.resolve(rootDir);
  const resolvedTarget = path.resolve(candidatePath);

  const normalizeForPlatform = (p: string) => {
    let real = p;
    try {
      real = fs.realpathSync(p);
    } catch {
      // Fall back to lexical resolution if path doesn't exist yet
    }
    return process.platform === 'win32' ? real.toLowerCase() : real;
  };

  const rRoot = normalizeForPlatform(resolvedRoot);
  const rTarget = normalizeForPlatform(resolvedTarget);
  const rel = path.relative(rRoot, rTarget);
  return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel));
}

export function buildSecurityHealthReport(params: {
  settings: SystemSettings;
  vaultStatus: SecretVaultStatus;
  totpStatus: TotpStatus;
  isElevatedAdmin: boolean;
  platform: string;
  httpsEnabled: boolean;
  recentFailedLogins24h: number;
}): SecurityHealthReport {
  const {
    settings,
    vaultStatus,
    totpStatus,
    isElevatedAdmin,
    platform,
    httpsEnabled,
    recentFailedLogins24h,
  } = params;

  const checks: SecurityHealthCheckItem[] = [
    {
      id: 'non_admin_process',
      title: platform === 'win32' ? 'Non-Administrator Windows Account' : 'Non-Root Process Privilege',
      status: isElevatedAdmin ? 'warn' : 'pass',
      detail: isElevatedAdmin
        ? platform === 'win32'
          ? 'ServerForge is currently running elevated as a Windows Administrator.'
          : 'ServerForge is currently running as root (UID 0).'
        : platform === 'win32'
          ? 'Running under a standard non-Administrator Windows account (least privilege).'
          : 'Running as a standard non-root user (least privilege).',
      recommendation: isElevatedAdmin
        ? 'Run ServerForge as a standard user account so game servers and dashboard actions do not inherit Administrator privileges.'
        : undefined,
    },
    {
      id: 'ip_allowlist',
      title: 'LAN / Tailscale IP Allowlist',
      status:
        settings.dashboardAccessMode === 'custom' &&
        settings.trustedCidrs.some((c) => c.trim() === '0.0.0.0/0' || c.trim() === '::/0')
          ? 'warn'
          : 'pass',
      detail:
        settings.dashboardAccessMode === 'localhost_only'
          ? 'Dashboard restricted strictly to this PC (localhost only).'
          : settings.dashboardAccessMode === 'lan_and_tailscale'
            ? 'Dashboard restricted to private LAN subnets and Tailscale (100.64.0.0/10).'
            : `Dashboard restricted to localhost + ${settings.trustedCidrs.length} custom trusted CIDR(s).`,
      recommendation:
        settings.dashboardAccessMode === 'custom' &&
        settings.trustedCidrs.some((c) => c.trim() === '0.0.0.0/0' || c.trim() === '::/0')
          ? 'Remove 0.0.0.0/0 or ::/0 from Trusted CIDRs in Settings -> Networking so the dashboard is not exposed to arbitrary IPs.'
          : undefined,
    },
    {
      id: 'secret_vault',
      title: 'Secret Vault Encryption at Rest',
      status: vaultStatus.encrypted && vaultStatus.undecryptableFields.length === 0 ? 'pass' : 'warn',
      detail:
        vaultStatus.undecryptableFields.length > 0
          ? `${vaultStatus.undecryptableFields.length} stored secret(s) could not be decrypted with this PC's key.`
          : vaultStatus.keyProtection === 'dpapi'
            ? 'All tokens & passwords encrypted with AES-256-GCM + Windows DPAPI (CurrentUser).'
            : 'All tokens & passwords encrypted with AES-256-GCM + 0600 local keyfile.',
      recommendation:
        vaultStatus.undecryptableFields.length > 0
          ? 'Re-enter the affected tokens/passwords in Settings so they are re-encrypted for this PC.'
          : undefined,
    },
    {
      id: 'totp_2fa',
      title: 'Two-Factor Authentication (TOTP 2FA)',
      status: totpStatus.enabled ? 'pass' : 'warn',
      detail: totpStatus.enabled
        ? `Enabled (${totpStatus.recoveryCodesRemaining} recovery codes remaining).`
        : 'Disabled (password-only sign-in).',
      recommendation: totpStatus.enabled
        ? undefined
        : 'Enable opt-in TOTP 2FA below to require an authenticator code on dashboard sign-ins.',
    },
    {
      id: 'https_tls',
      title: 'Encrypted Dashboard Transport (HTTPS / TLS)',
      status: httpsEnabled ? 'pass' : 'warn',
      detail: httpsEnabled
        ? 'Dashboard is serving over HTTPS with Secure session cookies.'
        : 'Dashboard is running over plain HTTP on the local network.',
      recommendation: httpsEnabled
        ? undefined
        : 'Enable built-in HTTPS / TLS (or access via Tailscale) if you manage ServerForge over shared Wi-Fi.',
    },
    {
      id: 'host_lockdown',
      title: 'Host Lockdown Controls',
      status: settings.lockHostFsBrowsing && settings.blockExecutableUploads ? 'pass' : 'warn',
      detail:
        settings.lockHostFsBrowsing && settings.blockExecutableUploads
          ? 'Host drive browsing is locked and executable/script web uploads are blocked.'
          : settings.lockHostFsBrowsing
            ? 'Host drive browsing is locked; executable web uploads are still permitted.'
            : settings.blockExecutableUploads
              ? 'Executable/script web uploads are blocked; host drive browsing is open for imports.'
              : 'Neither host drive browsing lock nor executable upload block is enabled yet.',
      recommendation:
        settings.lockHostFsBrowsing && settings.blockExecutableUploads
          ? undefined
          : 'Once you finish importing existing servers, enable both Host Lockdown switches below.',
    },
    {
      id: 'failed_logins',
      title: 'Failed Login Attempts (Last 24h)',
      status: recentFailedLogins24h >= 5 ? 'warn' : 'pass',
      detail:
        recentFailedLogins24h === 0
          ? 'No failed dashboard login attempts in the last 24 hours.'
          : `${recentFailedLogins24h} failed login attempt(s) recorded in the last 24 hours.`,
      recommendation:
        recentFailedLogins24h >= 5
          ? 'Review the Audit Log below and ensure your IP allowlist and 2FA are active.'
          : undefined,
    },
  ];

  const passCount = checks.filter((c) => c.status === 'pass').length;
  return {
    score: passCount,
    maxScore: checks.length,
    isElevatedAdmin,
    platform,
    httpsEnabled,
    recentFailedLogins24h,
    checks,
  };
}
