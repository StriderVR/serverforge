import React, { useState } from 'react';
import {
  Check,
  Clock,
  Copy,
  Cpu,
  HardDrive,
  MemoryStick,
  Play,
  Plus,
  RotateCw,
  Server,
  Square,
  Terminal,
  Timer,
} from 'lucide-react';
import type { GameTemplate, HostMetrics } from '@serverforge/shared';
import { api, formatRemaining, type InstanceWithJoin } from '../api';

interface OverviewPageProps {
  metrics: HostMetrics | null;
  instances: InstanceWithJoin[];
  catalog: GameTemplate[];
  onRefresh: () => void;
  onSelectInstance: (id: string) => void;
  onGoToDeploy: () => void;
}

export function OverviewPage({
  metrics,
  instances,
  catalog,
  onRefresh,
  onSelectInstance,
  onGoToDeploy,
}: OverviewPageProps) {
  const [busyId, setBusyId] = useState<string | null>(null);
  const [copiedId, setCopiedId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const templateMap = new Map(catalog.map((t) => [t.id, t]));

  const runAction = async (id: string, fn: () => Promise<unknown>) => {
    setError(null);
    setBusyId(id);
    try {
      await fn();
      onRefresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Action failed');
    } finally {
      setBusyId(null);
    }
  };

  const copyAddress = (id: string, address: string) => {
    navigator.clipboard?.writeText(address).catch(() => {});
    setCopiedId(id);
    setTimeout(() => setCopiedId((prev) => (prev === id ? null : prev)), 1800);
  };

  const ramPct =
    metrics && metrics.memoryTotalGb > 0
      ? Math.min(100, Math.round((metrics.memoryUsedGb / metrics.memoryTotalGb) * 100))
      : 0;
  const diskPct =
    metrics && metrics.diskTotalGb > 0
      ? Math.min(100, Math.round((metrics.diskUsedGb / metrics.diskTotalGb) * 100))
      : 0;

  return (
    <div>
      <header className="page-header">
        <div>
          <h1>Server Fleet</h1>
          <p className="page-subtitle">
            {metrics
              ? `${metrics.hostname} • ${metrics.osDistro} • ${metrics.runtimesAvailable.mock ? 'Mock Preview Mode' : [metrics.runtimesAvailable.docker && 'Docker', metrics.runtimesAvailable.native && 'Native'].filter(Boolean).join(' + ')}`
              : 'Loading host telemetry...'}
          </p>
        </div>
        <button id="deploy-new-btn" className="btn btn-primary" onClick={onGoToDeploy}>
          <Plus size={16} />
          Deploy Game Server
        </button>
      </header>

      {error && <div className="alert alert-error">{error}</div>}

      {/* Host Telemetry Strip */}
      <section className="metrics-strip" aria-label="Host machine telemetry">
        <div className="metric-card">
          <div className="metric-label">
            <span>Host CPU</span>
            <Cpu size={14} />
          </div>
          <div className="metric-value tabular">{metrics ? `${metrics.cpuLoadPercent}%` : '--'}</div>
          <div className="progress-track">
            <div
              className={`progress-fill ${(metrics?.cpuLoadPercent ?? 0) > 85 ? 'danger' : 'good'}`}
              style={{ width: `${Math.min(100, metrics?.cpuLoadPercent ?? 0)}%` }}
            />
          </div>
          <div className="metric-meta">{metrics ? `${metrics.cpuCores} logical cores` : 'Measuring...'}</div>
        </div>

        <div className="metric-card">
          <div className="metric-label">
            <span>System RAM</span>
            <MemoryStick size={14} />
          </div>
          <div className="metric-value tabular">
            {metrics ? `${metrics.memoryUsedGb} / ${metrics.memoryTotalGb} GB` : '--'}
          </div>
          <div className="progress-track">
            <div
              className={`progress-fill ${ramPct > 85 ? 'danger' : ramPct > 70 ? 'warn' : 'good'}`}
              style={{ width: `${ramPct}%` }}
            />
          </div>
          <div className="metric-meta">
            {metrics
              ? `${metrics.memoryFreeGb} GB free (${metrics.memoryReservedForOsGb} GB OS reserve)`
              : 'Measuring...'}
          </div>
        </div>

        <div className="metric-card">
          <div className="metric-label">
            <span>Storage</span>
            <HardDrive size={14} />
          </div>
          <div className="metric-value tabular">
            {metrics ? `${metrics.diskFreeGb} GB free` : '--'}
          </div>
          <div className="progress-track">
            <div className={`progress-fill ${diskPct > 85 ? 'warn' : 'good'}`} style={{ width: `${diskPct}%` }} />
          </div>
          <div className="metric-meta">
            {metrics ? `${metrics.diskUsedGb} / ${metrics.diskTotalGb} GB used` : 'Measuring...'}
          </div>
        </div>

        <div className="metric-card">
          <div className="metric-label">
            <span>Active Capacity</span>
            <Server size={14} />
          </div>
          <div className="metric-value tabular">
            {metrics ? `${metrics.runningServers} / ${metrics.maxConcurrentServers}` : '--'}
          </div>
          <div className="progress-track">
            <div
              className="progress-fill"
              style={{
                width: metrics
                  ? `${Math.min(100, (metrics.runningServers / Math.max(1, metrics.maxConcurrentServers)) * 100)}%`
                  : '0%',
              }}
            />
          </div>
          <div className="metric-meta">
            {metrics?.discordConnected
              ? `Discord Bot: ${metrics.discordBotTag}`
              : 'Discord Bot: Offline (Web-only)'}
          </div>
        </div>
      </section>

      {/* Instances List */}
      {instances.length === 0 ? (
        <div className="panel empty-state">
          <Server size={32} style={{ color: 'var(--text-muted)' }} />
          <h3>No game servers deployed yet</h3>
          <p style={{ maxWidth: 420, margin: '0 auto 18px', fontSize: 13.5 }}>
            Pick a game from your catalog (Minecraft, Satisfactory, Factorio, Palworld, or Ark: Survival Ascended)
            and launch it with a single click.
          </p>
          <button className="btn btn-primary" onClick={onGoToDeploy}>
            <Plus size={16} />
            Deploy Your First Server
          </button>
        </div>
      ) : (
        <section className="instance-grid" aria-label="Deployed game servers">
          {instances.map((inst) => {
            const tpl = templateMap.get(inst.gameId);
            const isBusy = busyId === inst.id;
            const isRunning = inst.status === 'running';
            const isStopped = inst.status === 'stopped' || inst.status === 'error';

            return (
              <article key={inst.id} className="instance-card">
                <div className="instance-top">
                  <div>
                    <h2 className="instance-title" onClick={() => onSelectInstance(inst.id)}>
                      {inst.name}
                    </h2>
                    <div className="instance-sub">
                      {tpl?.name ?? inst.gameId} • <span className="mono">{inst.runtime}</span>
                    </div>
                  </div>
                  <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'flex-end', gap: 6 }}>
                    <span className={`badge badge-${inst.status}`}>
                      <span className="badge-dot" />
                      {inst.status.toUpperCase()}
                    </span>
                    {inst.activeLease && (
                      <span className="badge badge-lease tabular" title={`Booted by ${inst.activeLease.requestedBy}`}>
                        <Clock size={11} />
                        {formatRemaining(inst.activeLease.expiresAt)} left
                      </span>
                    )}
                  </div>
                </div>

                <button
                  type="button"
                  className="copy-address"
                  onClick={() => copyAddress(inst.id, inst.joinAddress)}
                  title="Copy server join address"
                >
                  <span>{inst.joinAddress}</span>
                  {copiedId === inst.id ? <Check size={13} color="var(--status-online)" /> : <Copy size={13} />}
                </button>

                <div className="instance-meta-row tabular">
                  <div>
                    <div className="meta-cell-label">Players</div>
                    <div className="meta-cell-val">
                      {isRunning
                        ? inst.stats?.playerCount !== null && inst.stats?.playerCount !== undefined
                          ? `${inst.stats.playerCount} / ${inst.stats.maxPlayers ?? '?'}`
                          : 'Online'
                        : '—'}
                    </div>
                  </div>
                  <div>
                    <div className="meta-cell-label">RAM Limit</div>
                    <div className="meta-cell-val">
                      {isRunning && inst.stats?.memoryMb
                        ? `${(inst.stats.memoryMb / 1024).toFixed(1)} / ${(inst.memoryLimitMb / 1024).toFixed(0)} GB`
                        : `${(inst.memoryLimitMb / 1024).toFixed(1)} GB`}
                    </div>
                  </div>
                  <div>
                    <div className="meta-cell-label">Discord Boot</div>
                    <div className="meta-cell-val">{inst.discordEnabled ? 'Enabled' : 'Admin Only'}</div>
                  </div>
                </div>

                {inst.lastError && (
                  <div style={{ fontSize: 12, color: 'hsl(0, 82%, 72%)' }}>Error: {inst.lastError}</div>
                )}

                <div className="btn-row">
                  {isStopped ? (
                    <>
                      <button
                        className="btn btn-success btn-sm"
                        disabled={isBusy}
                        onClick={() => runAction(inst.id, () => api.startInstance(inst.id, { temporary: false }))}
                      >
                        <Play size={13} />
                        {isBusy ? 'Starting...' : 'Start'}
                      </button>
                      <button
                        className="btn btn-sm"
                        disabled={isBusy}
                        title="Start with automatic idle & TTL shutdown"
                        onClick={() =>
                          runAction(inst.id, () => api.startInstance(inst.id, { temporary: true, durationMinutes: 180 }))
                        }
                      >
                        <Timer size={13} />
                        Temp Boot (3h)
                      </button>
                    </>
                  ) : (
                    <>
                      <button
                        className="btn btn-danger btn-sm"
                        disabled={isBusy}
                        onClick={() => runAction(inst.id, () => api.stopInstance(inst.id))}
                      >
                        <Square size={13} />
                        {isBusy ? 'Stopping...' : 'Save & Stop'}
                      </button>
                      <button
                        className="btn btn-sm"
                        disabled={isBusy}
                        onClick={() => runAction(inst.id, () => api.restartInstance(inst.id))}
                      >
                        <RotateCw size={13} />
                        Restart
                      </button>
                    </>
                  )}
                  <button
                    className="btn btn-ghost btn-sm"
                    style={{ marginLeft: 'auto' }}
                    onClick={() => onSelectInstance(inst.id)}
                  >
                    <Terminal size={13} />
                    Manage
                  </button>
                </div>
              </article>
            );
          })}
        </section>
      )}
    </div>
  );
}
