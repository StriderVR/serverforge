import React, { useState } from 'react';
import { CheckCircle2, FileCode2, Plus, Trash2 } from 'lucide-react';
import type { GameTemplate } from '@serverforge/shared';
import { api } from '../api';

interface TemplatesPageProps {
  catalog: GameTemplate[];
  onRefreshCatalog: () => void;
}

const VALHEIM_EXAMPLE_YAML = `id: valheim
name: "Valheim"
shortName: "Valheim"
category: survival
description: "Viking co-op exploration and survival dedicated server."
resources:
  minRamGb: 4
  recommendedRamGb: 6
  minDiskGb: 5
ports:
  - key: game
    label: "Game Port"
    defaultPort: 2456
    protocol: udp
    primary: true
  - key: query
    label: "Query Port"
    defaultPort: 2457
    protocol: udp
runtimes:
  preferred: docker
  docker:
    image: "lloesche/valheim-server:latest"
    volumes:
      - hostSubdir: "config"
        containerPath: "/config"
      - hostSubdir: "data"
        containerPath: "/opt/valheim"
    envTemplate:
      SERVER_NAME: "{{SERVER_NAME}}"
      WORLD_NAME: "{{WORLD_NAME}}"
      SERVER_PASS: "{{SERVER_PASS}}"
      SERVER_PORT: "{{PORT_GAME}}"
  native:
    installer: steamcmd
    steamAppId: 896660
    executableWindows: "valheim_server.exe"
    executableLinux: "valheim_server.x86_64"
    argsTemplate: "-nographics -batchmode -name \\"{{SERVER_NAME}}\\" -port {{PORT_GAME}} -world \\"{{WORLD_NAME}}\\" -password \\"{{SERVER_PASS}}\\""
    saveSubdir: "saves"
query:
  protocol: none
lifecycle:
  bootGraceSeconds: 180
  gracefulStopTimeoutSeconds: 45
  saveMethod: none
configFields:
  - key: SERVER_NAME
    label: "Server Name"
    type: string
    default: "ServerForge Valheim"
    required: true
  - key: WORLD_NAME
    label: "World Name"
    type: string
    default: "Midgard"
    required: true
  - key: SERVER_PASS
    label: "Join Password (min 5 chars)"
    type: secret
    autoGenerate: true
    required: true
`;

