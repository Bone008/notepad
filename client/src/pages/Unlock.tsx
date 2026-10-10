import { useState, type FormEvent } from 'react';
import { eraseLocalData } from '../core/localData.js';
import { unlock } from '../core/localLock.js';

export function Unlock({ onUnlocked }: { onUnlocked: () => void }) {
  const [password, setPassword] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const submit = async (e: FormEvent): Promise<void> => {
    e.preventDefault();
    if (!password) return;
    setBusy(true);
    setError(null);
    try {
      if (await unlock(password)) onUnlocked();
      else setError('Wrong password.');
    } catch {
      setError('Could not unlock local data.');
    } finally {
      setBusy(false);
    }
  };

  const erase = async (): Promise<void> => {
    const ok = confirm(
      'Erase all Notepad data stored in this browser?\n\n' +
        'Vaults that no other device can still open are lost for good. This cannot be undone.',
    );
    if (!ok) return;
    await eraseLocalData();
    location.reload();
  };

  return (
    <div className="page unlock">
      <header className="home-head">
        <h1>Notepad is locked</h1>
      </header>
      <form className="stack" onSubmit={(e) => void submit(e)}>
        <p className="muted">Local data on this device is protected. Enter the local password to open it. It is kept in memory only, until you log out, reload or close this tab.</p>
        <label className="field">
          <span>Local password</span>
          <input type="password" autoFocus autoComplete="current-password" value={password} onChange={(e) => setPassword(e.target.value)} data-testid="unlock-password" />
        </label>
        {error && <p className="error">{error}</p>}
        <div className="row-end">
          <button className="primary" type="submit" disabled={busy || !password} data-testid="unlock-submit">
            {busy ? 'Unlocking…' : 'Unlock'}
          </button>
        </div>
      </form>
      <p className="muted small">
        Forgot the password? It cannot be recovered.{' '}
        <button className="danger small-btn" onClick={() => void erase()}>
          Erase local data
        </button>
      </p>
    </div>
  );
}
