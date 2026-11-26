import React, { useState } from 'react';
import { Activity, AlertTriangle, Bug, Check, Copy, RefreshCw, Trash2 } from 'lucide-react';
import type { AppDiagnosticEvent, AuditLogEntry, DiagnosticLevel } from '@serverforge/shared';
import { api } from '../../api';
import { copyTextToClipboard } from '../../utils/clipboard';
import type { ConfirmDialogOptions } from '../ConfirmModal';
import type { PushToastFn } from '../ToastStack';

interface DiagnosticsActivityTabProps {
  diagLogs: AppDiagnosticEvent[];
  diagFilter: 'all' | DiagnosticLevel;
  loadingDiag: boolean;
  auditLogs: AuditLogEntry[];
  onFilterChange: (level: 'all' | DiagnosticLevel) => void;
  onRefreshDiagnostics: () => void;
  onClearedDiagnostics: () => void;
  onConfirm: (opts: ConfirmDialogOptions) => Promise<boolean>;
  onToast: PushToastFn;
}

export function DiagnosticsActivityTab({
  diagLogs,
  diagFilter,
  loadingDiag,
  auditLogs,
  onFilterChange,
  onRefreshDiagnostics,
  onClearedDiagnostics,
  onConfirm,
  onToast,
}: DiagnosticsActivityTabProps) {
  const [copiedDiagReport, setCopiedDiagReport] = useState(false);
  const [copiedDiagId, setCopiedDiagId] = useState<string | null>(null);

  const handleCopySystemReport = async () => {
    try {
      const report = await api.getSystemDiagnosticsReport();
      const ok = await copyTextToClipboard(report.markdown);
      if (ok) {
        setCopiedDiagReport(true);
        onToast('success', 'System diagnostics report copied to clipboard.');
        setTimeout(() => setCopiedDiagReport(false), 2000);
      }
    } catch (err) {
      onToast('error', err instanceof Error ? err.message : 'Failed to build diagnostics report');
    }
  };

  const handleClearDiagnostics = async () => {
    const confirmed = await onConfirm({
      title: 'Clear Diagnostic Logs?',
      message: 'Remove all captured backend diagnostic events from the in-memory log buffer?',
      confirmLabel: 'Clear Logs',
      tone: 'danger',
    });
    if (!confirmed) return;

    try {
      await api.clearDiagnosticLogs();
      onClearedDiagnostics();
      onToast('info', 'Diagnostic logs cleared.');
    } catch (err) {
      onToast('error', err instanceof Error ? err.message : 'Clear failed');
    }
  };

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 18 }}>
      <section className="panel">
        <div className="panel-header" style={{ flexWrap: 'wrap', gap: 10 }}>
          <h2 style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
            <Bug size={16} /> Diagnostics &amp; App Logs
          </h2>
          <div className="btn-row">
            <button
              type="button"
              className={`btn btn-sm ${diagFilter === 'all' ? 'btn-primary' : ''}`}
              onClick={() => onFilterChange('all')}
            >
              All ({diagLogs.length})
            </button>
            <button
              type="button"
              className={`btn btn-sm ${diagFilter === 'error' ? 'btn-danger' : ''}`}
              onClick={() => onFilterChange('error')}
            >
              Errors
            </button>
            <button
              type="button"
              className={`btn btn-sm ${diagFilter === 'warn' ? 'btn-primary' : ''}`}
              onClick={() => onFilterChange('warn')}
            >
              Warnings
            </button>
            <button
              type="button"
              className="btn btn-sm"
              disabled={loadingDiag}
              onClick={onRefreshDiagnostics}
            >
              <RefreshCw size={13} className={loadingDiag ? 'spin' : ''} /> Refresh
            </button>
            <button
              type="button"
              className="btn btn-sm btn-primary"
              onClick={() => void handleCopySystemReport()}
            >
              {copiedDiagReport ? <Check size={13} /> : <Copy size={13} />}
              {copiedDiagReport ? 'Copied Report!' : 'Copy System Diagnostics'}
            </button>
            <button
              type="button"
              className="btn btn-sm btn-ghost"
              disabled={diagLogs.length === 0}
              onClick={() => void handleClearDiagnostics()}
            >
              <Trash2 size={13} /> Clear
            </button>
          </div>
        </div>
        <div className="panel-body" style={{ padding: 0, maxHeight: 360, overflowY: 'auto' }}>
          {diagLogs.length === 0 ? (
            <div style={{ padding: 18, color: 'var(--text-muted)', fontSize: 13 }}>
              No backend errors or warnings captured. API 4xx/5xx failures, crash watchdog alerts, and backup errors
              appear here automatically with secrets redacted.
            </div>
          ) : (
            <table className="data-table">
              <thead>
                <tr>
                  <th>Time</th>
                  <th>Level</th>
                  <th>Source</th>
                  <th>Details</th>
                  <th style={{ width: 64 }} />
                </tr>
              </thead>
              <tbody>
                {diagLogs.map((ev) => (
                  <tr key={ev.id}>
                    <td className="mono tabular" style={{ whiteSpace: 'nowrap', fontSize: 11.5 }}>
                      {new Date(ev.timestamp).toLocaleTimeString()}
                    </td>
                    <td>
                      <span
                        className={`badge ${
                          ev.level === 'error'
                            ? 'badge-error'
                            : ev.level === 'warn'
                              ? 'badge-starting'
                              : 'badge-stopped'
                        }`}
                      >
                        {ev.level === 'error' && <AlertTriangle size={10} />}
                        {ev.level.toUpperCase()}
                      </span>
                    </td>
                    <td className="mono" style={{ fontSize: 12 }}>
                      {ev.source}
                      {ev.statusCode ? ` (${ev.statusCode})` : ''}
                    </td>
                    <td style={{ fontSize: 12.5 }}>
                      <div style={{ color: 'var(--text-primary)', fontWeight: 500 }}>{ev.message}</div>
                      {(ev.method || ev.path) && (
                        <div className="mono" style={{ fontSize: 11, color: 'var(--text-muted)' }}>
                          {ev.method} {ev.path}
                        </div>
                      )}
                    </td>
                    <td>
                      <button
                        type="button"
                        className="btn btn-ghost btn-sm"
                        title="Copy error entry"
                        onClick={async () => {
                          const text =
                            `[${ev.timestamp}] [${ev.level.toUpperCase()}] [${ev.source}] ${ev.method ?? ''} ${ev.path ?? ''} ${ev.statusCode ?? ''} ${ev.message}${ev.details ? `\n${ev.details}` : ''}`.trim();
                          const ok = await copyTextToClipboard(text);
                          if (ok) {
                            setCopiedDiagId(ev.id);
                            setTimeout(() => setCopiedDiagId((cur) => (cur === ev.id ? null : cur)), 1800);
                          }
                        }}
                      >
                        {copiedDiagId === ev.id ? <Check size={12} color="var(--status-online)" /> : <Copy size={12} />}
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>
      </section>

      <section className="panel">
        <div className="panel-header">
          <h2 style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
            <Activity size={16} /> Recent Activity ({auditLogs.length})
          </h2>
        </div>
        <div className="panel-body" style={{ padding: 0, maxHeight: 320, overflowY: 'auto' }}>
          {auditLogs.length === 0 ? (
            <div style={{ padding: 18, color: 'var(--text-muted)' }}>No activity logged yet.</div>
          ) : (
            <table className="data-table">
              <tbody>
                {auditLogs.map((log) => (
                  <tr key={log.id}>
                    <td>
                      <div style={{ color: 'var(--text-primary)', fontWeight: 500 }}>{log.details || log.action}</div>
                      <div style={{ fontSize: 11.5, color: 'var(--text-muted)' }}>
                        {log.actor} ({log.source}) • {new Date(log.timestamp).toLocaleString()}
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>
      </section>
    </div>
  );
}