export function TemplatesPage({ catalog, onRefreshCatalog }: TemplatesPageProps) {
  const [yamlText, setYamlText] = useState(VALHEIM_EXAMPLE_YAML);
  const [inspectYaml, setInspectYaml] = useState<{ id: string; yaml: string } | null>(null);
  const [status, setStatus] = useState<{ kind: 'success' | 'error'; text: string } | null>(null);
  const [busy, setBusy] = useState(false);

  const handleInspect = async (id: string) => {
    try {
      const res = await api.getTemplateYaml(id);
      setInspectYaml(res);
    } catch (err) {
      setStatus({ kind: 'error', text: err instanceof Error ? err.message : 'Could not load YAML' });
    }
  };

  const handleValidate = async () => {
    setStatus(null);
    const res = await api.validateTemplateYaml(yamlText);
    if (res.valid && res.template) {
      setStatus({ kind: 'success', text: `Valid template: "${res.template.name}" (${res.template.id})` });
    } else {
      setStatus({ kind: 'error', text: (res.errors ?? ['Invalid YAML']).join(' | ') });
    }
  };

  const handleImport = async () => {
    setStatus(null);
    setBusy(true);
    try {
      const created = await api.importTemplateYaml(yamlText);
      setStatus({
        kind: 'success',
        text: `Imported "${created.name}"! It is now immediately available in One-Click Deploy.`,
      });
      onRefreshCatalog();
    } catch (err) {
      setStatus({ kind: 'error', text: err instanceof Error ? err.message : 'Import failed' });
    } finally {
      setBusy(false);
    }
  };

  const handleDeleteCustom = async (id: string) => {
    if (!window.confirm(`Remove custom game template "${id}"?`)) return;
    await api.deleteCustomTemplate(id);
    if (inspectYaml?.id === id) setInspectYaml(null);
    onRefreshCatalog();
  };

  return (
    <div>
      <header className="page-header">
        <div>
          <h1>Game Templates</h1>
          <p className="page-subtitle">
            Scale to any new game with zero code changes. Drop YAML files into{' '}
            <code className="mono">catalog/games/</code> or import them right here.
          </p>
        </div>
      </header>

      <div style={{ display: 'grid', gridTemplateColumns: 'minmax(0, 1fr) minmax(0, 1.25fr)', gap: 18 }}>
        <section className="panel">
          <div className="panel-header">
            <h2>Installed Catalog ({catalog.length})</h2>
          </div>
          <div className="panel-body" style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
            {catalog.map((tpl) => (
              <div
                key={tpl.id}
                style={{
                  display: 'flex',
                  alignItems: 'center',
                  justifyContent: 'space-between',
                  gap: 10,
                  padding: '10px 12px',
                  borderRadius: 'var(--radius-sm)',
                  background: 'var(--bg-elevated)',
                  border: '1px solid var(--border-subtle)',
                }}
              >
                <div>
                  <div style={{ fontWeight: 600 }}>{tpl.name}</div>
                  <div style={{ fontSize: 12, color: 'var(--text-muted)' }}>
                    <span className="mono">{tpl.id}</span> • {tpl.isCustom ? 'Custom' : 'Built-in'} • Prefers{' '}
                    {tpl.runtimes.preferred}
                  </div>
                </div>
                <div className="btn-row">
                  <button className="btn btn-sm" onClick={() => handleInspect(tpl.id)}>
                    <FileCode2 size={13} /> YAML
                  </button>
                  {tpl.isCustom && (
                    <button className="btn btn-danger btn-sm" onClick={() => handleDeleteCustom(tpl.id)}>
                      <Trash2 size={13} />
                    </button>
                  )}
                </div>
              </div>
            ))}

            {inspectYaml && (
              <div style={{ marginTop: 10 }}>
                <div style={{ fontSize: 12, color: 'var(--text-secondary)', marginBottom: 6 }}>
                  Viewing <span className="mono">{inspectYaml.id}.yaml</span>
                </div>
                <pre
                  style={{
                    margin: 0,
                    padding: 12,
                    borderRadius: 'var(--radius-sm)',
                    background: 'var(--bg-terminal)',
                    border: '1px solid var(--border-subtle)',
                    overflowX: 'auto',
                    maxHeight: 280,
                    fontSize: 12,
                  }}
                >
                  {inspectYaml.yaml}
                </pre>
              </div>
            )}
          </div>
        </section>

        <section className="panel">
          <div className="panel-header">
            <h2>Add New Game Template (YAML)</h2>
            <button className="btn btn-ghost btn-sm" onClick={() => setYamlText(VALHEIM_EXAMPLE_YAML)}>
              Load Valheim Example
            </button>
          </div>
          <div className="panel-body">
            {status && (
              <div className={`alert ${status.kind === 'error' ? 'alert-error' : 'alert-success'}`}>{status.text}</div>
            )}

            <textarea
              id="template-yaml-editor"
              className="textarea"
              rows={20}
              value={yamlText}
              onChange={(e) => setYamlText(e.target.value)}
            />

            <div className="btn-row" style={{ marginTop: 14 }}>
              <button type="button" className="btn" onClick={handleValidate}>
                <CheckCircle2 size={14} /> Validate Schema
              </button>
              <button
                id="import-template-btn"
                type="button"
                className="btn btn-primary"
                disabled={busy}
                onClick={handleImport}
              >
                <Plus size={14} /> {busy ? 'Importing...' : 'Save & Add to Catalog'}
              </button>
            </div>
          </div>
        </section>
      </div>
    </div>
  );
}
