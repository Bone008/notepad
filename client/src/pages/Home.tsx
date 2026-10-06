import { useState } from 'react';
import { CreateVaultDialog } from '../components/CreateVaultDialog.js';
import { Modal } from '../components/Modal.js';
import { PairingCodeInput } from '../components/PairingCodeInput.js';
import { navigate, vaultPath } from '../router.js';
import { useVaultList } from '../store/vaultList.js';

export function Home() {
  const vaults = useVaultList((s) => s.vaults);
  const [dialog, setDialog] = useState<'create' | 'join' | null>(null);

  return (
    <div className="page home">
      <header className="home-head">
        <h1>Notepad</h1>
        <button className="icon-btn" title="Settings" aria-label="Settings" onClick={() => navigate('/settings')}>
          ⚙
        </button>
      </header>

      <div className="home-actions">
        <button className="primary" onClick={() => setDialog('create')} data-testid="new-vault">
          New vault
        </button>
        <button onClick={() => setDialog('join')} data-testid="join-vault">
          Join with code or link
        </button>
      </div>

      {vaults.length === 0 ? (
        <p className="muted empty">
          No vaults on this device yet. Create one, or join a vault from another device with its pairing code, QR code or link.
        </p>
      ) : (
        <ul className="vault-list" data-testid="vault-list">
          {vaults.map((v) => (
            <li key={v.id}>
              <button className="vault-card" onClick={() => navigate(vaultPath(v.id))}>
                <span className="vault-name">{v.name || 'Untitled vault'}</span>
                <span className="muted small">{new Date(v.lastOpened).toLocaleString()}</span>
              </button>
            </li>
          ))}
        </ul>
      )}

      {dialog === 'create' && <CreateVaultDialog onClose={() => setDialog(null)} />}
      {dialog === 'join' && (
        <Modal title="Join a vault" onClose={() => setDialog(null)}>
          <PairingCodeInput onDone={() => setDialog(null)} />
        </Modal>
      )}
    </div>
  );
}
