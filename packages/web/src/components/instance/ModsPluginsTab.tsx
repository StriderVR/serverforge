import React, { useEffect, useState } from 'react';
import {
  ArrowUpCircle,
  Download,
  ExternalLink,
  Package,
  Power,
  RefreshCw,
  Search,
  Trash2,
} from 'lucide-react';
import type {
  AddonUpdateCandidate,
  InstalledAddonEntry,
  InstalledAddonsResponse,
  ModrinthProjectSummary,
} from '@serverforge/shared';
import { api } from '../../api';
import type { ConfirmDialogOptions } from '../ConfirmModal';
import type { PushToastFn } from '../ToastStack';

interface ModsPluginsTabProps {
  instanceId: string;
  onConfirm?: (opts: ConfirmDialogOptions) => Promise<boolean>;
  onToast?: PushToastFn;
}

function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(2)} MB`;
}

export function ModsPluginsTab({ instanceId, onConfirm, onToast }: ModsPluginsTabProps) {
  const [data, setData] = useState<InstalledAddonsResponse | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [busyKey, setBusyKey] = useState<string | null>(null);

  const [updates, setUpdates] = useState<AddonUpdateCandidate[]>([]);
  const [checkingUpdates, setCheckingUpdates] = useState(false);

  // Modrinth search panel
  const [searchQuery, setSearchQuery] = useState('');
  const [searchType, setSearchType] = useState<'mod' | 'plugin'>('mod');
  const [loaderFilter, setLoaderFilter] = useState('');
  const [mcVersionFilter, setMcVersionFilter] = useState('');
  const [searchResults, setSearchResults] = useState<ModrinthProjectSummary[]>([]);
  const [searching, setSearching] = useState(false);

  const loadAddons = async () => {
    setLoading(true);
    setError(null);
    try {
      const res = await api.listInstanceAddons(instanceId);
      setData(res);
      setSearchType(res.defaultFolder === 'plugins' ? 'plugin' : 'mod');
      if (res.detectedLoader && !loaderFilter) setLoaderFilter(res.detectedLoader);
      if (res.detectedMcVersion && !mcVersionFilter) setMcVersionFilter(res.detectedMcVersion);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load installed mods/plugins');
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    void loadAddons();
  }, [instanceId]);

  const handleSearch = async (e?: React.FormEvent) => {
    e?.preventDefault();
    setSearching(true);
    setError(null);
    try {
      const res = await api.searchModrinth({
        q: searchQuery,
        type: searchType,
        loader: loaderFilter || undefined,
        version: mcVersionFilter || undefined,
        limit: 12,
      });
      setSearchResults(res.results);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Modrinth search failed');
    } finally {
      setSearching(false);
    }
  };

  const handleInstall = async (projectId: string, title: string, versionId?: string) => {
    setBusyKey(`install:${projectId}`);
    setError(null);
    try {
      const targetFolder = searchType === 'plugin' ? 'plugins' : 'mods';
      const res = await api.installInstanceAddon(instanceId, {
        projectId,
        versionId,
        folder: targetFolder,
        loader: loaderFilter || undefined,
        gameVersion: mcVersionFilter || undefined,
      });
      const depNote =
        res.dependenciesInstalled.length > 0
          ? ` (+ dependencies: ${res.dependenciesInstalled.join(', ')})`
          : '';
      onToast?.('success', `Installed ${title} into ${targetFolder}/${depNote}`);
      await loadAddons();
      setUpdates((prev) => prev.filter((u) => u.projectId !== projectId));
    } catch (err) {
      setError(err instanceof Error ? err.message : `Failed to install ${title}`);
    } finally {
      setBusyKey(null);
    }
  };

  const handleToggle = async (addon: InstalledAddonEntry) => {
    setBusyKey(`toggle:${addon.folder}:${addon.filename}`);
    setError(null);
    try {
      const res = await api.toggleInstanceAddon(instanceId, addon.folder, addon.filename);
      onToast?.('success', `${res.enabled ? 'Enabled' : 'Disabled'} ${addon.folder}/${res.filename}`);
      await loadAddons();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to toggle addon');
    } finally {
      setBusyKey(null);
    }
  };

  const handleRemove = async (addon: InstalledAddonEntry) => {
    const ok = onConfirm
      ? await onConfirm({
          title: 'Remove Mod / Plugin?',
          message: `Delete "${addon.folder}/${addon.filename}" from this server?`,
          confirmLabel: 'Remove',
          tone: 'danger',
        })
      : window.confirm(`Remove ${addon.filename}?`);
    if (!ok) return;

    setBusyKey(`remove:${addon.folder}:${addon.filename}`);
    try {
      await api.deleteInstanceAddon(instanceId, addon.folder, addon.filename);
      onToast?.('success', `Removed ${addon.folder}/${addon.filename}`);
      await loadAddons();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to remove addon');
    } finally {
      setBusyKey(null);
    }
  };

  const handleCheckUpdates = async () => {
    setCheckingUpdates(true);
    setError(null);
    try {
      const res = await api.checkInstanceAddonUpdates(instanceId);
      setUpdates(res.updates);
      onToast?.(
        'info',
        res.updates.length > 0
          ? `${res.updates.length} Modrinth update(s) available.`
          : 'All tracked Modrinth mods/plugins are up to date.'
      );
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Update check failed');
    } finally {
      setCheckingUpdates(false);
    }
  };

  const updateMap = new Map(updates.map((u) => [u.projectId, u]));

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
      {error && <div className="alert alert-error">{error}</div>}

      {/* Modrinth Search & 1-Click Install */}
      <section className="panel">
        <div className="panel-header">
          <h2 style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
            <Download size={16} color="#1bd96a" /> Install Mods &amp; Plugins from Modrinth
          </h2>
          <span style={{ fontSize: 12, color: 'var(--text-muted)' }}>Zero API key • Auto-installs required dependencies</span>
        </div>
        <div className="panel-body">
          <form onSubmit={handleSearch} style={{ display: 'flex', gap: 8, flexWrap: 'wrap', marginBottom: 14 }}>
            <select
              className="select"
              style={{ width: 120 }}
              value={searchType}
              onChange={(e) => setSearchType(e.target.value as 'mod' | 'plugin')}
            >
              <option value="mod">Mods</option>
              <option value="plugin">Plugins</option>
            </select>
            <input
              className="input"
              style={{ flex: '2 1 220px' }}
              placeholder={searchType === 'plugin' ? 'Search Paper/Spigot plugins (e.g. EssentialsX, LuckPerms)...' : 'Search Fabric/NeoForge/Forge mods (e.g. Lithium, Sodium, Create)...'}
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
            />
            <input
              className="input"
              style={{ width: 120 }}
              placeholder="Loader (fabric)"
              value={loaderFilter}
              onChange={(e) => setLoaderFilter(e.target.value)}
            />
            <input
              className="input"
              style={{ width: 120 }}
              placeholder="MC (1.21.1)"
              value={mcVersionFilter}
              onChange={(e) => setMcVersionFilter(e.target.value)}
            />
            <button type="submit" className="btn btn-primary btn-sm" disabled={searching}>
              <Search size={14} /> {searching ? 'Searching...' : 'Search Modrinth'}
            </button>
          </form>

          {searchResults.length > 0 && (
            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(280px, 1fr))', gap: 10 }}>
              {searchResults.map((item) => {
                const installing = busyKey === `install:${item.projectId}`;
                return (
                  <div
                    key={item.projectId}
                    style={{
                      padding: 12,
                      borderRadius: 'var(--radius-sm)',
                      background: 'var(--bg-elevated)',
                      border: '1px solid var(--border-subtle)',
                      display: 'flex',
                      flexDirection: 'column',
                      gap: 8,
                    }}
                  >
                    <div style={{ display: 'flex', gap: 10, alignItems: 'flex-start' }}>
                      {item.iconUrl && (
                        <img
                          src={item.iconUrl}
                          alt=""
                          width={34}
                          height={34}
                          style={{ borderRadius: 6, objectFit: 'cover', flexShrink: 0 }}
                        />
                      )}
                      <div style={{ minWidth: 0, flex: 1 }}>
                        <div style={{ fontWeight: 600, fontSize: 13 }}>{item.title}</div>
                        <div style={{ fontSize: 11.5, color: 'var(--text-secondary)', marginTop: 2 }}>
                          {item.description.slice(0, 110)}
                        </div>
                      </div>
                    </div>
                    <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 8, marginTop: 'auto' }}>
                      <a
                        href={item.websiteUrl}
                        target="_blank"
                        rel="noreferrer"
                        style={{ fontSize: 11.5, color: 'var(--text-muted)', display: 'inline-flex', alignItems: 'center', gap: 4 }}
                      >
                        Modrinth <ExternalLink size={11} />
                      </a>
                      <button
                        type="button"
                        className="btn btn-primary btn-sm"
                        disabled={Boolean(busyKey)}
                        onClick={() => void handleInstall(item.projectId, item.title)}
                      >
                        <Download size={12} /> {installing ? 'Installing...' : 'Install'}
                      </button>
                    </div>
                  </div>
                );
              })}
            </div>
          )}
        </div>
      </section>

      {/* Installed Mods / Plugins List */}
      <section className="panel">
        <div className="panel-header" style={{ flexWrap: 'wrap', gap: 10 }}>
          <h2 style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
            <Package size={16} /> Installed Mods &amp; Plugins ({data?.addons.length ?? 0})
          </h2>
          <div className="btn-row">
            <button
              type="button"
              className="btn btn-sm"
              disabled={checkingUpdates}
              onClick={() => void handleCheckUpdates()}
            >
              <ArrowUpCircle size={13} /> {checkingUpdates ? 'Checking...' : 'Check Modrinth Updates'}
            </button>
            <button type="button" className="btn btn-sm" disabled={loading} onClick={() => void loadAddons()}>
              <RefreshCw size={13} /> Refresh
            </button>
          </div>
        </div>
        <div className="panel-body">
          {!data || data.addons.length === 0 ? (
            <div style={{ padding: 20, textAlign: 'center', color: 'var(--text-muted)', fontSize: 13 }}>
              No <code>.jar</code> files found in <code>mods/</code> or <code>plugins/</code> yet. Search Modrinth above
              or drag-and-drop <code>.jar</code> files in the <strong>Files</strong> tab.
            </div>
          ) : (
            <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
              {data.addons.map((addon) => {
                const availUpdate = addon.modrinthProjectId ? updateMap.get(addon.modrinthProjectId) : undefined;
                return (
                  <div
                    key={`${addon.folder}:${addon.filename}`}
                    style={{
                      display: 'flex',
                      alignItems: 'center',
                      justifyContent: 'space-between',
                      gap: 10,
                      padding: '9px 12px',
                      borderRadius: 'var(--radius-sm)',
                      background: 'var(--bg-elevated)',
                      border: '1px solid var(--border-subtle)',
                      opacity: addon.enabled ? 1 : 0.65,
                      flexWrap: 'wrap',
                    }}
                  >
                    <div style={{ minWidth: 200, flex: 1 }}>
                      <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
                        <strong style={{ fontSize: 13 }}>{addon.modrinthTitle ?? addon.baseName}</strong>
                        <span className="badge badge-stopped">{addon.folder}/</span>
                        <span className={`badge ${addon.enabled ? 'badge-running' : 'badge-stopped'}`}>
                          {addon.enabled ? 'ENABLED' : 'DISABLED'}
                        </span>
                        {addon.modrinthVersionNumber && (
                          <span className="mono" style={{ fontSize: 11.5, color: 'var(--text-muted)' }}>
                            v{addon.modrinthVersionNumber}
                          </span>
                        )}
                      </div>
                      <div className="mono" style={{ fontSize: 11.5, color: 'var(--text-muted)', marginTop: 2 }}>
                        {addon.filename} • {formatSize(addon.sizeBytes)}
                      </div>
                    </div>

                    <div className="btn-row">
                      {availUpdate && (
                        <button
                          type="button"
                          className="btn btn-primary btn-sm"
                          disabled={Boolean(busyKey)}
                          onClick={() =>
                            void handleInstall(
                              availUpdate.projectId,
                              availUpdate.title,
                              availUpdate.latestVersionId
                            )
                          }
                        >
                          <ArrowUpCircle size={13} /> Update to v{availUpdate.latestVersionNumber}
                        </button>
                      )}
                      <button
                        type="button"
                        className="btn btn-sm"
                        disabled={Boolean(busyKey)}
                        onClick={() => void handleToggle(addon)}
                      >
                        <Power size={12} /> {addon.enabled ? 'Disable' : 'Enable'}
                      </button>
                      <button
                        type="button"
                        className="btn btn-danger btn-sm"
                        disabled={Boolean(busyKey)}
                        onClick={() => void handleRemove(addon)}
                      >
                        <Trash2 size={12} /> Remove
                      </button>
                    </div>
                  </div>
                );
              })}
            </div>
          )}
        </div>
      </section>
    </div>
  );
}
