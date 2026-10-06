import type { SessionStatus } from '../core/provider.js';

const LABEL: Record<SessionStatus['state'], string> = {
  offline: 'Offline',
  connecting: 'Connecting',
  syncing: 'Syncing',
  synced: 'Synced',
  unauthorized: 'Not on server',
  wrongKey: 'Wrong key',
};

export function StatusIndicator({ status }: { status: SessionStatus }) {
  const transport = status.transport === 'http' ? 'HTTP' : status.transport === 'ws' ? 'WebSocket' : 'no connection';
  const pending = status.pending > 0 ? ` · ${status.pending} pending` : '';
  const title = `${LABEL[status.state]} via ${transport}${pending}${status.quotaExceeded ? ' · vault quota exceeded' : ''}`;
  return (
    <span className={`status status-${status.state}`} title={title} data-testid="status" data-transport={status.transport ?? ''}>
      <span className="status-dot" />
      <span className="status-text">
        {LABEL[status.state]}
        {status.transport === 'http' && <span className="status-badge">HTTP</span>}
        {status.pending > 0 && <span className="status-badge">{status.pending}</span>}
      </span>
    </span>
  );
}
