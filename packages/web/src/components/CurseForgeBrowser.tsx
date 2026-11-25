import React, { useEffect, useState } from 'react';
import { Check, Download, ExternalLink, Package, Search } from 'lucide-react';
import type { CurseForgeModpackFile, CurseForgeModpackSummary } from '@serverforge/shared';
import { api } from '../api';

export interface SelectedCurseForgePack {
  packName: string;
  slug: string;
  fileId: string;
  pageUrl: string;
  javaTag: 'java21' | 'java17' | 'java8' | 'latest';
  serverPackZipUrl?: string;
  hasNativeServerPack?: boolean;
}

interface CurseForgeBrowserProps {
  onSelectPack: (pack: SelectedCurseForgePack) => void;
  onGoToSettings: () => void;
}

function formatDownloads(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${Math.round(n / 1_000)}K`;
  return String(n);
}

export function CurseForgeBrowser({ onSelectPack, onGoToSettings }: CurseForgeBrowserProps) {
  const [configured, setConfigured] = useState<boolean | null>(null);
  const [query, setQuery] = useState('');
  const [results, setResults] = useState<CurseForgeModpackSummary[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const [selectedMod, setSelectedMod] = useState<CurseForgeModpackSummary | null>(null);
  const [files, setFiles] = useState<CurseForgeModpackFile[]>([]);
  const [selectedFileId, setSelectedFileId] = useState<string>('');
  const [loadingFiles, setLoadingFiles] = useState(false);
  const [nativePackStatus, setNativePackStatus] = useState<'checking' | 'ready' | 'missing' | null>(null);
  const [urlInput, setUrlInput] = useState('');
  const [urlNotice, setUrlNotice] = useState<string | null>(null);

  const handleApplyPastedUrl = () => {
    setUrlNotice(null);
    const trimmed = urlInput.trim();
    const match = trimmed.match(
      /curseforge\.com\/minecraft\/modpacks\/([a-z0-9-]+)(?:\/(?:files|download)\/(\d+))?/i
    );
    if (!match) {
      setUrlNotice('Paste a CurseForge modpack URL like https://www.curseforge.com/minecraft/modpacks/all-the-mods-10');
      return;
    }
    const slug = match[1].toLowerCase();
    const fileId = match[2] ?? '';
    const prettyName = slug
      .split('-')
      .map((w) => (w ? w[0].toUpperCase() + w.slice(1) : ''))
      .join(' ');
    onSelectPack({
      packName: prettyName,
      slug,
      fileId,
      pageUrl: trimmed,
      javaTag: 'java21',
    });
    setUrlNotice(`Loaded "${prettyName}" (${slug}${fileId ? ` #${fileId}` : ''}) into the deploy form below.`);
  };

  const runSearch = async (searchText: string) => {
    setError(null);
    setLoading(true);
    try {
      const data = await api.searchCurseForge(searchText);
      setResults(data);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Search failed');
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    void (async () => {
      try {
        const st = await api.getCurseForgeStatus();
        setConfigured(st.configured);
        if (st.configured) {
          await runSearch('');
        }
      } catch {
        setConfigured(false);
      }
    })();
  }, []);

  const resolvePackUrlForFile = async (
    mod: CurseForgeModpackSummary,
    file: CurseForgeModpackFile | undefined
  ): Promise<{ url?: string; hasPack: boolean }> => {
    const packFileId = file?.isServerPack ? file.id : file?.serverPackFileId;
    if (!packFileId) {
      return { hasPack: false };
    }
    try {
      const res = await api.getCurseForgeServerPackUrl(mod.id, packFileId);
      if (res.url) return { url: res.url, hasPack: true };
    } catch {
      // Fall back to server-side resolution on boot
    }
    return { url: file?.downloadUrl ?? undefined, hasPack: true };
  };

  const pickModpack = async (mod: CurseForgeModpackSummary) => {
    setSelectedMod(mod);
    setSelectedFileId('');
    setFiles([]);
    setNativePackStatus('checking');

    // Immediately populate with latest release defaults
    onSelectPack({
      packName: mod.name,
      slug: mod.slug,
      fileId: '',
      pageUrl: mod.websiteUrl || '',
      javaTag: mod.recommendedJavaTag,
      serverPackZipUrl: '',
    });

    setLoadingFiles(true);
    try {
      const modFiles = await api.getCurseForgeFiles(mod.id);
      setFiles(modFiles);
      const latestWithPack = modFiles.find((f) => Boolean(f.serverPackFileId) || f.isServerPack);
      const resolved = await resolvePackUrlForFile(mod, latestWithPack);
      setNativePackStatus(resolved.hasPack ? 'ready' : 'missing');
      onSelectPack({
        packName: mod.name,
        slug: mod.slug,
        fileId: '',
        pageUrl: mod.websiteUrl || '',
        javaTag: latestWithPack?.recommendedJavaTag ?? mod.recommendedJavaTag,
        serverPackZipUrl: resolved.url ?? '',
        hasNativeServerPack: resolved.hasPack,
      });
    } catch {
      setNativePackStatus(null);
    } finally {
      setLoadingFiles(false);
    }
  };

  const handleVersionChange = async (fileIdStr: string) => {
    setSelectedFileId(fileIdStr);
    if (!selectedMod) return;

    const file = fileIdStr
      ? files.find((f) => String(f.id) === fileIdStr)
      : files.find((f) => Boolean(f.serverPackFileId) || f.isServerPack);

    setNativePackStatus('checking');
    const resolved = await resolvePackUrlForFile(selectedMod, file);
    setNativePackStatus(resolved.hasPack ? 'ready' : 'missing');

    onSelectPack({
      packName: selectedMod.name,
      slug: selectedMod.slug,
      fileId: fileIdStr,
      pageUrl: selectedMod.websiteUrl || '',
      javaTag: file?.recommendedJavaTag ?? selectedMod.recommendedJavaTag,
      serverPackZipUrl: resolved.url ?? '',
      hasNativeServerPack: resolved.hasPack,
    });
  };

  if (configured === false) {
    return (
      <div className="alert alert-info" style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 12, flexWrap: 'wrap' }}>
        <div>
          <strong>Live CurseForge Modpack Browser</strong> — Add your free CurseForge API key (from{' '}
          <a
            href="https://console.curseforge.com/"
            target="_blank"
            rel="noreferrer"
            style={{ color: 'var(--accent)', textDecoration: 'underline' }}
          >
            console.curseforge.com
          </a>
          ) in Settings and click <strong>Verify &amp; Save Key</strong> to search modpacks here and enable Docker auto-downloads.
        </div>
        <button type="button" className="btn btn-sm" onClick={onGoToSettings}>
          Open Settings
        </button>
      </div>
    );
  }

  return (
    <div
      style={{
        marginBottom: 20,
        padding: 16,
        borderRadius: 'var(--radius-md)',
        background: 'var(--bg-elevated)',
        border: '1px solid var(--border-subtle)',
      }}
    >
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 12, marginBottom: 12, flexWrap: 'wrap' }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, fontWeight: 600 }}>
          <Package size={16} color="var(--accent)" />
          Browse CurseForge Modpacks
        </div>
        <form
          onSubmit={(e) => {
            e.preventDefault();
            void runSearch(query);
          }}
          style={{ display: 'flex', gap: 8, flex: '1 1 280px', maxWidth: 440 }}
        >
          <input
            id="curseforge-search-input"
            className="input"
            placeholder="Search modpacks (e.g., All the Mods 10, Better MC, RLCraft, Create)..."
            value={query}
            onChange={(e) => setQuery(e.target.value)}
          />
          <button type="submit" className="btn btn-primary btn-sm" disabled={loading}>
            <Search size={14} /> {loading ? 'Searching...' : 'Search'}
          </button>
        </form>
      </div>

      {error && (
        <div className="alert alert-error" style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 10, flexWrap: 'wrap' }}>
          <span>{error}</span>
          <div className="btn-row">
            <button type="button" className="btn btn-sm" onClick={() => void runSearch(query)}>
              Retry
            </button>
            <button type="button" className="btn btn-sm" onClick={onGoToSettings}>
              Open Settings
            </button>
          </div>
        </div>
      )}

      <div style={{ display: 'flex', gap: 8, marginBottom: 12, alignItems: 'center', flexWrap: 'wrap' }}>
        <input
          className="input"
          style={{ flex: '1 1 260px', fontSize: 12.5 }}
          placeholder="Or paste any CurseForge modpack URL directly (e.g., https://www.curseforge.com/minecraft/modpacks/all-the-mods-10)"
          value={urlInput}
          onChange={(e) => setUrlInput(e.target.value)}
        />
        <button type="button" className="btn btn-sm" onClick={handleApplyPastedUrl} disabled={!urlInput.trim()}>
          Use URL
        </button>
      </div>
      {urlNotice && (
        <div style={{ fontSize: 12, color: 'var(--text-secondary)', marginBottom: 10 }}>{urlNotice}</div>
      )}

      <div
        style={{
          display: 'grid',
          gridTemplateColumns: 'repeat(auto-fill, minmax(240px, 1fr))',
          gap: 10,
          maxHeight: 290,
          overflowY: 'auto',
          paddingRight: 4,
        }}
      >
        {results.map((mod) => {
          const isSelected = selectedMod?.id === mod.id;
          return (
            <button
              key={mod.id}
              type="button"
              onClick={() => void pickModpack(mod)}
              style={{
                textAlign: 'left',
                padding: 11,
                borderRadius: 'var(--radius-sm)',
                border: `1px solid ${isSelected ? 'var(--accent)' : 'var(--border-subtle)'}`,
                background: isSelected ? 'var(--bg-hover)' : 'var(--bg-surface)',
                color: 'inherit',
                font: 'inherit',
                cursor: 'pointer',
                display: 'flex',
                gap: 10,
                alignItems: 'flex-start',
              }}
            >
              {mod.logoUrl ? (
                <img
                  src={mod.logoUrl}
                  alt=""
                  width={42}
                  height={42}
                  style={{ borderRadius: 6, objectFit: 'cover', flexShrink: 0 }}
                />
              ) : (
                <div
                  style={{
                    width: 42,
                    height: 42,
                    borderRadius: 6,
                    background: 'var(--bg-elevated)',
                    display: 'grid',
                    placeItems: 'center',
                    flexShrink: 0,
                  }}
                >
                  <Package size={18} color="var(--text-muted)" />
                </div>
              )}
              <div style={{ minWidth: 0, flex: 1 }}>
                <div style={{ fontWeight: 600, fontSize: 13, display: 'flex', alignItems: 'center', gap: 6 }}>
                  <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{mod.name}</span>
                  {isSelected && <Check size={13} color="var(--accent)" />}
                </div>
                <div style={{ fontSize: 11.5, color: 'var(--text-muted)', marginTop: 2 }} className="tabular">
                  <Download size={10} style={{ display: 'inline', marginRight: 3 }} />
                  {formatDownloads(mod.downloadCount)} • {mod.latestGameVersions.slice(0, 2).join(', ') || 'MC'} •{' '}
                  <span className="mono">{mod.recommendedJavaTag}</span>
                </div>
                <div
                  style={{
                    fontSize: 11.5,
                    color: 'var(--text-secondary)',
                    marginTop: 4,
                    display: '-webkit-box',
                    WebkitLineClamp: 2,
                    WebkitBoxOrient: 'vertical',
                    overflow: 'hidden',
                  }}
                >
                  {mod.summary}
                </div>
              </div>
            </button>
          );
        })}
      </div>

      {selectedMod && (
        <div
          style={{
            marginTop: 12,
            paddingTop: 12,
            borderTop: '1px solid var(--border-subtle)',
            display: 'flex',
            alignItems: 'center',
            gap: 12,
            flexWrap: 'wrap',
          }}
        >
          <div style={{ fontSize: 12.5 }}>
            Selected: <strong>{selectedMod.name}</strong> (<code className="mono">{selectedMod.slug}</code>)
            {nativePackStatus === 'ready' && (
              <span className="badge badge-running" style={{ marginLeft: 8, fontSize: 10.5 }}>
                Native Server Pack Ready
              </span>
            )}
            {nativePackStatus === 'missing' && (
              <span className="badge badge-stopped" style={{ marginLeft: 8, fontSize: 10.5 }}>
                No Server Pack ZIP (Docker or Manual ZIP)
              </span>
            )}
          </div>
          <div style={{ flex: '1 1 240px', maxWidth: 360 }}>
            <select
              className="select"
              value={selectedFileId}
              disabled={loadingFiles}
              onChange={(e) => void handleVersionChange(e.target.value)}
            >
              <option value="">Latest Release (Automatic)</option>
              {files.map((f) => (
                <option key={f.id} value={String(f.id)}>
                  {f.displayName} ({f.gameVersions.slice(0, 2).join(', ')})
                  {f.serverPackFileId ? ' [Server Pack]' : ''}
                </option>
              ))}
            </select>
          </div>
          {selectedMod.websiteUrl && (
            <a
              href={selectedMod.websiteUrl}
              target="_blank"
              rel="noreferrer"
              className="btn btn-ghost btn-sm"
              style={{ textDecoration: 'none' }}
            >
              <ExternalLink size={13} /> CurseForge Page
            </a>
          )}
        </div>
      )}
    </div>
  );
}
