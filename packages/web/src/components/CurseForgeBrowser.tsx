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

  const pickModpack = async (mod: CurseForgeModpackSummary) => {
    setSelectedMod(mod);
    setSelectedFileId('');
    setFiles([]);

    // Immediately populate with latest release defaults
    onSelectPack({
      packName: mod.name,
      slug: mod.slug,
      fileId: '',
      pageUrl: mod.websiteUrl || '',
      javaTag: mod.recommendedJavaTag,
    });

    setLoadingFiles(true);
    try {
      const modFiles = await api.getCurseForgeFiles(mod.id);
      setFiles(modFiles);
    } catch {
      // Non-fatal; user can still deploy latest by slug
    } finally {
      setLoadingFiles(false);
    }
  };

  const handleVersionChange = async (fileIdStr: string) => {
    setSelectedFileId(fileIdStr);
    if (!selectedMod) return;

    if (!fileIdStr) {
      onSelectPack({
        packName: selectedMod.name,
        slug: selectedMod.slug,
        fileId: '',
        pageUrl: selectedMod.websiteUrl || '',
        javaTag: selectedMod.recommendedJavaTag,
      });
      return;
    }

    const file = files.find((f) => String(f.id) === fileIdStr);
    let serverPackZipUrl: string | undefined;
    if (file?.serverPackFileId) {
      try {
        const res = await api.getCurseForgeServerPackUrl(selectedMod.id, file.serverPackFileId);
        if (res.url) serverPackZipUrl = res.url;
      } catch {
        // Optional for Native mode
      }
    }

    onSelectPack({
      packName: selectedMod.name,
      slug: selectedMod.slug,
      fileId: fileIdStr,
      pageUrl: selectedMod.websiteUrl || '',
      javaTag: file?.recommendedJavaTag ?? selectedMod.recommendedJavaTag,
      serverPackZipUrl,
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
          ) in Settings to search modpacks here and enable Docker auto-downloads. Or paste a Server Pack ZIP path below.
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

      {error && <div className="alert alert-error">{error}</div>}

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
