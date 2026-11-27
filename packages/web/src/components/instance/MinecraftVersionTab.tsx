import React, { useEffect, useState } from 'react';
import { AlertTriangle, Layers, RefreshCw, ShieldCheck } from 'lucide-react';
import type {
  MinecraftLoaderKind,
  MinecraftLoaderVersionsResponse,
  ServerInstance,
} from '@serverforge/shared';
import { api } from '../../api';
import type { ConfirmDialogOptions } from '../ConfirmModal';
import type { PushToastFn } from '../ToastStack';

interface MinecraftVersionTabProps {
  instance: ServerInstance;
  onSwitched: () => Promise<void> | void;
  onConfirm?: (opts: ConfirmDialogOptions) => Promise<boolean>;
  onToast?: PushToastFn;
}

const LOADER_OPTIONS: Array<{ id: MinecraftLoaderKind; label: string; hint: string }> = [
  { id: 'PAPER', label: 'Paper', hint: 'High performance + Spigot/Bukkit plugins' },
  { id: 'VANILLA', label: 'Vanilla', hint: 'Official Mojang server JAR' },
  { id: 'FABRIC', label: 'Fabric', hint: 'Lightweight modern mod loader' },
  { id: 'FORGE', label: 'Forge', hint: 'Classic & modded community packs' },
  { id: 'NEOFORGE', label: 'NeoForge', hint: 'Modern Forge fork (1.20.4+)' },
];

function normalizeLoader(raw: unknown): MinecraftLoaderKind {
  const upper = String(raw ?? 'PAPER').trim().toUpperCase();
  if (upper === 'VANILLA' || upper === 'PAPER' || upper === 'FABRIC' || upper === 'FORGE' || upper === 'NEOFORGE') {
    return upper;
  }
  return 'PAPER';
}

