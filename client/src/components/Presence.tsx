import type { Peer } from '../hooks/useVaultSession.js';

export function Presence({ peers }: { peers: Peer[] }) {
  const shown = peers.slice(0, 5);
  return (
    <span className="presence" title={peers.map((p) => p.name + (p.self ? ' (you)' : '')).join(', ')} data-testid="presence" data-count={peers.length}>
      {shown.map((p) => (
        <span key={p.clientId} className="avatar" style={{ background: p.color }}>
          {p.name.slice(0, 1).toUpperCase()}
        </span>
      ))}
      {peers.length > shown.length && <span className="avatar avatar-more">+{peers.length - shown.length}</span>}
      <span className="presence-count">{peers.length} online</span>
    </span>
  );
}
