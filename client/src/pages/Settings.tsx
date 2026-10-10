import { useState } from 'react';
import { LocalAccessSettings } from '../components/LocalAccessSettings.js';
import { deleteDatabase, docDbName, syncDbName } from '../core/syncStore.js';
import { evictSession, peekSession } from '../core/sessionRegistry.js';
import { navigate } from '../router.js';
import { PALETTE, useVaultList } from '../store/vaultList.js';

export function Settings() {
  const { settings, setSettings, vaults, removeVault } = useVaultList();
  const [secretDraft, setSecretDraft] = useState(settings.createSecret ?? '');

  const leave = async (id: string, name: string): Promise<void> => {
    if (!confirm(`Remove "${name}" from this device? Other devices keep their copy. You can rejoin with a code or link.`)) return;
    const s = await evictSession(id);
    if (s) await s.wipeLocal();
    else {
      await deleteDatabase(docDbName('', id));
      await deleteDatabase(syncDbName('', id));
    }
    removeVault(id);
  };

  const toggleHttp = (forceHttp: boolean): void => {
    setSettings({ forceHttp });
    for (const v of vaults) peekSession(v.id)?.reconnect();
  };

  const updateUser = (patch: { deviceName?: string; color?: string }): void => {
    setSettings(patch);
    const { deviceName, color } = { ...settings, ...patch };
    for (const v of vaults) peekSession(v.id)?.setUser({ name: deviceName, color });
  };

  return (
    <div className="page settings">
      <header className="home-head">
        <button className="icon-btn" onClick={() => navigate('/')} aria-label="Back">
          ←
        </button>
        <h1>Settings</h1>
      </header>

      <section className="stack">
        <h2>This device</h2>
        <label className="field">
          <span>Name shown to collaborators</span>
          <input value={settings.deviceName} onChange={(e) => updateUser({ deviceName: e.target.value })} />
        </label>
        <div className="field">
          <span>Cursor color</span>
          <div className="swatches">
            {PALETTE.map((c) => (
              <button
                key={c}
                className={`swatch${settings.color === c ? ' active' : ''}`}
                style={{ background: c }}
                onClick={() => updateUser({ color: c })}
                aria-label={`Use color ${c}`}
              />
            ))}
          </div>
        </div>
      </section>

      <LocalAccessSettings />

      <section className="stack">
        <h2>Server</h2>
        <label className="toggle">
          <input type="checkbox" checked={settings.forceHttp} onChange={(e) => toggleHttp(e.target.checked)} data-testid="force-http" />
          <span>
            <strong>WebSocket-free mode</strong>
            <br />
            <small className="muted">Always use HTTP long-polling. Turn on if your network blocks WebSockets. Otherwise Notepad falls back automatically.</small>
          </span>
        </label>
        <label className="field">
          <span>Secret needed for vault creation</span>
          <input type="password" value={secretDraft} onChange={(e) => setSecretDraft(e.target.value)} onBlur={() => setSettings({ createSecret: secretDraft || null })} />
          <small className="muted">Needed only to create new vaults on this server.</small>
        </label>
      </section>

      <section className="stack">
        <h2>Vaults on this device</h2>
        {vaults.length === 0 && <p className="muted">None.</p>}
        <ul className="plain-list">
          {vaults.map((v) => (
            <li key={v.id} className="row-between">
              <span>{v.name || 'Untitled vault'}</span>
              <button className="danger" onClick={() => void leave(v.id, v.name)}>
                Leave
              </button>
            </li>
          ))}
        </ul>
      </section>

      <p className="muted small">Notepad · end-to-end encrypted · {__APP_VERSION__}</p>
    </div>
  );
}
