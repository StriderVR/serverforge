import React, { useState } from 'react';
import {
  AlertTriangle,
  ArrowUp,
  CheckCircle2,
  ChevronRight,
  FileCode2,
  Folder,
  FolderOpen,
  FolderSearch,
  HardDrive,
  Import,
  Info,
  Radar,
  Search,
} from 'lucide-react';
import type {
  DiscoveredProcess,
  FolderBrowseResult,
  GameTemplate,
  ImportInspectionResult,
} from '@serverforge/shared';
import { api } from '../api';

interface ImportPageProps {
  catalog: GameTemplate[];
  onImported: (instanceId: string) => void;
}

function buildPathBreadcrumbs(currentPath: string): Array<{ label: string; path: string }> {
  if (!currentPath) return [];
  const isWin = /^[A-Za-z]:[\\/]/.test(currentPath);
  if (isWin) {
    const parts = currentPath.split('\\').filter(Boolean);
    const crumbs: Array<{ label: string; path: string }> = [];
    let acc = '';
    for (let i = 0; i < parts.length; i++) {
      if (i === 0) {
        acc = `${parts[0]}\\`;
        crumbs.push({ label: parts[0], path: acc });
      } else {
        acc = acc.endsWith('\\') ? `${acc}${parts[i]}` : `${acc}\\${parts[i]}`;
        crumbs.push({ label: parts[i], path: acc });
      }
    }
    return crumbs;
  }

  const parts = currentPath.split('/').filter(Boolean);
  const crumbs: Array<{ label: string; path: string }> = [{ label: '/', path: '/' }];
  let acc = '';
  for (const part of parts) {
    acc = `${acc}/${part}`;
    crumbs.push({ label: part, path: acc });
  }
  return crumbs;
}

