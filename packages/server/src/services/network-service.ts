import { execFile } from 'node:child_process';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import type { NetworkStatus, PublicHostSource } from '@serverforge/shared';
import type { AppConfig } from '../config.js';
import type { AppDatabase } from '../db/database.js';
import { encodePowerShellCommand } from './import-service.js';

const PUBLIC_IP_ENDPOINTS = [
  'https://api.ipify.org?format=text',
  'https://icanhazip.com',
];

const CACHE_TTL_MS = 10 * 60_000;
const DUCKDNS_UPDATE_INTERVAL_MS = 15 * 60_000;
const VIRTUAL_ADAPTER_RE = /(?:vethernet|docker|br-|virbr|vmnet|vbox|tailscale|wg\d|zt|utun|wsl|loopback|hyper-v)/i;
const DUCKDNS_LABEL_RE = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/i;
const RESERVED_DUCKDNS_SUBDOMAINS = new Set(['www', 'api', 'ns1', 'ns2', 'ns3', 'ns4', 'ns5', 'ns6']);

export interface NetworkServiceOptions {
  fetchImpl?: typeof fetch;
  detectDuckDnsDomainsImpl?: () => Promise<string[]>;
  detectLanIpImpl?: () => string | null;
}

/**
 * Normalizes a user-provided or detected DuckDNS domain into `<subdomain>.duckdns.org`.
 * Accepts `myserver`, `myserver.duckdns.org`, `https://myserver.duckdns.org/`, or comma-separated lists
 * (returns the first valid domain for join addresses).
 */
