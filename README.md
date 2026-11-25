# ServerForge

**ServerForge** is a self-hosted, one-click game server deployment control plane and Discord temporary-boot orchestrator designed for Windows 11 and Linux server PCs.

## Key Capabilities

- **One-Click Web Dashboard**: Deploy, start, stop, restart, edit configuration, watch real-time streaming console logs (WebSocket), send RCON/console commands, and take timestamped `.zip` world backups from any browser (no Remote Desktop required).
- **Discord Temporary Server Booting**: Role-gated Discord slash commands (`/server list`, `/server start`, `/server extend`, `/server stop`, `/server status`) with interactive **Extend +1h** and **Save & Stop** buttons.
- **Automatic Idle & Lease Auto-Shutdown**: Protects your PC's power and RAM by automatically warning Discord 10 minutes before shutdown, running each game's native save command (RCON / Palworld REST API), and cleanly stopping servers when either the temporary lease expires or the server sits empty with 0 players.
- **Resource Guardrails**: Enforces configurable max concurrent running servers, keeps a configurable OS RAM reserve free for Windows 11, and automatically assigns non-overlapping ports when deploying multiple instances of the same game.
- **Hybrid Runtime Architecture**: Supports both **Docker Desktop (WSL2)** and **Native Windows SteamCMD / Java** processes per instance — ideal for running RAM-heavy Windows-native servers like **Ark: Survival Ascended** natively alongside Dockerized servers.
- **Zero-Code Scalability (YAML Game Catalog)**: Ships with 5 built-in templates — **Minecraft (Java/Paper/Modded)**, **Satisfactory**, **Factorio**, **Palworld**, and **Ark: Survival Ascended**. Add new games anytime by dropping a `.yaml` file into `catalog/games/` or importing one directly in the Web UI.

---

## Quick Start on Windows 11

### Option 1 (Easiest): Standalone `ServerForge.exe` (No Node.js Required)

1. Go to this repository's **Releases** page on GitHub and download **`ServerForge.exe`**.
2. Put `ServerForge.exe` in a dedicated folder on your Windows 11 server PC (for example `C:\ServerForge\ServerForge.exe`).
3. **Double-click `ServerForge.exe`**!
   - On first launch it automatically creates `.env` and `catalog/games/*.yaml` right beside the `.exe`, starts the control plane, and opens `http://localhost:3000` in your browser.
   - To enable Discord slash commands, open `.env` in Notepad, paste your `DISCORD_TOKEN`, `DISCORD_CLIENT_ID`, and `DISCORD_GUILD_ID`, and restart `ServerForge.exe`.
   - For running real game servers, install **Docker Desktop** (for Minecraft, Factorio, Satisfactory, Palworld) and/or **SteamCMD** (`C:\steamcmd\steamcmd.exe` for Native Windows **Ark: Survival Ascended**).

### Option 2: Run from Source (or Build `ServerForge.exe` Yourself)

#### Prerequisites
- **Node.js 22.5+** (`winget install OpenJS.NodeJS.LTS`)
- **Docker Desktop** (recommended for Minecraft, Factorio, Satisfactory, Palworld) and/or **SteamCMD** (recommended for Native Windows **Ark: Survival Ascended**)

#### Install & Build

Open PowerShell in the cloned `serverforge` directory:

```powershell
# Basic setup + auto-download Valve SteamCMD into data/tools/steamcmd
.\scripts\install-windows.ps1 -InstallSteamCmd

# Optional: build your own local standalone ServerForge.exe
.\scripts\build-windows-exe.ps1

# Optional: also register Windows Startup Task (runs at boot without RDP) and open port 3000
# (Run PowerShell as Administrator for these flags)
.\scripts\install-windows.ps1 -InstallSteamCmd -RegisterStartupTask -OpenFirewallPort
```

Start ServerForge:

```powershell
pnpm start
```

Open `http://localhost:3000` (or `http://<your-tailscale-ip>:3000`) to complete the first-run Admin account setup.

### Try Instant Preview Mode (No Docker / Game Downloads Needed)

```bash
pnpm build
pnpm start:mock
```

---

## Setting Up the Discord Bot

1. Go to the [Discord Developer Portal](https://discord.com/developers/applications) and create a **New Application**.
2. Open **Bot** -> click **Reset Token** and copy the token into `.env` as `DISCORD_TOKEN`.
3. Open **General Information** -> copy **Application ID** into `.env` as `DISCORD_CLIENT_ID`.
4. Right-click your Discord server (with Developer Mode enabled in Discord Settings) -> **Copy Server ID** -> set `DISCORD_GUILD_ID` in `.env` for instant slash-command registration.
5. Open **OAuth2 -> URL Generator**:
   - Scopes: `bot`, `applications.commands`
   - Bot Permissions: `Send Messages`, `Embed Links`, `Read Message History`
   - Open the generated invite URL to add the bot to your Discord server.
6. Restart ServerForge, then open **Discord & Guardrails** in the Web UI to set:
   - **Public / Tailscale Hostname** (so Discord displays copy-pasteable `IP:Port` join addresses)
   - **Allowed Discord Role IDs** (who can run `/server start` and `/server extend`)
   - **Notification Channel ID** (where 10-minute auto-shutdown warnings & interactive buttons are posted)

---

## Remote Access Recommendation

For the safest and easiest remote access without exposing your admin panel to the public internet:
- Install **Tailscale** on your Windows 11 server PC and your laptop/phone.
- Access the dashboard at `http://<server-tailscale-ip>:3000`.
- For friends connecting to game servers, either forward the game ports shown in ServerForge on your router, share a Tailscale node, or use a free game tunnel like Playit.gg.

---

## Adding a New Game in 5 Minutes

All games live in `catalog/games/*.yaml` (or can be imported live in **Game Templates** in the Web UI). No code changes are required — the deploy form, port allocator, guardrails, Discord autocomplete, and shutdown lifecycle read straight from the YAML schema.

See `catalog/games/minecraft.yaml` or click **Load Valheim Example** in the Web UI's **Game Templates** tab for a complete template example.

---

## Development & Testing

```bash
pnpm install
pnpm typecheck
pnpm test
pnpm dev:mock
```
