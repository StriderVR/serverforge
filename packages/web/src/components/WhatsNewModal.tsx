import React, { useEffect, useState } from 'react';
import { Sparkles, X } from 'lucide-react';
import {
  getReleaseNotesForVersion,
  normalizeReleaseVersion,
  RELEASE_NOTES,
  type ReleaseNoteEntry,
} from '@serverforge/shared';

interface WhatsNewModalProps {
  open: boolean;
  currentVersion: string;
  onClose: () => void;
}

export function WhatsNewModal({ open, currentVersion, onClose }: WhatsNewModalProps) {
  const normalizedCurrent = normalizeReleaseVersion(currentVersion);
  const initialEntry: ReleaseNoteEntry =
    getReleaseNotesForVersion(normalizedCurrent) ?? RELEASE_NOTES[0];
  const [selectedVersion, setSelectedVersion] = useState<string>(initialEntry.version);

  useEffect(() => {
    if (!open) return;
    const match = getReleaseNotesForVersion(normalizedCurrent) ?? RELEASE_NOTES[0];
    setSelectedVersion(match.version);
  }, [open, normalizedCurrent]);

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

  const entry =
    RELEASE_NOTES.find((r) => r.version === selectedVersion) ?? initialEntry;

  const allSections: Array<{
    key: 'added' | 'changed' | 'removed';
    label: string;
    items: string[];
  }> = [
    { key: 'added', label: 'Added', items: entry.added ?? [] },
    { key: 'changed', label: 'Changed', items: entry.changed ?? [] },
    { key: 'removed', label: 'Removed', items: entry.removed ?? [] },
  ];
  const sections = allSections.filter((sec) => sec.items.length > 0);

  return (
    <div
      className="modal-backdrop"
      role="presentation"
      onClick={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div
        className="modal-card whats-new-card"
        role="dialog"
        aria-modal="true"
        aria-labelledby="whats-new-title"
      >
        <div className="modal-header">
          <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
            <span className="modal-icon modal-icon-primary">
              <Sparkles size={17} />
            </span>
            <div>
              <h2 id="whats-new-title" style={{ margin: 0, fontSize: 16 }}>
                What&apos;s New in v{entry.version}
              </h2>
              <div style={{ fontSize: 12, color: 'var(--text-muted)', marginTop: 2 }}>
                {entry.title}
              </div>
            </div>
          </div>
          <button type="button" className="btn btn-ghost btn-sm" aria-label="Close" onClick={onClose}>
            <X size={15} />
          </button>
        </div>

        <div className="modal-body" style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
          <p style={{ margin: 0, fontSize: 13.5, color: 'var(--text-secondary)', lineHeight: 1.5 }}>
            {entry.summary}
          </p>

          {sections.map((section) => (
            <div key={section.key} className="whats-new-section">
              <span className={`whats-new-pill whats-new-pill-${section.key}`}>{section.label}</span>
              <ul className="whats-new-list">
                {section.items.map((item, idx) => (
                  <li key={idx}>{item}</li>
                ))}
              </ul>
            </div>
          ))}
        </div>

        <div className="modal-footer" style={{ justifyContent: 'space-between', flexWrap: 'wrap', gap: 10 }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
            <label htmlFor="whats-new-version-select" style={{ fontSize: 12, color: 'var(--text-muted)' }}>
              Release:
            </label>
            <select
              id="whats-new-version-select"
              className="select"
              style={{ padding: '4px 10px', fontSize: 12 }}
              value={entry.version}
              onChange={(e) => setSelectedVersion(e.target.value)}
            >
              {RELEASE_NOTES.map((r) => (
                <option key={r.version} value={r.version}>
                  v{r.version}
                  {r.version === normalizedCurrent ? ' (Current)' : ''} — {r.title}
                </option>
              ))}
            </select>
          </div>
          <button type="button" className="btn btn-primary" autoFocus onClick={onClose}>
            Got it
          </button>
        </div>
      </div>
    </div>
  );
}
