import React, { useCallback, useEffect, useState } from 'react';
import {
  Activity,
  AlertTriangle,
  Check,
  CheckCircle2,
  Copy,
  Download,
  Globe,
  Lock,
  RefreshCw,
  Router,
  Shield,
  ShieldAlert,
  ShieldCheck,
  ShieldOff,
  XCircle,
} from 'lucide-react';
import type {
  ConnectivityHopStatus,
  FirewallStatus,
  InstanceConnectivityReport,
  InstanceNetworkGuide,
  UpnpInstanceStatus,
  UpnpMode,
} from '@serverforge/shared';
import { api } from '../../api';
import { copyTextToClipboard } from '../../utils/clipboard';
import type { PushToastFn } from '../ToastStack';

interface NetworkTabProps {
  instanceId: string;
  isRunning: boolean;
  onStartServer?: () => void;
  onGoToConfig?: () => void;
  onToast?: PushToastFn;
}

function hopBadgeClass(status: ConnectivityHopStatus): string {
  if (status === 'pass') return 'badge-running';
  if (status === 'fail') return 'badge-error';
  if (status === 'warn') return 'badge-starting';
  return 'badge-stopped';
}

function hopStatusLabel(status: ConnectivityHopStatus): string {
  if (status === 'pass') return 'PASS';
  if (status === 'fail') return 'FAIL';
  if (status === 'warn') return 'WARN';
  return 'SKIPPED';
}