export function ImportPage({ catalog, onImported }: ImportPageProps) {
  const [folderPath, setFolderPath] = useState('');
  const [discovering, setDiscovering] = useState(false);
  const [discovered, setDiscovered] = useState<DiscoveredProcess[] | null>(null);

  const [pickingFolder, setPickingFolder] = useState(false);
  const [pickerNotice, setPickerNotice] = useState<string | null>(null);

  const [browsing, setBrowsing] = useState(false);
  const [browseData, setBrowseData] = useState<FolderBrowseResult | null>(null);

  const [inspecting, setInspecting] = useState(false);
  const [inspection, setInspection] = useState<ImportInspectionResult | null>(null);
  const [error, setError] = useState<string | null>(null);

  // Editable import review fields
  const [name, setName] = useState('');
  const [gameId, setGameId] = useState('minecraft-curseforge');
  const [mode, setMode] = useState<'link' | 'copy'>('link');
  const [launchScript, setLaunchScript] = useState('');
  const [memoryGb, setMemoryGb] = useState(8);
  const [gamePort, setGamePort] = useState(25565);
  const [rconPort, setRconPort] = useState(25575);
  const [enableRcon, setEnableRcon] = useState(true);
  const [autoStart, setAutoStart] = useState(false);
  const [discordEnabled, setDiscordEnabled] = useState(true);
  const [importing, setImporting] = useState(false);

  const handleDiscover = async () => {
    setError(null);
    setDiscovering(true);
    try {
      const procs = await api.discoverRunningServers();
      setDiscovered(procs);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Discovery failed');
    } finally {
      setDiscovering(false);
    }
  };

  const openBrowser = async (dir?: string) => {
    setError(null);
    setBrowsing(true);
    try {
      const data = await api.browseFolders(dir);
      setBrowseData(data);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Unable to browse folder');
    } finally {
      setBrowsing(false);
    }
  };

  const handleNativeFolderPick = async () => {
    setError(null);
    setPickerNotice(null);
    setPickingFolder(true);
    try {
      const result = await api.pickImportFolder(folderPath.trim() || undefined);
      if (!result.supported) {
        setPickerNotice(
          result.reason || 'Native Windows Explorer picker is unavailable here — opened the Web Folder Browser below.'
        );
        await openBrowser(folderPath.trim() || '');
        return;
      }
      if (result.cancelled || !result.folderPath) {
        return;
      }
      setBrowseData(null);
      await runInspect(result.folderPath);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to open Windows folder picker');
    } finally {
      setPickingFolder(false);
    }
  };

  const runInspect = async (targetPath: string) => {
    const clean = targetPath.trim();
    if (!clean) return;
    setError(null);
    setPickerNotice(null);
    setInspecting(true);
    setFolderPath(clean);
    try {
      const res = await api.inspectImportFolder(clean);
      setFolderPath(res.folderPath);
      setInspection(res);
      setName(res.suggestedName);
      setGameId(res.detectedGameId);
      setMode('link');
      const rec = res.launchCandidates.find((c) => c.recommended) ?? res.launchCandidates[0];
      setLaunchScript(rec?.script ?? '');
      setMemoryGb(Math.max(2, Math.round(res.detectedMemoryMb / 1024)));
      setGamePort(res.detectedPorts.game ?? 25565);
      setRconPort(res.detectedPorts.rcon ?? 25575);
      setEnableRcon(true);
      setBrowseData(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Inspection failed');
      setInspection(null);
    } finally {
      setInspecting(false);
    }
  };

  const handleImport = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!inspection) return;
    setError(null);
    setImporting(true);
    try {
      const ports: Record<string, number> = {
        ...inspection.detectedPorts,
        game: gamePort,
      };
      if (gameId === 'minecraft' || gameId === 'minecraft-curseforge' || gameId === 'factorio') {
        ports.rcon = rconPort;
      }

      const created = await api.executeImport({
        folderPath: inspection.folderPath,
        mode,
        name: name.trim(),
        gameId,
        runtime: 'native',
        launchScript: launchScript.trim() || null,
        ports,
        memoryLimitMb: Math.round(memoryGb * 1024),
        config: inspection.detectedConfig,
        enableRcon,
        autoStart,
        discordEnabled,
      });
      onImported(created.id);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Import failed');
      setImporting(false);
    }
  };

  const breadcrumbs = browseData ? buildPathBreadcrumbs(browseData.currentPath) : [];

  return (
    <div>
      <header className="page-header">
        <div>
          <h1>Smart Server Import</h1>
          <p className="page-subtitle">
            Bring an existing modded Minecraft or dedicated game server on this PC under ServerForge control — zero world rebuilds.
          </p>
        </div>
        <button
          id="scan-running-servers-btn"
          type="button"
          className="btn"
          disabled={discovering}
          onClick={handleDiscover}
        >
          <Radar size={15} /> {discovering ? 'Scanning PC...' : 'Scan Running Servers'}
        </button>
      </header>

      {error && <div className="alert alert-error">{error}</div>}
      {pickerNotice && (
        <div className="alert alert-info" style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
          <Info size={15} style={{ flexShrink: 0 }} />
          <span>{pickerNotice}</span>
        </div>
      )}

      {/* Running Process Auto-Discovery Results */}
      {discovered !== null && (
        <section className="panel" style={{ marginBottom: 18 }}>
          <div className="panel-header">
            <h2>Running Game Processes Detected ({discovered.length})</h2>
          </div>
          <div className="panel-body">
            {discovered.length === 0 ? (
              <p style={{ margin: 0, color: 'var(--text-secondary)', fontSize: 13 }}>
                No running Java or dedicated game server processes were detected right now. Choose or paste your server folder below.
              </p>
            ) : (
              <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
                <div className="alert alert-info" style={{ marginBottom: 4 }}>
                  You can inspect and import a running server right now — just remember to stop its existing manual window before clicking <strong>Start</strong> inside ServerForge.
                </div>
                {discovered.map((p) => (
                  <div
                    key={p.pid}
                    style={{
                      display: 'flex',
                      justifyContent: 'space-between',
                      alignItems: 'center',
                      gap: 12,
                      padding: 12,
                      borderRadius: 'var(--radius-sm)',
                      background: 'var(--bg-elevated)',
                      border: '1px solid var(--border-subtle)',
                      flexWrap: 'wrap',
                    }}
                  >
                    <div style={{ minWidth: 0, flex: 1 }}>
                      <div style={{ fontWeight: 600 }}>
                        {p.processName} <span className="mono" style={{ color: 'var(--text-muted)' }}>(PID {p.pid})</span>
                      </div>
                      <div className="mono" style={{ fontSize: 12, color: p.workingDir ? 'var(--status-online)' : 'var(--text-secondary)', marginTop: 2 }}>
                        {p.workingDir ||
                          'Folder path could not be resolved automatically (if this server is running as Administrator, run ServerForge as Admin or choose the folder below)'}
                      </div>
                      <div className="mono" style={{ fontSize: 11, color: 'var(--text-muted)', marginTop: 4, wordBreak: 'break-all' }}>
                        {p.commandLine}
                      </div>
                    </div>
                    {p.workingDir ? (
                      <button
                        type="button"
                        className="btn btn-primary btn-sm"
                        onClick={() => void runInspect(p.workingDir!)}
                      >
                        Inspect Folder
                      </button>
                    ) : (
                      <button
                        type="button"
                        className="btn btn-sm"
                        disabled={pickingFolder}
                        onClick={() => void handleNativeFolderPick()}
                      >
                        <FolderOpen size={14} /> Choose Folder...
                      </button>
                    )}
                  </div>
                ))}
              </div>
            )}
          </div>
        </section>
      )}

      {/* Step 1: Select or Browse Server Folder */}
      <section className="panel" style={{ marginBottom: 18 }}>
        <div className="panel-header">
          <h2>1. Locate Existing Server Folder</h2>
          <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
            <button
              id="pick-native-folder-btn"
              type="button"
              className="btn btn-primary btn-sm"
              disabled={pickingFolder || inspecting}
              onClick={() => void handleNativeFolderPick()}
            >
              <FolderOpen size={14} /> {pickingFolder ? 'Waiting for File Explorer...' : 'Choose Folder...'}
            </button>
            <button
              type="button"
              className="btn btn-sm"
              disabled={browsing}
              onClick={() => (browseData ? setBrowseData(null) : void openBrowser(folderPath || ''))}
              title="Browse server folders inside the web UI (helpful when connecting remotely)"
            >
              <FolderSearch size={14} /> {browseData ? 'Close Web Browser' : 'Web Browser'}
            </button>
          </div>
        </div>
        <div className="panel-body">
          <form
            onSubmit={(e) => {
              e.preventDefault();
              void runInspect(folderPath);
            }}
            style={{ display: 'flex', gap: 10, flexWrap: 'wrap' }}
          >
            <input
              id="import-folder-input"
              className="input mono"
              style={{ flex: '1 1 340px' }}
              placeholder="Click Choose Folder... or paste a path like C:\Minecraft\ATM 10"
              value={folderPath}
              onChange={(e) => setFolderPath(e.target.value)}
            />
            <button
              id="inspect-folder-btn"
              type="submit"
              className="btn btn-primary"
              disabled={inspecting || !folderPath.trim()}
            >
              <Search size={14} /> {inspecting ? 'Analyzing...' : 'Smart Inspect'}
            </button>
          </form>

          {browseData && (
            <div
              style={{
                marginTop: 14,
                borderRadius: 'var(--radius-sm)',
                background: 'var(--bg-terminal)',
                border: '1px solid var(--border-subtle)',
                overflow: 'hidden',
              }}
            >
              {/* Explorer-style toolbar & clickable breadcrumbs */}
              <div
                style={{
                  display: 'flex',
                  alignItems: 'center',
                  justifyContent: 'space-between',
                  gap: 10,
                  padding: '10px 12px',
                  borderBottom: '1px solid var(--border-subtle)',
                  background: 'var(--bg-elevated)',
                  flexWrap: 'wrap',
                }}
              >
                <div style={{ display: 'flex', alignItems: 'center', gap: 6, flexWrap: 'wrap', minWidth: 0, flex: 1 }}>
                  {browseData.parentPath !== null && (
                    <button
                      type="button"
                      className="btn btn-sm"
                      onClick={() => void openBrowser(browseData.parentPath!)}
                      title="Go up one folder"
                    >
                      <ArrowUp size={13} /> Up
                    </button>
                  )}
                  <div style={{ display: 'flex', alignItems: 'center', gap: 2, flexWrap: 'wrap', fontSize: 12.5 }}>
                    <button
                      type="button"
                      className="btn btn-ghost btn-sm"
                      style={{ padding: '2px 6px', fontSize: 12 }}
                      onClick={() => void openBrowser('')}
                    >
                      This PC
                    </button>
                    {breadcrumbs.map((crumb) => (
                      <React.Fragment key={crumb.path}>
                        <ChevronRight size={12} style={{ color: 'var(--text-muted)' }} />
                        <button
                          type="button"
                          className="btn btn-ghost btn-sm mono"
                          style={{ padding: '2px 6px', fontSize: 12 }}
                          onClick={() => void openBrowser(crumb.path)}
                        >
                          {crumb.label}
                        </button>
                      </React.Fragment>
                    ))}
                  </div>
                </div>
                {browseData.currentPath && (
                  <button
                    type="button"
                    className="btn btn-primary btn-sm"
                    onClick={() => void runInspect(browseData.currentPath)}
                  >
                    Inspect This Folder
                  </button>
                )}
              </div>

              {browseData.currentFolderHint && (
                <div
                  style={{
                    padding: '8px 12px',
                    fontSize: 12.5,
                    background: 'rgba(34, 197, 94, 0.1)',
                    borderBottom: '1px solid var(--border-subtle)',
                    display: 'flex',
                    alignItems: 'center',
                    gap: 8,
                    color: 'var(--status-online)',
                  }}
                >
                  <CheckCircle2 size={14} />
                  <span>
                    Server files detected in this folder: <strong>{browseData.currentFolderHint}</strong> — click <strong>Inspect This Folder</strong>.
                  </span>
                </div>
              )}

              {/* Explorer-style single-column folder list */}
              <div style={{ maxHeight: 260, overflowY: 'auto' }}>
                {browseData.directories.length === 0 ? (
                  <div style={{ padding: '14px 12px', fontSize: 12.5, color: 'var(--text-muted)' }}>
                    No subfolders in this directory.
                  </div>
                ) : (
                  browseData.directories.map((dir) => (
                    <button
                      key={dir.path}
                      type="button"
                      className="btn btn-ghost btn-sm"
                      style={{
                        width: '100%',
                        justifyContent: 'space-between',
                        borderRadius: 0,
                        padding: '8px 12px',
                        borderBottom: '1px solid rgba(255,255,255,0.04)',
                      }}
                      onClick={() => void openBrowser(dir.path)}
                    >
                      <span style={{ display: 'flex', alignItems: 'center', gap: 8, minWidth: 0 }}>
                        {browseData.currentPath ? (
                          <Folder size={14} color={dir.isServerFolder ? 'var(--status-online)' : undefined} />
                        ) : (
                          <HardDrive size={14} />
                        )}
                        <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                          {dir.name}
                        </span>
                      </span>
                      <span style={{ display: 'flex', alignItems: 'center', gap: 8, flexShrink: 0 }}>
                        {dir.isServerFolder && (
                          <span className="badge badge-running" style={{ fontSize: 10.5, padding: '1px 7px' }}>
                            {dir.serverHint || 'Server'}
                          </span>
                        )}
                        <ChevronRight size={13} style={{ color: 'var(--text-muted)' }} />
                      </span>
                    </button>
                  ))
                )}
              </div>

              {browseData.previewFiles && browseData.previewFiles.length > 0 && (
                <div
                  style={{
                    padding: '8px 12px',
                    borderTop: '1px solid var(--border-subtle)',
                    background: 'var(--bg-elevated)',
                    fontSize: 11.5,
                    color: 'var(--text-muted)',
                    display: 'flex',
                    alignItems: 'center',
                    gap: 8,
                    flexWrap: 'wrap',
                  }}
                >
                  <FileCode2 size={13} />
                  <span>Files here:</span>
                  {browseData.previewFiles.map((file) => (
                    <code key={file} className="mono" style={{ color: 'var(--text-secondary)' }}>
                      {file}
                    </code>
                  ))}
                </div>
              )}
            </div>
          )}
        </div>
      </section>

      {/* Step 2: Review Detected Details & Import */}
      {inspection && (
        <form className="panel" onSubmit={handleImport}>
          <div className="panel-header">
            <h2 style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
              <CheckCircle2 size={16} color="var(--status-online)" /> 2. Review Detected Server &amp; Import
            </h2>
            <span className="badge badge-running">{inspection.detectedGameName}</span>
          </div>

          <div className="panel-body">
            {inspection.autoResolvedFrom && (
              <div className="alert alert-info" style={{ display: 'flex', gap: 8, alignItems: 'flex-start', marginBottom: 14 }}>
                <Info size={15} style={{ flexShrink: 0, marginTop: 2 }} />
                <span>
                  Found server files inside nested subfolder <code className="mono">{inspection.folderPath}</code> (auto-detected from{' '}
                  <code className="mono">{inspection.autoResolvedFrom}</code>).
                </span>
              </div>
            )}

            {inspection.detectedSubfolders && inspection.detectedSubfolders.length > 0 && (
              <div
                style={{
                  marginBottom: 16,
                  padding: 12,
                  borderRadius: 'var(--radius-sm)',
                  background: 'var(--bg-elevated)',
                  border: '1px solid var(--border-subtle)',
                }}
              >
                <div style={{ fontWeight: 600, fontSize: 13, marginBottom: 8 }}>
                  Server Subfolders Found Inside This Directory ({inspection.detectedSubfolders.length})
                </div>
                <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
                  {inspection.detectedSubfolders.map((sub) => (
                    <div
                      key={sub.path}
                      style={{
                        display: 'flex',
                        justifyContent: 'space-between',
                        alignItems: 'center',
                        gap: 10,
                        padding: '8px 10px',
                        borderRadius: 'var(--radius-sm)',
                        background: 'var(--bg-terminal)',
                        border: '1px solid var(--border-subtle)',
                        flexWrap: 'wrap',
                      }}
                    >
                      <div style={{ minWidth: 0, flex: 1 }}>
                        <div className="mono" style={{ fontWeight: 600, fontSize: 12.5 }}>
                          {sub.relativePath}
                        </div>
                        <div style={{ fontSize: 11.5, color: 'var(--text-secondary)', marginTop: 2 }}>{sub.summary}</div>
                      </div>
                      <button
                        type="button"
                        className="btn btn-primary btn-sm"
                        onClick={() => void runInspect(sub.path)}
                      >
                        Inspect Subfolder
                      </button>
                    </div>
                  ))}
                </div>
              </div>
            )}

            {/* Smart Detection Summary Strip */}
            <div className="instance-meta-row" style={{ marginBottom: 16 }}>
              <div>
                <div className="meta-cell-label">Detected Type</div>
                <div className="meta-cell-val">{inspection.modloader || inspection.detectedGameName}</div>
              </div>
              <div>
                <div className="meta-cell-label">Installed Mods</div>
                <div className="meta-cell-val tabular">
                  {inspection.modCount > 0 ? `${inspection.modCount} mods` : 'None / Vanilla'}
                </div>
              </div>
              <div>
                <div className="meta-cell-label">World / Saves</div>
                <div className="meta-cell-val">
                  {inspection.worldFolders.length > 0 ? inspection.worldFolders.join(', ') : 'Not created yet'}
                </div>
              </div>
            </div>

            {inspection.warnings.map((w, idx) => (
              <div key={idx} className="alert alert-info" style={{ display: 'flex', gap: 8, alignItems: 'flex-start' }}>
                <AlertTriangle size={15} style={{ flexShrink: 0, marginTop: 2 }} />
                <span>{w}</span>
              </div>
            ))}

            <div className="form-grid">
              <div className="field">
                <label htmlFor="imp-name">Server Display Name</label>
                <input
                  id="imp-name"
                  className="input"
                  value={name}
                  onChange={(e) => setName(e.target.value)}
                  required
                />
              </div>

              <div className="field">
                <label htmlFor="imp-game">Game Template</label>
                <select
                  id="imp-game"
                  className="select"
                  value={gameId}
                  onChange={(e) => setGameId(e.target.value)}
                >
                  {catalog.map((tpl) => (
                    <option key={tpl.id} value={tpl.id}>
                      {tpl.name}
                    </option>
                  ))}
                </select>
              </div>

              <div className="field">
                <label htmlFor="imp-mode">Import Mode</label>
                <select
                  id="imp-mode"
                  className="select"
                  value={mode}
                  onChange={(e) => setMode(e.target.value as 'link' | 'copy')}
                >
                  <option value="link">Link In-Place (Recommended — Instant, Zero Copy, Safe Unlink)</option>
                  <option value="copy">Copy into ServerForge Storage (Keeps Original as Backup)</option>
                </select>
                <span className="field-hint">
                  {mode === 'link'
                    ? `Manages directly inside ${inspection.folderPath}. Removing later only unlinks it.`
                    : 'Duplicates the folder into data/instances/ (may take a moment for large modpacks).'}
                </span>
              </div>

              <div className="field">
                <label htmlFor="imp-script">Startup Script / Executable</label>
                {inspection.launchCandidates.length > 0 ? (
                  <select
                    id="imp-script"
                    className="select mono"
                    value={launchScript}
                    onChange={(e) => setLaunchScript(e.target.value)}
                  >
                    {inspection.launchCandidates.map((c) => (
                      <option key={c.script} value={c.script}>
                        {c.label}
                        {c.recommended ? ' (Detected)' : ''}
                      </option>
                    ))}
                  </select>
                ) : (
                  <input
                    id="imp-script"
                    className="input mono"
                    placeholder="e.g., run.bat or server.jar"
                    value={launchScript}
                    onChange={(e) => setLaunchScript(e.target.value)}
                  />
                )}
              </div>

              <div className="field">
                <label htmlFor="imp-ram">RAM Allocation (GB)</label>
                <input
                  id="imp-ram"
                  type="number"
                  min={1}
                  max={128}
                  className="input tabular"
                  value={memoryGb}
                  onChange={(e) => setMemoryGb(Number(e.target.value))}
                />
                <span className="field-hint">Auto-detected from user_jvm_args.txt / startup script when present.</span>
              </div>

              <div className="field">
                <label htmlFor="imp-port">Game Port / RCON Port</label>
                <div style={{ display: 'flex', gap: 8 }}>
                  <input
                    id="imp-port"
                    type="number"
                    className="input tabular"
                    value={gamePort}
                    onChange={(e) => setGamePort(Number(e.target.value))}
                    title="Game Port"
                  />
                  {(gameId === 'minecraft' || gameId === 'minecraft-curseforge' || gameId === 'factorio') && (
                    <input
                      type="number"
                      className="input tabular"
                      value={rconPort}
                      onChange={(e) => setRconPort(Number(e.target.value))}
                      title="RCON Port"
                    />
                  )}
                </div>
              </div>

              <div className="field full">
                {(gameId === 'minecraft' || gameId === 'minecraft-curseforge') && (
                  <label className="checkbox-row" style={{ paddingBottom: 2 }}>
                    <input
                      id="imp-enable-rcon"
                      type="checkbox"
                      checked={enableRcon}
                      onChange={(e) => setEnableRcon(e.target.checked)}
                    />
                    <span>
                      Auto-enable RCON in <code className="mono">server.properties</code> (preserves all your other settings; enables live player counts, idle auto-shutdown &amp; safe saves)
                    </span>
                  </label>
                )}
                <label className="checkbox-row" style={{ paddingBottom: 2 }}>
                  <input
                    type="checkbox"
                    checked={discordEnabled}
                    onChange={(e) => setDiscordEnabled(e.target.checked)}
                  />
                  <span>Allow authorized Discord members to temporarily boot this server via /server start</span>
                </label>
                <label className="checkbox-row">
                  <input
                    type="checkbox"
                    checked={autoStart}
                    onChange={(e) => setAutoStart(e.target.checked)}
                  />
                  <span>Auto-start when server PC boots (after daily morning restart)</span>
                </label>
              </div>
            </div>

            <div style={{ marginTop: 18, paddingTop: 16, borderTop: '1px solid var(--border-subtle)' }}>
              <button id="execute-import-btn" type="submit" className="btn btn-primary" disabled={importing || name.trim().length < 2}>
                <Import size={15} /> {importing ? 'Importing...' : `Import "${name || 'Server'}"`}
              </button>
            </div>
          </div>
        </form>
      )}
    </div>
  );
}
