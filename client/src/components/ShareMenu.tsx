import { useEffect, useState } from 'react';
import { QRCodeSVG } from 'qrcode.react';
import {
  buildJoinLink,
  derivePairingKeys,
  formatPairingCode,
  generatePairingCode,
  wrapPairingPayload,
} from '@notepad/shared';
import { pairingClaimed, postPairing } from '../core/api.js';
import { Modal } from './Modal.js';

type Tab = 'code' | 'qr' | 'link';

interface ActiveCode {
  code: string;
  lookupId: string;
  expiresAt: number;
}

export function ShareMenu({ vaultId, keyB64, vaultName, onClose }: { vaultId: string; keyB64: string; vaultName: string; onClose: () => void }) {
  const [tab, setTab] = useState<Tab>('code');
  const [active, setActive] = useState<ActiveCode | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [claimed, setClaimed] = useState(false);
  const [now, setNow] = useState(Date.now());
  const [copied, setCopied] = useState(false);
  const link = buildJoinLink(location.origin, { vaultId, keyB64 });

  const generate = async (): Promise<void> => {
    setBusy(true);
    setError(null);
    setClaimed(false);
    try {
      const code = generatePairingCode();
      const keys = await derivePairingKeys(code);
      const blob = await wrapPairingPayload(keys, { v: 1, vaultId, key: keyB64, name: vaultName });
      const { expiresAt } = await postPairing('', keys.lookupId, blob);
      setActive({ code, lookupId: keys.lookupId, expiresAt });
    } catch {
      setError('Could not create a pairing code. Are you online?');
    } finally {
      setBusy(false);
    }
  };

  useEffect(() => {
    if (tab === 'code' && !active && !busy && !error) void generate();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tab]);

  useEffect(() => {
    if (!active || claimed) return;
    const t = setInterval(() => {
      setNow(Date.now());
      void pairingClaimed('', active.lookupId).then((c) => {
        if (c) setClaimed(true);
        if (c === null) setActive(null);
      });
    }, 3000);
    return () => clearInterval(t);
  }, [active, claimed]);

  const secondsLeft = active ? Math.max(0, Math.round((active.expiresAt - now) / 1000)) : 0;

  const copy = async (): Promise<void> => {
    try {
      await navigator.clipboard.writeText(link);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      prompt('Copy this link', link);
    }
  };

  return (
    <Modal title="Add a device" onClose={onClose}>
      <div className="tabs" role="tablist">
        {(['code', 'qr', 'link'] as Tab[]).map((t) => (
          <button key={t} role="tab" aria-selected={tab === t} className={tab === t ? 'active' : ''} onClick={() => setTab(t)}>
            {t === 'code' ? 'Pairing code' : t === 'qr' ? 'QR code' : 'Link'}
          </button>
        ))}
      </div>

      {tab === 'code' && (
        <div className="stack center">
          <p className="muted">On the other device open Notepad, choose “Join with code” and type:</p>
          {active ? (
            <>
              <div className="pairing-code" data-testid="pairing-code">
                {formatPairingCode(active.code)}
              </div>
              <p className="muted">
                {claimed ? (
                  <strong className="ok">A device joined with this code.</strong>
                ) : (
                  <>Valid for {Math.floor(secondsLeft / 60)}:{String(secondsLeft % 60).padStart(2, '0')} · single use</>
                )}
              </p>
            </>
          ) : (
            <div className="pairing-code muted">{busy ? '…' : '— — —'}</div>
          )}
          {error && <p className="error">{error}</p>}
          <button onClick={() => void generate()} disabled={busy}>
            New code
          </button>
        </div>
      )}

      {tab === 'qr' && (
        <div className="stack center">
          <p className="muted">Scan with the other device's camera. The QR code contains the vault key.</p>
          <div className="qr">
            <QRCodeSVG value={link} size={224} marginSize={2} />
          </div>
        </div>
      )}

      {tab === 'link' && (
        <div className="stack">
          <p className="muted">
            Anyone with this link can read and edit the vault. The part after <code>#</code> is the key and is never sent to the server.
          </p>
          <input readOnly value={link} onFocus={(e) => e.target.select()} data-testid="join-link" />
          <div className="row-end">
            <button className="primary" onClick={() => void copy()}>
              {copied ? 'Copied' : 'Copy link'}
            </button>
          </div>
        </div>
      )}
    </Modal>
  );
}
