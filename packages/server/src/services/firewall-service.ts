import { execFile } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type {
  FirewallApplyResult,
  FirewallPortStatus,
  FirewallRemoveResult,
  FirewallStatus,
  GameTemplate,
  PortProtocol,
  ServerInstance,
  WindowsNetworkProfileKind,
} from '@serverforge/shared';
import { encodePowerShellCommand } from './import-service.js';

export interface FirewallExecResult {
  stdout: string;
  stderr: string;
  exitCode: number;
}

export type FirewallExecFn = (
  file: string,
  args: string[],
  timeoutMs?: number
) => Promise<FirewallExecResult>;

export interface FirewallServiceOptions {
  platform?: NodeJS.Platform;
  tmpDir?: string;
  execImpl?: FirewallExecFn;
}

export interface ResolvedInstancePort {
  key: string;
  label: string;
  port: number;
  defaultPort: number;
  protocol: PortProtocol;
  internalOnly: boolean;
  primary: boolean;
}

const SAFE_LABEL_RE = /[^a-zA-Z0-9 _()-]/g;

/**
 * Strictly sanitizes any label embedded into Windows Firewall rule display names
 * or PowerShell scripts so arbitrary characters can never break out or inject commands.
 */
export function sanitizeFirewallLabel(raw: string): string {
  const cleaned = raw.replace(SAFE_LABEL_RE, '').replace(/\s+/g, ' ').trim();
  return (cleaned || 'server').slice(0, 60);
}

/**
 * Escapes a string for safe embedding inside a single-quoted PowerShell literal ('...').
 * In PowerShell, single-quoted strings treat $, `, and " literally; only ' needs doubling.
 */
