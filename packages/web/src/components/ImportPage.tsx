import React, { useState } from 'react';
import {
  AlertTriangle,
  ArrowUp,
  CheckCircle2,
  Folder,
  FolderOpen,
  HardDrive,
  Import,
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

export function ImportPage({ catalog, onImported }: ImportPageProps) {
  const [folderPath, setFolderPath] = useState('');
  const [discovering, setDiscovering] = useState(false);
  const [discovered, setDiscovered] = useState<DiscoveredProcess[] | null>(null);

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

  const runInspect = async (targetPath: string) => {
    const clean = targetPath.trim();
    if (!clean) return;
    setError(null);
    setInspecting(true);
    setFolderPath(clean);
    try {
      const res = await api.inspectImportFolder(clean);
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

      {/* Running Process Auto-Discovery Results */}
      {discovered !== null && (
        <section className="panel" style={{ marginBottom: 18 }}>
          <div className="panel-header">
            <h2>Running Game Processes Detected ({discovered.length})</h2>
          </div>
          <div className="panel-body">
            {discovered.length === 0 ? (
              <p style={{ margin: 0, color: 'var(--text-secondary)', fontSize: 13 }}>
                No running Java or dedicated game server processes were detected right now. Paste or browse to your server folder below.
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
                      <div className="mono" style={{ fontSize: 12, color: 'var(--text-secondary)', marginTop: 2 }}>
                        {p.workingDir || 'Folder path not automatically resolved — browse below'}
                      </div>
                      <div className="mono" style={{ fontSize: 11, color: 'var(--text-muted)', marginTop: 4, wordBreak: 'break-all' }}>
                        {p.commandLine}
                      </div>
                    </div>
                    {p.workingDir && (
                      <button
                        type="button"
                        className="btn btn-primary btn-sm"
                        onClick={() => void runInspect(p.workingDir!)}
                      >
                        Inspect Folder
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
          <button
            type="button"
            className="btn btn-sm"
            disabled={browsing}
            onClick={() => (browseData ? setBrowseData(null) : void openBrowser(folderPath || ''))}
          >
            <FolderOpen size={14} /> {browseData ? 'Close Browser' : 'Browse PC Folders'}
          </button>
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
              placeholder="e.g., C:\Minecraft\AllTheMods10 or D:\GameServers\BetterMC"
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
                padding: 12,
                borderRadius: 'var(--radius-sm)',
                background: 'var(--bg-terminal)',
                border: '1px solid var(--border-subtle)',
              }}
            >
              <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 10, marginBottom: 10, flexWrap: 'wrap' }}>
                <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                  {browseData.parentPath !== null && (
                    <button
                      type="button"
                      className="btn btn-sm"
                      onClick={() => void openBrowser(browseData.parentPath!)}
                    >
                      <ArrowUp size={13} /> Up
                    </button>
                  )}
                  <span className="mono" style={{ fontSize: 12.5 }}>
                    {browseData.currentPath || 'This PC (Drives)'}
                  </span>
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

              <div
                style={{
                  display: 'grid',
                  gridTemplateColumns: 'repeat(auto-fill, minmax(210px, 1fr))',
                  gap: 6,
                  maxHeight: 230,
                  overflowY: 'auto',
                }}
              >
                {browseData.directories.map((dir) => (
                  <button
                    key={dir.path}
                    type="button"
                    className="btn btn-ghost btn-sm"
                    style={{ justifyContent: 'flex-start', overflow: 'hidden', textOverflow: 'ellipsis' }}
                    onClick={() => void openBrowser(dir.path)}
                  >
                    {browseData.currentPath ? <Folder size={13} /> : <HardDrive size={13} />}
                    <span style={{ overflow: 'hidden', textOverflow: 'ellipsis' }}>{dir.name}</span>
                  </button>
                ))}
              </div>
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
