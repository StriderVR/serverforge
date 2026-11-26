# ServerForge Versioning & Release Policy

Starting after `v1.1.8.x`, **ServerForge** follows **Product Semantic Versioning** using lowercase **`vMAJOR.MINOR.PATCH`** tags (for example, `v1.2.0`, `v1.2.1`, `v2.0.0`).

This format is directly compatible with ServerForge's built-in GitHub self-updater (`compareSemver` in `packages/server/src/services/updater-service.ts`), `package.json`, and the automated Windows `.exe` release workflow (`.github/workflows/build-windows-exe.yml`).

---

## Version Format: `vMAJOR.MINOR.PATCH`

| Segment | Meaning | When to Increment | Reset Rule | Examples |
| --- | --- | --- | --- | --- |
| **`MAJOR`** (`X.0.0`) | **Major Release** *(Breaking / Platform Leap)* | Flagship architectural overhauls, breaking config/database migrations, or major platform expansions. | Resets `MINOR` and `PATCH` to `0` (`v2.0.0`). | Multi-node remote host agents, v2 dashboard overhaul, breaking YAML template schema v2. |
| **`MINOR`** (`1.Y.0`) | **Features & QoL** | New user-facing features, new integrations, quality-of-life upgrades, or new built-in game templates (backwards-compatible). | Resets `PATCH` to `0` (`v1.2.0`). | In-browser File Manager, Modrinth integration, Live Discord Status Panel, Scheduled Tasks. |
| **`PATCH`** (`1.Y.Z`) | **Bug Fixes & Hotfixes** | Bug fixes, crash fixes, security fixes, and minor polish with no major new features. | Increments `PATCH` only (`v1.2.1`). | Fixing launch script edge cases, Windows firewall/path fixes, API error handling fixes. |

### Pre-Releases (Optional)

When testing risky changes (such as Windows self-updater or runtime changes) before promoting them to everyone:

- Use a pre-release suffix such as `v1.2.0-beta.1` or `v1.2.0-rc.1`.
- Mark the GitHub Release as a **Pre-release** so stable `ServerForge.exe` installations checking `/releases/latest` ignore it until the final `v1.2.0` release is published.

---

## Release Checklist

1. **Bump `package.json`** using the helper script (or preview first with `--dry-run`):
   ```bash
   pnpm bump:patch   # Bug fixes & hotfixes (e.g., 1.2.0 -> 1.2.1)
   pnpm bump:minor   # Features & QoL       (e.g., 1.2.1 -> 1.3.0)
   pnpm bump:major   # Major release        (e.g., 1.3.0 -> 2.0.0)
   ```
   *(Pass `-- --dry-run` to preview without editing `package.json`.)*

2. **Verify locally**:
   ```bash
   pnpm build && pnpm typecheck && pnpm test
   ```

3. **Commit, tag, and push**:
   ```bash
   git add package.json
   git commit -m "Release vX.Y.Z"
   git tag vX.Y.Z
   git push origin main --tags
   ```

4. **Automated Build & GitHub Release**:
   - Pushing a lowercase `v*` tag triggers `.github/workflows/build-windows-exe.yml`.
   - GitHub Actions runs tests, compiles & smoke-tests standalone `ServerForge.exe`, and publishes the GitHub Release with auto-categorized release notes configured in `.github/release.yml`.
