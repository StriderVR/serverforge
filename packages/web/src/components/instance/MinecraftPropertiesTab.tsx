import React, { useEffect, useMemo, useState } from 'react';
import { Code, Lock, Plus, RefreshCw, RotateCw, Save, Search } from 'lucide-react';
import type { MinecraftPropertiesResponse } from '@serverforge/shared';
import { api } from '../../api';
import type { PushToastFn } from '../ToastStack';

interface MinecraftPropertiesTabProps {
  instanceId: string;
  isRunning: boolean;
  onSaved?: () => void;
  onToast?: PushToastFn;
}

interface PropertyFieldDef {
  key: string;
  label: string;
  type: 'text' | 'number' | 'boolean' | 'select';
  options?: string[];
  hint?: string;
}

const PROPERTY_CATEGORIES: Array<{ title: string; fields: PropertyFieldDef[] }> = [
  {
    title: 'Gameplay',
    fields: [
      { key: 'gamemode', label: 'Default Game Mode', type: 'select', options: ['survival', 'creative', 'adventure', 'spectator'] },
      { key: 'difficulty', label: 'Difficulty', type: 'select', options: ['peaceful', 'easy', 'normal', 'hard'] },
      { key: 'hardcore', label: 'Hardcore Mode', type: 'boolean' },
      { key: 'pvp', label: 'Allow PvP', type: 'boolean' },
      { key: 'force-gamemode', label: 'Force Game Mode on Join', type: 'boolean' },
      { key: 'allow-flight', label: 'Allow Flight (Recommended for Modpacks)', type: 'boolean' },
      { key: 'allow-nether', label: 'Allow Nether', type: 'boolean' },
      { key: 'enable-command-block', label: 'Enable Command Blocks', type: 'boolean' },
      { key: 'spawn-monsters', label: 'Spawn Monsters', type: 'boolean' },
      { key: 'spawn-animals', label: 'Spawn Animals', type: 'boolean' },
      { key: 'spawn-npcs', label: 'Spawn Villagers / NPCs', type: 'boolean' },
    ],
  },
  {
    title: 'World & Network',
    fields: [
      { key: 'motd', label: 'Server MOTD', type: 'text' },
      { key: 'level-name', label: 'World Folder Name (level-name)', type: 'text' },
      { key: 'level-seed', label: 'World Seed (level-seed)', type: 'text' },
      { key: 'max-players', label: 'Max Players', type: 'number' },
      { key: 'spawn-protection', label: 'Spawn Protection Radius', type: 'number' },
      { key: 'online-mode', label: 'Online Mode (Verify Mojang Accounts)', type: 'boolean' },
      { key: 'white-list', label: 'Enable Whitelist', type: 'boolean' },
      { key: 'enforce-whitelist', label: 'Enforce Whitelist Immediately', type: 'boolean' },
    ],
  },
  {
    title: 'Performance',
    fields: [
      { key: 'view-distance', label: 'View Distance (chunks)', type: 'number' },
      { key: 'simulation-distance', label: 'Simulation Distance (chunks)', type: 'number' },
      { key: 'max-tick-time', label: 'Max Tick Time (ms, -1 to disable watchdog)', type: 'number' },
      { key: 'entity-broadcast-range-percentage', label: 'Entity Broadcast Range (%)', type: 'number' },
    ],
  },
];

const KNOWN_KEYS = new Set(PROPERTY_CATEGORIES.flatMap((c) => c.fields.map((f) => f.key)));

