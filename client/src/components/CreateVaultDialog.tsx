import { useState } from 'react';
import { deriveVaultKeys, generateVaultId, generateVaultKey, toBase64Url } from '@notepad/shared';
import { ApiError, createVaultOnServer } from '../core/api.js';
import { initVault } from '../core/files.js';
import { acquireSession, releaseSession } from '../core/sessionRegistry.js';
import { navigate, vaultPath } from '../router.js';
import { useVaultList } from '../store/vaultList.js';
import { Modal } from './Modal.js';

export function CreateVaultDialog({ onClose }: { onClose: () => void }) {
  const { settings, setSettings, addVault } = useVaultList();
  const [name, setName] = useState('My notes');
  const [secret, setSecret] = useState(settings.createSecret ?? '');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const create = async (): Promise<void> => {
    setBusy(true);
    setError(null);
    const vaultId = generateVaultId();
    const key = generateVaultKey();
    try {
      const keys = await deriveVaultKeys(vaultId, key);
      await createVaultOnServer('', vaultId, keys.authToken, secret);
      setSettings({ createSecret: secret });
      const keyB64 = toBase64Url(key);
      addVault({ id: vaultId, keyB64, name: name.trim() || 'Notes' });
      // Initialize the document on this device before anyone else can join, so joiners never
      // need to create a default file themselves.
      const session = acquireSession({
        vaultId,
        keyB64,
        forceHttp: () => useVaultList.getState().settings.forceHttp,
        user: () => ({ name: useVaultList.getState().settings.deviceName, color: useVaultList.getState().settings.color }),
      });
      await session.ready;
      initVault(session.doc, name.trim() || 'Notes');
      releaseSession(vaultId);
      onClose();
      navigate(vaultPath(vaultId));
    } catch (e) {
      if (e instanceof ApiError && e.status === 401) {
        setError('The server rejected the create secret.');
        setSettings({ createSecret: null });
      } else if (e instanceof ApiError && e.status === 0) {
        setError('Could not reach the server. You need to be online to create a vault.');
      } else {
        setError('Could not create the vault.');
      }
    } finally {
      setBusy(false);
    }
  };

  return (
    <Modal title="New vault" onClose={onClose}>
      <form
        className="stack"
        onSubmit={(e) => {
          e.preventDefault();
          void create();
        }}
      >
        <label className="field">
          <span>Vault name</span>
          <input autoFocus value={name} onChange={(e) => setName(e.target.value)} data-testid="vault-name" />
        </label>
        <label className="field">
          <span>Server create secret</span>
          <input
            type="password"
            value={secret}
            onChange={(e) => setSecret(e.target.value)}
            placeholder="Ask the server admin"
            data-testid="create-secret"
          />
          <small>Required once per device to create vaults. Joining an existing vault never needs it.</small>
        </label>
        {error && <p className="error">{error}</p>}
        <div className="row-end">
          <button type="submit" className="primary" disabled={busy || !secret} data-testid="create-submit">
            {busy ? 'Creating…' : 'Create'}
          </button>
        </div>
      </form>
    </Modal>
  );
}
