import { useEffect, useState } from 'react';
import { deriveVaultKeys, fromBase64Url } from '@notepad/shared';
import { Editor } from '../components/Editor.js';
import { FileSidebar } from '../components/FileSidebar.js';
import { LockButton } from '../components/LockButton.js';
import { Presence } from '../components/Presence.js';
import { ShareMenu } from '../components/ShareMenu.js';
import { StatusIndicator } from '../components/StatusIndicator.js';
import { Viewer } from '../components/Viewer.js';
import { ApiError, createVaultOnServer } from '../core/api.js';
import { setVaultName } from '../core/files.js';
import { useFileText, useFiles, usePeers, useSessionStatus, useVaultName, useVaultSession, useYTextString } from '../hooks/useVaultSession.js';
import { navigate, vaultPath } from '../router.js';
import { useVault, useVaultList } from '../store/vaultList.js';

export function VaultView({ vaultId, fileId }: { vaultId: string; fileId: string | null }) {
  const record = useVault(vaultId);
  if (!record) {
    return (
      <div className="page">
        <header className="home-head">
          <button className="icon-btn" onClick={() => navigate('/')} aria-label="Back to vaults">
            ←
          </button>
          <h1>Vault not found</h1>
        </header>
        <div className="stack" data-testid="vault-missing">
          <p className="error">This vault is not on this device.</p>
          <p className="muted">
            Links to a file only work on devices that have already joined the vault. To add this device, use a pairing code, QR code or join link
            from a device that has the vault (Share → Add a device).
          </p>
          <div>
            <button className="primary" onClick={() => navigate('/')}>
              Go to my vaults
            </button>
          </div>
        </div>
      </div>
    );
  }
  return <VaultInner vaultId={vaultId} keyB64={record.keyB64} fileId={fileId} />;
}

function VaultInner({ vaultId, keyB64, fileId }: { vaultId: string; keyB64: string; fileId: string | null }) {
  const { session, ready } = useVaultSession(vaultId, keyB64);
  const status = useSessionStatus(session);
  const doc = ready && session ? session.doc : null;
  const files = useFiles(doc);
  const vaultName = useVaultName(doc);
  const peers = usePeers(ready && session ? session.awareness : null);
  const touchVault = useVaultList((s) => s.touchVault);
  const settings = useVaultList((s) => s.settings);
  const setSettings = useVaultList((s) => s.setSettings);
  const [mode, setMode] = useState<'code' | 'view'>('code');
  const [sidebar, setSidebar] = useState(false);
  const [share, setShare] = useState(false);
  const [recreateError, setRecreateError] = useState<string | null>(null);

  const activeId = fileId && files.some((f) => f.id === fileId) ? fileId : (files[0]?.id ?? null);
  const text = useFileText(doc, activeId);
  const rendered = useYTextString(mode === 'view' ? text : null);

  useEffect(() => {
    touchVault(vaultId, vaultName || undefined);
  }, [vaultId, vaultName, touchVault]);

  useEffect(() => {
    if (!session) return;
    // Leave on unload/refresh; come back when restored from the back/forward cache.
    const onHide = (): void => void session.leavePresence();
    const onShow = (e: PageTransitionEvent): void => {
      if (e.persisted) session.announce();
    };
    window.addEventListener('pagehide', onHide);
    window.addEventListener('pageshow', onShow);
    return () => {
      window.removeEventListener('pagehide', onHide);
      window.removeEventListener('pageshow', onShow);
    };
  }, [session]);

  const rename = (): void => {
    if (!doc) return;
    const name = prompt('Vault name', vaultName);
    if (name && name.trim()) setVaultName(doc, name.trim());
  };

  const recreateOnServer = async (): Promise<void> => {
    const secret = settings.createSecret ?? prompt('Server create secret');
    if (!secret || !session) return;
    try {
      const keys = await deriveVaultKeys(vaultId, fromBase64Url(keyB64));
      await createVaultOnServer('', vaultId, keys.authToken, secret);
      setSettings({ createSecret: secret });
      setRecreateError(null);
      session.reconnect();
    } catch (e) {
      setRecreateError(e instanceof ApiError && e.status === 401 ? 'Wrong create secret.' : 'Could not re-create the vault on the server.');
    }
  };

  let body;
  if (!ready || !doc) {
    body = <div className="center-msg muted">Opening vault…</div>;
  } else if (status.state === 'wrongKey') {
    body = <div className="center-msg error">This device's key does not match the vault on the server. Leave the vault and join it again.</div>;
  } else if (files.length === 0) {
    body = (
      <div className="center-msg stack">
        <p className="muted">Waiting for the first sync from the server…</p>
        {status.state === 'unauthorized' && (
          <>
            <p className="error">The server does not know this vault. If the server was reset, you can re-create it with the create secret.</p>
            <button onClick={() => void recreateOnServer()}>Re-create on server</button>
            {recreateError && <p className="error">{recreateError}</p>}
          </>
        )}
      </div>
    );
  } else if (text && session) {
    body = mode === 'code' ? <Editor key={activeId} text={text} awareness={session.awareness} /> : <Viewer text={rendered} />;
  } else {
    body = <div className="center-msg muted">File not found.</div>;
  }

  const activeFile = files.find((f) => f.id === activeId);

  return (
    <div className={`vault${sidebar ? ' with-sidebar' : ''}`}>
      <header className="vault-head">
        <button className="icon-btn" onClick={() => navigate('/')} aria-label="Back to vaults" title="Back">
          ←
        </button>
        <button className="icon-btn" onClick={() => setSidebar((s) => !s)} aria-label="Toggle files" title="Files" data-testid="toggle-sidebar">
          ☰
        </button>
        <button className="vault-title" onClick={rename} title="Rename vault" data-testid="vault-title">
          {vaultName || 'Untitled vault'}
          {activeFile && <span className="muted"> / {activeFile.name}</span>}
        </button>
        <div className="spacer" />
        <StatusIndicator status={status} />
        <Presence peers={peers} />
        {status.state === 'unauthorized' && files.length > 0 && (
          <button className="small-btn" onClick={() => void recreateOnServer()} title="The server does not know this vault">
            Re-create on server
          </button>
        )}
        <button className="small-btn" onClick={() => setShare(true)} data-testid="share">
          Share
        </button>
        <div className="segmented" role="tablist">
          <button role="tab" aria-selected={mode === 'code'} className={mode === 'code' ? 'active' : ''} onClick={() => setMode('code')} data-testid="mode-code">
            Code
          </button>
          <button role="tab" aria-selected={mode === 'view'} className={mode === 'view' ? 'active' : ''} onClick={() => setMode('view')} data-testid="mode-view">
            View
          </button>
        </div>
        <LockButton />
      </header>
      <div className="vault-body">
        {sidebar && doc && (
          <FileSidebar
            doc={doc}
            files={files}
            activeId={activeId}
            onSelect={(id) => {
              navigate(vaultPath(vaultId, id), true);
              if (window.innerWidth < 720) setSidebar(false);
            }}
          />
        )}
        <main className="vault-main">{body}</main>
      </div>
      {share && (
        <ShareMenu
          vaultId={vaultId}
          keyB64={keyB64}
          vaultName={vaultName}
          fileId={activeId}
          fileName={activeFile?.name ?? null}
          onClose={() => setShare(false)}
        />
      )}
    </div>
  );
}