export function escapePsSingleQuoted(raw: string): string {
  return raw.replace(/'/g, "''");
}

export function validatePortNumber(port: number): number {
  if (!Number.isInteger(port) || port < 1024 || port > 65535) {
    throw new Error(`Invalid port number: ${port}. Must be an integer between 1024 and 65535.`);
  }
  return port;
}

export function buildManagedRulePrefix(slug: string): string {
  return `ServerForge - ${sanitizeFirewallLabel(slug)}`;
}

/**
 * Resolves all configured ports for an instance using its game template metadata.
 */
export function resolveInstancePorts(
  instance: ServerInstance,
  template: GameTemplate | null
): ResolvedInstancePort[] {
  const resolved: ResolvedInstancePort[] = [];
  const seen = new Set<string>();

  for (const spec of template?.ports ?? []) {
    const port = instance.ports[spec.key] ?? spec.defaultPort;
    resolved.push({
      key: spec.key,
      label: spec.label,
      port,
      defaultPort: spec.defaultPort,
      protocol: spec.protocol,
      internalOnly: Boolean(spec.internalOnly),
      primary: Boolean(spec.primary),
    });
    seen.add(spec.key);
  }

  for (const [key, port] of Object.entries(instance.ports)) {
    if (seen.has(key)) continue;
    const isInternal = key === 'rcon' || key === 'rest';
    resolved.push({
      key,
      label: key.toUpperCase(),
      port,
      defaultPort: port,
      protocol: 'tcp',
      internalOnly: isInternal,
      primary: key === 'game',
    });
  }

  return resolved;
}

/**
 * Returns ONLY external-facing ports (!internalOnly).
 * Internal management ports (RCON, Palworld REST, etc.) are strictly excluded so
 * ServerForge never opens them in Windows Firewall or router forwarding guides.
 */
export function getExternalPortSpecs(
  instance: ServerInstance,
  template: GameTemplate | null
): ResolvedInstancePort[] {
  return resolveInstancePorts(instance, template).filter((p) => !p.internalOnly);
}

/**
 * Generates an idempotent, least-privilege Windows PowerShell script that:
 * 1. Removes stale ServerForge-managed rules for this instance (revoking old ports).
 * 2. Optionally switches the home network adapter from Public -> Private (when explicitly requested).
 * 3. Creates inbound Allow rules strictly scoped to `-Profile Private` for ONLY the required external ports.
 *    Never opens `internalOnly` ports (RCON/REST) and never uses `-Profile Any` or `Public`.
 */
export function buildWindowsFirewallScript(
  instance: ServerInstance,
  template: GameTemplate | null,
  options: { switchProfileToPrivate?: boolean; profileName?: string | null } = {}
): string {
  const prefix = buildManagedRulePrefix(instance.slug);
  const externalPorts = getExternalPortSpecs(instance, template);
  const lines: string[] = [
    `# ServerForge Least-Privilege Windows Firewall Script`,
    `# Server: ${sanitizeFirewallLabel(instance.name)} (${sanitizeFirewallLabel(instance.slug)})`,
    `# Security: Scoped strictly to Private network profile; internal-only ports (RCON/REST) are NEVER opened.`,
    `$ErrorActionPreference = 'Stop'`,
    ``,
    `# 1. Remove any previous ServerForge-managed rules for this server so old ports stay locked down`,
    `Get-NetFirewallRule -DisplayName '${escapePsSingleQuoted(prefix)}*' -ErrorAction SilentlyContinue | Remove-NetFirewallRule -ErrorAction SilentlyContinue`,
    ``,
  ];

  if (options.switchProfileToPrivate && options.profileName) {
    const safeProfile = sanitizeFirewallLabel(options.profileName);
    lines.push(
      `# 2. Switch home network profile from Public to Private`,
      `Set-NetConnectionProfile -Name '${escapePsSingleQuoted(safeProfile)}' -NetworkCategory Private`,
      ``
    );
  }

  lines.push(`# Create exact inbound Private-profile rules for required external game ports only`);
  for (const p of externalPorts) {
    const validPort = validatePortNumber(p.port);
    const protos: Array<'TCP' | 'UDP'> =
      p.protocol === 'both' ? ['TCP', 'UDP'] : [p.protocol === 'udp' ? 'UDP' : 'TCP'];

    for (const proto of protos) {
      const ruleName = `${prefix} (${validPort}/${proto})`;
      lines.push(
        `New-NetFirewallRule -DisplayName '${escapePsSingleQuoted(ruleName)}' -Direction Inbound -Protocol ${proto} -LocalPort ${validPort} -Profile Private -Action Allow | Out-Null`
      );
    }
  }

  lines.push(``, `Write-Host '[ServerForge] Private-profile firewall rules applied cleanly.'`);
  return lines.join('\r\n') + '\r\n';
}

/**
 * Generates copyable least-privilege Linux UFW commands for external game ports only.
 */
export function buildLinuxUfwScript(
  instance: ServerInstance,
  template: GameTemplate | null
): string {
  const externalPorts = getExternalPortSpecs(instance, template);
  const lines: string[] = [
    `# ServerForge Linux Firewall (UFW) Commands — External game ports only`,
    `# Internal management ports (RCON/REST) are intentionally excluded.`,
  ];

  for (const p of externalPorts) {
    const validPort = validatePortNumber(p.port);
    const comment = sanitizeFirewallLabel(`ServerForge ${instance.slug} ${p.key}`);
    if (p.protocol === 'both') {
      lines.push(`sudo ufw allow ${validPort}/tcp comment '${comment}'`);
      lines.push(`sudo ufw allow ${validPort}/udp comment '${comment}'`);
    } else {
      lines.push(`sudo ufw allow ${validPort}/${p.protocol} comment '${comment}'`);
    }
  }

  return lines.join('\n') + '\n';
}

function getGameExecutableHint(gameId: string, template: GameTemplate | null): string {
  if (gameId === 'satisfactory') return 'FactoryServer';
  if (gameId === 'palworld') return 'PalServer';
  if (gameId === 'ark-survival-ascended') return 'ArkAscendedServer';
  if (gameId === 'factorio') return 'factorio';
  if (gameId.startsWith('minecraft')) return 'java';
  const winExe = template?.runtimes.native?.executableWindows ?? '';
  const base = path.basename(winExe, path.extname(winExe));
  return sanitizeFirewallLabel(base);
}

export interface ParsedWindowsFirewallProbe {
  isAdmin: boolean;
  networkProfile: WindowsNetworkProfileKind;
  profileName: string | null;
  allowRules: Array<{
    displayName: string;
    protocol: string;
    localPorts: string[];
    profile: string;
  }>;
  appBlockRules: Array<{
    displayName: string;
    profile: string;
  }>;
}

/**
 * Parses the JSON stdout produced by the Windows firewall inspection script.
 */
export function parseWindowsFirewallProbeOutput(stdout: string): ParsedWindowsFirewallProbe {
  const trimmed = stdout.trim();
  if (!trimmed) {
    return {
      isAdmin: false,
      networkProfile: 'Unknown',
      profileName: null,
      allowRules: [],
      appBlockRules: [],
    };
  }

  const parsed = JSON.parse(trimmed) as {
    isAdmin?: boolean;
    profileCategory?: string;
    profileName?: string;
    allowRules?: Array<{ displayName?: string; protocol?: string; localPort?: string | string[]; profile?: string }>;
    appBlockRules?: Array<{ displayName?: string; profile?: string }>;
  };

  const catRaw = String(parsed.profileCategory ?? '');
  let networkProfile: WindowsNetworkProfileKind = 'Unknown';
  if (catRaw === 'Private') networkProfile = 'Private';
  else if (catRaw === 'Public') networkProfile = 'Public';
  else if (catRaw === 'DomainAuthenticated') networkProfile = 'DomainAuthenticated';

  const rawAllow = Array.isArray(parsed.allowRules)
    ? parsed.allowRules
    : parsed.allowRules
      ? [parsed.allowRules]
      : [];

  const allowRules = rawAllow.map((r) => {
    const ports = Array.isArray(r.localPort)
      ? r.localPort.map(String)
      : r.localPort !== undefined && r.localPort !== null
        ? [String(r.localPort)]
        : [];
    return {
      displayName: String(r.displayName ?? ''),
      protocol: String(r.protocol ?? 'Any').toUpperCase(),
      localPorts: ports,
      profile: String(r.profile ?? 'Any'),
    };
  });

  const rawBlock = Array.isArray(parsed.appBlockRules)
    ? parsed.appBlockRules
    : parsed.appBlockRules
      ? [parsed.appBlockRules]
      : [];

  const appBlockRules = rawBlock.map((r) => ({
    displayName: String(r.displayName ?? ''),
    profile: String(r.profile ?? 'Any'),
  }));

  return {
    isAdmin: Boolean(parsed.isAdmin),
    networkProfile,
    profileName: parsed.profileName ? String(parsed.profileName) : null,
    allowRules,
    appBlockRules,
  };
}

function ruleMatchesPort(localPorts: string[], targetPort: number): boolean {
  const targetStr = String(targetPort);
  for (const entry of localPorts) {
    const clean = entry.trim();
    if (clean === targetStr) return true;
    const rangeMatch = /^(\d+)-(\d+)$/.exec(clean);
    if (rangeMatch) {
      const start = Number(rangeMatch[1]);
      const end = Number(rangeMatch[2]);
      if (targetPort >= start && targetPort <= end) return true;
    }
  }
  return false;
}

function ruleAppliesToProfile(ruleProfile: string, activeProfile: WindowsNetworkProfileKind): boolean {
  const lower = ruleProfile.toLowerCase();
  if (lower.includes('any')) return true;
  if (activeProfile === 'Unknown') return true;
  if (activeProfile === 'Private') return lower.includes('private');
  if (activeProfile === 'Public') return lower.includes('public');
  if (activeProfile === 'DomainAuthenticated') return lower.includes('domain');
  return true;
}

function defaultExec(file: string, args: string[], timeoutMs = 12_000): Promise<FirewallExecResult> {
  return new Promise((resolve) => {
    execFile(
      file,
      args,
      { timeout: timeoutMs, windowsHide: true, maxBuffer: 2 * 1024 * 1024 },
      (err, stdout, stderr) => {
        const code = err && typeof (err as NodeJS.ErrnoException & { code?: unknown }).code === 'number'
          ? Number((err as NodeJS.ErrnoException & { code?: unknown }).code)
          : err
            ? 1
            : 0;
        resolve({
          stdout: String(stdout ?? ''),
          stderr: String(stderr ?? ''),
          exitCode: code,
        });
      }
    );
  });
}

export class FirewallService {
  private readonly platform: NodeJS.Platform;
  private readonly tmpDir: string;
  private readonly execImpl: FirewallExecFn;

  constructor(options: FirewallServiceOptions = {}) {
    this.platform = options.platform ?? process.platform;
    this.tmpDir = options.tmpDir ?? os.tmpdir();
    this.execImpl = options.execImpl ?? defaultExec;
  }

  /**
   * Builds the read-only PowerShell probe script for inspecting Windows network profile,
   * active inbound Allow rules on the instance's configured ports, and any inbound Block rules
   * targeting the server executable.
   */
  private buildWindowsInspectScript(ports: ResolvedInstancePort[], exeHint: string): string {
    const portNums = ports.map((p) => validatePortNumber(p.port));
    const portListLiteral = portNums.length > 0 ? portNums.join(',') : '0';
    const safeExe = escapePsSingleQuoted(sanitizeFirewallLabel(exeHint));

    return `
$ErrorActionPreference = 'SilentlyContinue'
$principal = New-Object Security.Principal.WindowsPrincipal([Security.Principal.WindowsIdentity]::GetCurrent())
$isAdmin = $principal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)

$profiles = @(Get-NetConnectionProfile)
$activeProfile = $profiles | Where-Object { $_.IPv4Connectivity -eq 'Internet' } | Select-Object -First 1
if (-not $activeProfile) { $activeProfile = $profiles | Select-Object -First 1 }

$targetPorts = @(${portListLiteral})
$allowRules = @()
$inboundAllow = Get-NetFirewallRule -Direction Inbound -Action Allow -Enabled True
foreach ($rule in $inboundAllow) {
  $pf = Get-NetFirewallPortFilter -AssociatedNetFirewallRule $rule
  if (-not $pf) { continue }
  $lp = @($pf.LocalPort)
  $matched = $false
  foreach ($item in $lp) {
    $s = [string]$item
    if ($s -match '^\\d+$' -and ($targetPorts -contains [int]$s)) { $matched = $true; break }
    if ($s -match '^(\\d+)-(\\d+)$') {
      $lo = [int]$Matches[1]; $hi = [int]$Matches[2]
      foreach ($tp in $targetPorts) {
        if ($tp -ge $lo -and $tp -le $hi) { $matched = $true; break }
      }
      if ($matched) { break }
    }
  }
  if ($matched) {
    $allowRules += [PSCustomObject]@{
      displayName = [string]$rule.DisplayName
      protocol    = [string]$pf.Protocol
      localPort   = $lp
      profile     = [string]$rule.Profile
    }
  }
}

$appBlockRules = @()
if ('${safeExe}' -ne '') {
  $appFilters = Get-NetFirewallApplicationFilter | Where-Object { $_.Program -and $_.Program -match '${safeExe}' }
  foreach ($af in $appFilters) {
    $r = Get-NetFirewallRule -AssociatedNetFirewallApplicationFilter $af
    if ($r -and $r.Direction -eq 'Inbound' -and $r.Action -eq 'Block' -and $r.Enabled -eq 'True') {
      $appBlockRules += [PSCustomObject]@{
        displayName = [string]$r.DisplayName
        profile     = [string]$r.Profile
      }
    }
  }
}

[PSCustomObject]@{
  isAdmin         = $isAdmin
  profileCategory = if ($activeProfile) { [string]$activeProfile.NetworkCategory } else { 'Unknown' }
  profileName     = if ($activeProfile) { [string]$activeProfile.Name } else { $null }
  allowRules      = $allowRules
  appBlockRules   = $appBlockRules
} | ConvertTo-Json -Depth 5 -Compress
`;
  }

  async inspectInstance(
    instance: ServerInstance,
    template: GameTemplate | null
  ): Promise<FirewallStatus> {
    const resolvedPorts = resolveInstancePorts(instance, template);
    const prefix = buildManagedRulePrefix(instance.slug);

    if (this.platform !== 'win32') {
      const ufwScript = buildLinuxUfwScript(instance, template);
      return {
        platform: this.platform,
        supported: false,
        isAdmin: false,
        networkProfile: 'Unknown',
        profileName: null,
        publicProfileWarning: false,
        internalExposureWarnings: [],
        appBlockWarnings: [],
        ports: resolvedPorts.map((p) => ({
          key: p.key,
          label: p.label,
          port: p.port,
          protocol: p.protocol,
          internalOnly: p.internalOnly,
          tcpAllowed: false,
          udpAllowed: false,
          ruleNames: [],
          blockedByAppRule: false,
          exposedInternalWarning: false,
        })),
        managedRulePrefix: prefix,
        scriptContent: ufwScript,
        scriptFilename: `serverforge-ufw-${sanitizeFirewallLabel(instance.slug)}.sh`,
      };
    }

    const exeHint = getGameExecutableHint(instance.gameId, template);
    const probeScript = this.buildWindowsInspectScript(resolvedPorts, exeHint);
    const encoded = encodePowerShellCommand(probeScript);
    const res = await this.execImpl(
      'powershell.exe',
      ['-NoProfile', '-NonInteractive', '-EncodedCommand', encoded],
      15_000
    );

    let parsed: ParsedWindowsFirewallProbe;
    try {
      parsed = parseWindowsFirewallProbeOutput(res.stdout);
    } catch {
      parsed = {
        isAdmin: false,
        networkProfile: 'Unknown',
        profileName: null,
        allowRules: [],
        appBlockRules: [],
      };
    }

    const activeAppBlocks = parsed.appBlockRules.filter((r) =>
      ruleAppliesToProfile(r.profile, parsed.networkProfile)
    );
    const hasAppBlock = activeAppBlocks.length > 0;
    const appBlockWarnings = activeAppBlocks.map(
      (r) => `Windows Firewall has an active Inbound BLOCK rule "${r.displayName}" (${r.profile}) that overrides Allow rules.`
    );

    const internalExposureWarnings: string[] = [];
    const ports: FirewallPortStatus[] = resolvedPorts.map((p) => {
      const matching = parsed.allowRules.filter(
        (r) =>
          ruleMatchesPort(r.localPorts, p.port) &&
          ruleAppliesToProfile(r.profile, parsed.networkProfile)
      );
      const tcpAllowed = matching.some((r) => r.protocol === 'TCP' || r.protocol === 'ANY');
      const udpAllowed = matching.some((r) => r.protocol === 'UDP' || r.protocol === 'ANY');
      const ruleNames = Array.from(new Set(matching.map((r) => r.displayName).filter(Boolean)));
      const exposedInternalWarning = p.internalOnly && (tcpAllowed || udpAllowed);

      if (exposedInternalWarning) {
        internalExposureWarnings.push(
          `Security Warning: Internal-only port ${p.label} (${p.port}/${p.protocol.toUpperCase()}) has an active inbound Windows Firewall Allow rule (${ruleNames.join(', ')}). Keep management ports locked down to localhost.`
        );
      }

      return {
        key: p.key,
        label: p.label,
        port: p.port,
        protocol: p.protocol,
        internalOnly: p.internalOnly,
        tcpAllowed,
        udpAllowed,
        ruleNames,
        blockedByAppRule: !p.internalOnly && hasAppBlock,
        exposedInternalWarning,
      };
    });

    const publicProfileWarning = parsed.networkProfile === 'Public';
    const scriptContent = buildWindowsFirewallScript(instance, template, {
      switchProfileToPrivate: publicProfileWarning,
      profileName: parsed.profileName,
    });

    return {
      platform: this.platform,
      supported: true,
      isAdmin: parsed.isAdmin,
      networkProfile: parsed.networkProfile,
      profileName: parsed.profileName,
      publicProfileWarning,
      internalExposureWarnings,
      appBlockWarnings,
      ports,
      managedRulePrefix: prefix,
      scriptContent,
      scriptFilename: `serverforge-firewall-${sanitizeFirewallLabel(instance.slug)}.ps1`,
    };
  }

  async applyInstanceRules(
    instance: ServerInstance,
    template: GameTemplate | null,
    options: { switchProfileToPrivate?: boolean } = {}
  ): Promise<FirewallApplyResult> {
    const before = await this.inspectInstance(instance, template);

    if (this.platform !== 'win32') {
      return {
        ok: false,
        method: 'manual',
        message: 'Automatic Windows Firewall configuration is only available on Windows. Use the generated UFW commands on Linux.',
        status: before,
      };
    }

    const script = buildWindowsFirewallScript(instance, template, {
      switchProfileToPrivate: Boolean(options.switchProfileToPrivate && before.profileName),
      profileName: before.profileName,
    });

    if (before.isAdmin) {
      const encoded = encodePowerShellCommand(script);
      const res = await this.execImpl(
        'powershell.exe',
        ['-NoProfile', '-NonInteractive', '-EncodedCommand', encoded],
        20_000
      );
      const after = await this.inspectInstance(instance, template);
      if (res.exitCode === 0) {
        return {
          ok: true,
          method: 'direct',
          message: 'Private-profile Windows Firewall rules applied for required external game ports.',
          status: after,
        };
      }
      return {
        ok: false,
        method: 'direct',
        message: `Failed to apply Windows Firewall rules: ${res.stderr.trim() || `exit code ${res.exitCode}`}`,
        status: after,
      };
    }

    // Non-Admin: write temp .ps1 and trigger UAC elevation prompt via Start-Process -Verb RunAs
    fs.mkdirSync(this.tmpDir, { recursive: true });
    const tempScriptPath = path.join(
      this.tmpDir,
      `sf-fw-${sanitizeFirewallLabel(instance.slug)}-${Date.now()}.ps1`
    );
    try {
      fs.writeFileSync(tempScriptPath, script, 'utf8');
      const launcherScript = `
$ErrorActionPreference = 'Stop'
$proc = Start-Process -FilePath 'powershell.exe' -ArgumentList @('-NoProfile','-ExecutionPolicy','Bypass','-File','${escapePsSingleQuoted(tempScriptPath)}') -Verb RunAs -Wait -PassThru
exit $proc.ExitCode
`;
      const encoded = encodePowerShellCommand(launcherScript);
      const res = await this.execImpl(
        'powershell.exe',
        ['-NoProfile', '-NonInteractive', '-EncodedCommand', encoded],
        60_000
      );
      const after = await this.inspectInstance(instance, template);
      if (res.exitCode === 0) {
        return {
          ok: true,
          method: 'uac',
          message: 'Private-profile Windows Firewall rules applied via Administrator elevation (UAC).',
          status: after,
        };
      }
      return {
        ok: false,
        method: 'manual',
        message:
          'Administrator elevation was cancelled or unavailable (e.g. if accessing remotely). Copy or download the PowerShell script and run it in an Administrator PowerShell window on the server PC.',
        status: after,
      };
    } finally {
      try {
        if (fs.existsSync(tempScriptPath)) fs.rmSync(tempScriptPath, { force: true });
      } catch {
        // ignore temp cleanup errors
      }
    }
  }

  /**
   * Removes all ServerForge-managed firewall rules for an instance (`ServerForge - <slug>*`).
   * Used both for manual Lockdown and automatic cleanup when ports change or a server is deleted.
   */
  async removeInstanceRules(
    instance: ServerInstance,
    options: { allowUac?: boolean } = {}
  ): Promise<FirewallRemoveResult> {
    if (this.platform !== 'win32') {
      return {
        ok: true,
        removedCount: 0,
        message: 'No Windows Firewall rules to remove on this platform.',
      };
    }

    const prefix = buildManagedRulePrefix(instance.slug);
    const removeScript = `
$ErrorActionPreference = 'Stop'
$rules = @(Get-NetFirewallRule -DisplayName '${escapePsSingleQuoted(prefix)}*' -ErrorAction SilentlyContinue)
$count = $rules.Count
if ($count -gt 0) {
  $rules | Remove-NetFirewallRule
}
Write-Output $count
`;

    // Check elevation first so background cleanups (like deleteInstance) never hang on an unexpected UAC modal
    const checkAdminRes = await this.execImpl(
      'powershell.exe',
      [
        '-NoProfile',
        '-NonInteractive',
        '-Command',
        "([Security.Principal.WindowsPrincipal][Security.Principal.WindowsIdentity]::GetCurrent()).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)",
      ],
      6000
    );
    const isAdmin = checkAdminRes.stdout.trim().toLowerCase() === 'true';

    if (isAdmin) {
      const encoded = encodePowerShellCommand(removeScript);
      const res = await this.execImpl(
        'powershell.exe',
        ['-NoProfile', '-NonInteractive', '-EncodedCommand', encoded],
        15_000
      );
      if (res.exitCode === 0) {
        const count = Number.parseInt(res.stdout.trim(), 10) || 0;
        return {
          ok: true,
          removedCount: count,
          message:
            count > 0
              ? `Removed ${count} ServerForge-managed firewall rule(s) for "${instance.name}".`
              : `No ServerForge-managed firewall rules were active for "${instance.name}".`,
        };
      }
      return {
        ok: false,
        removedCount: 0,
        message: `Failed to remove firewall rules: ${res.stderr.trim() || `exit code ${res.exitCode}`}`,
      };
    }

    if (!options.allowUac) {
      return {
        ok: false,
        removedCount: 0,
        message:
          'Skipped automatic firewall rule removal because ServerForge is not running as Administrator.',
      };
    }

    fs.mkdirSync(this.tmpDir, { recursive: true });
    const tempScriptPath = path.join(
      this.tmpDir,
      `sf-fw-rm-${sanitizeFirewallLabel(instance.slug)}-${Date.now()}.ps1`
    );
    try {
      fs.writeFileSync(tempScriptPath, removeScript, 'utf8');
      const launcherScript = `
$ErrorActionPreference = 'Stop'
$proc = Start-Process -FilePath 'powershell.exe' -ArgumentList @('-NoProfile','-ExecutionPolicy','Bypass','-File','${escapePsSingleQuoted(tempScriptPath)}') -Verb RunAs -Wait -PassThru
exit $proc.ExitCode
`;
      const encoded = encodePowerShellCommand(launcherScript);
      const res = await this.execImpl(
        'powershell.exe',
        ['-NoProfile', '-NonInteractive', '-EncodedCommand', encoded],
        60_000
      );
      if (res.exitCode === 0) {
        return {
          ok: true,
          removedCount: 1,
          message: `Removed ServerForge-managed firewall rules for "${instance.name}" via Administrator elevation.`,
        };
      }
      return {
        ok: false,
        removedCount: 0,
        message: 'Administrator elevation was cancelled. Remove rules manually from Windows Defender Firewall.',
      };
    } finally {
      try {
        if (fs.existsSync(tempScriptPath)) fs.rmSync(tempScriptPath, { force: true });
      } catch {
        // ignore temp cleanup errors
      }
    }
  }
}
