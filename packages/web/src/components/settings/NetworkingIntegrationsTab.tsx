import React, { useEffect, useState } from 'react';
import { AlertTriangle, CheckCircle2, Eye, EyeOff, Globe, Lock, Network, Package, RefreshCw, Router } from 'lucide-react';
import type {
  ConsolidatedPortMapEntry,
  NetworkStatus,
  PublicHostMode,
  SystemSettings,
  UpnpMappingRecord,
  UpnpRouterInfo,
} from '@serverforge/shared';
import { api, formatHostSourceLabel } from '../../api';
import type { PushToastFn } from '../ToastStack';

interface NetworkingIntegrationsTabProps {
  settings: SystemSettings;
  networkStatus: NetworkStatus | null;
  onChange: (patch: Partial<SystemSettings>) => void;
  onNetworkUpdated: (status: NetworkStatus) => void;
  onSyncSavedSetting: (patch: Partial<SystemSettings>) => void;
  onToast: PushToastFn;
}

export function NetworkingIntegrationsTab({
  settings,
  networkStatus,
  onChange,
  onNetworkUpdated,
  onSyncSavedSetting,
  onToast,
}: NetworkingIntegrationsTabProps) {
  const [detectingNetwork, setDetectingNetwork] = useState(false);
  const [showDuckToken, setShowDuckToken] = useState(false);
  const [updatingDuckDns, setUpdatingDuckDns] = useState(false);
  const [duckResult, setDuckResult] = useState<{ ok: boolean; message: string } | null>(null);

  const [showCfKey, setShowCfKey] = useState(false);
  const [testingCfKey, setTestingCfKey] = useState(false);
  const [cfTestResult, setCfTestResult] = useState<{ ok: boolean; message: string } | null>(null);

  const [portMap, setPortMap] = useState<ConsolidatedPortMapEntry[]>([]);
  const [portMapLanIp, setPortMapLanIp] = useState<string | null>(null);
  const [loadingPortMap, setLoadingPortMap] = useState(false);

  const [upnpRouter, setUpnpRouter] = useState<UpnpRouterInfo | null>(null);
  const [upnpActiveMappings, setUpnpActiveMappings] = useState<UpnpMappingRecord[]>([]);
  const [discoveringUpnp, setDiscoveringUpnp] = useState(false);

  const loadPortMap = async () => {
    setLoadingPortMap(true);
    try {
      const res = await api.getConsolidatedPortMap();
      setPortMap(res.entries);
      setPortMapLanIp(res.lanIp);
    } catch {
      // ignore initial port map errors
    } finally {
      setLoadingPortMap(false);
    }
  };

  const loadUpnpStatus = async () => {
    try {
      const res = await api.getUpnpStatus();
      setUpnpRouter(res.router);
      setUpnpActiveMappings(res.activeMappings);
    } catch {
      // ignore
    }
  };

  const handleDiscoverUpnp = async () => {
    setDiscoveringUpnp(true);
    try {
      const res = await api.discoverUpnpRouter();
      setUpnpRouter(res.router);
      setUpnpActiveMappings(res.activeMappings);
      if (res.router.found) {
        onToast('success', `Discovered ${res.router.friendlyName ?? res.router.routerIp} (${res.router.protocol}).`);
      } else {
        onToast('info', res.router.error ?? 'No UPnP/NAT-PMP router responded.');
      }
    } catch (err) {
      onToast('error', err instanceof Error ? err.message : 'Router discovery failed');
    } finally {
      setDiscoveringUpnp(false);
    }
  };

  useEffect(() => {
    void loadPortMap();
    void loadUpnpStatus();
  }, []);

  const handleDetectNetwork = async () => {
    setDetectingNetwork(true);
    setDuckResult(null);
    try {
      const detected = await api.detectNetwork();
      onNetworkUpdated(detected);
      onToast('success', `Detected active host: ${detected.effectiveHost}`);
    } catch (err) {
      onToast('error', err instanceof Error ? err.message : 'Network detection failed');
    } finally {
      setDetectingNetwork(false);
    }
  };

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 18 }}>
      <section className="panel">
        <div className="panel-header" style={{ flexWrap: 'wrap', gap: 10 }}>
          <h2 style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
            <Globe size={16} /> Public Join Address &amp; DuckDNS
          </h2>
          <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
            {networkStatus && (
              <span className="badge badge-running">
                <span className="badge-dot" />
                {formatHostSourceLabel(networkStatus.effectiveHostSource)}: {networkStatus.effectiveHost}
              </span>
            )}
            <button
              type="button"
              className="btn btn-sm"
              disabled={detectingNetwork}
              onClick={() => void handleDetectNetwork()}
            >
              <RefreshCw size={12} className={detectingNetwork ? 'spin' : ''} />{' '}
              {detectingNetwork ? 'Detecting...' : 'Re-detect Now'}
            </button>
          </div>
        </div>
        <div className="panel-body">
          {networkStatus && (
            <div className="settings-summary-strip">
              <div>
                <span className="settings-summary-label">Public IP</span>
                <span className="mono">{networkStatus.publicIp ?? 'Not detected'}</span>
              </div>
              <div>
                <span className="settings-summary-label">Local LAN IP</span>
                <span className="mono">{networkStatus.lanIp ?? 'Not detected'}</span>
              </div>
              {networkStatus.detectedDuckDnsDomains.length > 0 && (
                <div style={{ display: 'flex', alignItems: 'center', gap: 6, flexWrap: 'wrap' }}>
                  <span className="settings-summary-label">Detected DuckDNS:</span>
                  {networkStatus.detectedDuckDnsDomains.map((dom) => (
                    <button
                      key={dom}
                      type="button"
                      className="btn btn-sm"
                      style={{ padding: '2px 8px', fontSize: 11.5 }}
                      onClick={() =>
                        onChange({
                          publicHostMode: 'duckdns',
                          duckdnsDomain: dom,
                        })
                      }
                    >
                      Use {dom}
                    </button>
                  ))}
                </div>
              )}
            </div>
          )}

          <div className="form-grid">
            <div className="field">
              <label htmlFor="set-public-host-mode">Public Address Mode</label>
              <select
                id="set-public-host-mode"
                className="select"
                value={settings.publicHostMode}
                onChange={(e) =>
                  onChange({
                    publicHostMode: e.target.value as PublicHostMode,
                  })
                }
              >
                <option value="auto">Automatic (DuckDNS -&gt; Public IP)</option>
                <option value="duckdns">DuckDNS Domain</option>
                <option value="manual">Custom Hostname / Tailscale / IP</option>
              </select>
            </div>

            <div className="field">
              <label htmlFor="set-duckdns-domain">DuckDNS Domain (optional)</label>
              <input
                id="set-duckdns-domain"
                className="input mono"
                value={settings.duckdnsDomain}
                onChange={(e) => {
                  setDuckResult(null);
                  onChange({ duckdnsDomain: e.target.value });
                }}
                placeholder="e.g., myserver.duckdns.org"
              />
            </div>

            <div className="field full">
              <label htmlFor="set-duckdns-token">DuckDNS Account Token (optional — for built-in DDNS updates)</label>
              <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
                <input
                  id="set-duckdns-token"
                  type={showDuckToken ? 'text' : 'password'}
                  className="input mono"
                  style={{ flex: 1, minWidth: 220 }}
                  value={settings.duckdnsToken}
                  onChange={(e) => {
                    setDuckResult(null);
                    onChange({ duckdnsToken: e.target.value });
                  }}
                  placeholder="Paste your DuckDNS token from duckdns.org"
                />
                <button
                  type="button"
                  className="btn btn-sm"
                  title={showDuckToken ? 'Hide token' : 'Show token'}
                  onClick={() => setShowDuckToken((v) => !v)}
                >
                  {showDuckToken ? <EyeOff size={14} /> : <Eye size={14} />}
                </button>
                <button
                  type="button"
                  className="btn btn-primary btn-sm"
                  disabled={updatingDuckDns}
                  onClick={async () => {
                    setUpdatingDuckDns(true);
                    setDuckResult(null);
                    try {
                      const res = await api.updateDuckDns({
                        domain: settings.duckdnsDomain,
                        token: settings.duckdnsToken,
                        saveOnSuccess: true,
                        autoUpdate: settings.duckdnsAutoUpdate,
                      });
                      setDuckResult({ ok: res.ok, message: res.message });
                      onNetworkUpdated(res.status);
                      if (res.ok && res.saved) {
                        onSyncSavedSetting({
                          duckdnsDomain: res.domain,
                          publicHostMode: 'duckdns',
                          duckdnsToken: settings.duckdnsToken,
                          duckdnsAutoUpdate: settings.duckdnsAutoUpdate,
                        });
                        onToast('success', `DuckDNS verified & saved (${res.domain}).`);
                      }
                    } catch (err) {
                      setDuckResult({
                        ok: false,
                        message: err instanceof Error ? err.message : 'DuckDNS update failed',
                      });
                    } finally {
                      setUpdatingDuckDns(false);
                    }
                  }}
                >
                  <CheckCircle2 size={14} /> {updatingDuckDns ? 'Updating...' : 'Update & Save DuckDNS'}
                </button>
              </div>
              <label className="checkbox-row" style={{ paddingTop: 6 }}>
                <input
                  type="checkbox"
                  checked={settings.duckdnsAutoUpdate}
                  onChange={(e) => onChange({ duckdnsAutoUpdate: e.target.checked })}
                />
                <span>Keep DuckDNS IP updated automatically from ServerForge (every 15m)</span>
              </label>
              {duckResult && (
                <div
                  className={`alert ${duckResult.ok ? 'alert-success' : 'alert-error'}`}
                  style={{ marginTop: 8, marginBottom: 0 }}
                >
                  {duckResult.message}
                </div>
              )}
            </div>

            {settings.publicHostMode !== 'duckdns' && (
              <div className="field full">
                <label htmlFor="set-public-host">Custom / Tailscale Hostname or IP</label>
                <input
                  id="set-public-host"
                  className="input mono"
                  value={settings.publicHost}
                  onChange={(e) => onChange({ publicHost: e.target.value })}
                  placeholder="e.g., 100.64.0.12 or games.yourdomain.com (leave localhost for auto)"
                />
                <span className="field-hint">
                  Displayed in copyable join addresses and Discord embeds when friends boot a server.
                </span>
              </div>
            )}
          </div>
        </div>
      </section>

      <section className="panel">
        <div className="panel-header">
          <h2 style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
            <Package size={16} /> CurseForge Integration (Modded Minecraft)
          </h2>
          <span className={`badge ${settings.curseforgeApiKey.trim() ? 'badge-running' : 'badge-stopped'}`}>
            <span className="badge-dot" />
            {settings.curseforgeApiKey.trim() ? 'KEY CONFIGURED' : 'NOT SET'}
          </span>
        </div>
        <div className="panel-body">
          <div className="field">
            <label htmlFor="set-cf-key">CurseForge Core API Key</label>
            <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
              <input
                id="set-cf-key"
                type={showCfKey ? 'text' : 'password'}
                className="input mono"
                style={{ flex: 1, minWidth: 220 }}
                value={settings.curseforgeApiKey}
                onChange={(e) => {
                  setCfTestResult(null);
                  onChange({ curseforgeApiKey: e.target.value });
                }}
                placeholder="$2a$10$... (60-char Core API key from console.curseforge.com)"
              />
              <button
                type="button"
                className="btn btn-sm"
                title={showCfKey ? 'Hide key' : 'Show key'}
                onClick={() => setShowCfKey((v) => !v)}
              >
                {showCfKey ? <EyeOff size={14} /> : <Eye size={14} />}
              </button>
              <button
                type="button"
                className="btn btn-primary btn-sm"
                disabled={testingCfKey}
                onClick={async () => {
                  setTestingCfKey(true);
                  setCfTestResult(null);
                  try {
                    const res = await api.testCurseForgeKey(settings.curseforgeApiKey);
                    const finalKey = res.normalizedKey || settings.curseforgeApiKey;
                    setCfTestResult({ ok: res.ok, message: res.message });
                    if (res.ok && res.saved) {
                      onSyncSavedSetting({ curseforgeApiKey: finalKey });
                      onToast('success', 'CurseForge API key verified & saved.');
                    } else if (res.normalizedKey && res.normalizedKey !== settings.curseforgeApiKey) {
                      onChange({ curseforgeApiKey: res.normalizedKey });
                    }
                  } catch (err) {
                    setCfTestResult({
                      ok: false,
                      message: err instanceof Error ? err.message : 'Test failed',
                    });
                  } finally {
                    setTestingCfKey(false);
                  }
                }}
              >
                <CheckCircle2 size={14} /> {testingCfKey ? 'Verifying...' : 'Verify & Save Key'}
              </button>
            </div>
            {cfTestResult && (
              <div
                className={`alert ${cfTestResult.ok ? 'alert-success' : 'alert-error'}`}
                style={{ marginTop: 8, marginBottom: 0 }}
              >
                {cfTestResult.message}
              </div>
            )}
            <span className="field-hint">
              Use a <strong>Core API Key</strong> starting with <code className="mono">$2a$10$...</code> from{' '}
              <a
                href="https://console.curseforge.com/"
                target="_blank"
                rel="noreferrer"
                style={{ color: 'var(--accent)', textDecoration: 'underline' }}
              >
                console.curseforge.com
              </a>{' '}
              (API keys tab). Clicking <strong>Verify &amp; Save Key</strong> tests live modpack search and saves automatically.
            </span>
          </div>
        </div>
      </section>

      <section className="panel">
        <div className="panel-header" style={{ flexWrap: 'wrap', gap: 10 }}>
          <h2 style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
            <Network size={16} /> Consolidated All-Server Port Map
          </h2>
          <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
            {portMapLanIp && (
              <span className="badge badge-stopped">
                Target LAN IP: <strong className="mono" style={{ marginLeft: 4 }}>{portMapLanIp}</strong>
              </span>
            )}
            <button
              type="button"
              className="btn btn-sm"
              disabled={loadingPortMap}
              onClick={() => void loadPortMap()}
            >
              <RefreshCw size={12} className={loadingPortMap ? 'spin' : ''} /> Refresh
            </button>
          </div>
        </div>
        <div className="panel-body">
          <p style={{ margin: '0 0 12px', fontSize: 13, color: 'var(--text-secondary)' }}>
            Only forward ports marked <strong>Required External</strong> in your router. Ports marked{' '}
            <strong>Local Only</strong> (RCON / REST) and ServerForge&apos;s dashboard port (<code className="mono">3000</code>) must remain locked down locally.
          </p>

          {portMap.length === 0 ? (
            <p style={{ margin: 0, color: 'var(--text-muted)', fontSize: 13 }}>
              No servers deployed yet. Deploy a game server to see its exact port-forwarding table here.
            </p>
          ) : (
            <table className="data-table">
              <thead>
                <tr>
                  <th>Server</th>
                  <th>Purpose</th>
                  <th>Port</th>
                  <th>Protocol</th>
                  <th>Exposure / Conflicts</th>
                </tr>
              </thead>
              <tbody>
                {portMap.map((entry) => (
                  <tr key={`${entry.instanceId}-${entry.portKey}`}>
                    <td>
                      <strong>{entry.instanceName}</strong>
                      <div style={{ fontSize: 11.5, color: 'var(--text-muted)' }}>{entry.gameId}</div>
                    </td>
                    <td>{entry.label}</td>
                    <td className="mono">{entry.port}</td>
                    <td className="mono">{entry.protocol.toUpperCase()}</td>
                    <td>
                      <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', alignItems: 'center' }}>
                        {entry.internalOnly ? (
                          <span className="badge badge-stopped">
                            <Lock size={11} /> Local Only — Do NOT Forward
                          </span>
                        ) : (
                          <span className="badge badge-running">Required External</span>
                        )}
                        {entry.conflictWith.length > 0 && (
                          <span className="badge badge-error" title={`Overlaps with: ${entry.conflictWith.join(', ')}`}>
                            <AlertTriangle size={11} /> Conflict: {entry.conflictWith[0]}
                          </span>
                        )}
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>
      </section>

      <section className="panel">
        <div className="panel-header" style={{ flexWrap: 'wrap', gap: 10 }}>
          <h2 style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
            <Router size={16} /> Automatic Router Port Forwarding (UPnP IGD / NAT-PMP — Opt-In)
          </h2>
          <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
            <span className={`badge ${settings.upnpEnabled ? 'badge-running' : 'badge-stopped'}`}>
              <span className="badge-dot" />
              {settings.upnpEnabled ? 'ENABLED GLOBALLY' : 'OFF BY DEFAULT'}
            </span>
            <button
              type="button"
              className="btn btn-sm"
              disabled={discoveringUpnp}
              onClick={() => void handleDiscoverUpnp()}
            >
              <RefreshCw size={12} className={discoveringUpnp ? 'spin' : ''} />
              {discoveringUpnp ? 'Scanning LAN...' : 'Discover Router'}
            </button>
          </div>
        </div>
        <div className="panel-body">
          <label className="checkbox-row" style={{ marginBottom: 10 }}>
            <input
              type="checkbox"
              checked={Boolean(settings.upnpEnabled)}
              onChange={(e) => onChange({ upnpEnabled: e.target.checked })}
            />
            <span>
              <strong>Enable automatic UPnP / NAT-PMP port forwarding by default</strong> for newly started servers
              (remember to click <em>Save Settings</em>; you can also override this per-server in each server&apos;s{' '}
              <strong>Network &amp; Firewall</strong> tab).
            </span>
          </label>
          <p style={{ margin: '0 0 12px', fontSize: 12.5, color: 'var(--text-muted)' }}>
            Security: ServerForge only maps required external game ports while a server is running, never maps internal-only ports (RCON / REST / Dashboard), and automatically deletes mappings on stop, shutdown, or after a PC crash.
          </p>

          {upnpRouter && (
            <div className="settings-summary-strip" style={{ marginBottom: upnpRouter.error ? 10 : 0 }}>
              <div>
                <span className="settings-summary-label">Router Gateway</span>
                <span className="mono">
                  {upnpRouter.found
                    ? `${upnpRouter.friendlyName ?? upnpRouter.modelName ?? 'Gateway'} (${upnpRouter.routerIp})`
                    : 'Not detected'}
                </span>
              </div>
              <div>
                <span className="settings-summary-label">Protocol</span>
                <span className="mono">{upnpRouter.protocol}</span>
              </div>
              <div>
                <span className="settings-summary-label">Router WAN IP</span>
                <span className="mono">{upnpRouter.externalIp ?? 'Unknown'}</span>
              </div>
              <div>
                <span className="settings-summary-label">Active ServerForge Leases</span>
                <span className="mono">{upnpActiveMappings.length}</span>
              </div>
            </div>
          )}

          {upnpRouter?.error && (
            <div className="alert alert-info" style={{ marginTop: 10, marginBottom: 0 }}>
              {upnpRouter.error}
            </div>
          )}

          {upnpRouter?.found && upnpRouter.existingMappings.length > 0 && (
            <div style={{ marginTop: 12, fontSize: 12.5, color: 'var(--text-secondary)' }}>
              <strong>Existing Router UPnP Mappings ({upnpRouter.existingMappings.length}):</strong>{' '}
              <span className="mono">
                {upnpRouter.existingMappings
                  .slice(0, 8)
                  .map((m) => `${m.externalPort}/${m.protocol} -> ${m.internalClient}`)
                  .join(', ')}
                {upnpRouter.existingMappings.length > 8 ? ` (+${upnpRouter.existingMappings.length - 8} more)` : ''}
              </span>
            </div>
          )}
        </div>
      </section>
    </div>
  );
}
