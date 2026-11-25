import React, { useEffect, useState } from 'react';
import { Play, Rocket } from 'lucide-react';
import type { GameTemplate, HostMetrics, RuntimeKind } from '@serverforge/shared';
import { api } from '../api';
import { CurseForgeBrowser, type SelectedCurseForgePack } from './CurseForgeBrowser';

interface DeployPageProps {
  catalog: GameTemplate[];
  metrics: HostMetrics | null;
  onDeployed: (instanceId: string, autoBoot?: boolean) => void;
  onGoToSettings: () => void;
}

const DOCKER_ONLY_FIELDS = new Set(['CF_FORCE_SYNCHRONIZE']);

export function DeployPage({ catalog, metrics, onDeployed, onGoToSettings }: DeployPageProps) {
  const [selectedId, setSelectedId] = useState<string>(catalog[0]?.id ?? '');
  const selected = catalog.find((t) => t.id === selectedId) ?? catalog[0] ?? null;
  const dockerAvailable = Boolean(metrics?.runtimesAvailable?.docker);

  const [name, setName] = useState('');
  const [runtime, setRuntime] = useState<RuntimeKind>('native');
  const [memoryGb, setMemoryGb] = useState<number>(4);
  const [autoStart, setAutoStart] = useState(false);
  const [discordEnabled, setDiscordEnabled] = useState(true);
  const [config, setConfig] = useState<Record<string, string | number | boolean>>({});
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!selected) return;
    setName(`${selected.shortName} Server`);
    setRuntime(selected.runtimes.native ? 'native' : 'docker');
    setMemoryGb(selected.resources.recommendedRamGb);
    setAutoStart(false);
    const defaults: Record<string, string | number | boolean> = {};
    for (const field of selected.configFields) {
      if (field.default !== undefined) {
        defaults[field.key] = field.default;
      } else if (field.type === 'boolean') {
        defaults[field.key] = false;
      } else {
        defaults[field.key] = '';
      }
    }
    setConfig(defaults);
    setError(null);
  }, [selected?.id]);

  const handleSelectCurseForgePack = (pack: SelectedCurseForgePack) => {
    setName(pack.packName.slice(0, 56));
    setMemoryGb((prev) => Math.max(prev, 8));
    setConfig((prev) => ({
      ...prev,
      CF_SLUG: pack.slug,
      CF_FILE_ID: pack.fileId,
      CF_PAGE_URL: pack.pageUrl,
      JAVA_IMAGE_TAG: pack.javaTag,
      MOTD: `${pack.packName} — ServerForge`,
      ...(pack.serverPackZipUrl !== undefined ? { SERVER_PACK_ZIP: pack.serverPackZipUrl } : {}),
    }));
  };

  const handleDeploy = async (startImmediately: boolean) => {
    if (!selected) return;
    setError(null);
    setSubmitting(true);
    try {
      // For Native deployments (which may download large CurseForge packs, SteamCMD apps, or portable Java),
      // navigate straight to the Live Console and start immediately so progress streams in real time.
      const deferStartToConsole = startImmediately && runtime === 'native';
      const created = await api.createInstance({
        name: name.trim(),
        gameId: selected.id,
        runtime,
        memoryLimitMb: Math.round(memoryGb * 1024),
        config,
        autoStart,
        discordEnabled,
        startImmediately: deferStartToConsole ? false : startImmediately,
      });
      onDeployed(created.id, deferStartToConsole);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Deployment failed');
    } finally {
      setSubmitting(false);
    }
  };

  const visibleConfigFields = (selected?.configFields ?? []).filter((field) => {
    if (runtime === 'native' && DOCKER_ONLY_FIELDS.has(field.key)) {
      return false;
    }
    return true;
  });

  const showDockerOption = Boolean(selected?.runtimes.docker && (dockerAvailable || !selected?.runtimes.native));

  return (
    <div>
      <header className="page-header">
        <div>
          <h1>One-Click Deploy</h1>
          <p className="page-subtitle">
            Choose any game from your catalog to run locally on this server PC. Ports are automatically allocated without conflicts.
          </p>
        </div>
      </header>

      <section className="catalog-grid" aria-label="Game server templates">
        {catalog.map((tpl) => (
          <button
            key={tpl.id}
            type="button"
            className={`catalog-card ${selected?.id === tpl.id ? 'selected' : ''}`}
            onClick={() => setSelectedId(tpl.id)}
          >
            <div className="catalog-title-row">
              <span className="catalog-name">{tpl.name}</span>
              <span className="catalog-cat">{tpl.isCustom ? 'Custom' : tpl.category}</span>
            </div>
            <p className="catalog-desc">{tpl.description}</p>
            <div className="catalog-specs tabular">
              <span>Min {tpl.resources.minRamGb} GB RAM</span>
              <span>•</span>
              <span>{tpl.runtimes.native ? 'Local Native' : 'Docker Only'}</span>
            </div>
          </button>
        ))}
      </section>

      {selected && (
        <section className="panel">
          <div className="panel-header">
            <h2>Configure {selected.name}</h2>
            <span style={{ fontSize: 12, color: 'var(--text-muted)' }}>
              Ports auto-assigned starting from{' '}
              <span className="mono">{selected.ports.map((p) => `${p.defaultPort}/${p.protocol}`).join(', ')}</span>
            </span>
          </div>

          <div className="panel-body">
            {error && <div className="alert alert-error">{error}</div>}

            {selected.id === 'minecraft-curseforge' && (
              <CurseForgeBrowser
                onSelectPack={handleSelectCurseForgePack}
                onGoToSettings={onGoToSettings}
              />
            )}

            {selected.id === 'minecraft-curseforge' && runtime === 'native' && (
              <div className="alert alert-info" style={{ marginBottom: 16 }}>
                <strong>Native Modpack Auto-Setup:</strong> ServerForge will automatically download &amp; extract the
                CurseForge Server Pack ZIP, install the matching portable Java runtime (Java 8 / 17 / 21) if needed, and
                stream setup progress to the Live Console. First boot may take 1–3 minutes depending on pack size.
              </div>
            )}

            <div className="form-grid">
              <div className="field">
                <label htmlFor="deploy-name">Instance Display Name</label>
                <input
                  id="deploy-name"
                  className="input"
                  value={name}
                  onChange={(e) => setName(e.target.value)}
                  required
                />
              </div>

              <div className="field">
                <label htmlFor="deploy-runtime">Execution Runtime</label>
                <select
                  id="deploy-runtime"
                  className="select"
                  value={runtime}
                  onChange={(e) => setRuntime(e.target.value as RuntimeKind)}
                >
                  {selected.runtimes.native && (
                    <option value="native">
                      Local Native Process ({selected.runtimes.native.installer.toUpperCase()} — runs directly on this PC)
                    </option>
                  )}
                  {showDockerOption && selected.runtimes.docker && (
                    <option value="docker">
                      Docker Container ({selected.runtimes.docker.image})
                    </option>
                  )}
                </select>
              </div>

              <div className="field">
                <label htmlFor="deploy-ram">RAM Allocation Cap (GB)</label>
                <input
                  id="deploy-ram"
                  type="number"
                  min={selected.resources.minRamGb}
                  max={128}
                  step={1}
                  className="input tabular"
                  value={memoryGb}
                  onChange={(e) => setMemoryGb(Number(e.target.value))}
                />
                <span className="field-hint">
                  Minimum {selected.resources.minRamGb} GB • Recommended {selected.resources.recommendedRamGb} GB
                </span>
              </div>

              <div className="field" style={{ justifyContent: 'center' }}>
                <label className="checkbox-row">
                  <input
                    id="deploy-discord-enabled"
                    type="checkbox"
                    checked={discordEnabled}
                    onChange={(e) => setDiscordEnabled(e.target.checked)}
                  />
                  <span>Allow authorized Discord members to temporarily boot this server</span>
                </label>
                <label className="checkbox-row" style={{ paddingTop: 2 }}>
                  <input
                    id="deploy-autostart"
                    type="checkbox"
                    checked={autoStart}
                    onChange={(e) => setAutoStart(e.target.checked)}
                  />
                  <span>Auto-start when server PC boots (after daily morning restart)</span>
                </label>
              </div>

              {visibleConfigFields.map((field) => (
                <div key={field.key} className="field">
                  <label htmlFor={`cfg-${field.key}`}>
                    {field.label} {field.autoGenerate ? '(auto-generated if blank)' : ''}
                  </label>

                  {field.type === 'select' && field.options ? (
                    <select
                      id={`cfg-${field.key}`}
                      className="select"
                      value={String(config[field.key] ?? field.default ?? '')}
                      onChange={(e) => setConfig((prev) => ({ ...prev, [field.key]: e.target.value }))}
                    >
                      {field.options.map((opt) => (
                        <option key={opt} value={opt}>
                          {opt}
                        </option>
                      ))}
                    </select>
                  ) : field.type === 'boolean' ? (
                    <label className="checkbox-row">
                      <input
                        id={`cfg-${field.key}`}
                        type="checkbox"
                        checked={Boolean(config[field.key])}
                        onChange={(e) => setConfig((prev) => ({ ...prev, [field.key]: e.target.checked }))}
                      />
                      <span>Enabled</span>
                    </label>
                  ) : field.type === 'number' ? (
                    <input
                      id={`cfg-${field.key}`}
                      type="number"
                      className="input tabular"
                      min={field.min}
                      max={field.max}
                      value={Number(config[field.key] ?? field.default ?? 0)}
                      onChange={(e) => setConfig((prev) => ({ ...prev, [field.key]: Number(e.target.value) }))}
                    />
                  ) : (
                    <input
                      id={`cfg-${field.key}`}
                      type={field.type === 'secret' ? 'password' : 'text'}
                      className="input"
                      placeholder={field.autoGenerate ? 'Leave blank to auto-generate securely' : ''}
                      value={String(config[field.key] ?? '')}
                      onChange={(e) => setConfig((prev) => ({ ...prev, [field.key]: e.target.value }))}
                    />
                  )}

                  {field.description && <span className="field-hint">{field.description}</span>}
                </div>
              ))}
            </div>

            <div className="btn-row" style={{ marginTop: 22, paddingTop: 16, borderTop: '1px solid var(--border-subtle)' }}>
              <button
                id="deploy-and-start-btn"
                type="button"
                className="btn btn-primary"
                disabled={submitting || name.trim().length < 2}
                onClick={() => handleDeploy(true)}
              >
                <Rocket size={15} />
                {submitting ? 'Deploying...' : 'Deploy & Boot Now'}
              </button>
              <button
                id="deploy-stopped-btn"
                type="button"
                className="btn"
                disabled={submitting || name.trim().length < 2}
                onClick={() => handleDeploy(false)}
              >
                <Play size={14} />
                Deploy Ready (Boot Later)
              </button>
            </div>
          </div>
        </section>
      )}
    </div>
  );
}
