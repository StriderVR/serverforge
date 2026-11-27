# ServerForge Manual QA Matrix & Pre-Release Verification Gate

This checklist defines the manual verification gate required before promoting any **Pre-Release** (`vX.Y.Z-rc.N` / `-beta.N`) to a **Stable** release (`vX.Y.Z`). Automated unit & integration tests run in `mock` runtime mode and cannot catch Windows 11 firewall, router UPnP/NAT, SteamCMD, or external WAN join regressions on their own.

---

## 1. Release Gate & Promotion Workflow

1. **All Milestone Tickets Complete:** Never cut a Stable release until every ticket targeted for that milestone is merged and closed.
2. **Automated CI Must Be Green:** `pnpm build`, `pnpm typecheck`, `pnpm test`, and Windows `ServerForge.exe` build + live self-update smoke test must pass on `main`.
3. **Pre-Release Smoke Test on Real Windows 11 Host:**
   - Tag a pre-release (e.g. `v1.5.0-rc.1`). GitHub Actions automatically builds `ServerForge.exe` and publishes it as a GitHub **Pre-Release**.
   - On the Windows server PC, switch **Settings → Updates & Maintenance → Update Channel** to **Experimental (Pre-Releases)** and install the RC build using the **Version Selector**.
   - Sign off every applicable row in Sections 2–4 below.
   - If a bug is found, file it directly via the **Report a Bug** button in the sidebar (and roll back to the previous stable version via the Version Selector if needed).
4. **Promote to Stable:** Only after manual sign-off, tag the Stable version (`v1.5.0`) and confirm `ServerForge.exe` is attached to the GitHub Release.

---

## 2. Core Platform & Security QA Matrix

