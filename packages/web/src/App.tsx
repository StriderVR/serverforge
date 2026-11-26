import React, { useCallback, useEffect, useRef, useState } from 'react';
import { Download, FileCode2, FolderInput, LogOut, PlusCircle, Server, Settings, Wifi, WifiOff } from 'lucide-react';
import type { GameTemplate, HostMetrics, UpdaterStatus, WsServerEvent } from '@serverforge/shared';
import { api, type AuthState, type InstanceWithJoin } from './api';
import { AuthView } from './components/AuthView';
import { ConfirmModal, type ConfirmDialogOptions } from './components/ConfirmModal';
import { DeployPage } from './components/DeployPage';
import { ImportPage } from './components/ImportPage';
import { InstanceDetailPage, type InstanceTabId } from './components/InstanceDetailPage';
import { OverviewPage } from './components/OverviewPage';
import { SettingsPage, type SettingsTabId } from './components/SettingsPage';
import { TemplatesPage } from './components/TemplatesPage';
import { ToastStack, type ToastItem, type ToastKind } from './components/ToastStack';

type NavView = 'overview' | 'deploy' | 'import' | 'templates' | 'settings' | 'detail';

const VALID_SETTINGS_TABS = new Set<SettingsTabId>(['general', 'networking', 'discord', 'updates', 'diagnostics']);
const VALID_INSTANCE_TABS = new Set<InstanceTabId>(['console', 'config', 'backups']);

interface ParsedRoute {
  view: NavView;
  instanceId: string | null;
  instanceTab: InstanceTabId;
  settingsTab: SettingsTabId;
}

