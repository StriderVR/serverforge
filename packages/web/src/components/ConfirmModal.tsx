import React, { useEffect } from 'react';
import { AlertTriangle, HelpCircle, X } from 'lucide-react';

export interface ConfirmDialogOptions {
  title: string;
  message: string;
  confirmLabel?: string;
  cancelLabel?: string;
  tone?: 'danger' | 'primary';
}

interface ConfirmModalProps {
  open: boolean;
  options: ConfirmDialogOptions | null;
  onConfirm: () => void;
  onCancel: () => void;
}

export function ConfirmModal({ open, options, onConfirm, onCancel }: ConfirmModalProps) {
  useEffect(() => {
    if (!open) return;
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.preventDefault();
        onCancel();
      }
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [open, onCancel]);

  if (!open || !options) return null;

  const isDanger = options.tone === 'danger';

  return (
    <div
      className="modal-backdrop"
      role="presentation"
      onClick={(e) => {
        if (e.target === e.currentTarget) onCancel();
      }}
    >
      <div
        className="modal-card"
        role="dialog"
        aria-modal="true"
        aria-labelledby="confirm-modal-title"
      >
        <div className="modal-header">
          <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
            <span className={`modal-icon ${isDanger ? 'modal-icon-danger' : 'modal-icon-primary'}`}>
              {isDanger ? <AlertTriangle size={17} /> : <HelpCircle size={17} />}
            </span>
            <h2 id="confirm-modal-title" style={{ margin: 0, fontSize: 16 }}>
              {options.title}
            </h2>
          </div>
          <button type="button" className="btn btn-ghost btn-sm" aria-label="Close" onClick={onCancel}>
            <X size={15} />
          </button>
        </div>

        <div className="modal-body">
          <p style={{ margin: 0, whiteSpace: 'pre-line', lineHeight: 1.55, color: 'var(--text-secondary)' }}>
            {options.message}
          </p>
        </div>

        <div className="modal-footer">
          <button type="button" className="btn" onClick={onCancel}>
            {options.cancelLabel ?? 'Cancel'}
          </button>
          <button
            type="button"
            className={`btn ${isDanger ? 'btn-danger' : 'btn-primary'}`}
            autoFocus
            onClick={onConfirm}
          >
            {options.confirmLabel ?? 'Confirm'}
          </button>
        </div>
      </div>
    </div>
  );
}
