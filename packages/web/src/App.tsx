import React, { useCallback, useEffect, useState } from 'react';
import { Download, FileCode2, LogOut, PlusCircle, Server, Settings, Wifi, WifiOff } from 'lucide-react';
import type { GameTemplate, HostMetrics, UpdaterStatus, WsServerEvent } from '@serverforge/shared';
import { api, type AuthState, type InstanceWithJoin } from './api';
import { AuthView } from './components/AuthView';
import { DeployPage } from './components/DeployPage';
import { InstanceDetailPage } from './components/InstanceDetailPage';
import { OverviewPage } from './components/OverviewPage';
import { SettingsPage } from './components/SettingsPage';
import { TemplatesPage } from './components/TemplatesPage';

type NavView = 'overview' | 'deploy' | 'templates' | 'settings' | 'detail';

export function App() {
  const [auth, setAuth] = useState<AuthState | null>(null);
  const [view, setView] = useState<NavView>('overview');
  const [selectedInstanceId, setSelectedInstanceId] = useState<string | null>(null);

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
    const ws = new WebSocket(`${protocol}//${window.location.host}/ws`);

    ws.onopen = () => setWsConnected(true);
    ws.onclose = () => setWsConnected(false);
    ws.onmessage = (event) => {
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
        } else if (msg.type === 'instance:update' || msg.type === 'instance:deleted') {
          void refreshData();
        } else if (msg.type === 'updater:progress') {
          setUpdaterProgress({ stage: msg.stage, percent: msg.percent, message: msg.message });
        }
      } catch {
        // ignore malformed frames
      }
    };

    const poll = setInterval(() => {
      void refreshData();
    }, 15_000);

    return () => {
      clearInterval(poll);
      ws.close();
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

  const openInstance = (id: string) => {
    setLiveLogsByInstance((prev) => ({ ...prev, [id]: [] }));
    setSelectedInstanceId(id);
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
            onSelectInstance={openInstance}
            onGoToDeploy={() => setView('deploy')}
          />
        )}

        {view === 'deploy' && (
          <DeployPage
            catalog={catalog}
            onDeployed={(id) => {
              void refreshData();
              openInstance(id);
            }}
            onGoToSettings={() => setView('settings')}
          />
        )}

        {view === 'detail' && selectedInstanceId && (
          <InstanceDetailPage
            instanceId={selectedInstanceId}
            catalog={catalog}
            liveLogs={liveLogsByInstance[selectedInstanceId] ?? []}
            onBack={() => setView('overview')}
            onDeleted={() => {
              setSelectedInstanceId(null);
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
