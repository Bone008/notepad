import { useState, type FormEvent } from 'react';
import { turnOffLocalLock, turnOnLocalLock, useLockEnabled } from '../core/localAccess.js';
import { LockButton } from './LockButton.js';

const MIN_PASSWORD_LENGTH = 8;

export function LocalAccessSettings() {
  const enabled = useLockEnabled();
  const [form, setForm] = useState(false);

  return (
    <section className="stack" data-testid="local-access">
      <div className="row-between">
        <h2>Local access control</h2>
        <LockButton />
      </div>
      {enabled ? (
        <>
          <p className="muted">
            <strong className="ok">On.</strong> Vault keys, documents and settings stored in this browser are encrypted with your local password. The key is kept in
            this tab's memory only: logging out, reloading, closing the tab or opening a new one asks for the password again.
          </p>
          {form ? (
            <DisableForm onClose={() => setForm(false)} />
          ) : (
            <div>
              <button onClick={() => setForm(true)}>Turn off…</button>
            </div>
          )}
        </>
      ) : (
        <>
          <p className="muted">
            Protect everything Notepad stores in this browser with a password. It is kept in memory only, so every new tab and every reload asks for it.
          </p>
          {form ? (
            <EnableForm onClose={() => setForm(false)} />
          ) : (
            <div>
              <button onClick={() => setForm(true)} data-testid="lock-enable">
                Protect with a password…
              </button>
            </div>
          )}
        </>
      )}
    </section>
  );
}

function EnableForm({ onClose }: { onClose: () => void }) {
  const [password, setPassword] = useState('');
  const [confirmation, setConfirmation] = useState('');
  const [understood, setUnderstood] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const tooShort = password.length < MIN_PASSWORD_LENGTH;
  const mismatch = confirmation !== password;

  const submit = async (e: FormEvent): Promise<void> => {
    e.preventDefault();
    if (tooShort || mismatch || !understood) return;
    setBusy(true);
    setError(null);
    try {
      await turnOnLocalLock(password);
      onClose();
    } catch (err) {
      console.error(err);
      setError('Could not encrypt local data. Reload and try again.');
      setBusy(false);
    }
  };

  return (
    <form className="stack" onSubmit={(e) => void submit(e)}>
      <div className="warning" role="alert">
        <strong>You must not forget this password.</strong> It cannot be reset or recovered, not even by the server, which never sees your keys. Without it this device cannot open
        its vaults any more. If no linked device can still open a vault, because each one is locked with a forgotten password, erased or lost, the vault contents are gone for
        good: the server only holds ciphertext.
      </div>
      <label className="field">
        <span>Local password (at least {MIN_PASSWORD_LENGTH} characters)</span>
        <input type="password" autoComplete="new-password" value={password} onChange={(e) => setPassword(e.target.value)} data-testid="lock-password" />
      </label>
      <label className="field">
        <span>Repeat password</span>
        <input type="password" autoComplete="new-password" value={confirmation} onChange={(e) => setConfirmation(e.target.value)} data-testid="lock-password-repeat" />
        {confirmation && mismatch && <small className="error">The passwords do not match.</small>}
      </label>
      <label className="toggle">
        <input type="checkbox" checked={understood} onChange={(e) => setUnderstood(e.target.checked)} data-testid="lock-understood" />
        <span>I understand that there is no way to recover this password, and that vault contents are lost if no linked device can access its stored key any more.</span>
      </label>
      {error && <p className="error">{error}</p>}
      <div className="row-end">
        <button type="button" onClick={onClose} disabled={busy}>
          Cancel
        </button>
        <button className="primary" type="submit" disabled={busy || tooShort || mismatch || !understood} data-testid="lock-submit">
          {busy ? 'Encrypting…' : 'Turn on'}
        </button>
      </div>
    </form>
  );
}

function DisableForm({ onClose }: { onClose: () => void }) {
  const [password, setPassword] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const submit = async (e: FormEvent): Promise<void> => {
    e.preventDefault();
    if (!password) return;
    setBusy(true);
    setError(null);
    try {
      if (await turnOffLocalLock(password)) {
        onClose();
      } else {
        setError('Wrong password.');
        setBusy(false);
      }
    } catch (err) {
      console.error(err);
      setError('Could not decrypt local data. Reload and try again.');
      setBusy(false);
    }
  };

  return (
    <form className="stack" onSubmit={(e) => void submit(e)}>
      <p className="muted">Local data will be stored unencrypted again. Enter the current password to confirm.</p>
      <label className="field">
        <span>Local password</span>
        <input type="password" autoComplete="current-password" value={password} onChange={(e) => setPassword(e.target.value)} />
      </label>
      {error && <p className="error">{error}</p>}
      <div className="row-end">
        <button type="button" onClick={onClose} disabled={busy}>
          Cancel
        </button>
        <button className="danger" type="submit" disabled={busy || !password}>
          {busy ? 'Decrypting…' : 'Turn off'}
        </button>
      </div>
    </form>
  );
}
