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
