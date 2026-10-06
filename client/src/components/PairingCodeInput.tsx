import { useState } from 'react';
import {
  PAIR_CODE_LENGTH,
  derivePairingKeys,
  formatPairingCode,
  fromBase64Url,
  normalizePairingCode,
  parseJoinLink,
  unwrapPairingPayload,
} from '@notepad/shared';
import { claimPairing } from '../core/api.js';
import { navigate, vaultPath } from '../router.js';
import { useVaultList } from '../store/vaultList.js';

/** Live-formats typed codes as XXXX-XXXX-XXXX; leaves pasted links alone. */
function formatDraft(raw: string): string {
  if (raw.includes('#') || raw.includes('join=')) return raw;
  const cleaned = raw.toUpperCase().replace(/[^0-9A-Z]/g, '').slice(0, PAIR_CODE_LENGTH);
  return formatPairingCode(cleaned);
}

export function PairingCodeInput({ onDone }: { onDone: () => void }) {
  const [value, setValue] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const addVault = useVaultList((s) => s.addVault);

  const submit = async (): Promise<void> => {
    setError(null);
    const link = parseJoinLink(value);
    if (link) {
      addVault({ id: link.vaultId, keyB64: link.keyB64, name: 'Shared vault' });
      onDone();
      navigate(vaultPath(link.vaultId));
      return;
    }
    const code = normalizePairingCode(value);
    if (!code) {
      setError('Enter the 12-character code shown on your other device.');
      return;
    }
    setBusy(true);
    try {
      const keys = await derivePairingKeys(code);
      const blob = await claimPairing('', keys.lookupId);
      if (!blob) {
        setError('Code not found or expired. Codes are valid for 10 minutes and can be used once.');
        return;
      }
      const payload = await unwrapPairingPayload(keys, fromBase64Url(blob));
      addVault({ id: payload.vaultId, keyB64: payload.key, name: payload.name || 'Shared vault' });
      onDone();
      navigate(vaultPath(payload.vaultId));
    } catch (e) {
      setError(e instanceof Error && e.message === 'network' ? 'Could not reach the server.' : 'That code did not work. Check it and try again.');
    } finally {
      setBusy(false);
    }
  };

  return (
    <form
      className="stack"
      onSubmit={(e) => {
        e.preventDefault();
        void submit();
      }}
    >
      <label className="field">
        <span>Pairing code or link</span>
        <input
          className="code-input"
          autoFocus
          autoCapitalize="characters"
          autoCorrect="off"
          spellCheck={false}
          placeholder="XXXX-XXXX-XXXX"
          value={value}
          onChange={(e) => setValue(formatDraft(e.target.value))}
          data-testid="pair-input"
        />
      </label>
      {error && <p className="error">{error}</p>}
      <div className="row-end">
        <button type="submit" className="primary" disabled={busy || value.length === 0} data-testid="pair-submit">
          {busy ? 'Checking…' : 'Join vault'}
        </button>
      </div>
    </form>
  );
}