export function MinecraftVersionTab({ instance, onSwitched, onConfirm, onToast }: MinecraftVersionTabProps) {
  const currentLoader = normalizeLoader(instance.config.SERVER_TYPE);
  const currentMc = String(instance.config.MC_VERSION ?? 'LATEST').trim() || 'LATEST';
  const currentLoaderBuild = String(instance.config.LOADER_VERSION ?? '').trim();
  const currentJavaTag = String(instance.config.JAVA_IMAGE_TAG ?? '').trim();

  const [loader, setLoader] = useState<MinecraftLoaderKind>(currentLoader);
  const [mcVersion, setMcVersion] = useState<string>(currentMc === 'LATEST' ? '' : currentMc);
  const [loaderVersion, setLoaderVersion] = useState<string>(currentLoaderBuild);
  const [createBackup, setCreateBackup] = useState<boolean>(true);

  const [versionInfo, setVersionInfo] = useState<MinecraftLoaderVersionsResponse | null>(null);
  const [loadingVersions, setLoadingVersions] = useState(false);
  const [switching, setSwitching] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [successMsg, setSuccessMsg] = useState<string | null>(null);

  const fetchVersions = async (targetLoader: MinecraftLoaderKind, targetMc?: string) => {
    setLoadingVersions(true);
    setError(null);
    try {
      const info = await api.getMinecraftLoaderVersions(
        targetLoader,
        targetMc && targetMc !== 'LATEST' ? targetMc : undefined
      );
      setVersionInfo(info);
      if (info.mcVersion && (!targetMc || targetMc === 'LATEST' || !info.mcVersions.includes(targetMc))) {
        setMcVersion(info.mcVersion);
      }
      setLoaderVersion((prev) =>
        prev && info.loaderVersions.includes(prev) ? prev : (info.loaderVersions[0] ?? '')
      );
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load available versions for this loader.');
    } finally {
      setLoadingVersions(false);
    }
  };

  useEffect(() => {
    void fetchVersions(loader, mcVersion || undefined);
  }, [loader]);

  const handleMcChange = (nextMc: string) => {
    setMcVersion(nextMc);
    setLoaderVersion('');
    void fetchVersions(loader, nextMc);
  };

  const handleSwitch = async (e: React.FormEvent) => {
    e.preventDefault();
    const targetMc = (mcVersion || versionInfo?.mcVersion || '').trim();
    if (!targetMc) {
      setError('Select a target Minecraft version first.');
      return;
    }

    const confirmText = `Switch "${instance.name}" from ${currentLoader} ${currentMc} to ${loader} ${targetMc}${loaderVersion ? ` (${loaderVersion})` : ''}?${
      instance.status === 'running' ? ' The server will be saved and stopped first.' : ''
    }${createBackup ? ' A pre-switch safety backup will be created automatically.' : ''}`;

    const confirmed = onConfirm
      ? await onConfirm({
          title: 'Switch Minecraft Loader / Version?',
          message: confirmText,
          confirmLabel: 'Switch Loader',
          tone: 'primary',
        })
      : window.confirm(confirmText);
    if (!confirmed) return;

    setSwitching(true);
    setError(null);
    setSuccessMsg(null);
    try {
      const res = await api.switchMinecraftLoader(instance.id, {
        loader,
        mcVersion: targetMc,
        loaderVersion: loaderVersion || undefined,
        createBackup,
      });
      setSuccessMsg(res.summary);
      onToast?.('success', res.summary);
      await onSwitched();
    } catch (err) {
      const msg = err instanceof Error ? err.message : 'Loader switch failed';
      setError(msg);
      onToast?.('error', msg);
    } finally {
      setSwitching(false);
    }
  };

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
      {error && <div className="alert alert-error">{error}</div>}
      {successMsg && <div className="alert alert-success">{successMsg}</div>}

      <section className="panel">
        <div className="panel-header" style={{ flexWrap: 'wrap', gap: 8 }}>
          <h2 style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
            <Layers size={16} /> Minecraft Loader &amp; Version Switcher
          </h2>
          <button
            type="button"
            className="btn btn-sm"
            disabled={loadingVersions}
            onClick={() => void fetchVersions(loader, mcVersion || undefined)}
          >
            <RefreshCw size={13} /> {loadingVersions ? 'Refreshing...' : 'Refresh Versions'}
          </button>
        </div>

        <div className="panel-body">
          <div
            style={{
              display: 'flex',
              flexWrap: 'wrap',
              gap: 10,
              marginBottom: 16,
              padding: '10px 12px',
              borderRadius: 'var(--radius-sm)',
              background: 'var(--bg-elevated)',
              border: '1px solid var(--border-subtle)',
              fontSize: 12.5,
            }}
          >
            <span>
              Current Loader: <strong className="mono">{currentLoader}</strong>
            </span>
            <span>•</span>
            <span>
              Minecraft: <strong className="mono">{currentMc}</strong>
            </span>
            {currentLoaderBuild && (
              <>
                <span>•</span>
                <span>
                  Build: <strong className="mono">{currentLoaderBuild}</strong>
                </span>
              </>
            )}
            {currentJavaTag && (
              <>
                <span>•</span>
                <span>
                  Java: <strong className="mono">{currentJavaTag}</strong>
                </span>
              </>
            )}
          </div>

          <form onSubmit={handleSwitch} style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
            <div className="form-grid">
              <div className="field">
                <label htmlFor="mc-switch-loader">Target Server Loader</label>
                <select
                  id="mc-switch-loader"
                  className="select"
                  value={loader}
                  onChange={(e) => setLoader(e.target.value as MinecraftLoaderKind)}
                >
                  {LOADER_OPTIONS.map((opt) => (
                    <option key={opt.id} value={opt.id}>
                      {opt.label} — {opt.hint}
                    </option>
                  ))}
                </select>
              </div>

              <div className="field">
                <label htmlFor="mc-switch-version">Minecraft Version</label>
                {versionInfo && versionInfo.mcVersions.length > 0 ? (
                  <select
                    id="mc-switch-version"
                    className="select"
                    value={mcVersion}
                    onChange={(e) => handleMcChange(e.target.value)}
                    disabled={loadingVersions}
                  >
                    {versionInfo.mcVersions.map((ver) => (
                      <option key={ver} value={ver}>
                        {ver}
                      </option>
                    ))}
                  </select>
                ) : (
                  <input
                    id="mc-switch-version"
                    className="input"
                    value={mcVersion}
                    onChange={(e) => setMcVersion(e.target.value)}
                    placeholder="e.g. 1.21.4"
                  />
                )}
                {versionInfo && (
                  <span className="field-hint">
                    Auto-selected runtime: <strong className="mono">Java {versionInfo.recommendedJavaMajor}</strong>{' '}
                    (auto-upgrades or downgrades JRE safely)
                  </span>
                )}
              </div>

              {loader !== 'VANILLA' && (
                <div className="field">
                  <label htmlFor="mc-switch-build">Loader Build / Version</label>
                  {versionInfo && versionInfo.loaderVersions.length > 0 ? (
                    <select
                      id="mc-switch-build"
                      className="select"
                      value={loaderVersion}
                      onChange={(e) => setLoaderVersion(e.target.value)}
                      disabled={loadingVersions}
                    >
                      {versionInfo.loaderVersions.map((b, idx) => (
                        <option key={b} value={b}>
                          {b}
                          {idx === 0 ? ' (Latest)' : ''}
                        </option>
                      ))}
                    </select>
                  ) : (
                    <input
                      id="mc-switch-build"
                      className="input"
                      value={loaderVersion}
                      onChange={(e) => setLoaderVersion(e.target.value)}
                      placeholder="Latest recommended"
                    />
                  )}
                </div>
              )}
            </div>

            <label className="checkbox-row">
              <input
                type="checkbox"
                checked={createBackup}
                onChange={(e) => setCreateBackup(e.target.checked)}
              />
              <span>Create automatic pre-switch safety backup before changing loader files (Recommended)</span>
            </label>

            <div className="alert alert-info" style={{ display: 'flex', alignItems: 'flex-start', gap: 10 }}>
              <ShieldCheck size={16} style={{ flexShrink: 0, marginTop: 2 }} />
              <div style={{ fontSize: 12.5 }}>
                <strong>Safe Cleanup Guarantee:</strong> Switching removes only stale loader binaries &amp; scripts (
                <code>server.jar</code>, <code>run.bat</code>, <code>.fabric/</code>, Forge/NeoForge libraries). Your
                worlds, <code>server.properties</code>, whitelist, ops, <code>mods/</code>, <code>plugins/</code>, and{' '}
                <code>config/</code> stay untouched.
              </div>
            </div>

            {loader !== currentLoader && (
              <div className="alert alert-warn" style={{ display: 'flex', alignItems: 'flex-start', gap: 10 }}>
                <AlertTriangle size={16} style={{ flexShrink: 0, marginTop: 2 }} />
                <div style={{ fontSize: 12.5 }}>
                  Switching loaders ({currentLoader} → {loader}) may require updating or toggling incompatible mods/plugins
                  in the <strong>Mods / Plugins / Datapacks</strong> tab before booting.
                </div>
              </div>
            )}

            <div className="btn-row">
              <button type="submit" className="btn btn-primary" disabled={switching || loadingVersions}>
                <Layers size={14} />
                {switching ? 'Switching Loader...' : `Switch to ${loader} ${mcVersion || ''}`}
              </button>
            </div>
          </form>
        </div>
      </section>
    </div>
  );
}
