import React, { useCallback, useEffect, useState } from 'react';
import { Download, FileCode2, FolderInput, LogOut, PlusCircle, Server, Settings, Wifi, WifiOff } from 'lucide-react';
import type { GameTemplate, HostMetrics, UpdaterStatus, WsServerEvent } from '@serverforge/shared';
import { api, type AuthState, type InstanceWithJoin } from './api';
import { AuthView } from './components/AuthView';
import { DeployPage } from './components/DeployPage';
import { ImportPage } from './components/ImportPage';
import { InstanceDetailPage } from './components/InstanceDetailPage';
import { OverviewPage } from './components/OverviewPage';
import { SettingsPage } from './components/SettingsPage';
import { TemplatesPage } from './components/TemplatesPage';

type NavView = 'overview' | 'deploy' | 'import' | 'templates' | 'settings' | 'detail';

export function App() {
  const [auth, setAuth] = useState<AuthState | null>(null);
  const [view, setView] = useState<NavView>('overview');
  const [selectedInstanceId, setSelectedInstanceId] = useState<string | null>(null);
  const [autoBootInstanceId, setAutoBootInstanceId] = useState<string | null>(null);

  const [metrics, setMetrics] = useState<HostMetrics | null>(null);
  const [catalog, setCatalog] = useState<GameTemplate[]>([]);
  const [instances, setInstances] = useState<InstanceWithJoin[]>([]);
  const [updaterStatus, setUpdaterStatus] = useState<UpdaterStatus | null>(null);
  const [updaterProgress, setUpdaterProgress] = useState<{
    stage: string;
    percent: number;
    message: string;
  } | null>(null);
  const [reconnectingState, setReconnectingState] = useState<{
    label: string;
    expectedVersion?: string;
  } | null>(null);

  const [wsConnected, setWsConnected] = useState(false);
  const [liveLogsByInstance, setLiveLogsByInstance] = useState<
    Record<string, Array<{ timestamp: string; line: string }>>
  >({});

  const checkAuth = useCallback(async () => {
    const state = await api.getAuthMe();
    setAuth(state);
  }, []);

  const refreshUpdater = useCallback(async (force = false) => {
    try {
      const st = await api.getUpdaterStatus(force);
      setUpdaterStatus(st);
    } catch {
      // Non-fatal if offline
    }
  }, []);

  const refreshData = useCallback(async () => {
    const [m, c, inst] = await Promise.all([api.getHostMetrics(), api.getCatalog(), api.getInstances()]);
    setMetrics(m);
    setCatalog(c);
    setInstances(inst);
  }, []);

  useEffect(() => {
    void checkAuth();
  }, [checkAuth]);

  useEffect(() => {
    if (!auth?.authenticated) return;
    void refreshData();
    void refreshUpdater(false);

    const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
    const wsUrl = `${protocol}//${window.location.host}/ws`;
    let ws: WebSocket | null = null;
    let reconnectTimer: ReturnType<typeof setTimeout> | null = null;
    let disposed = false;

    const connect = () => {
      if (disposed) return;
      const socket = new WebSocket(wsUrl);
      ws = socket;

      socket.onopen = () => {
        if (!disposed) setWsConnected(true);
      };
      socket.onclose = () => {
        if (disposed) return;
        setWsConnected(false);
        reconnectTimer = setTimeout(connect, 2000);
      };
      socket.onerror = () => {
        // onclose will trigger automatic reconnect
      };
      socket.onmessage = (event) => {
        try {
          const msg = JSON.parse(event.data) as WsServerEvent;
          if (msg.type === 'host:metrics') {
            setMetrics(msg.metrics);
          } else if (msg.type === 'console:line') {
            setLiveLogsByInstance((prev) => {
              const existing = prev[msg.instanceId] ?? [];
              const next = [...existing, { timestamp: msg.timestamp, line: msg.line }].slice(-250);
              return { ...prev, [msg.instanceId]: next };
            });
          } else if (
            msg.type === 'instance:update' ||
            msg.type === 'instance:deleted' ||
            msg.type === 'instance:crash'
          ) {
            void refreshData();
          } else if (msg.type === 'updater:progress') {
            setUpdaterProgress({ stage: msg.stage, percent: msg.percent, message: msg.message });
            if (msg.stage === 'error') {
              setReconnectingState(null);
            }
          }
        } catch {
          // ignore malformed frames
        }
      };
    };

    connect();

    const poll = setInterval(() => {
      void refreshData();
    }, 15_000);

    return () => {
      disposed = true;
      clearInterval(poll);
      if (reconnectTimer) clearTimeout(reconnectTimer);
      ws?.close();
    };
  }, [auth?.authenticated, refreshData, refreshUpdater]);

  // Auto-poll /api/health while ServerForge is updating or rebooting the host PC
  useEffect(() => {
    if (!reconnectingState) return;
    let sawOffline = false;

    const timer = setInterval(async () => {
      try {
        const health = await api.getHealth();
        if (
          health.status === 'ok' &&
          (sawOffline ||
            (reconnectingState.expectedVersion && health.version === reconnectingState.expectedVersion))
        ) {
          window.location.reload();
        }
      } catch {
        sawOffline = true;
      }
    }, 2500);

    return () => clearInterval(timer);
  }, [reconnectingState]);

  if (!auth) {
    return (
      <div className="auth-wrapper" style={{ color: 'var(--text-secondary)' }}>
        Connecting to ServerForge...
      </div>
    );
  }

  if (!auth.authenticated) {
    return <AuthView needsSetup={auth.needsSetup} onAuthenticated={() => void checkAuth()} />;
  }

  const openInstance = (id: string, autoBoot = false) => {
    setLiveLogsByInstance((prev) => ({ ...prev, [id]: [] }));
    setSelectedInstanceId(id);
    setAutoBootInstanceId(autoBoot ? id : null);
    setView('detail');
  };

  const handleLogout = async () => {
    await api.logout();
    await checkAuth();
  };

  return (
    <div className="app-shell">
      <aside className="sidebar">
        <div className="brand">
          <div className="brand-mark">
            <Server size={18} />
          </div>
          <div>
            <div className="brand-title">ServerForge</div>
            <span className="brand-sub">
              {updaterStatus ? `v${updaterStatus.currentVersion}` : 'Game Control Plane'}
            </span>
          </div>
        </div>

        <nav className="nav-list" aria-label="Main navigation">
          <button
            className={`nav-item ${view === 'overview' || view === 'detail' ? 'active' : ''}`}
            onClick={() => setView('overview')}
          >
            <Server size={16} />
            Server Fleet
          </button>
          <button className={`nav-item ${view === 'deploy' ? 'active' : ''}`} onClick={() => setView('deploy')}>
            <PlusCircle size={16} />
            One-Click Deploy
          </button>
          <button className={`nav-item ${view === 'import' ? 'active' : ''}`} onClick={() => setView('import')}>
            <FolderInput size={16} />
            Import Server
          </button>
          <button className={`nav-item ${view === 'templates' ? 'active' : ''}`} onClick={() => setView('templates')}>
            <FileCode2 size={16} />
            Game Templates
          </button>
          <button className={`nav-item ${view === 'settings' ? 'active' : ''}`} onClick={() => setView('settings')}>
            <Settings size={16} />
            Settings &amp; Automation
          </button>
        </nav>

        <div className="sidebar-footer">
          {updaterStatus?.updateAvailable && (
            <button
              type="button"
              className="btn btn-primary btn-sm"
              style={{ width: '100%' }}
              onClick={() => setView('settings')}
            >
              <Download size={13} /> Update v{updaterStatus.latestVersion} Ready
            </button>
          )}
          <div className="status-line">
            <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}>
              {wsConnected ? <Wifi size={13} color="var(--status-online)" /> : <WifiOff size={13} />}
              {wsConnected ? 'Live Stream' : 'Reconnecting'}
            </span>
            <span className="mono">{auth.user?.username}</span>
          </div>
          <button className="btn btn-ghost btn-sm" style={{ justifyContent: 'flex-start' }} onClick={handleLogout}>
            <LogOut size={14} />
            Sign Out
          </button>
        </div>
      </aside>

      <main className="main-content">
        {reconnectingState && (
          <div className="alert alert-info" style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
            <strong>{reconnectingState.label}</strong>
            <span>
              {updaterProgress?.message ||
                'Waiting for ServerForge to come back online. This page will reload automatically.'}
            </span>
            {updaterProgress && (
              <div className="progress-track">
                <div className="progress-fill" style={{ width: `${updaterProgress.percent}%` }} />
              </div>
            )}
          </div>
        )}

        {view === 'overview' && (
          <OverviewPage
            metrics={metrics}
            instances={instances}
            catalog={catalog}
            onRefresh={() => void refreshData()}
            onSelectInstance={(id) => openInstance(id, false)}
            onGoToDeploy={() => setView('deploy')}
          />
        )}

        {view === 'deploy' && (
          <DeployPage
            catalog={catalog}
            metrics={metrics}
            onDeployed={(id, autoBoot) => {
              void refreshData();
              openInstance(id, Boolean(autoBoot));
            }}
            onGoToSettings={() => setView('settings')}
          />
        )}

        {view === 'import' && (
          <ImportPage
            catalog={catalog}
            onImported={(id) => {
              void refreshData();
              openInstance(id, false);
            }}
          />
        )}

        {view === 'detail' && selectedInstanceId && (
          <InstanceDetailPage
            instanceId={selectedInstanceId}
            instanceSummary={instances.find((i) => i.id === selectedInstanceId) ?? null}
            catalog={catalog}
            metrics={metrics}
            liveLogs={liveLogsByInstance[selectedInstanceId] ?? []}
            autoBoot={autoBootInstanceId === selectedInstanceId}
            onAutoBootConsumed={() => setAutoBootInstanceId(null)}
            onBack={() => setView('overview')}
            onDeleted={() => {
              setSelectedInstanceId(null);
              setAutoBootInstanceId(null);
              setView('overview');
            }}
            onGlobalRefresh={() => void refreshData()}
          />
        )}

        {view === 'templates' && (
          <TemplatesPage catalog={catalog} onRefreshCatalog={() => void refreshData()} />
        )}

        {view === 'settings' && (
          <SettingsPage
            metrics={metrics}
            updaterStatus={updaterStatus}
            updaterProgress={updaterProgress}
            onSaved={() => void refreshData()}
            onRefreshUpdater={refreshUpdater}
            onStartReconnecting={(label, expectedVersion) =>
              setReconnectingState({ label, expectedVersion })
            }
          />
        )}
      </main>
    </div>
  );
}
