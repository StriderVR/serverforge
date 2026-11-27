import React, { useEffect, useRef, useState } from 'react';
import {
  ChevronRight,
  Download,
  Edit3,
  FileCode2,
  Folder,
  FolderPlus,
  RefreshCw,
  Save,
  Trash2,
  Upload,
  X,
} from 'lucide-react';
import type { InstanceFileContent, InstanceFileEntry, InstanceFileListing } from '@serverforge/shared';
import { api } from '../../api';
import type { ConfirmDialogOptions } from '../ConfirmModal';
import type { PushToastFn } from '../ToastStack';

interface FilesTabProps {
  instanceId: string;
  onConfirm?: (opts: ConfirmDialogOptions) => Promise<boolean>;
  onToast?: PushToastFn;
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(2)} MB`;
}

export function FilesTab({ instanceId, onConfirm, onToast }: FilesTabProps) {
  const [listing, setListing] = useState<InstanceFileListing | null>(null);
  const [currentPath, setCurrentPath] = useState('');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const [openFile, setOpenFile] = useState<InstanceFileContent | null>(null);
  const [editorText, setEditorText] = useState('');
  const [savingFile, setSavingFile] = useState(false);
  const [loadingFile, setLoadingFile] = useState(false);

  const [dragActive, setDragActive] = useState(false);
  const [uploadProgress, setUploadProgress] = useState<{ name: string; percent: number } | null>(null);
  const [creatingFolder, setCreatingFolder] = useState(false);
  const [newFolderName, setNewFolderName] = useState('');
  const [renamingPath, setRenamingPath] = useState<string | null>(null);
  const [renameValue, setRenameValue] = useState('');
  const fileInputRef = useRef<HTMLInputElement | null>(null);

  const isDirty = openFile !== null && editorText !== openFile.content;

  const loadDirectory = async (dirPath: string) => {
    setLoading(true);
    setError(null);
    try {
      const data = await api.listInstanceFiles(instanceId, dirPath);
      setListing(data);
      setCurrentPath(data.currentPath);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to list files');
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    setOpenFile(null);
    void loadDirectory('');
  }, [instanceId]);

  const handleOpenFile = async (relPath: string) => {
    if (isDirty) {
      const ok = onConfirm
        ? await onConfirm({
            title: 'Discard Unsaved Changes?',
            message: `You have unsaved edits in "${openFile?.name}". Opening another file will discard them.`,
            confirmLabel: 'Discard & Open',
            tone: 'danger',
          })
        : window.confirm('Discard unsaved edits?');
      if (!ok) return;
    }
    setLoadingFile(true);
    setError(null);
    try {
      const file = await api.readInstanceFile(instanceId, relPath);
      setOpenFile(file);
      setEditorText(file.content);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Unable to open file');
    } finally {
      setLoadingFile(false);
    }
  };

  const handleSaveFile = async () => {
    if (!openFile) return;
    setSavingFile(true);
    setError(null);
    try {
      const saved = await api.writeInstanceFile(instanceId, openFile.path, editorText);
      setOpenFile(saved);
      setEditorText(saved.content);
      onToast?.('success', `Saved ${saved.path}`);
      await loadDirectory(currentPath);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to save file');
    } finally {
      setSavingFile(false);
    }
  };

  const handleUploadFiles = async (files: FileList | File[]) => {
    const list = Array.from(files);
    if (list.length === 0) return;
    setError(null);
    for (const file of list) {
      try {
        setUploadProgress({ name: file.name, percent: 0 });
        await api.uploadInstanceFile(instanceId, currentPath, file, (pct) => {
          setUploadProgress({ name: file.name, percent: pct });
        });
        onToast?.('success', `Uploaded ${file.name}`);
      } catch (err) {
        setError(err instanceof Error ? err.message : `Failed to upload ${file.name}`);
        break;
      }
    }
    setUploadProgress(null);
    await loadDirectory(currentPath);
  };

  const handleCreateFolder = async (e: React.FormEvent) => {
    e.preventDefault();
    const trimmed = newFolderName.trim();
    if (!trimmed) return;
    const targetPath = currentPath ? `${currentPath}/${trimmed}` : trimmed;
    try {
      await api.mkdirInstanceDir(instanceId, targetPath);
      setNewFolderName('');
      setCreatingFolder(false);
      await loadDirectory(currentPath);
      onToast?.('success', `Created folder ${targetPath}`);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to create folder');
    }
  };

  const handleRenameSubmit = async (entry: InstanceFileEntry) => {
    const trimmed = renameValue.trim();
    if (!trimmed || trimmed === entry.name) {
      setRenamingPath(null);
      return;
    }
    try {
      await api.renameInstanceFile(instanceId, entry.path, trimmed);
      setRenamingPath(null);
      await loadDirectory(currentPath);
      onToast?.('success', `Renamed ${entry.name} to ${trimmed}`);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Rename failed');
    }
  };

  const handleDelete = async (entry: InstanceFileEntry) => {
    const ok = onConfirm
      ? await onConfirm({
          title: `Delete ${entry.isDirectory ? 'Folder' : 'File'}?`,
          message: `Permanently delete "${entry.path}"${entry.isDirectory ? ' and all files inside it' : ''}?`,
          confirmLabel: 'Delete',
          tone: 'danger',
        })
      : window.confirm(`Delete ${entry.path}?`);
    if (!ok) return;

    try {
      await api.deleteInstanceFile(instanceId, entry.path);
      if (openFile?.path === entry.path) {
        setOpenFile(null);
      }
      await loadDirectory(currentPath);
      onToast?.('success', `Deleted ${entry.path}`);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Delete failed');
    }
  };

  const breadcrumbs = currentPath ? currentPath.split('/') : [];

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
      {/* Quick-jump config shortcuts */}
      {listing && listing.quickFiles.length > 0 && (
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
          <span style={{ fontSize: 12, color: 'var(--text-muted)', fontWeight: 600 }}>Quick Configs:</span>
          {listing.quickFiles.map((qf) => (
            <button
              key={qf.path}
              type="button"
              className="btn btn-sm"
              onClick={() => void handleOpenFile(qf.path)}
            >
              <FileCode2 size={13} /> {qf.label}
            </button>
          ))}
        </div>
      )}

      {error && <div className="alert alert-error">{error}</div>}

      {/* Inline Text Editor */}
      {(openFile || loadingFile) && (
        <section className="panel">
          <div className="panel-header">
            <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
              <FileCode2 size={16} />
              <h2 className="mono" style={{ fontSize: 14 }}>
                {loadingFile ? 'Loading file...' : openFile?.path}
              </h2>
              {isDirty && <span className="badge badge-starting">UNSAVED</span>}
            </div>
            <div className="btn-row">
              <button
                type="button"
                className="btn btn-primary btn-sm"
                disabled={savingFile || !openFile || !isDirty}
                onClick={() => void handleSaveFile()}
              >
                <Save size={13} /> {savingFile ? 'Saving...' : 'Save File'}
              </button>
              <button
                type="button"
                className="btn btn-sm"
                onClick={() => setOpenFile(null)}
              >
                <X size={13} /> Close
              </button>
            </div>
          </div>
          <div className="panel-body">
            <textarea
              className="textarea mono"
              style={{ width: '100%', minHeight: 320, fontSize: 12.5, lineHeight: 1.5, resize: 'vertical' }}
              value={editorText}
              onChange={(e) => setEditorText(e.target.value)}
              onKeyDown={(e) => {
                if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 's') {
                  e.preventDefault();
                  if (isDirty && !savingFile) void handleSaveFile();
                }
              }}
              spellCheck={false}
            />
          </div>
        </section>
      )}

      {/* Directory Explorer + Drag-and-Drop Upload */}
      <section
        className="panel"
        onDragOver={(e) => {
          e.preventDefault();
          setDragActive(true);
        }}
        onDragLeave={() => setDragActive(false)}
        onDrop={(e) => {
          e.preventDefault();
          setDragActive(false);
          if (e.dataTransfer.files?.length) {
            void handleUploadFiles(e.dataTransfer.files);
          }
        }}
        style={dragActive ? { borderColor: 'var(--accent)', boxShadow: '0 0 0 2px var(--accent-soft)' } : undefined}
      >
        <div className="panel-header" style={{ flexWrap: 'wrap', gap: 10 }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 4, flexWrap: 'wrap', fontSize: 13 }}>
            <button
              type="button"
              className="btn btn-sm"
              onClick={() => void loadDirectory('')}
            >
              Server Root
            </button>
            {breadcrumbs.map((seg, idx) => {
              const crumbPath = breadcrumbs.slice(0, idx + 1).join('/');
              return (
                <React.Fragment key={crumbPath}>
                  <ChevronRight size={13} color="var(--text-muted)" />
                  <button
                    type="button"
                    className="btn btn-sm"
                    onClick={() => void loadDirectory(crumbPath)}
                  >
                    {seg}
                  </button>
                </React.Fragment>
              );
            })}
          </div>

          <div className="btn-row">
            <input
              ref={fileInputRef}
              type="file"
              multiple
              style={{ display: 'none' }}
              onChange={(e) => {
                if (e.target.files?.length) {
                  void handleUploadFiles(e.target.files);
                  e.target.value = '';
                }
              }}
            />
            <button type="button" className="btn btn-primary btn-sm" onClick={() => fileInputRef.current?.click()}>
              <Upload size={13} /> Upload Files
            </button>
            <button type="button" className="btn btn-sm" onClick={() => setCreatingFolder((v) => !v)}>
              <FolderPlus size={13} /> New Folder
            </button>
            <button type="button" className="btn btn-sm" disabled={loading} onClick={() => void loadDirectory(currentPath)}>
              <RefreshCw size={13} /> Refresh
            </button>
          </div>
        </div>

        <div className="panel-body">
          {uploadProgress && (
            <div className="alert alert-info" style={{ marginBottom: 12 }}>
              <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: 6 }}>
                <span>
                  Uploading <strong>{uploadProgress.name}</strong>...
                </span>
                <span className="tabular">{uploadProgress.percent}%</span>
              </div>
              <div style={{ height: 6, background: 'var(--bg-canvas)', borderRadius: 4, overflow: 'hidden' }}>
                <div
                  style={{
                    width: `${uploadProgress.percent}%`,
                    height: '100%',
                    background: 'var(--accent)',
                    transition: 'width 120ms linear',
                  }}
                />
              </div>
            </div>
          )}

          {creatingFolder && (
            <form onSubmit={handleCreateFolder} style={{ display: 'flex', gap: 8, marginBottom: 12 }}>
              <input
                className="input"
                placeholder="New folder name..."
                value={newFolderName}
                onChange={(e) => setNewFolderName(e.target.value)}
                autoFocus
                style={{ maxWidth: 280 }}
              />
              <button type="submit" className="btn btn-primary btn-sm">
                Create
              </button>
              <button type="button" className="btn btn-sm" onClick={() => setCreatingFolder(false)}>
                Cancel
              </button>
            </form>
          )}

          <div
            style={{
              fontSize: 12,
              color: 'var(--text-muted)',
              marginBottom: 10,
              padding: '8px 12px',
              border: '1px dashed var(--border-strong)',
              borderRadius: 'var(--radius-sm)',
              textAlign: 'center',
            }}
          >
            Drag &amp; drop mods (<code>.jar</code>), configs, or world files anywhere in this panel to upload to{' '}
            <code className="mono">/{currentPath || ''}</code> (up to 100 MB per file). Text files up to 1 MB can be edited inline.
          </div>

          {listing && listing.entries.length === 0 ? (
            <div style={{ padding: 24, textAlign: 'center', color: 'var(--text-muted)', fontSize: 13 }}>
              This folder is empty.
            </div>
          ) : (
            <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
              {listing?.parentPath !== null && listing?.parentPath !== undefined && (
                <button
                  type="button"
                  onClick={() => void loadDirectory(listing.parentPath ?? '')}
                  style={{
                    display: 'flex',
                    alignItems: 'center',
                    gap: 8,
                    padding: '8px 10px',
                    background: 'var(--bg-elevated)',
                    border: '1px solid var(--border-subtle)',
                    borderRadius: 'var(--radius-sm)',
                    color: 'var(--text-secondary)',
                    cursor: 'pointer',
                    textAlign: 'left',
                  }}
                >
                  <Folder size={15} /> <span>.. (Parent Directory)</span>
                </button>
              )}

              {(listing?.entries ?? []).map((entry) => (
                <div
                  key={entry.path}
                  style={{
                    display: 'flex',
                    alignItems: 'center',
                    justifyContent: 'space-between',
                    gap: 10,
                    padding: '8px 10px',
                    background: 'var(--bg-elevated)',
                    border: '1px solid var(--border-subtle)',
                    borderRadius: 'var(--radius-sm)',
                    flexWrap: 'wrap',
                  }}
                >
                  <div style={{ display: 'flex', alignItems: 'center', gap: 8, minWidth: 0, flex: '1 1 160px' }}>
                    {entry.isDirectory ? (
                      <Folder size={15} color="var(--accent)" />
                    ) : (
                      <FileCode2 size={15} color={entry.editable ? '#60a5fa' : 'var(--text-muted)'} />
                    )}

                    {renamingPath === entry.path ? (
                      <form
                        style={{ display: 'flex', gap: 6, flex: 1 }}
                        onSubmit={(e) => {
                          e.preventDefault();
                          void handleRenameSubmit(entry);
                        }}
                      >
                        <input
                          className="input"
                          style={{ padding: '4px 8px', fontSize: 12.5 }}
                          value={renameValue}
                          onChange={(e) => setRenameValue(e.target.value)}
                          autoFocus
                        />
                        <button type="submit" className="btn btn-primary btn-sm">
                          Save
                        </button>
                        <button type="button" className="btn btn-sm" onClick={() => setRenamingPath(null)}>
                          Cancel
                        </button>
                      </form>
                    ) : (
                      <button
                        type="button"
                        onClick={() =>
                          entry.isDirectory
                            ? void loadDirectory(entry.path)
                            : entry.editable
                              ? void handleOpenFile(entry.path)
                              : onToast?.('info', 'Use Download to inspect binary files or logs larger than 1 MB.')
                        }
                        style={{
                          background: 'none',
                          border: 'none',
                          padding: 0,
                          color: 'var(--text-primary)',
                          font: 'inherit',
                          fontWeight: entry.isDirectory ? 600 : 400,
                          cursor: 'pointer',
                          textAlign: 'left',
                        }}
                      >
                        {entry.name}
                      </button>
                    )}
                  </div>

                  <div style={{ display: 'flex', alignItems: 'center', gap: 10, fontSize: 12, color: 'var(--text-muted)' }}>
                    <span className="tabular" style={{ minWidth: 68, textAlign: 'right' }}>
                      {entry.isDirectory ? 'Folder' : formatBytes(entry.sizeBytes)}
                    </span>
                    <div className="btn-row">
                      {!entry.isDirectory && entry.editable && (
                        <button type="button" className="btn btn-sm" onClick={() => void handleOpenFile(entry.path)}>
                          Edit
                        </button>
                      )}
                      {!entry.isDirectory && (
                        <a
                          href={api.getInstanceFileDownloadUrl(instanceId, entry.path)}
                          className="btn btn-sm"
                          title="Download file"
                        >
                          <Download size={12} />
                        </a>
                      )}
                      <button
                        type="button"
                        className="btn btn-sm"
                        title="Rename"
                        onClick={() => {
                          setRenamingPath(entry.path);
                          setRenameValue(entry.name);
                        }}
                      >
                        <Edit3 size={12} />
                      </button>
                      <button
                        type="button"
                        className="btn btn-danger btn-sm"
                        title="Delete"
                        onClick={() => void handleDelete(entry)}
                      >
                        <Trash2 size={12} />
                      </button>
                    </div>
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>
      </section>
    </div>
  );
}
