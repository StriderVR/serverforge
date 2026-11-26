import React from 'react';
import { Clock, Shield } from 'lucide-react';
import type { SystemSettings } from '@serverforge/shared';

interface GeneralGuardrailsTabProps {
  settings: SystemSettings;
  onChange: (patch: Partial<SystemSettings>) => void;
}

export function GeneralGuardrailsTab({ settings, onChange }: GeneralGuardrailsTabProps) {
  return (
    <div className="settings-grid-two">
      <section className="panel">
        <div className="panel-header">
          <h2 style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
            <Shield size={16} /> Host Resource Guardrails
          </h2>
        </div>
        <div className="panel-body">
          <p className="settings-card-desc">
            Protect your server PC from RAM exhaustion when friends boot multiple game servers simultaneously.
          </p>
          <div className="form-grid">
            <div className="field">
              <label htmlFor="set-max-concurrent">Max Concurrent Running Servers</label>
              <input
                id="set-max-concurrent"
                type="number"
                min={1}
                max={32}
                className="input tabular"
                value={settings.maxConcurrentServers}
                onChange={(e) => onChange({ maxConcurrentServers: Number(e.target.value) })}
              />
              <span className="field-hint">Hard cap on how many servers can run at once.</span>
            </div>

            <div className="field">
              <label htmlFor="set-ram-reserve">Host OS RAM Reserve (GB)</label>
              <input
                id="set-ram-reserve"
                type="number"
                min={1}
                max={64}
                className="input tabular"
                value={settings.hostRamReserveGb}
                onChange={(e) => onChange({ hostRamReserveGb: Number(e.target.value) })}
              />
              <span className="field-hint">Always kept free so Windows 11 stays responsive.</span>
            </div>

            <div className="field full">
              <label htmlFor="set-github-repo">GitHub Releases Repository (for App Updates)</label>
              <input
                id="set-github-repo"
                className="input mono"
                value={settings.githubRepo}
                onChange={(e) => onChange({ githubRepo: e.target.value })}
              />
              <span className="field-hint">
                Default: <code className="mono">StriderVR/serverforge</code>
              </span>
            </div>
          </div>
        </div>
      </section>

      <section className="panel">
        <div className="panel-header">
          <h2 style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
            <Clock size={16} /> Temporary Leases &amp; Idle Shutdown
          </h2>
        </div>
        <div className="panel-body">
          <p className="settings-card-desc">
            Control how long temporary Discord or web-booted sessions run and when empty servers save and shut down.
          </p>
          <div className="form-grid">
            <div className="field">
              <label htmlFor="set-default-lease">Default Temporary Lease (minutes)</label>
              <input
                id="set-default-lease"
                type="number"
                min={15}
                max={1440}
                className="input tabular"
                value={settings.defaultLeaseMinutes}
                onChange={(e) => onChange({ defaultLeaseMinutes: Number(e.target.value) })}
              />
            </div>

            <div className="field">
              <label htmlFor="set-max-lease">Max Temporary Lease Cap (minutes)</label>
              <input
                id="set-max-lease"
                type="number"
                min={30}
                max={2880}
                className="input tabular"
                value={settings.maxLeaseMinutes}
                onChange={(e) => onChange({ maxLeaseMinutes: Number(e.target.value) })}
              />
            </div>

            <div className="field">
              <label htmlFor="set-idle">Idle Auto-Shutdown (minutes at 0 players)</label>
              <input
                id="set-idle"
                type="number"
                min={0}
                max={240}
                className="input tabular"
                value={settings.defaultIdleTimeoutMinutes}
                onChange={(e) => onChange({ defaultIdleTimeoutMinutes: Number(e.target.value) })}
              />
              <span className="field-hint">Set to 0 to disable idle shutdown.</span>
            </div>

            <div className="field">
              <label htmlFor="set-warn">Shutdown Warning Lead Time (minutes)</label>
              <input
                id="set-warn"
                type="number"
                min={1}
                max={60}
                className="input tabular"
                value={settings.warningBeforeStopMinutes}
                onChange={(e) => onChange({ warningBeforeStopMinutes: Number(e.target.value) })}
              />
              <span className="field-hint">Posted to Discord before auto-stopping a server.</span>
            </div>
          </div>
        </div>
      </section>
    </div>
  );
}