function parseHashRoute(): ParsedRoute {
  const raw = (typeof window !== 'undefined' ? window.location.hash : '').replace(/^#\/?/, '').trim();
  const parts = raw.split('/').filter(Boolean);
  const head = parts[0];

  if (head === 'deploy') return { view: 'deploy', instanceId: null, instanceTab: 'console', settingsTab: 'general' };
  if (head === 'import') return { view: 'import', instanceId: null, instanceTab: 'console', settingsTab: 'general' };
  if (head === 'templates') return { view: 'templates', instanceId: null, instanceTab: 'console', settingsTab: 'general' };
  if (head === 'settings') {
    const sub = parts[1] as SettingsTabId | undefined;
    return {
      view: 'settings',
      instanceId: null,
      instanceTab: 'console',
      settingsTab: sub && VALID_SETTINGS_TABS.has(sub) ? sub : 'general',
    };
  }
  if (head === 'server' && parts[1]) {
    const sub = parts[2] as InstanceTabId | undefined;
    return {
      view: 'detail',
      instanceId: decodeURIComponent(parts[1]),
      instanceTab: sub && VALID_INSTANCE_TABS.has(sub) ? sub : 'console',
      settingsTab: 'general',
    };
  }
  return { view: 'overview', instanceId: null, instanceTab: 'console', settingsTab: 'general' };
}

function buildHashRoute(route: ParsedRoute): string {
  if (route.view === 'deploy') return '#deploy';
  if (route.view === 'import') return '#import';
  if (route.view === 'templates') return '#templates';
  if (route.view === 'settings') return `#settings/${route.settingsTab}`;
  if (route.view === 'detail' && route.instanceId) {
    return `#server/${encodeURIComponent(route.instanceId)}/${route.instanceTab}`;
  }
  return '#overview';
}

export function App() {
  const initialRoute = parseHashRoute();
  const [auth, setAuth] = useState<AuthState | null>(null);
  const [view, setView] = useState<NavView>(initialRoute.view);
  const [selectedInstanceId, setSelectedInstanceId] = useState<string | null>(initialRoute.instanceId);
  const [instanceTab, setInstanceTab] = useState<InstanceTabId>(initialRoute.instanceTab);
  const [settingsTab, setSettingsTab] = useState<SettingsTabId>(initialRoute.settingsTab);
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

  // Global Confirm Modal & Toast Stack
  const [confirmState, setConfirmState] = useState<ConfirmDialogOptions | null>(null);
  const confirmResolverRef = useRef<((confirmed: boolean) => void) | null>(null);
  const [toasts, setToasts] = useState<ToastItem[]>([]);

  const requestConfirm = useCallback((options: ConfirmDialogOptions): Promise<boolean> => {
    return new Promise<boolean>((resolve) => {
      confirmResolverRef.current = resolve;
      setConfirmState(options);
    });
  }, []);

  const resolveConfirm = useCallback((confirmed: boolean) => {
    const resolver = confirmResolverRef.current;
    confirmResolverRef.current = null;
    setConfirmState(null);
    resolver?.(confirmed);
  }, []);

  const dismissToast = useCallback((id: string) => {
    setToasts((prev) => prev.filter((t) => t.id !== id));
  }, []);

  const pushToast = useCallback(
    (kind: ToastKind, text: string) => {
      const id = `${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
      setToasts((prev) => [...prev.slice(-3), { id, kind, text }]);
      setTimeout(() => {
        dismissToast(id);
      }, 3800);
    },
    [dismissToast]
  );

  // Sync navigation state to URL hash so page refreshes keep the active view & tab
  useEffect(() => {
    const targetHash = buildHashRoute({ view, instanceId: selectedInstanceId, instanceTab, settingsTab });
    if (window.location.hash !== targetHash) {
      window.history.replaceState(null, '', targetHash);
    }
  }, [view, selectedInstanceId, instanceTab, settingsTab]);

  useEffect(() => {
    const onHashChange = () => {
      const parsed = parseHashRoute();
      setView(parsed.view);
      setSelectedInstanceId(parsed.instanceId);
      setInstanceTab(parsed.instanceTab);
      setSettingsTab(parsed.settingsTab);
    };
    window.addEventListener('hashchange', onHashChange);
    return () => window.removeEventListener('hashchange', onHashChange);
  }, []);

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

  const openInstance = (id: string, autoBoot = false, tab: InstanceTabId = 'console') => {
    setLiveLogsByInstance((prev) => ({ ...prev, [id]: [] }));
    setSelectedInstanceId(id);
    setInstanceTab(tab);
    setAutoBootInstanceId(autoBoot ? id : null);
    setView('detail');
  };

  const openSettings = (tab?: SettingsTabId) => {
    if (tab) setSettingsTab(tab);
    setView('settings');
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
          <button
            className={`nav-item ${view === 'settings' ? 'active' : ''}`}
            onClick={() => openSettings()}
          >
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
              onClick={() => openSettings('updates')}
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
            onToast={pushToast}
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
            onGoToSettings={() => openSettings('networking')}
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
            activeTab={instanceTab}
            onTabChange={setInstanceTab}
            autoBoot={autoBootInstanceId === selectedInstanceId}
            onAutoBootConsumed={() => setAutoBootInstanceId(null)}
            onBack={() => setView('overview')}
            onDeleted={() => {
              setSelectedInstanceId(null);
              setAutoBootInstanceId(null);
              setView('overview');
              pushToast('info', 'Server removed from ServerForge.');
            }}
            onGlobalRefresh={() => void refreshData()}
            onConfirm={requestConfirm}
            onToast={pushToast}
          />
        )}

        {view === 'templates' && (
          <TemplatesPage
            catalog={catalog}
            onRefreshCatalog={() => void refreshData()}
            onConfirm={requestConfirm}
            onToast={pushToast}
          />
        )}

        {view === 'settings' && (
          <SettingsPage
            metrics={metrics}
            updaterStatus={updaterStatus}
            updaterProgress={updaterProgress}
            activeTab={settingsTab}
            onTabChange={setSettingsTab}
            onSaved={() => void refreshData()}
            onRefreshUpdater={refreshUpdater}
            onStartReconnecting={(label, expectedVersion) =>
              setReconnectingState({ label, expectedVersion })
            }
            onConfirm={requestConfirm}
            onToast={pushToast}
          />
        )}
      </main>

      <ConfirmModal
        open={Boolean(confirmState)}
        options={confirmState}
        onConfirm={() => resolveConfirm(true)}
        onCancel={() => resolveConfirm(false)}
      />

      <ToastStack toasts={toasts} onDismiss={dismissToast} />
    </div>
  );
}
