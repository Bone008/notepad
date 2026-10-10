import { logOut, useLockEnabled } from '../core/localAccess.js';

/** "Log out" of the local password; only shown when local access control is on. */
export function LockButton() {
  const enabled = useLockEnabled();
  if (!enabled) return null;
  return (
    <button className="icon-btn" onClick={() => void logOut()} title="Log out (lock this tab)" aria-label="Log out" data-testid="lock-tab">
      <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
        <path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4" />
        <polyline points="16 17 21 12 16 7" />
        <line x1="21" y1="12" x2="9" y2="12" />
      </svg>
    </button>
  );
}
