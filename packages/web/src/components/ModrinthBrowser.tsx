import React, { useEffect, useState } from 'react';
import { Download, ExternalLink, Search, Sparkles } from 'lucide-react';
import type { ModrinthProjectSummary, ModrinthVersionSummary } from '@serverforge/shared';
import { api } from '../api';

export interface SelectedModrinthPack {
  projectId: string;
  slug: string;
  packName: string;
  versionId: string;
  javaTag: string;
}

interface ModrinthBrowserProps {
  onSelectPack: (pack: SelectedModrinthPack) => void;
}

function formatDownloads(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}K`;
  return String(n);
}

export function ModrinthBrowser({ onSelectPack }: ModrinthBrowserProps) {
  const [query, setQuery] = useState('');
  const [results, setResults] = useState<ModrinthProjectSummary[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [selectedSlug, setSelectedSlug] = useState<string | null>(null);
  const [versions, setVersions] = useState<ModrinthVersionSummary[]>([]);
  const [loadingVersions, setLoadingVersions] = useState(false);
  const [selectedVersionId, setSelectedVersionId] = useState('');

  const runSearch = async (q: string) => {
    setLoading(true);
    setError(null);
    try {
      const res = await api.searchModrinth({ q, type: 'modpack', limit: 12 });
      setResults(res.results);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Modrinth search failed');
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    void runSearch('');
  }, []);

  const pickPack = async (pack: ModrinthProjectSummary) => {
    setSelectedSlug(pack.slug);
    setSelectedVersionId('');
    setVersions([]);
    onSelectPack({
      projectId: pack.slug,
      slug: pack.slug,
      packName: pack.title,
      versionId: '',
      javaTag: pack.recommendedJavaTag,
    });

    setLoadingVersions(true);
    try {
      const res = await api.getModrinthVersions(pack.projectId);
      setVersions(res.versions.slice(0, 15));
      if (res.versions[0]) {
        setSelectedVersionId(res.versions[0].id);
        onSelectPack({
          projectId: pack.slug,
          slug: pack.slug,
          packName: pack.title,
          versionId: res.versions[0].id,
          javaTag: res.versions[0].recommendedJavaTag,
        });
      }
    } catch {
      // Latest version will be auto-resolved on boot
    } finally {
      setLoadingVersions(false);
    }
  };

  const activePack = results.find((r) => r.slug === selectedSlug) ?? null;

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
      <div
        style={{
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'space-between',
          gap: 10,
          marginBottom: 12,
          flexWrap: 'wrap',
        }}
      >
        <div>
          <strong style={{ display: 'inline-flex', alignItems: 'center', gap: 6, fontSize: 14 }}>
            <Sparkles size={15} color="#1bd96a" /> Browse Modrinth Modpacks
          </strong>
          <div style={{ fontSize: 12, color: 'var(--text-secondary)' }}>
            No API key required — pick any Modrinth <code>.mrpack</code> modpack to auto-fill settings and Java version.
          </div>
        </div>
        <form
          style={{ display: 'flex', gap: 8, flex: '1 1 260px', maxWidth: 420 }}
          onSubmit={(e) => {
            e.preventDefault();
            void runSearch(query);
          }}
        >
          <input
            className="input"
            placeholder="Search Modrinth modpacks (e.g. Cobblemon, Better MC, Create)..."
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            style={{ flex: 1 }}
          />
          <button type="submit" className="btn btn-sm" disabled={loading}>
            <Search size={14} /> {loading ? 'Searching...' : 'Search'}
          </button>
        </form>
      </div>

      {error && <div className="alert alert-error">{error}</div>}

      <div
        style={{
          display: 'grid',
          gridTemplateColumns: 'repeat(auto-fill, minmax(230px, 1fr))',
          gap: 10,
          maxHeight: 280,
          overflowY: 'auto',
          paddingRight: 4,
        }}
      >
        {results.map((pack) => {
          const isSelected = pack.slug === selectedSlug;
          return (
            <button
              key={pack.projectId}
              type="button"
              onClick={() => void pickPack(pack)}
              style={{
                textAlign: 'left',
                padding: 10,
                borderRadius: 'var(--radius-sm)',
                border: isSelected ? '1px solid #1bd96a' : '1px solid var(--border-subtle)',
                background: isSelected ? 'rgba(27, 217, 106, 0.12)' : 'var(--bg-surface)',
                color: 'inherit',
                cursor: 'pointer',
                display: 'flex',
                gap: 10,
                alignItems: 'flex-start',
              }}
            >
              {pack.iconUrl && (
                <img
                  src={pack.iconUrl}
                  alt=""
                  width={36}
                  height={36}
                  style={{ borderRadius: 6, flexShrink: 0, objectFit: 'cover' }}
                />
              )}
              <div style={{ minWidth: 0, flex: 1 }}>
                <div style={{ fontWeight: 600, fontSize: 13, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                  {pack.title}
                </div>
                <div
                  style={{
                    fontSize: 11.5,
                    color: 'var(--text-secondary)',
                    display: '-webkit-box',
                    WebkitLineClamp: 2,
                    WebkitBoxOrient: 'vertical',
                    overflow: 'hidden',
                    marginTop: 2,
                  }}
                >
                  {pack.description}
                </div>
                <div style={{ display: 'flex', gap: 8, marginTop: 6, fontSize: 11, color: 'var(--text-muted)' }}>
                  <span style={{ display: 'inline-flex', alignItems: 'center', gap: 3 }}>
                    <Download size={10} /> {formatDownloads(pack.downloads)}
                  </span>
                  {pack.gameVersions[0] && <span>MC {pack.gameVersions[0]}</span>}
                </div>
              </div>
            </button>
          );
        })}
      </div>

      {activePack && (
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
          <span style={{ fontSize: 12.5 }}>
            Selected: <strong>{activePack.title}</strong>
          </span>
          <a
            href={activePack.websiteUrl}
            target="_blank"
            rel="noreferrer"
            style={{ fontSize: 12, color: 'var(--accent)', display: 'inline-flex', alignItems: 'center', gap: 4 }}
          >
            Modrinth Page <ExternalLink size={11} />
          </a>
          <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginLeft: 'auto' }}>
            <label htmlFor="mr-version-select" style={{ fontSize: 12, color: 'var(--text-secondary)' }}>
              Version:
            </label>
            <select
              id="mr-version-select"
              className="select"
              style={{ maxWidth: 260, fontSize: 12 }}
              disabled={loadingVersions}
              value={selectedVersionId}
              onChange={(e) => {
                const verId = e.target.value;
                setSelectedVersionId(verId);
                const ver = versions.find((v) => v.id === verId);
                onSelectPack({
                  projectId: activePack.slug,
                  slug: activePack.slug,
                  packName: activePack.title,
                  versionId: verId,
                  javaTag: ver?.recommendedJavaTag ?? activePack.recommendedJavaTag,
                });
              }}
            >
              <option value="">Latest Version</option>
              {versions.map((v) => (
                <option key={v.id} value={v.id}>
                  {v.name} ({v.gameVersions[0] ?? 'MC'})
                </option>
              ))}
            </select>
          </div>
        </div>
      )}
    </div>
  );
}