| Area | Manual Test Steps (Windows 11 `ServerForge.exe`) | Expected Result | Status |
| :--- | :--- | :--- | :--- |
| **Fresh Boot & Upgrade** | Upgrade over an existing `data/` folder containing `serverforge.sqlite`, instances, and older `catalog/games/*.yaml`. | App starts cleanly, migrates SQLite & legacy YAML ports/settings without overwriting custom tweaks. | [ ] |
| **Self-Updater & Rollback** | Switch channel to Experimental, update to a pre-release, then roll back to previous stable via **Version Selector**. | Running servers gracefully save & stop, `ServerForge.exe` swaps cleanly, servers auto-resume; releases without `.exe` are never offered (#69). | [ ] |
| **Auth, Sessions & 2FA** | Test 5 failed logins (triggers HTTP 429), revoke a secondary session in **Settings → Security & Audit**, enable/verify/disable TOTP 2FA. | Lockout enforces cooldown, revoked browser immediately logs out, TOTP + single-use recovery codes work. | [ ] |
| **Secret Vault & Masking** | Save Discord/DuckDNS/CurseForge/GitHub tokens, inspect network tab on `GET /api/settings` and `GET /api/instances`. | Zero raw tokens/passwords returned to browser; saving unrelated settings preserves encrypted secrets. | [ ] |
| **Host Lockdown & Health** | Check **Live Security Health Checklist**, toggle Lock Host FS Browsing & Block Executable Uploads with admin password. | External `/api/import/browse` and `.exe`/`.ps1` uploads return HTTP 403; `.jar` mod uploads still work. | [ ] |
| **Opt-In HTTPS / TLS** | Enable HTTPS (auto-generated local cert), restart, download `.crt`, verify dashboard & live console WebSocket (`wss://`). | Dashboard loads over `https://`, `sf_token` cookie has `Secure` flag, console streams over `wss://`. | [ ] |
| **In-Built Bug Reporter** | Click **Report a Bug**, select a server, preview redacted bundle, open pre-filled GitHub issue (and test direct submit if PAT configured). | Secrets redacted (`[REDACTED]`), pre-filled issue opens cleanly (or direct submit returns issue URL). | [ ] |
| **Discord Bot** | Connect bot, sync slash commands, run `/server list`, `/server start`, `/server status`, `/server stop`, verify Live Status Panel & alerts. | Commands respond, temporary lease starts & stops cleanly, security/crash alerts post to channel. | [ ] |
| **Backups & File Manager** | Create manual backup, edit config file, upload mod `.jar`, restore backup while server is running. | Pre-restore safety snapshot created, server stops, world restores, server boots cleanly. | [ ] |

---

## 3. Networking, Firewall & External WAN QA Matrix

| Check | Manual Test Steps | Expected Result | Status |
| :--- | :--- | :--- | :--- |
| **Windows Firewall (Private Profile)** | Click **Apply Windows Firewall Rules** on a server's Network tab; inspect Windows Defender Firewall. | Inbound rules created **only** for `Private` profile and **only** for public game/query ports (never `internalOnly` RCON/REST). Changing ports or deleting instance cleans stale rules. | [ ] |
| **UPnP / NAT-PMP (Opt-In)** | Enable UPnP in Settings → Networking, start a server, check router port mappings, then stop server. | Public game ports mapped on router while running, unmapped cleanly on stop; `internalOnly` ports never mapped. | [ ] |
| **5-Hop Connectivity Tester** | Run **Test External Reachability** while server is running. | Reports LAN IP, DuckDNS/WAN IP, Firewall, Local Port Listen, and External Reachability accurately; detects CGNAT or LAN IP drift if present. | [ ] |
| **Real External Friend Join** | Have a friend on an external network (non-LAN / mobile hotspot) connect using the copyable Join Address. | Friend connects, stays connected without timeout/disconnect, and sees world updates. | [ ] |

---

## 4. Per-Game Live Verification Matrix

Verify every template touched by a release (and spot-check core games before every major/minor release):

| Game Template | Required Public Ports | Internal-Only Ports (Loopback / Never Forwarded) | Install / Update | Boot & Config / Custom Port | LAN Join | External WAN Join | Save Persist & Stop |
| :--- | :--- | :--- | :---: | :---: | :---: | :---: | :---: |
| **Satisfactory 1.1+** | `7777` TCP+UDP, `8888` TCP (`ReliablePort`) | — | [ ] | [ ] | [ ] | [ ] | [ ] |
| **Minecraft Vanilla** | `25565` TCP | `25575` TCP (RCON) | [ ] | [ ] | [ ] | [ ] | [ ] |
| **Minecraft CurseForge** | `25565` TCP | `25575` TCP (RCON) | [ ] | [ ] | [ ] | [ ] | [ ] |
| **Minecraft Modrinth** | `25565` TCP | `25575` TCP (RCON) | [ ] | [ ] | [ ] | [ ] | [ ] |
| **Palworld** | `8211` UDP, `27015` UDP (query) | `25575` TCP (RCON), `8212` TCP (REST) | [ ] | [ ] | [ ] | [ ] | [ ] |
| **Factorio** | `34197` UDP | `27015` TCP (RCON `127.0.0.1`) | [ ] | [ ] | [ ] | [ ] | [ ] |
| **ARK: Survival Ascended** | `7777` UDP, `7778` UDP | `27020` TCP (RCON) | [ ] | [ ] | [ ] | [ ] | [ ] |

---

## 5. `v1.5.0` Manual Verification Checklist (Not Covered by Automation)

Automated unit, integration, and SEA bundle tests verify parsing, API contracts, sandboxing, secret redaction, and mocked upstream APIs, but **cannot** exercise real Discord UI rendering, real phone browsers, router/WAN isolation, live upstream Modrinth/Paper/Forge/NeoForge downloads, or live Windows 11 `ServerForge.exe` upgrades. Verify these items manually on your Windows 11 host and phone:

### A. Discord `/server guide` & Live Status Panel (#109)
- [ ] **Slash Command Sync & Guide Embed:** Restart or reconnect the Discord bot, verify `/server guide` appears in Discord autocomplete, and run `/server guide <server>` for both a running and a stopped server.
  - *Expected:* Rich embed displays live status/player count, copyable public join address (DuckDNS / WAN host, never `localhost` when WAN is unconfigured), game-specific `connectSteps`, and modpack/loader details (for modded Minecraft).
- [ ] **How to Connect Button:** Post/refresh the Live Status Panel in Discord and click a server's **How to Connect** button (`sf:guide:<id>`).
  - *Expected:* Ephemeral reply visible only to the clicking friend; `RCON_PASSWORD`, `ADMIN_PASSWORD`, and plaintext `SERVER_PASSWORD` are never shown (passworded servers show *"Password required — ask the host"*).

### B. Mobile-Responsive LAN Dashboard & Installable PWA (#107, #108)
- [ ] **Real Phone Viewport Check (iOS Safari & Android Chrome, 375px–430px):** Open `http://<LAN-IP>:3000` (or `https://<LAN-IP>:3000`) on a phone and visit **Server Fleet**, **One-Click Deploy**, **Game Templates**, **Instance Detail** (all tabs including **Version & Updates**, **Mods/Plugins/Datapacks**, **Network**, **Files**, **Backups**), and **Settings**.
  - *Expected:* Hamburger menu opens the slide-in navigation drawer cleanly and closes on backdrop tap/navigation; horizontal pill tabs scroll smoothly; wide tables scroll inside `.table-scroll` without causing horizontal page overflow; buttons and inputs are comfortably tappable (`>= 44px`).
- [ ] **Installable LAN PWA ("Add to Home Screen"):**
  - *Android Chrome (requires HTTPS enabled in **Settings → Security & Audit**, with local `.crt` trusted or accepted):* Tap **Install app** / **Add to Home screen**, launch from the home screen, and verify it opens fullscreen (`standalone`) with the ServerForge icon and live WebSocket console streaming works.
  - *iOS Safari:* Tap **Share → Add to Home Screen**, launch from the home screen, and verify safe-area notch/home-indicator spacing looks clean.
- [ ] **LAN-Only Security Invariant (WAN Block):** Confirm from outside your LAN (or via external check) that `/`, `/manifest.webmanifest`, and `/sw.js` are never reachable publicly (and any non-LAN/non-Tailscale IP hitting port 3000 receives HTTP `403`).

### C. Minecraft Plugin & World Datapack Manager (#128)
- [ ] **Real Paper/Purpur Plugin Install & Toggle:** On a live Paper (or Purpur/Spigot) instance, open **Mods / Plugins / Datapacks**, confirm loader auto-detection, search Modrinth for a real plugin (e.g., `LuckPerms`), install it, toggle it Disabled (`.jar.disabled`) and back Enabled (`.jar`), boot the server, and verify `/plugins` lists it.
- [ ] **Real World Datapack Install, `.zip` Upload & Custom `level-name`:**
  - Search Modrinth with type **Datapacks** (e.g., `Terralith` or a lightweight datapack) and install it; also test **Upload Datapack (.zip)** with a local `.zip` datapack.
  - Confirm the file lands in `<level-name>/datapacks/` (even if `level-name` in `server.properties` was customized), toggle `.zip` ↔ `.zip.disabled`, boot the server, and run `datapack list` in the live console to confirm Minecraft loads it.

### D. Minecraft 5-Loader Switcher & Auto-JRE (#127)
- [ ] **Live Loader Switches (Vanilla / Paper / Fabric / Forge / NeoForge):**
  - Deploy a standard Minecraft instance using the **Quick Loader Picker**, boot once to generate a world, then switch loaders in the **Version & Updates** tab (e.g., **Paper 1.21.4 → Fabric 1.21.4**, then **Forge 1.20.1**, then **NeoForge 1.21.1**).
  - *Expected:* Server stops gracefully, automatic pre-switch backup `.zip` is created, old loader artifacts (`server.jar`, `run.bat`, Forge/NeoForge libs) are removed while `world/`, `server.properties`, `whitelist.json`, `mods/`, `plugins/`, and `config/` remain intact, and the new loader installs & boots cleanly.
- [ ] **Auto-JRE Upgrade & Downgrade:** Switch from **1.21.4 (Java 21)** → **1.16.5 (Java 8)** (or **1.20.1 (Java 17)**) and back → **1.21.4 (Java 21)**, verifying portable Temurin JRE downloads automatically and the server boots without `UnsupportedClassVersionError`.
- [ ] **Pre-Switch Backup Restore:** Restore one of the automatic pre-switch safety backups from the **Backups** tab and confirm the previous world/server state comes back cleanly.

### E. Minecraft Crash Report Analyzer & Bug Reporter (#129)
- [ ] **Real Mod Crash Diagnosis:** Deliberately drop an incompatible client-only mod (e.g., Sodium/Oculus) or a mod missing its required dependency into a Forge/Fabric server's `mods/` folder and start the server.
  - *Expected:* After crash exit, the red `.crash-banner` displays the category badge (`CLIENT ONLY MOD` / `MISSING DEPENDENCY`), suspected JAR/mod chip, and plain-English **Recommended fix**.
- [ ] **Bug Reporter Prefill & Secret Redaction:** Click **Report Issue** inside the crash banner, preview the generated Markdown, and confirm `### Minecraft Crash Analysis` is attached while `RCON_PASSWORD` and API tokens are redacted as `[REDACTED]`.

### F. Windows 11 `ServerForge.exe` Live Upgrade (`v1.4.7` → `v1.5.0`)
- [ ] **In-App Self-Update:** On your Windows 11 PC running `v1.4.7`, open **Settings → Updates & Maintenance**, verify `v1.5.0` appears only after `ServerForge.exe` is attached to the GitHub Release, click **Update**, and confirm running servers gracefully save & stop, `ServerForge.exe` swaps cleanly, servers auto-resume, and the **"What's New in v1.5.0"** modal appears once.