export function NetworkTab({
  instanceId,
  isRunning,
  onStartServer,
  onGoToConfig,
  onToast,
}: NetworkTabProps) {
  const [guide, setGuide] = useState<InstanceNetworkGuide | null>(null);
  const [firewall, setFirewall] = useState<FirewallStatus | null>(null);
  const [upnp, setUpnp] = useState<UpnpInstanceStatus | null>(null);
  const [report, setReport] = useState<InstanceConnectivityReport | null>(null);
  const [loading, setLoading] = useState(true);
  const [checking, setChecking] = useState(false);
  const [applyingFw, setApplyingFw] = useState(false);
  const [removingFw, setRemovingFw] = useState(false);
  const [busyUpnp, setBusyUpnp] = useState(false);
  const [switchPrivate, setSwitchPrivate] = useState(true);
  const [copiedRouter, setCopiedRouter] = useState(false);
  const [copiedScript, setCopiedScript] = useState(false);
  const [showScript, setShowScript] = useState(false);
  const [fwFeedback, setFwFeedback] = useState<{ kind: 'success' | 'error'; text: string } | null>(null);

  const loadData = useCallback(async () => {
    setLoading(true);
    try {
      const [g, fw, up] = await Promise.all([
        api.getInstanceNetworkGuide(instanceId),
        api.getInstanceFirewall(instanceId),
        api.getInstanceUpnp(instanceId).catch(() => null),
      ]);
      setGuide(g);
      setFirewall(fw);
      setUpnp(up);
      setSwitchPrivate(fw.publicProfileWarning);
    } catch (err) {
      onToast?.('error', err instanceof Error ? err.message : 'Failed to load network information');
    } finally {
      setLoading(false);
    }
  }, [instanceId, onToast]);

  useEffect(() => {
    setReport(null);
    setFwFeedback(null);
    void loadData();
  }, [loadData]);

  const handleRunCheck = async () => {
    setChecking(true);
    try {
      const res = await api.runInstanceNetworkCheck(instanceId);
      setReport(res);
      // Also refresh firewall snapshot so badges stay in sync
      const fw = await api.getInstanceFirewall(instanceId).catch(() => null);
      if (fw) setFirewall(fw);
      if (res.overallStatus === 'pass') {
        onToast?.('success', 'All connectivity checks passed!');
      } else if (res.overallStatus === 'warn') {
        onToast?.('info', 'Connectivity check finished with warnings — review details below.');
      } else {
        onToast?.('error', 'Connectivity check detected a blocker — see the highlighted step below.');
      }
    } catch (err) {
      onToast?.('error', err instanceof Error ? err.message : 'Connectivity check failed');
    } finally {
      setChecking(false);
    }
  };

  const handleApplyFirewall = async (forceSwitchPrivate?: boolean) => {
    setApplyingFw(true);
    setFwFeedback(null);
    try {
      const shouldSwitch = forceSwitchPrivate ?? (Boolean(firewall?.publicProfileWarning) && switchPrivate);
      const res = await api.applyInstanceFirewall(instanceId, shouldSwitch);
      setFirewall(res.status);
      setSwitchPrivate(res.status.publicProfileWarning);
      setFwFeedback({ kind: res.ok ? 'success' : 'error', text: res.message });
      onToast?.(res.ok ? 'success' : 'error', res.message);
    } catch (err) {
      const msg = err instanceof Error ? err.message : 'Failed to apply Windows Firewall rules';
      setFwFeedback({ kind: 'error', text: msg });
      onToast?.('error', msg);
    } finally {
      setApplyingFw(false);
    }
  };

  const handleRemoveFirewall = async () => {
    setRemovingFw(true);
    setFwFeedback(null);
    try {
      const res = await api.removeInstanceFirewall(instanceId);
      const updated = await api.getInstanceFirewall(instanceId).catch(() => null);
      if (updated) setFirewall(updated);
      setFwFeedback({ kind: res.ok ? 'success' : 'error', text: res.message });
      onToast?.(res.ok ? 'success' : 'error', res.message);
    } catch (err) {
      const msg = err instanceof Error ? err.message : 'Failed to remove firewall rules';
      setFwFeedback({ kind: 'error', text: msg });
      onToast?.('error', msg);
    } finally {
      setRemovingFw(false);
    }
  };

  const handleCopyRouterRules = async () => {
    if (!guide) return;
    const ok = await copyTextToClipboard(guide.copyableRouterText);
    if (ok) {
      setCopiedRouter(true);
      onToast?.('success', 'Copied router port-forwarding rules (external ports only).');
      setTimeout(() => setCopiedRouter(false), 1800);
    } else {
      onToast?.('error', 'Clipboard unavailable — select and copy manually.');
    }
  };

  const handleCopyScript = async () => {
    if (!firewall) return;
    const ok = await copyTextToClipboard(firewall.scriptContent);
    if (ok) {
      setCopiedScript(true);
      onToast?.('success', 'Copied least-privilege firewall script.');
      setTimeout(() => setCopiedScript(false), 1800);
    } else {
      onToast?.('error', 'Clipboard unavailable.');
    }
  };

  const handleSetUpnpMode = async (mode: UpnpMode) => {
    setBusyUpnp(true);
    try {
      const updated = await api.setInstanceUpnpMode(instanceId, mode);
      setUpnp(updated);
      onToast?.('success', `UPnP auto-forwarding set to "${mode}".`);
    } catch (err) {
      onToast?.('error', err instanceof Error ? err.message : 'Failed to update UPnP mode');
    } finally {
      setBusyUpnp(false);
    }
  };

  const handleMapUpnp = async () => {
    setBusyUpnp(true);
    try {
      const updated = await api.mapInstanceUpnp(instanceId);
      setUpnp(updated);
      const okCount = updated.lastAttempts.filter((a) => a.ok).length;
      if (okCount === updated.lastAttempts.length && okCount > 0) {
        onToast?.('success', `Mapped ${okCount} router port(s) automatically via UPnP!`);
      } else if (okCount > 0) {
        onToast?.('info', `Mapped ${okCount}/${updated.lastAttempts.length} ports — check warnings below.`);
      } else {
        onToast?.('error', updated.lastAttempts[0]?.message ?? 'Router rejected UPnP port mapping.');
      }
    } catch (err) {
      onToast?.('error', err instanceof Error ? err.message : 'UPnP mapping failed');
    } finally {
      setBusyUpnp(false);
    }
  };

  const handleUnmapUpnp = async () => {
    setBusyUpnp(true);
    try {
      const res = await api.unmapInstanceUpnp(instanceId);
      setUpnp(res.status);
      onToast?.('success', `Removed ${res.removed} UPnP router mapping(s).`);
    } catch (err) {
      onToast?.('error', err instanceof Error ? err.message : 'Failed to remove UPnP mappings');
    } finally {
      setBusyUpnp(false);
    }
  };

  const handleDownloadScript = () => {
    if (!firewall) return;
    const blob = new Blob([firewall.scriptContent], { type: 'text/plain;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = firewall.scriptFilename;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
  };

  if (loading && !guide) {
    return (
      <div className="panel panel-body" style={{ color: 'var(--text-secondary)' }}>
        Loading network guide &amp; firewall status...
      </div>
    );
  }

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 18 }}>
      {/* 1. Hop-by-Hop External Connectivity Troubleshooter (#51) */}
      <section className="panel">
        <div className="panel-header" style={{ flexWrap: 'wrap', gap: 10 }}>
          <h2 style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
            <Activity size={16} /> External Connectivity Troubleshooter
          </h2>
          <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
            {report && (
              <span className={`badge ${hopBadgeClass(report.overallStatus)}`}>
                <span className="badge-dot" />
                {report.overallStatus === 'pass'
                  ? 'EXTERNALLY READY'
                  : report.overallStatus === 'warn'
                    ? 'WARNINGS'
                    : 'BLOCKER DETECTED'}
              </span>
            )}
            <button
              type="button"
              className="btn btn-primary btn-sm"
              disabled={checking}
              onClick={() => void handleRunCheck()}
            >
              <RefreshCw size={13} className={checking ? 'spin' : ''} />
              {checking ? 'Testing 5 Hops...' : 'Run External Connectivity Test'}
            </button>
          </div>
        </div>
        <div className="panel-body">
          <p style={{ margin: '0 0 12px', fontSize: 13, color: 'var(--text-secondary)' }}>
            Tests every layer end-to-end: <strong>Socket Bind → Windows Firewall &amp; Exposure Audit → LAN IP Drift → NAT/CGNAT → External Internet TCP Probe</strong> (probes only your own public IP&apos;s required external TCP ports via{' '}
            <span className="mono">check-host.net</span> on click — never runs in the background).
          </p>

          {!report ? (
            <div className="alert alert-info" style={{ marginBottom: 0 }}>
              {isRunning
                ? 'Click "Run External Connectivity Test" to verify whether remote friends can reach this server from outside your home network.'
                : 'Start the server first, then run the External Connectivity Test to check every hop from local socket binding to external internet reachability.'}
            </div>
          ) : (
            <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
              {report.hops.map((hop) => (
                <div
                  key={hop.id}
                  style={{
                    padding: '10px 14px',
                    borderRadius: 8,
                    border: '1px solid var(--border-subtle)',
                    background: 'var(--bg-elevated)',
                    display: 'flex',
                    flexDirection: 'column',
                    gap: 6,
                  }}
                >
                  <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 10, flexWrap: 'wrap' }}>
                    <strong style={{ fontSize: 13.5, display: 'flex', alignItems: 'center', gap: 8 }}>
                      {hop.status === 'pass' ? (
                        <CheckCircle2 size={15} color="var(--status-online)" />
                      ) : hop.status === 'fail' ? (
                        <XCircle size={15} color="var(--status-error)" />
                      ) : (
                        <AlertTriangle size={15} color="var(--status-warn)" />
                      )}
                      {hop.label}
                    </strong>
                    <span className={`badge ${hopBadgeClass(hop.status)}`}>
                      <span className="badge-dot" />
                      {hopStatusLabel(hop.status)}
                    </span>
                  </div>
                  <div style={{ fontSize: 13, color: 'var(--text-primary)' }}>{hop.summary}</div>
                  {hop.detail && (
                    <div style={{ fontSize: 12, color: 'var(--text-muted)' }}>{hop.detail}</div>
                  )}
                  {hop.fixHint && (
                    <div
                      style={{
                        fontSize: 12.5,
                        color: 'var(--text-secondary)',
                        paddingTop: 4,
                        display: 'flex',
                        alignItems: 'center',
                        justifyContent: 'space-between',
                        gap: 10,
                        flexWrap: 'wrap',
                      }}
                    >
                      <span>
                        <strong>Fix:</strong> {hop.fixHint}
                      </span>
                      {hop.actionId === 'open_firewall' && firewall?.supported && (
                        <button
                          type="button"
                          className="btn btn-primary btn-sm"
                          disabled={applyingFw}
                          onClick={() => void handleApplyFirewall(false)}
                        >
                          <ShieldCheck size={13} /> Open Required Ports (Private)
                        </button>
                      )}
                      {hop.actionId === 'switch_private' && firewall?.supported && (
                        <button
                          type="button"
                          className="btn btn-primary btn-sm"
                          disabled={applyingFw}
                          onClick={() => void handleApplyFirewall(true)}
                        >
                          <ShieldCheck size={13} /> Switch to Private &amp; Apply Rules
                        </button>
                      )}
                      {hop.actionId === 'start_server' && onStartServer && (
                        <button type="button" className="btn btn-primary btn-sm" onClick={onStartServer}>
                          Start Server
                        </button>
                      )}
                    </div>
                  )}
                </div>
              ))}

              {report.wanProbes.length > 0 && (
                <div style={{ marginTop: 6 }}>
                  <div style={{ fontSize: 12, fontWeight: 600, color: 'var(--text-muted)', marginBottom: 6, textTransform: 'uppercase' }}>
                    External Port Probe Results ({report.publicIp})
                  </div>
                  <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
                    {report.wanProbes.map((probe) => (
                      <div
                        key={`${probe.key}-${probe.port}`}
                        style={{
                          display: 'flex',
                          alignItems: 'center',
                          justifyContent: 'space-between',
                          gap: 10,
                          flexWrap: 'wrap',
                          padding: '8px 12px',
                          borderRadius: 6,
                          border: '1px solid var(--border-subtle)',
                          fontSize: 12.5,
                        }}
                      >
                        <div>
                          <strong className="mono">
                            {probe.port}/{probe.protocol.toUpperCase()}
                          </strong>{' '}
                          <span style={{ color: 'var(--text-secondary)' }}>— {probe.label}</span>
                          <div style={{ fontSize: 12, color: 'var(--text-muted)', marginTop: 2 }}>{probe.detail}</div>
                        </div>
                        <span
                          className={`badge ${
                            probe.status === 'open'
                              ? 'badge-running'
                              : probe.status === 'closed' || probe.status === 'timeout'
                                ? 'badge-error'
                                : 'badge-starting'
                          }`}
                        >
                          <span className="badge-dot" />
                          {probe.status === 'open'
                            ? 'OPEN'
                            : probe.status === 'timeout'
                              ? 'TIMED OUT'
                              : probe.status === 'closed'
                                ? 'CLOSED'
                                : probe.status === 'udp_unverifiable'
                                  ? 'UDP (MANUAL)'
                                  : 'UNAVAILABLE'}
                        </span>
                      </div>
                    ))}
                  </div>
                </div>
              )}
            </div>
          )}
        </div>
      </section>

      {/* 2. Least-Privilege Windows Firewall Manager (#50) */}
      {firewall && (
        <section className="panel">
          <div className="panel-header" style={{ flexWrap: 'wrap', gap: 10 }}>
            <h2 style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
              <Shield size={16} /> Host Firewall (Least-Privilege Private Profile)
            </h2>
            <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
              {firewall.supported && (
                <span className={`badge ${firewall.publicProfileWarning ? 'badge-error' : 'badge-running'}`}>
                  <span className="badge-dot" />
                  Profile: {firewall.networkProfile}
                  {firewall.profileName ? ` (${firewall.profileName})` : ''}
                </span>
              )}
              <button type="button" className="btn btn-sm" onClick={() => void loadData()}>
                <RefreshCw size={12} /> Refresh
              </button>
            </div>
          </div>
          <div className="panel-body">
            <div className="alert alert-info" style={{ marginBottom: 14 }}>
              <Lock size={14} style={{ verticalAlign: 'text-bottom', marginRight: 6 }} />
              <strong>Security Lockdown:</strong> ServerForge only opens exact required external ports on your{' '}
              <strong>Private</strong> network profile — never <code>Public</code>, never port ranges, and never internal-only ports (RCON / REST / Dashboard).
            </div>

            {firewall.publicProfileWarning && (
              <div className="alert alert-error" style={{ marginBottom: 14 }}>
                <ShieldAlert size={14} style={{ verticalAlign: 'text-bottom', marginRight: 6 }} />
                <strong>Public Network Detected:</strong> Your active Windows adapter (
                <span className="mono">{firewall.profileName ?? 'Active Network'}</span>) is set to{' '}
                <strong>Public</strong>, which blocks Private-profile game rules. Switch it to{' '}
                <strong>Private</strong> so only your home network allows these game ports.
              </div>
            )}

            {firewall.appBlockWarnings.map((warn, idx) => (
              <div key={`blk-${idx}`} className="alert alert-error" style={{ marginBottom: 12 }}>
                <ShieldAlert size={14} style={{ verticalAlign: 'text-bottom', marginRight: 6 }} />
                {warn}
              </div>
            ))}

            {firewall.internalExposureWarnings.map((warn, idx) => (
              <div key={`int-${idx}`} className="alert alert-error" style={{ marginBottom: 12 }}>
                <AlertTriangle size={14} style={{ verticalAlign: 'text-bottom', marginRight: 6 }} />
                {warn}
              </div>
            ))}

            {fwFeedback && (
              <div className={`alert ${fwFeedback.kind === 'success' ? 'alert-success' : 'alert-error'}`} style={{ marginBottom: 12 }}>
                {fwFeedback.text}
              </div>
            )}

            <div className="table-scroll" style={{ marginBottom: 14 }}>
              <table className="data-table">
              <thead>
                <tr>
                  <th>Port</th>
                  <th>Protocol</th>
                  <th>Exposure</th>
                  <th>Firewall Status</th>
                </tr>
              </thead>
              <tbody>
                {firewall.ports.map((p) => {
                  const needsTcp = !p.internalOnly && (p.protocol === 'tcp' || p.protocol === 'both');
                  const needsUdp = !p.internalOnly && (p.protocol === 'udp' || p.protocol === 'both');
                  const okExternal =
                    !p.internalOnly &&
                    !p.blockedByAppRule &&
                    (!needsTcp || p.tcpAllowed) &&
                    (!needsUdp || p.udpAllowed);
                  return (
                    <tr key={`fw-${p.key}`}>
                      <td>
                        <strong className="mono">{p.port}</strong>{' '}
                        <span style={{ color: 'var(--text-secondary)', fontSize: 12.5 }}>{p.label}</span>
                      </td>
                      <td className="mono">{p.protocol.toUpperCase()}</td>
                      <td>
                        {p.internalOnly ? (
                          <span className="badge badge-stopped">
                            <Lock size={11} /> Local Only
                          </span>
                        ) : (
                          <span className="badge badge-starting">Required External</span>
                        )}
                      </td>
                      <td>
                        {!firewall.supported ? (
                          <span style={{ color: 'var(--text-muted)', fontSize: 12 }}>Use UFW commands below</span>
                        ) : p.internalOnly ? (
                          p.exposedInternalWarning ? (
                            <span className="badge badge-error">EXPOSED — LOCK DOWN</span>
                          ) : (
                            <span className="badge badge-running">Locked Locally</span>
                          )
                        ) : p.blockedByAppRule ? (
                          <span className="badge badge-error">BLOCKED BY APP RULE</span>
                        ) : okExternal ? (
                          <span className="badge badge-running">
                            Allowed ({p.ruleNames.slice(0, 2).join(', ') || 'Active'})
                          </span>
                        ) : (
                          <span className="badge badge-error">
                            Missing{' '}
                            {[needsTcp && !p.tcpAllowed ? 'TCP' : null, needsUdp && !p.udpAllowed ? 'UDP' : null]
                              .filter(Boolean)
                              .join(' + ')}
                          </span>
                        )}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
              </table>
            </div>

            {firewall.supported && firewall.publicProfileWarning && (
              <label className="checkbox-row" style={{ marginBottom: 12 }}>
                <input
                  type="checkbox"
                  checked={switchPrivate}
                  onChange={(e) => setSwitchPrivate(e.target.checked)}
                />
                <span>
                  Also switch <strong className="mono">{firewall.profileName ?? 'active network'}</strong> from{' '}
                  <strong>Public</strong> to <strong>Private</strong> profile when applying rules
                </span>
              </label>
            )}

            <div className="btn-row" style={{ flexWrap: 'wrap', gap: 8 }}>
              {firewall.supported && (
                <>
                  <button
                    type="button"
                    className="btn btn-primary btn-sm"
                    disabled={applyingFw || removingFw}
                    onClick={() => void handleApplyFirewall()}
                  >
                    <ShieldCheck size={14} />
                    {applyingFw
                      ? 'Applying...'
                      : firewall.isAdmin
                        ? 'Open Required Ports (Private Profile)'
                        : 'Open Required Ports (Admin UAC)'}
                  </button>
                  <button
                    type="button"
                    className="btn btn-sm"
                    disabled={applyingFw || removingFw}
                    onClick={() => void handleRemoveFirewall()}
                    title="Immediately revoke all ServerForge-managed firewall rules for this server"
                  >
                    <ShieldOff size={14} /> {removingFw ? 'Locking Down...' : 'Lock Down (Remove Rules)'}
                  </button>
                </>
              )}
              <button type="button" className="btn btn-sm" onClick={() => void handleCopyScript()}>
                {copiedScript ? <Check size={13} color="var(--status-online)" /> : <Copy size={13} />}
                Copy {firewall.supported ? 'PowerShell Script' : 'UFW Commands'}
              </button>
              <button type="button" className="btn btn-sm" onClick={handleDownloadScript}>
                <Download size={13} /> Download {firewall.supported ? '.ps1' : '.sh'}
              </button>
              <button type="button" className="btn btn-sm" onClick={() => setShowScript((v) => !v)}>
                {showScript ? 'Hide Script' : 'Preview Script'}
              </button>
            </div>

            {showScript && (
              <pre
                className="mono"
                style={{
                  marginTop: 12,
                  padding: 12,
                  borderRadius: 8,
                  background: 'var(--bg-elevated)',
                  border: '1px solid var(--border-subtle)',
                  fontSize: 12,
                  overflowX: 'auto',
                  whiteSpace: 'pre',
                }}
              >
                {firewall.scriptContent}
              </pre>
            )}
          </div>
        </section>
      )}

      {/* 3. Opt-In Automatic Router Port Forwarding (UPnP / NAT-PMP) (#52) */}
      {upnp && (
        <section className="panel">
          <div className="panel-header" style={{ flexWrap: 'wrap', gap: 10 }}>
            <h2 style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
              <Router size={16} /> Automatic Router Port Forwarding (UPnP / NAT-PMP — Opt-In)
            </h2>
            <span
              className={`badge ${
                upnp.activeMappings.length > 0
                  ? 'badge-running'
                  : upnp.effectiveEnabled
                    ? 'badge-starting'
                    : 'badge-stopped'
              }`}
            >
              <span className="badge-dot" />
              {upnp.activeMappings.length > 0
                ? `${upnp.activeMappings.length} ACTIVE LEASE(S)`
                : upnp.effectiveEnabled
                  ? 'ENABLED (MAPS ON START)'
                  : 'OFF (MANUAL FORWARDING)'}
            </span>
          </div>
          <div className="panel-body">
            <p style={{ margin: '0 0 12px', fontSize: 13, color: 'var(--text-secondary)' }}>
              When enabled, ServerForge asks your router via <strong>UPnP IGD / NAT-PMP</strong> to open{' '}
              <strong>only required external game ports</strong> while this server is running, renews leases automatically, and deletes them immediately when the server stops. Internal-only ports (RCON / REST) are never mapped.
            </p>

            <div className="form-grid" style={{ marginBottom: 14 }}>
              <div className="field">
                <label htmlFor="inst-upnp-mode">Per-Server UPnP Setting</label>
                <select
                  id="inst-upnp-mode"
                  className="select"
                  disabled={busyUpnp}
                  value={upnp.instanceMode}
                  onChange={(e) => void handleSetUpnpMode(e.target.value as UpnpMode)}
                >
                  <option value="inherit">
                    Inherit Global Setting ({upnp.globalEnabled ? 'Currently ON' : 'Currently OFF'})
                  </option>
                  <option value="enabled">Enabled for This Server (Auto-map on Start)</option>
                  <option value="disabled">Disabled (Manual Router Rules Only)</option>
                </select>
              </div>
              <div className="field" style={{ justifyContent: 'flex-end' }}>
                <div className="btn-row" style={{ flexWrap: 'wrap', gap: 8 }}>
                  <button
                    type="button"
                    className="btn btn-primary btn-sm"
                    disabled={busyUpnp}
                    onClick={() => void handleMapUpnp()}
                  >
                    <Router size={13} /> {busyUpnp ? 'Contacting Router...' : 'Map Ports Now via UPnP'}
                  </button>
                  <button
                    type="button"
                    className="btn btn-sm"
                    disabled={busyUpnp || upnp.activeMappings.length === 0}
                    onClick={() => void handleUnmapUpnp()}
                  >
                    <ShieldOff size={13} /> Remove UPnP Mappings
                  </button>
                </div>
              </div>
            </div>

            {upnp.lastAttempts.length > 0 && (
              <div style={{ display: 'flex', flexDirection: 'column', gap: 6, marginBottom: 12 }}>
                {upnp.lastAttempts.map((a, idx) => (
                  <div
                    key={`upnp-att-${idx}`}
                    className={`alert ${a.ok ? 'alert-success' : 'alert-error'}`}
                    style={{ marginBottom: 0, padding: '8px 12px', fontSize: 12.5 }}
                  >
                    <strong className="mono">
                      {a.port}/{a.protocol}
                    </strong>{' '}
                    ({a.label}): {a.message}
                  </div>
                ))}
              </div>
            )}

            {upnp.activeMappings.length > 0 && (
              <div className="table-scroll">
                <table className="data-table">
                <thead>
                  <tr>
                    <th>Port</th>
                    <th>Protocol</th>
                    <th>Target LAN IP</th>
                    <th>Lease</th>
                    <th>Router Protocol</th>
                  </tr>
                </thead>
                <tbody>
                  {upnp.activeMappings.map((m) => (
                    <tr key={m.id}>
                      <td className="mono">{m.externalPort}</td>
                      <td className="mono">{m.protocol}</td>
                      <td className="mono">{m.internalClient}</td>
                      <td>{m.leaseDurationSeconds === 0 ? 'Permanent (removed on stop)' : `${m.leaseDurationSeconds}s (auto-renewed)`}</td>
                      <td className="mono">{m.protocolUsed}</td>
                    </tr>
                  ))}
                </tbody>
                </table>
              </div>
            )}
          </div>
        </section>
      )}

      {/* 4. Router Port Forwarding Guide (#49) */}
      {guide && (
        <section className="panel">
          <div className="panel-header" style={{ flexWrap: 'wrap', gap: 10 }}>
            <h2 style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
              <Globe size={16} /> Router Port Forwarding Guide
            </h2>
            <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
              {onGoToConfig && (
                <button type="button" className="btn btn-sm" onClick={onGoToConfig}>
                  Change Ports
                </button>
              )}
              <button type="button" className="btn btn-primary btn-sm" onClick={() => void handleCopyRouterRules()}>
                {copiedRouter ? <Check size={13} /> : <Copy size={13} />}
                Copy Router Rules
              </button>
            </div>
          </div>
          <div className="panel-body">
            <div className="settings-summary-strip" style={{ marginBottom: 14 }}>
              <div>
                <span className="settings-summary-label">Target Server PC LAN IP</span>
                <span className="mono">{guide.lanIp ?? 'Not detected'}</span>
              </div>
              <div>
                <span className="settings-summary-label">Public Join Host</span>
                <span className="mono">{guide.effectiveHost}</span>
              </div>
              <div>
                <span className="settings-summary-label">Detected Public IP</span>
                <span className="mono">{guide.publicIp ?? 'Not detected'}</span>
              </div>
            </div>

            <div className="table-scroll" style={{ marginBottom: 14 }}>
              <table className="data-table">
              <thead>
                <tr>
                  <th>Purpose</th>
                  <th>External Port</th>
                  <th>Internal Port</th>
                  <th>Protocol</th>
                  <th>Target LAN IP</th>
                  <th>Exposure</th>
                </tr>
              </thead>
              <tbody>
                {guide.ports.map((p) => (
                  <tr key={`guide-${p.key}`}>
                    <td>
                      <strong>{p.label}</strong>
                      {p.note && (
                        <div style={{ fontSize: 11.5, color: 'var(--text-muted)', marginTop: 2 }}>{p.note}</div>
                      )}
                    </td>
                    <td className="mono">{p.internalOnly ? '—' : p.port}</td>
                    <td className="mono">{p.port}</td>
                    <td className="mono">
                      {p.protocol === 'both' ? 'TCP + UDP (split recommended)' : p.protocol.toUpperCase()}
                    </td>
                    <td className="mono">{p.internalOnly ? '127.0.0.1 only' : guide.lanIp ?? 'This PC'}</td>
                    <td>
                      {p.internalOnly ? (
                        <span className="badge badge-stopped">
                          <Lock size={11} /> Local Only — Do NOT Forward
                        </span>
                      ) : p.exposure === 'optional_query' ? (
                        <span className="badge badge-starting">Optional Query</span>
                      ) : (
                        <span className="badge badge-running">Required for Online</span>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
              </table>
            </div>

            <div style={{ fontSize: 12.5, color: 'var(--text-secondary)' }}>
              <strong style={{ display: 'block', marginBottom: 6, color: 'var(--text-primary)' }}>
                Router &amp; Security Notes
              </strong>
              <ul style={{ margin: 0, paddingLeft: 18, display: 'flex', flexDirection: 'column', gap: 6 }}>
                {guide.routerNotes.map((note, idx) => (
                  <li key={`note-${idx}`}>{note}</li>
                ))}
              </ul>
            </div>
          </div>
        </section>
      )}
    </div>
  );
}