export function normalizeDuckDnsDomain(raw: string): string {
  const cleaned = raw
    .trim()
    .replace(/^https?:\/\//i, '')
    .split(/[/?#\s]/)[0]
    .split(',')[0]
    .trim()
    .replace(/\.+$/, '')
    .toLowerCase();

  if (!cleaned) return '';

  const sub = cleaned.endsWith('.duckdns.org')
    ? cleaned.slice(0, -'.duckdns.org'.length)
    : cleaned;

  if (!sub || RESERVED_DUCKDNS_SUBDOMAINS.has(sub) || !DUCKDNS_LABEL_RE.test(sub)) {
    return '';
  }
  return `${sub}.duckdns.org`;
}

/**
 * Extracts one or more comma-separated DuckDNS subdomains for the DuckDNS update API (`domains=...`).
 */
export function extractDuckDnsSubdomains(raw: string): string {
  const parts = raw
    .split(/[,;\s]+/)
    .map((item) =>
      item
        .trim()
        .replace(/^https?:\/\//i, '')
        .split(/[/?#]/)[0]
        .replace(/\.+$/, '')
        .toLowerCase()
    )
    .map((item) => (item.endsWith('.duckdns.org') ? item.slice(0, -'.duckdns.org'.length) : item))
    .filter((sub) => Boolean(sub) && !RESERVED_DUCKDNS_SUBDOMAINS.has(sub) && DUCKDNS_LABEL_RE.test(sub));

  return Array.from(new Set(parts)).join(',');
}

/**
 * Returns true if `host` is localhost, loopback, unspecified, or an RFC1918 private LAN IP.
 * Tailscale CGNAT (`100.64.0.0/10`) and public domains return false.
 */
export function isLocalOrPrivateHost(host: string): boolean {
  const h = host.trim().toLowerCase().replace(/^\[|\]$/g, '');
  if (!h) return true;
  if (h === 'localhost' || h === '::1' || h === '0.0.0.0' || h.endsWith('.local')) {
    return true;
  }
  const ipVer = net.isIP(h);
  if (ipVer === 4) {
    const octets = h.split('.').map(Number);
    if (octets.length !== 4 || octets.some((o) => !Number.isFinite(o))) return true;
    const [a, b] = octets;
    if (a === 127 || a === 10 || a === 0) return true;
    if (a === 192 && b === 168) return true;
    if (a === 172 && b >= 16 && b <= 31) return true;
    if (a === 169 && b === 254) return true;
    return false;
  }
  if (ipVer === 6) {
    return h === '::1' || h === '::' || h.startsWith('fe80:') || h.startsWith('fc') || h.startsWith('fd');
  }
  return false;
}

export function isValidPublicIp(raw: string): boolean {
  const trimmed = raw.trim();
  const ver = net.isIP(trimmed);
  if (ver !== 4 && ver !== 6) return false;
  return !isLocalOrPrivateHost(trimmed);
}

/**
 * Parses DuckDNS domain names from arbitrary config/script/XML/Registry text
 * (e.g., Windows DuckDNS GUI `.NET user.config`, Registry values, Scheduled Tasks, Linux `duck.sh`).
 * Never extracts or returns authentication tokens.
 */
export function parseDuckDnsDomainsFromText(text: string): string[] {
  const found = new Set<string>();
  const addList = (rawList: string) => {
    for (const part of rawList.split(/[,;\s]+/)) {
      const normalized = normalizeDuckDnsDomain(part);
      if (normalized) found.add(normalized);
    }
  };

  // 1. Explicit `something.duckdns.org` hostnames
  for (const m of text.matchAll(/\b([a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.duckdns\.org)\b/gi)) {
    const normalized = normalizeDuckDnsDomain(m[1]);
    if (normalized) found.add(normalized);
  }

  // 2. Query string `domains=foo,bar` (from duckdns.org/update?domains=...)
  for (const m of text.matchAll(/[?&]domains=([a-z0-9,_-]+)/gi)) {
    addList(m[1]);
  }

  // 3. .NET user.config XML: <setting name="Domain" ...><value>myserver</value></setting>
  for (const m of text.matchAll(
    /<setting\b[^>]*name=["'](?:sub)?domains?["'][^>]*>[\s\S]*?<value>([^<]+)<\/value>/gi
  )) {
    addList(m[1]);
  }

  // 4. INI / Registry / JSON key-value lines: Domain=myserver, "domains": "myserver"
  for (const m of text.matchAll(/(?:^|[\r\n{,])\s*["']?(?:sub)?domains?["']?\s*[:=]\s*["']?([a-z0-9.,_-]+)["']?/gim)) {
    addList(m[1]);
  }

  return Array.from(found);
}

export function detectLocalLanIp(): string | null {
  const interfaces = os.networkInterfaces();
  const preferred: string[] = [];
  const fallback: string[] = [];

  for (const [name, addrs] of Object.entries(interfaces)) {
    if (!addrs) continue;
    for (const info of addrs) {
      if (info.family !== 'IPv4' || info.internal) continue;
      if (info.address.startsWith('169.254.')) continue;
      if (VIRTUAL_ADAPTER_RE.test(name)) {
        fallback.push(info.address);
      } else {
        preferred.push(info.address);
      }
    }
  }

  return preferred[0] ?? fallback[0] ?? null;
}

const WINDOWS_DUCKDNS_PROBE_SCRIPT = `
$ErrorActionPreference = 'SilentlyContinue'
$lines = New-Object System.Collections.Generic.List[string]

function Add-Text([string]$t) {
  if ($t) { $lines.Add($t) }
}

# 1. Windows Registry keys used by DuckDNS GUI clients
$regPaths = @(
  'HKCU:\\Software\\DuckDNS',
  'HKLM:\\Software\\DuckDNS',
  'HKCU:\\Software\\WOW6432Node\\DuckDNS',
  'HKLM:\\Software\\WOW6432Node\\DuckDNS'
)
foreach ($rp in $regPaths) {
  if (Test-Path $rp) {
    $props = Get-ItemProperty -Path $rp
    foreach ($p in $props.PSObject.Properties) {
      if ($p.Name -match 'domain' -or ($p.Value -is [string] -and $p.Value -match 'duckdns')) {
        Add-Text ("$($p.Name)=$($p.Value)")
      }
    }
    Get-ChildItem -Path $rp -Recurse | ForEach-Object {
      $sp = Get-ItemProperty -Path $_.PSPath
      foreach ($p in $sp.PSObject.Properties) {
        if ($p.Name -match 'domain' -or ($p.Value -is [string] -and $p.Value -match 'duckdns')) {
          Add-Text ("$($p.Name)=$($p.Value)")
        }
      }
    }
  }
}

# 2. AppData / LocalAppData / ProgramData / UserProfile DuckDNS config files (including .NET user.config)
$scanDirs = New-Object System.Collections.Generic.List[string]
foreach ($base in @($env:LOCALAPPDATA, $env:APPDATA, $env:PROGRAMDATA, $env:USERPROFILE)) {
  if ($base -and (Test-Path $base)) {
    Get-ChildItem -Path $base -Directory -Filter '*duckdns*' | ForEach-Object { $scanDirs.Add($_.FullName) }
  }
}

# Also check running DuckDNS process folder & Run startup registry entry
Get-Process | Where-Object { $_.ProcessName -match 'duckdns' } | ForEach-Object {
  if ($_.Path) { $scanDirs.Add((Split-Path $_.Path -Parent)) }
}
$runKey = Get-ItemProperty -Path 'HKCU:\\Software\\Microsoft\\Windows\\CurrentVersion\\Run'
if ($runKey) {
  foreach ($p in $runKey.PSObject.Properties) {
    if ($p.Name -match 'duckdns' -or ($p.Value -is [string] -and $p.Value -match 'duckdns')) {
      Add-Text ([string]$p.Value)
      if ($p.Value -match '([A-Za-z]:\\\\[^"''\\r\\n]+?duckdns[^"''\\r\\n]*\\.exe)') {
        $dir = Split-Path $Matches[1] -Parent
        if ($dir -and (Test-Path $dir)) { $scanDirs.Add($dir) }
      }
    }
  }
}

foreach ($dir in ($scanDirs | Select-Object -Unique)) {
  Get-ChildItem -Path $dir -Recurse -File -Include '*.config','*.ini','*.json','*.txt','*.bat','*.cmd','*.ps1','*.cfg','*.xml' |
    Where-Object { $_.Length -lt 262144 } |
    Select-Object -First 20 |
    ForEach-Object {
      $raw = Get-Content -Path $_.FullName -Raw
      if ($raw) {
        # Strip any token values before outputting
        $safe = $raw -replace '(token\\s*[:=]\\s*["'']?)[^&"'';\\r\\n\\s<]+', '$1REDACTED'
        Add-Text $safe
      }
    }
}

# 3. Windows Scheduled Tasks referencing duckdns.org
Get-ScheduledTask | ForEach-Object {
  foreach ($a in $_.Actions) {
    $cmd = "$($a.Execute) $($a.Arguments)"
    if ($cmd -match 'duckdns') {
      $safe = $cmd -replace '(token=)[^&\\s"'']+', '$1REDACTED'
      Add-Text $safe
    }
  }
}

$lines -join "\`n"
`;

async function detectWindowsDuckDnsDomains(): Promise<string[]> {
  return new Promise((resolve) => {
    const encoded = encodePowerShellCommand(WINDOWS_DUCKDNS_PROBE_SCRIPT);
    execFile(
      'powershell.exe',
      ['-NoProfile', '-NonInteractive', '-EncodedCommand', encoded],
      { timeout: 6000, windowsHide: true, maxBuffer: 512 * 1024 },
      (err, stdout) => {
        if (err || !stdout) return resolve([]);
        resolve(parseDuckDnsDomainsFromText(stdout));
      }
    );
  });
}

async function detectUnixDuckDnsDomains(): Promise<string[]> {
  const found = new Set<string>();
  const home = os.homedir();
  const candidateFiles = [
    path.join(home, 'duckdns', 'duck.sh'),
    path.join(home, '.duckdns', 'duck.sh'),
    '/etc/duckdns/duck.sh',
  ];

  for (const file of candidateFiles) {
    if (!fs.existsSync(file)) continue;
    try {
      const content = fs.readFileSync(file, 'utf8');
      for (const domain of parseDuckDnsDomainsFromText(content)) {
        found.add(domain);
      }
    } catch {
      // ignore unreadable files
    }
  }

  return Array.from(found);
}

export class NetworkAddressService {
  private readonly fetchImpl: typeof fetch;
  private readonly detectDuckDnsImpl: () => Promise<string[]>;
  private readonly detectLanIpImpl: () => string | null;

  private publicIp: string | null = null;
  private lanIp: string | null = null;
  private detectedDuckDnsDomains: string[] = [];
  private lastCheckedAt: string | null = null;
  private lastCheckedMs = 0;

  private duckdnsLastUpdateAt: string | null = null;
  private duckdnsLastStatus: string | null = null;

  private refreshTimer: NodeJS.Timeout | null = null;
  private ddnsTimer: NodeJS.Timeout | null = null;
  private inFlightRefresh: Promise<NetworkStatus> | null = null;

  constructor(
    private readonly config: AppConfig,
    private readonly db: AppDatabase,
    options: NetworkServiceOptions = {}
  ) {
    this.fetchImpl = options.fetchImpl ?? fetch;
    this.detectDuckDnsImpl =
      options.detectDuckDnsDomainsImpl ??
      (process.platform === 'win32' ? detectWindowsDuckDnsDomains : detectUnixDuckDnsDomains);
    this.detectLanIpImpl = options.detectLanIpImpl ?? detectLocalLanIp;
    this.lanIp = this.detectLanIpImpl();
  }

  /**
   * Starts periodic public IP / DuckDNS refresh and optional built-in DuckDNS DDNS updates.
   * Waits up to `initialWaitMs` for initial discovery so the first dashboard load shows the public address.
   */
  async start(initialWaitMs = 3000): Promise<void> {
    const initialPromise = this.refresh(true).catch(() => this.getStatusSync());
    await Promise.race([
      initialPromise,
      new Promise<void>((resolve) => setTimeout(resolve, initialWaitMs)),
    ]);

    const settings = this.db.getSettings(this.config.publicHost);
    if (settings.duckdnsAutoUpdate && settings.duckdnsDomain && settings.duckdnsToken) {
      void this.updateDuckDns().catch(() => {});
    }

    this.refreshTimer = setInterval(() => {
      void this.refresh(true).catch(() => {});
    }, CACHE_TTL_MS);
    this.refreshTimer.unref?.();

    this.ddnsTimer = setInterval(() => {
      const cur = this.db.getSettings(this.config.publicHost);
      if (cur.duckdnsAutoUpdate && cur.duckdnsDomain && cur.duckdnsToken) {
        void this.updateDuckDns().catch(() => {});
      }
    }, DUCKDNS_UPDATE_INTERVAL_MS);
    this.ddnsTimer.unref?.();
  }

  stop(): void {
    if (this.refreshTimer) {
      clearInterval(this.refreshTimer);
      this.refreshTimer = null;
    }
    if (this.ddnsTimer) {
      clearInterval(this.ddnsTimer);
      this.ddnsTimer = null;
    }
  }

  async detectPublicIp(): Promise<string | null> {
    for (const endpoint of PUBLIC_IP_ENDPOINTS) {
      try {
        const res = await this.fetchImpl(endpoint, {
          headers: { 'User-Agent': 'ServerForge/1.1.6 (+https://github.com/StriderVR/serverforge)' },
          signal: AbortSignal.timeout(4000),
        });
        if (!res.ok) continue;
        const text = (await res.text()).trim();
        if (isValidPublicIp(text)) {
          return text;
        }
      } catch {
        // try next endpoint
      }
    }
    return null;
  }

  async refresh(force = false): Promise<NetworkStatus> {
    if (!force && this.lastCheckedMs > 0 && Date.now() - this.lastCheckedMs < CACHE_TTL_MS) {
      return this.getStatusSync();
    }
    if (this.inFlightRefresh) {
      return this.inFlightRefresh;
    }

    this.inFlightRefresh = (async () => {
      try {
        this.lanIp = this.detectLanIpImpl();
        const [ip, duckDomains] = await Promise.all([
          this.detectPublicIp(),
          this.detectDuckDnsImpl().catch(() => [] as string[]),
        ]);
        if (ip) {
          this.publicIp = ip;
        }
        this.detectedDuckDnsDomains = Array.from(
          new Set(duckDomains.map(normalizeDuckDnsDomain).filter(Boolean))
        );
        this.lastCheckedMs = Date.now();
        this.lastCheckedAt = new Date(this.lastCheckedMs).toISOString();
        return this.getStatusSync();
      } finally {
        this.inFlightRefresh = null;
      }
    })();

    return this.inFlightRefresh;
  }

  /**
   * Resolves the best join host synchronously using current settings + cached network discovery.
   */
  resolveEffectiveHost(): { host: string; source: PublicHostSource } {
    const settings = this.db.getSettings(this.config.publicHost);
    const configuredDuck = normalizeDuckDnsDomain(settings.duckdnsDomain);
    const detectedDuck = this.detectedDuckDnsDomains[0] ?? '';
    const manualHost = settings.publicHost.trim();
    const envHost = this.config.publicHost.trim();

    if (settings.publicHostMode === 'duckdns') {
      if (configuredDuck) return { host: configuredDuck, source: 'duckdns' };
      if (detectedDuck) return { host: detectedDuck, source: 'detected_duckdns' };
    }

    if (settings.publicHostMode === 'manual') {
      if (manualHost) return { host: manualHost, source: 'manual' };
      return { host: 'localhost', source: 'fallback' };
    }

    // Automatic mode: DuckDNS (configured -> auto-detected) -> custom non-local host -> .env -> Public IP -> fallback
    if (configuredDuck) {
      return { host: configuredDuck, source: 'duckdns' };
    }
    if (detectedDuck) {
      return { host: detectedDuck, source: 'detected_duckdns' };
    }
    if (manualHost && !isLocalOrPrivateHost(manualHost)) {
      const source: PublicHostSource =
        envHost && manualHost.toLowerCase() === envHost.toLowerCase() && !isLocalOrPrivateHost(envHost)
          ? 'env'
          : 'manual';
      return { host: manualHost, source };
    }
    if (envHost && !isLocalOrPrivateHost(envHost)) {
      return { host: envHost, source: 'env' };
    }
    if (this.publicIp) {
      return { host: this.publicIp, source: 'public_ip' };
    }
    if (manualHost) {
      return { host: manualHost, source: isLocalOrPrivateHost(manualHost) ? 'fallback' : 'manual' };
    }
    return { host: 'localhost', source: 'fallback' };
  }

  getLanIp(): string | null {
    if (!this.lanIp) {
      this.lanIp = this.detectLanIpImpl();
    }
    return this.lanIp;
  }

  getStatusSync(): NetworkStatus {
    const settings = this.db.getSettings(this.config.publicHost);
    const resolved = this.resolveEffectiveHost();
    const normalizedDuck = normalizeDuckDnsDomain(settings.duckdnsDomain);

    return {
      effectiveHost: resolved.host,
      effectiveHostSource: resolved.source,
      publicIp: this.publicIp,
      lanIp: this.getLanIp(),
      detectedDuckDnsDomains: [...this.detectedDuckDnsDomains],
      duckdnsDomain: normalizedDuck || settings.duckdnsDomain.trim(),
      duckdnsConfigured: Boolean(normalizedDuck && settings.duckdnsToken.trim()),
      duckdnsLastUpdateAt: this.duckdnsLastUpdateAt,
      duckdnsLastStatus: this.duckdnsLastStatus,
      lastCheckedAt: this.lastCheckedAt,
    };
  }

  async getStatus(forceRefresh = false): Promise<NetworkStatus> {
    if (forceRefresh || this.lastCheckedMs === 0) {
      return this.refresh(forceRefresh);
    }
    return this.getStatusSync();
  }

  /**
   * Sends a Dynamic DNS update to DuckDNS (`https://www.duckdns.org/update`).
   */
  async updateDuckDns(options: { domain?: string; token?: string } = {}): Promise<{
    ok: boolean;
    message: string;
    domain: string;
    ip: string | null;
  }> {
    const settings = this.db.getSettings(this.config.publicHost);
    const rawDomain = (options.domain !== undefined ? options.domain : settings.duckdnsDomain).trim();
    const rawToken = (options.token !== undefined ? options.token : settings.duckdnsToken).trim();

    const subdomains = extractDuckDnsSubdomains(rawDomain);
    const normalizedDomain = normalizeDuckDnsDomain(rawDomain);

    if (!subdomains || !normalizedDomain) {
      return {
        ok: false,
        message: 'Enter a valid DuckDNS domain (e.g., myserver.duckdns.org or myserver).',
        domain: normalizedDomain,
        ip: this.publicIp,
      };
    }

    if (!rawToken) {
      return {
        ok: false,
        message: 'Enter your DuckDNS account token (found at https://www.duckdns.org/) to push IP updates.',
        domain: normalizedDomain,
        ip: this.publicIp,
      };
    }

    const url = `https://www.duckdns.org/update?domains=${encodeURIComponent(subdomains)}&token=${encodeURIComponent(rawToken)}&ip=`;

    try {
      const res = await this.fetchImpl(url, {
        headers: { 'User-Agent': 'ServerForge/1.1.6 (+https://github.com/StriderVR/serverforge)' },
        signal: AbortSignal.timeout(10_000),
      });
      const body = (await res.text()).trim();
      const nowIso = new Date().toISOString();
      this.duckdnsLastUpdateAt = nowIso;

      if (res.ok && body.startsWith('OK')) {
        const ip = (await this.detectPublicIp()) ?? this.publicIp;
        if (ip) this.publicIp = ip;
        this.duckdnsLastStatus = 'OK';
        return {
          ok: true,
          message: ip
            ? `DuckDNS updated ${normalizedDomain} -> ${ip} (OK).`
            : `DuckDNS updated ${normalizedDomain} cleanly (OK).`,
          domain: normalizedDomain,
          ip,
        };
      }

      this.duckdnsLastStatus = body ? `Failed (${body.slice(0, 60)})` : `HTTP ${res.status}`;
      return {
        ok: false,
        message: `DuckDNS rejected the update (${this.duckdnsLastStatus}). Check that "${subdomains}" belongs to this DuckDNS token.`,
        domain: normalizedDomain,
        ip: this.publicIp,
      };
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      this.duckdnsLastUpdateAt = new Date().toISOString();
      this.duckdnsLastStatus = `Error: ${msg}`;
      return {
        ok: false,
        message: `Could not reach DuckDNS: ${msg}`,
        domain: normalizedDomain,
        ip: this.publicIp,
      };
    }
  }
}
