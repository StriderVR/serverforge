import React, { useEffect, useState } from 'react';
import { Bug, Check, Copy, ExternalLink, Send, Sparkles, X } from 'lucide-react';
import type {
  BugReportCategory,
  BugReportPreviewResult,
  BugReportSubmitResult,
} from '@serverforge/shared';
import { api, type InstanceWithJoin } from '../api';
import { copyTextToClipboard } from '../utils/clipboard';
import type { PushToastFn } from './ToastStack';

interface BugReportModalProps {
  open: boolean;
  instances: InstanceWithJoin[];
  initialInstanceId?: string | null;
  initialTitle?: string;
  initialDescription?: string;
  onClose: () => void;
  onToast: PushToastFn;
}

const CATEGORY_OPTIONS: Array<{ value: BugReportCategory; label: string }> = [
  { value: 'networking', label: 'Networking / Port Forwarding / WAN Join' },
  { value: 'game_template', label: 'Game Template / SteamCMD / Mods' },
  { value: 'updater', label: 'Self-Updater / Version Selector' },
  { value: 'web_ui', label: 'Web Dashboard UI / UX' },
  { value: 'discord', label: 'Discord Bot / Slash Commands' },
  { value: 'security', label: 'Security / Auth / 2FA / HTTPS' },
  { value: 'other', label: 'Other / General Backend' },
];

