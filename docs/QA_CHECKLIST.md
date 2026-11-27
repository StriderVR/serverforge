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