export function MinecraftPropertiesTab({
  instanceId,
  isRunning,
  onSaved,
  onToast,
}: MinecraftPropertiesTabProps) {
  const [data, setData] = useState<MinecraftPropertiesResponse | null>(null);
  const [propsMap, setPropsMap] = useState<Record<string, string>>({});
  const [rawMode, setRawMode] = useState(false);
  const [rawText, setRawText] = useState('');
  const [search, setSearch] = useState('');
  const [newKey, setNewKey] = useState('');
  const [newVal, setNewVal] = useState('');
  const [loading, setLoading] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const loadProperties = async () => {
    setLoading(true);
    setError(null);
    try {
      const res = await api.getMinecraftProperties(instanceId);
      setData(res);
      setPropsMap(res.properties);
      setRawText(res.rawContent);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load server.properties');
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    void loadProperties();
  }, [instanceId]);

  const managedKeySet = useMemo(() => new Set(data?.managedKeys ?? []), [data]);

  const extraKeys = useMemo(() => {
    const q = search.trim().toLowerCase();
    return Object.keys(propsMap)
      .filter((k) => !KNOWN_KEYS.has(k))
      .filter((k) => !q || k.toLowerCase().includes(q) || (propsMap[k] ?? '').toLowerCase().includes(q))
      .sort();
  }, [propsMap, search]);

  const handleSave = async (restartAfterSave: boolean, createIfMissing = false) => {
    setSaving(true);
    setError(null);
    try {
      const res = await api.saveMinecraftProperties(instanceId, {
        ...(rawMode && !createIfMissing ? { rawContent: rawText } : { properties: propsMap }),
        createIfMissing,
        restartAfterSave,
      });
      setData(res);
      setPropsMap(res.properties);
      setRawText(res.rawContent);
      onSaved?.();
      onToast?.(
        'success',
        createIfMissing
          ? 'Created default server.properties.'
          : restartAfterSave
            ? 'Saved server.properties and restarted server.'
            : isRunning
              ? 'Saved server.properties — restart server to apply changes.'
              : 'Saved server.properties.'
      );
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to save server.properties');
    } finally {
      setSaving(false);
    }
  };

  if (loading && !data) {
    return <div className="panel panel-body">Loading server.properties...</div>;
  }

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
      {error && <div className="alert alert-error">{error}</div>}

      {data && !data.exists ? (
        <section className="panel panel-body">
          <h3 style={{ marginTop: 0 }}>server.properties Not Generated Yet</h3>
          <p style={{ color: 'var(--text-secondary)', fontSize: 13 }}>
            Minecraft generates <code>server.properties</code> automatically on first launch. You can either start the
            server once, or pre-create a default <code>server.properties</code> now to customize settings before booting.
          </p>
          <div className="btn-row">
            <button
              type="button"
              className="btn btn-primary"
              disabled={saving}
              onClick={() => void handleSave(false, true)}
            >
              <Plus size={14} /> {saving ? 'Creating...' : 'Create Default server.properties'}
            </button>
            <button type="button" className="btn" onClick={() => void loadProperties()}>
              <RefreshCw size={14} /> Refresh
            </button>
          </div>
        </section>
      ) : (
        <>
          {isRunning && (
            <div
              className="alert alert-info"
              style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 12, flexWrap: 'wrap' }}
            >
              <span>
                <strong>Restart Required to Apply:</strong> This server is currently online. Saved edits take effect after
                restarting Minecraft.
              </span>
              <button
                type="button"
                className="btn btn-primary btn-sm"
                disabled={saving}
                onClick={() => void handleSave(true)}
              >
                <RotateCw size={13} /> {saving ? 'Saving...' : 'Save & Restart Server'}
              </button>
            </div>
          )}

          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 10, flexWrap: 'wrap' }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
              <button
                type="button"
                className={`btn btn-sm ${!rawMode ? 'btn-primary' : ''}`}
                onClick={() => setRawMode(false)}
              >
                Categorized Editor
              </button>
              <button
                type="button"
                className={`btn btn-sm ${rawMode ? 'btn-primary' : ''}`}
                onClick={() => setRawMode(true)}
              >
                <Code size={13} /> Raw Text
              </button>
            </div>
            <div className="btn-row">
              <button type="button" className="btn btn-sm" onClick={() => void loadProperties()}>
                <RefreshCw size={13} /> Reload
              </button>
              <button
                type="button"
                className="btn btn-primary btn-sm"
                disabled={saving}
                onClick={() => void handleSave(false)}
              >
                <Save size={13} /> {saving ? 'Saving...' : 'Save Changes'}
              </button>
            </div>
          </div>

          {rawMode ? (
            <section className="panel panel-body">
              <p style={{ fontSize: 12, color: 'var(--text-muted)', marginTop: 0 }}>
                ServerForge-managed keys (<code>server-port</code>, <code>rcon.port</code>, <code>rcon.password</code>,{' '}
                <code>enable-rcon</code>) are automatically preserved on save so RCON and port allocations stay intact.
              </p>
              <textarea
                className="textarea mono"
                style={{ width: '100%', minHeight: 380, fontSize: 12.5, lineHeight: 1.5 }}
                value={rawText}
                onChange={(e) => setRawText(e.target.value)}
                spellCheck={false}
              />
            </section>
          ) : (
            <>
              {PROPERTY_CATEGORIES.map((category) => (
                <section key={category.title} className="panel">
                  <div className="panel-header">
                    <h2>{category.title}</h2>
                  </div>
                  <div className="panel-body">
                    <div className="form-grid">
                      {category.fields.map((field) => {
                        const val = propsMap[field.key] ?? '';
                        return (
                          <div key={field.key} className="field">
                            <label htmlFor={`mcprop-${field.key}`}>
                              {field.label} <span className="mono" style={{ opacity: 0.65, fontSize: 11 }}>({field.key})</span>
                            </label>
                            {field.type === 'boolean' ? (
                              <label className="checkbox-row">
                                <input
                                  id={`mcprop-${field.key}`}
                                  type="checkbox"
                                  checked={val === 'true'}
                                  onChange={(e) =>
                                    setPropsMap((prev) => ({ ...prev, [field.key]: e.target.checked ? 'true' : 'false' }))
                                  }
                                />
                                <span>{val === 'true' ? 'Enabled (true)' : 'Disabled (false)'}</span>
                              </label>
                            ) : field.type === 'select' && field.options ? (
                              <select
                                id={`mcprop-${field.key}`}
                                className="select"
                                value={val || field.options[0]}
                                onChange={(e) => setPropsMap((prev) => ({ ...prev, [field.key]: e.target.value }))}
                              >
                                {field.options.map((opt) => (
                                  <option key={opt} value={opt}>
                                    {opt}
                                  </option>
                                ))}
                              </select>
                            ) : (
                              <input
                                id={`mcprop-${field.key}`}
                                type={field.type === 'number' ? 'number' : 'text'}
                                className="input"
                                value={val}
                                onChange={(e) => setPropsMap((prev) => ({ ...prev, [field.key]: e.target.value }))}
                              />
                            )}
                          </div>
                        );
                      })}
                    </div>
                  </div>
                </section>
              ))}

              {/* Advanced / Other / Modded Properties */}
              <section className="panel">
                <div className="panel-header" style={{ flexWrap: 'wrap', gap: 10 }}>
                  <h2>Advanced &amp; Other Properties ({extraKeys.length})</h2>
                  <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                    <Search size={13} color="var(--text-muted)" />
                    <input
                      className="input"
                      style={{ padding: '5px 10px', fontSize: 12.5, width: 220 }}
                      placeholder="Filter keys..."
                      value={search}
                      onChange={(e) => setSearch(e.target.value)}
                    />
                  </div>
                </div>
                <div className="panel-body">
                  <div className="form-grid">
                    {extraKeys.map((key) => {
                      const isLocked = managedKeySet.has(key);
                      return (
                        <div key={key} className="field">
                          <label htmlFor={`mcprop-extra-${key}`} style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                            <span className="mono">{key}</span>
                            {isLocked && (
                              <span
                                style={{
                                  display: 'inline-flex',
                                  alignItems: 'center',
                                  gap: 3,
                                  fontSize: 10.5,
                                  color: 'var(--accent)',
                                }}
                                title="Managed by ServerForge to keep ports & RCON working"
                              >
                                <Lock size={10} /> Managed
                              </span>
                            )}
                          </label>
                          <input
                            id={`mcprop-extra-${key}`}
                            type={key === 'rcon.password' ? 'password' : 'text'}
                            className="input mono"
                            disabled={isLocked}
                            value={propsMap[key] ?? ''}
                            onChange={(e) => setPropsMap((prev) => ({ ...prev, [key]: e.target.value }))}
                          />
                        </div>
                      );
                    })}
                  </div>

                  {/* Add custom / modded key */}
                  <div
                    style={{
                      marginTop: 16,
                      paddingTop: 14,
                      borderTop: '1px solid var(--border-subtle)',
                      display: 'flex',
                      gap: 8,
                      flexWrap: 'wrap',
                      alignItems: 'center',
                    }}
                  >
                    <input
                      className="input mono"
                      style={{ maxWidth: 220 }}
                      placeholder="Custom property key"
                      value={newKey}
                      onChange={(e) => setNewKey(e.target.value)}
                    />
                    <input
                      className="input mono"
                      style={{ maxWidth: 220 }}
                      placeholder="Value"
                      value={newVal}
                      onChange={(e) => setNewVal(e.target.value)}
                    />
                    <button
                      type="button"
                      className="btn btn-sm"
                      disabled={!newKey.trim() || managedKeySet.has(newKey.trim())}
                      onClick={() => {
                        const k = newKey.trim();
                        if (!k) return;
                        setPropsMap((prev) => ({ ...prev, [k]: newVal }));
                        setNewKey('');
                        setNewVal('');
                      }}
                    >
                      <Plus size={13} /> Add Property
                    </button>
                  </div>
                </div>
              </section>
            </>
          )}
        </>
      )}
    </div>
  );
}