export function BugReportModal({
  open,
  instances,
  initialInstanceId = null,
  initialTitle = '',
  initialDescription = '',
  onClose,
  onToast,
}: BugReportModalProps) {
  const [title, setTitle] = useState(initialTitle);
  const [category, setCategory] = useState<BugReportCategory>('networking');
  const [instanceId, setInstanceId] = useState<string>(initialInstanceId ?? '');
  const [description, setDescription] = useState(initialDescription);
  const [stepsToReproduce, setStepsToReproduce] = useState('');
  const [includeDiagnostics, setIncludeDiagnostics] = useState(true);

  const [preview, setPreview] = useState<BugReportPreviewResult | null>(null);
  const [loadingPreview, setLoadingPreview] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [submitted, setSubmitted] = useState<BugReportSubmitResult | null>(null);
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    if (!open) return;
    setTitle(initialTitle);
    setDescription(initialDescription);
    setInstanceId(initialInstanceId ?? '');
    setPreview(null);
    setSubmitted(null);
  }, [open, initialInstanceId, initialTitle, initialDescription]);

  useEffect(() => {
    if (!open) return;
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.preventDefault();
        onClose();
      }
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [open, onClose]);

  if (!open) return null;

  const buildPayload = () => ({
    title: title.trim(),
    category,
    description: description.trim(),
    stepsToReproduce: stepsToReproduce.trim() || undefined,
    instanceId: instanceId || null,
    includeDiagnostics,
  });

  const handleGeneratePreview = async (e?: React.FormEvent) => {
    e?.preventDefault();
    if (!title.trim()) {
      onToast('error', 'Enter a short bug title first.');
      return;
    }
    setLoadingPreview(true);
    setSubmitted(null);
    try {
      const res = await api.previewBugReport(buildPayload());
      setPreview(res);
    } catch (err) {
      onToast('error', err instanceof Error ? err.message : 'Failed to generate bug report preview');
    } finally {
      setLoadingPreview(false);
    }
  };

  const handleCopyMarkdown = async () => {
    if (!preview) return;
    const ok = await copyTextToClipboard(preview.markdown);
    if (ok) {
      setCopied(true);
      onToast('success', 'Full secret-redacted bug report copied to clipboard.');
      setTimeout(() => setCopied(false), 2000);
    }
  };

  const handleSubmitDirect = async () => {
    if (!title.trim()) {
      onToast('error', 'Enter a short bug title first.');
      return;
    }
    setSubmitting(true);
    try {
      const res = await api.submitBugReport(buildPayload());
      setSubmitted(res);
      onToast('success', `GitHub Issue #${res.issueNumber} created!`);
    } catch (err) {
      onToast('error', err instanceof Error ? err.message : 'Failed to submit bug report');
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <div
      className="modal-backdrop"
      role="dialog"
      aria-modal="true"
      aria-labelledby="bug-reporter-title"
      onClick={onClose}
    >
      <div
        className="modal-card"
        style={{ maxWidth: 740, width: '94vw', maxHeight: '88vh', display: 'flex', flexDirection: 'column' }}
        onClick={(e) => e.stopPropagation()}
      >
        <div className="modal-header" style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
            <Bug size={18} />
            <h2 id="bug-reporter-title" style={{ margin: 0, fontSize: 16 }}>
              In-Built Bug Reporter
            </h2>
          </div>
          <button type="button" className="btn btn-ghost btn-sm" onClick={onClose} aria-label="Close">
            <X size={16} />
          </button>
        </div>

        <div className="modal-body" style={{ overflowY: 'auto', display: 'flex', flexDirection: 'column', gap: 12 }}>
          <p className="muted" style={{ margin: 0, fontSize: 12.5 }}>
            Describe the issue below. ServerForge automatically collects your version, OS, and recent logs while stripping all tokens, API keys, and passwords (<code>[REDACTED]</code>).
          </p>

          {submitted && (
            <div className="alert alert-success" style={{ marginBottom: 0, display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 10, flexWrap: 'wrap' }}>
              <span>
                Submitted <strong>Issue #{submitted.issueNumber}</strong> directly to GitHub!
              </span>
              <a
                href={submitted.issueUrl}
                target="_blank"
                rel="noreferrer"
                className="btn btn-sm btn-primary"
                style={{ textDecoration: 'none' }}
              >
                <ExternalLink size={13} /> View Issue #{submitted.issueNumber}
              </a>
            </div>
          )}

          <form onSubmit={handleGeneratePreview} style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(220px, 1fr))', gap: 10 }}>
              <div className="field">
                <label htmlFor="bug-title">Bug Summary</label>
                <input
                  id="bug-title"
                  className="input"
                  value={title}
                  onChange={(e) => {
                    setTitle(e.target.value);
                    setPreview(null);
                  }}
                  placeholder="e.g., Friend cannot join Satisfactory after port edit"
                  required
                />
              </div>

              <div className="field">
                <label htmlFor="bug-category">Area / Category</label>
                <select
                  id="bug-category"
                  className="input"
                  value={category}
                  onChange={(e) => {
                    setCategory(e.target.value as BugReportCategory);
                    setPreview(null);
                  }}
                >
                  {CATEGORY_OPTIONS.map((opt) => (
                    <option key={opt.value} value={opt.value}>
                      {opt.label}
                    </option>
                  ))}
                </select>
              </div>
            </div>

            <div className="field">
              <label htmlFor="bug-instance">Affected Server (optional)</label>
              <select
                id="bug-instance"
                className="input"
                value={instanceId}
                onChange={(e) => {
                  setInstanceId(e.target.value);
                  setPreview(null);
                }}
              >
                <option value="">None / General ServerForge issue</option>
                {instances.map((inst) => (
                  <option key={inst.id} value={inst.id}>
                    {inst.name} ({inst.gameId} · {inst.status})
                  </option>
                ))}
              </select>
            </div>

            <div className="field">
              <label htmlFor="bug-desc">What happened?</label>
              <textarea
                id="bug-desc"
                className="input"
                rows={3}
                value={description}
                onChange={(e) => {
                  setDescription(e.target.value);
                  setPreview(null);
                }}
                placeholder="Describe what went wrong and what you expected to happen..."
              />
            </div>

            <div className="field">
              <label htmlFor="bug-steps">Steps to reproduce (optional)</label>
              <textarea
                id="bug-steps"
                className="input"
                rows={2}
                value={stepsToReproduce}
                onChange={(e) => {
                  setStepsToReproduce(e.target.value);
                  setPreview(null);
                }}
                placeholder="1. Open Network tab  2. Click Apply Firewall Rules..."
              />
            </div>

            <label className="checkbox-row" style={{ padding: 0 }}>
              <input
                type="checkbox"
                checked={includeDiagnostics}
                onChange={(e) => {
                  setIncludeDiagnostics(e.target.checked);
                  setPreview(null);
                }}
              />
              <span>Include auto-redacted system &amp; server diagnostic logs</span>
            </label>

            <div className="btn-row" style={{ marginTop: 4 }}>
              <button type="submit" className="btn btn-primary" disabled={loadingPreview || !title.trim()}>
                <Sparkles size={14} /> {loadingPreview ? 'Building Redacted Report...' : 'Build Redacted Report'}
              </button>
            </div>
          </form>

          {preview && (
            <div style={{ display: 'flex', flexDirection: 'column', gap: 10, paddingTop: 10, borderTop: '1px solid var(--border-subtle)' }}>
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', flexWrap: 'wrap', gap: 8 }}>
                <div style={{ fontWeight: 600, fontSize: 13 }}>
                  Preview ({preview.labels.join(', ')})
                </div>
                <div className="btn-row">
                  <button type="button" className="btn btn-sm" onClick={() => void handleCopyMarkdown()}>
                    {copied ? <Check size={13} /> : <Copy size={13} />}
                    {copied ? 'Copied!' : 'Copy Full Report'}
                  </button>
                  <a
                    href={preview.githubNewIssueUrl}
                    target="_blank"
                    rel="noreferrer"
                    className="btn btn-sm btn-primary"
                    style={{ textDecoration: 'none' }}
                  >
                    <ExternalLink size={13} /> Open Pre-Filled GitHub Issue
                  </a>
                  {preview.hasDirectToken && (
                    <button
                      type="button"
                      className="btn btn-sm btn-primary"
                      disabled={submitting}
                      onClick={() => void handleSubmitDirect()}
                    >
                      <Send size={13} /> {submitting ? 'Submitting...' : 'Submit Directly to GitHub'}
                    </button>
                  )}
                </div>
              </div>

              {preview.truncatedForUrl && (
                <div className="alert alert-info" style={{ marginBottom: 0, fontSize: 12 }}>
                  Diagnostic bundle is large for a browser URL — click <strong>Copy Full Report</strong> first so you can paste the complete logs into the GitHub issue box (or configure an optional GitHub PAT in Settings -&gt; Diagnostics for full direct submission).
                </div>
              )}

              <pre
                style={{
                  margin: 0,
                  padding: 10,
                  borderRadius: 'var(--radius-sm)',
                  background: 'var(--bg-terminal)',
                  border: '1px solid var(--border-subtle)',
                  maxHeight: 210,
                  overflowY: 'auto',
                  fontSize: 11.5,
                  whiteSpace: 'pre-wrap',
                }}
              >
                {preview.markdown}
              </pre>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
