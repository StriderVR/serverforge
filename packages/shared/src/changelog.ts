export interface ReleaseNoteEntry {
  version: string;
  title: string;
  summary: string;
  added?: string[];
  changed?: string[];
  removed?: string[];
}

/**
 * Curated, high-level, plain-English release highlights displayed in the
 * "What's New" splash popup after each ServerForge update.
 * Ordered newest-first.
 */
export const RELEASE_NOTES: ReleaseNoteEntry[] = [
  {
    version: '1.4.7',
    title: 'Version Selector & Rollback, Hybrid Bug Reporter & QA Gate',
    summary: 'Adds an in-app version selector with Experimental channel & rollback, prevents updates before ServerForge.exe is uploaded, adds a hybrid in-built GitHub bug reporter, and introduces the Manual QA & Pre-Release Gate.',
    added: [
      'In-App Version Selector & Rollback in Settings -> Updates & Maintenance with Stable vs Experimental (Pre-Release) channel toggle and full release picker.',
      'Hybrid In-Built Bug Reporter accessible from the sidebar and server crash cards — auto-attaches secret-redacted diagnostics for 1-click pre-filled GitHub issues or optional direct submission via encrypted GitHub PAT.',
      'Versioned Manual QA Matrix & Per-Game Verification Checklist (docs/QA_CHECKLIST.md) and automatic Pre-Release CI tagging for hyphenated RC/beta tags.',
    ],
    changed: [
      'Self-updater now checks that ServerForge.exe is actually attached to a GitHub release before advertising an update as ready (fixes #69).',
    ],
  },
  {
    version: '1.4.6',
    title: 'Opt-In Built-In HTTPS / TLS for Encrypted LAN Access',
    summary: 'Adds optional built-in HTTPS with zero-dependency local TLS certificate generation, custom PEM cert support, automatic Secure auth cookies, wss:// WebSockets, and safe HTTP fallback.',
    added: [
      'Opt-in HTTPS / TLS toggle in Settings -> Security & Audit supporting auto-generated local X.509 certificates (with localhost, LAN IP, and .local hostname SANs) or custom .crt/.key paths.',
      'One-click Download Local Certificate (.crt) and Regenerate Certificate controls with brief Windows/mobile trust steps.',
      'Safe automatic fallback to HTTP with a clear diagnostic alert if a custom certificate or key file fails to load.',
    ],
    changed: [
      'Auth session cookies automatically enable Secure when running over HTTPS and WebSockets connect over wss://.',
    ],
  },
  {
    version: '1.4.5',
    title: 'Security & Audit Dashboard, Host Lockdown & Loopback RCON',
    summary: 'Adds a live security health checklist, searchable audit log viewer with export, password-confirmed host lockdown switches, and strict localhost binding for internal management ports.',
    added: [
      'Live Security Health Checklist in Settings -> Security & Audit, including Windows Administrator elevation warning, IP allowlist, Vault, 2FA, HTTPS, and failed-login checks.',
      'Password-confirmed Host Lockdown switches to disable host drive browsing outside ServerForge data and block executable/script web uploads (.exe, .bat, .cmd, .ps1, .dll, .vbs, .msi, .sh).',
      'Searchable, filterable Audit Log viewer backed by GET /api/audit-logs with one-click JSON and CSV export.',
    ],
    changed: [
      'Docker internal-only management ports (RCON / REST API) now bind strictly to 127.0.0.1, and native Factorio RCON binds strictly to 127.0.0.1.',
    ],
  },
  {
    version: '1.4.4',
    title: 'Encrypted Secret Vault & Masked API Responses',
    summary: 'Encrypts stored tokens and server passwords at rest with AES-256-GCM + Windows DPAPI and stops sending raw secrets back to the browser.',
    added: [
      'Authenticated AES-256-GCM Secret Vault encrypting Discord bot tokens, DuckDNS tokens, CurseForge API keys, and sensitive instance passwords in SQLite.',
      'Windows DPAPI (CurrentUser) master-key protection on Windows 11 with automatic 0600 local keyfile fallback on Linux and transparent plaintext migration.',
      'Graceful recovery banner in Settings if a database is moved to another PC and stored secrets need to be re-entered.',
    ],
    changed: [
      'GET /api/settings and instance endpoints now return write-only masked previews instead of raw tokens or passwords.',
    ],
  },
  {
    version: '1.4.3',
    title: 'Auth Hardening, Active Sessions & Opt-In 2FA',
    summary: 'Adds brute-force login protection, revocable device sessions, in-app password changes, Discord security alerts, and optional TOTP two-factor authentication.',
    added: [
      'Login rate-limiting with progressive lockout (HTTP 429 + Retry-After) and optional Discord alerts on lockouts or logins from new IPs.',
      'SQLite-tracked active sessions in Settings -> Security with per-device revocation and "Sign Out All Devices".',
      'In-app Change Password flow with option to sign out all other devices immediately.',
      'Opt-in RFC 6238 TOTP Two-Factor Authentication (authenticator app key + 8 hashed single-use recovery codes).',
    ],
  },
  {
    version: '1.4.2',
    title: 'Strict CORS, CSRF Protection, Security Headers & IP Allowlisting',
    summary: 'Locks down the ServerForge dashboard against cross-origin browser attacks and accidental public internet exposure.',
    added: [
      'Default LAN + Tailscale IP allowlist on port 3000 — blocks any public internet IP from accessing the dashboard even if port 3000 were accidentally forwarded.',
      'Dashboard Access Control setting in Settings -> Network supporting LAN & Tailscale (default), Localhost-Only lockdown, or Custom Trusted CIDRs.',
      'Strict Same-Origin CORS & CSRF Origin/Referer protection rejecting cross-origin state-changing browser requests (403).',
      'Standard HTTP security headers (Content-Security-Policy, X-Frame-Options: DENY, X-Content-Type-Options: nosniff, Referrer-Policy, Permissions-Policy) on all API and Web UI responses.',
    ],
  },
  {
    version: '1.4.1',
    title: 'Opt-In Automatic Router Port Forwarding (UPnP / NAT-PMP)',
    summary: 'Automatically open and clean up required game ports on compatible routers — disabled by default for security, with per-server controls.',
    added: [
      'Opt-in UPnP IGD (v1/v2) & NAT-PMP automatic port forwarding: maps only required external game ports while a server is running, renews leases automatically, and deletes mappings immediately on stop, delete, or shutdown.',
      'Per-server UPnP override (Inherit / Enabled / Disabled) right inside each server\'s Network & Firewall tab so you can test UPnP on one game without affecting others.',
      'Router UPnP Discovery card in Settings -> Network showing router model, router-reported WAN IP, and existing port mappings with clear error hints for port conflicts (718) and permanent-lease routers (725).',
      'Crash-recovery cleanup persisted in SQLite so stale UPnP router rules are automatically removed on next startup.',
    ],
  },
  {
    version: '1.4.0',
    title: 'Security-First Network Guide, Firewall & External Reachability Tester',
    summary: 'Pinpoint why remote friends cannot connect, open only the exact required game ports on your Private network profile, and keep internal management ports locked down locally.',
    added: [
      'Dedicated Network tab on every server with a live 5-hop External Connectivity Troubleshooter (Process Bind -> Windows Firewall & Exposure Audit -> LAN IP Drift -> NAT/CGNAT -> External WAN Probe).',
      'Least-privilege Windows Firewall manager that inspects active rules, warns on Public network profiles or hidden Block rules, opens only required external ports on the Private profile, and auto-cleans old rules when ports change or a server is deleted.',
      'Per-server Router Port Forwarding Guide with Local Only security badges (so RCON/REST never get forwarded) and 1-click Copy Router Rules.',
      'Consolidated All-Server Port Map in Settings -> Network to spot port conflicts across all servers at a glance.',
    ],
  },
  {
    version: '1.3.6',
    title: 'Automatic Satisfactory Port Upgrade',
    summary: 'Automatically adds the Satisfactory 1.1+ Reliable Messaging port to existing installations without requiring manual YAML cleanup.',
    changed: [
      'Upgraded ServerForge installs now automatically show the Reliable Messaging Port (1.1+) (TCP) field on Deploy and Configuration screens even when an older satisfactory.yaml file exists on disk.',
    ],
  },
  {
    version: '1.3.5',
    title: 'Custom Port Configuration',
    summary: 'Choose custom ports when deploying a new server or edit ports anytime on an existing stopped server.',
    added: [
      'Editable port fields on the One-Click Deploy page so you can pick alternate ports (e.g. 27777 / 25577) when your router blocks defaults.',
      'Editable port fields in the Instance Configuration tab so existing servers can be reassigned to new ports without recreating them.',
    ],
  },
  {
    version: '1.3.4',
    title: 'Satisfactory 1.1+ Remote Connectivity Fix',
    summary: 'Adds Satisfactory 1.1+ Reliable Messaging port configuration and explicit IPv4 interface binding so remote friends can connect reliably.',
    added: [
      'Configurable Reliable Messaging TCP port (default 8888) for Satisfactory 1.1+ servers, supporting custom alternate ports when routers block default ports.',
    ],
    changed: [
      'Satisfactory native servers now launch with -ReliablePort and -multihome=0.0.0.0 for reliable remote connections on Windows and Linux.',
    ],
  },
  {
    version: '1.3.3',
    title: "What's New Splash Screen",
    summary: 'See a quick, plain-English overview of changes every time ServerForge updates.',
    added: [
      '"What\'s New" popup that appears once after each update with simple Added, Changed, and Removed highlights.',
      'Click the version number in the sidebar anytime to re-open release highlights or browse recent updates.',
    ],
    changed: [
      'Refreshing your browser on the Files, Server Properties, or Mods / Plugins tabs now keeps you on the same tab.',
    ],
  },
  {
    version: '1.3.2',
    title: 'Files, Mods & One-Click Updates',
    summary: 'Manage server files, Minecraft settings, Modrinth mods, and game updates right from your browser.',
    added: [
      'In-browser Files tab to browse folders, edit configs, and drag-and-drop mods or world files.',
      'Dedicated Minecraft Server Properties editor with friendly toggles and a Save & Restart option.',
      'Modrinth Modpack deployments and a Mods / Plugins tab to install, toggle, or update Minecraft mods without an API key.',
      'One-click Update Server button for SteamCMD games, CurseForge modpacks, and Modrinth modpacks with automatic safety backups.',
    ],
    changed: [
      'Minecraft now includes Standard, CurseForge Modpack, and Modrinth Modpack editions inside one tile.',
    ],
  },
  {
    version: '1.3.1',
    title: 'Cleaner Game Catalog',
    summary: 'Simplified the One-Click Deploy screen by combining Minecraft editions into one card.',
    changed: [
      'Combined Minecraft and Minecraft (CurseForge Modpack) into a single Minecraft tile with an edition switcher.',
      'Switching between Minecraft editions now keeps your server name, RAM cap, and shared settings intact.',
    ],
  },
  {
    version: '1.3.0',
    title: 'Guided Discord Bot & Live Panel',
    summary: 'Connect your Discord bot directly from Settings with zero manual config files.',
    added: [
      'Step-by-step Discord Bot setup wizard inside Settings with live server, channel, and role pickers.',
      'Auto-updating Live Status Panel for Discord with interactive Start, Extend, Stop, and Refresh buttons.',
      'Expanded Discord admin commands (/server backup, /server say, /server whitelist, /server panel) and optional player join/leave alerts.',
    ],
  },
  {
    version: '1.2.2',
    title: 'One-Click Steam & Native Game Boot Fixes',
    summary: 'Improved out-of-the-box booting for Satisfactory, Factorio, Palworld, and Ark: Survival Ascended.',
    changed: [
      'Automatically downloads SteamCMD and configures Satisfactory, Palworld, Factorio, and Ark: ASA on Windows without manual setup.',
    ],
  },
];

export function normalizeReleaseVersion(version: string): string {
  return version.trim().replace(/^v/i, '');
}

export function getReleaseNotesForVersion(version: string): ReleaseNoteEntry | null {
  const clean = normalizeReleaseVersion(version);
  if (!clean) return null;
  return RELEASE_NOTES.find((entry) => entry.version === clean) ?? null;
}
