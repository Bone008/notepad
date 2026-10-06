import type { ServerMessage } from '@notepad/shared';

export interface RoomClient {
  send(msg: ServerMessage): void;
}

interface Waiter {
  since: number;
  awSince: number;
  wake: () => void;
}

interface AwarenessFrame {
  tick: number;
  blob: string;
  at: number;
}

const AWARENESS_RING = 256;
const AWARENESS_TTL_MS = 60_000;

class Room {
  readonly clients = new Set<RoomClient>();
  readonly waiters = new Set<Waiter>();
  awareness: AwarenessFrame[] = [];
  awTick = 0;

  isEmpty(): boolean {
    return this.clients.size === 0 && this.waiters.size === 0 && this.awareness.length === 0;
  }
}

/** In-memory fan-out per vault: WebSocket clients, HTTP long-poll waiters, and an awareness ring buffer. */
export class Rooms {
  private rooms = new Map<string, Room>();

  private get(vaultId: string): Room {
    let r = this.rooms.get(vaultId);
    if (!r) {
      r = new Room();
      this.rooms.set(vaultId, r);
    }
    return r;
  }

  private maybeDrop(vaultId: string, room: Room): void {
    if (room.isEmpty()) this.rooms.delete(vaultId);
  }

  subscribe(vaultId: string, client: RoomClient): () => void {
    const room = this.get(vaultId);
    room.clients.add(client);
    return () => {
      room.clients.delete(client);
      this.maybeDrop(vaultId, room);
    };
  }

  broadcastUpdate(vaultId: string, seq: number, blob: string, exclude?: RoomClient): void {
    const room = this.rooms.get(vaultId);
    if (!room) return;
    const msg: ServerMessage = { t: 'update', seq, blob };
    for (const c of room.clients) if (c !== exclude) c.send(msg);
    for (const w of room.waiters) if (seq > w.since) w.wake();
  }

  publishAwareness(vaultId: string, blob: string, exclude?: RoomClient): number {
    const room = this.get(vaultId);
    const now = Date.now();
    room.awTick += 1;
    room.awareness.push({ tick: room.awTick, blob, at: now });
    this.prune(room, now);
    const msg: ServerMessage = { t: 'awareness', blob };
    for (const c of room.clients) if (c !== exclude) c.send(msg);
    for (const w of room.waiters) if (room.awTick > w.awSince) w.wake();
    return room.awTick;
  }

  awarenessSince(vaultId: string, awSince: number): { blobs: string[]; tick: number } {
    const room = this.rooms.get(vaultId);
    if (!room) return { blobs: [], tick: 0 };
    this.prune(room, Date.now());
    return { blobs: room.awareness.filter((f) => f.tick > awSince).map((f) => f.blob), tick: room.awTick };
  }

  /** Resolves when something newer than (since, awSince) arrives, on timeout, or when the signal aborts. */
  wait(vaultId: string, since: number, awSince: number, timeoutMs: number, signal?: AbortSignal): Promise<void> {
    const room = this.get(vaultId);
    return new Promise<void>((resolve) => {
      let timer: ReturnType<typeof setTimeout> | undefined;
      const finish = (): void => {
        clearTimeout(timer);
        signal?.removeEventListener('abort', onAbort);
        room.waiters.delete(waiter);
        this.maybeDrop(vaultId, room);
        resolve();
      };
      const onAbort = (): void => finish();
      const waiter: Waiter = { since, awSince, wake: finish };
      timer = setTimeout(finish, timeoutMs);
      room.waiters.add(waiter);
      signal?.addEventListener('abort', onAbort, { once: true });
    });
  }

  private prune(room: Room, now: number): void {
    const cutoff = now - AWARENESS_TTL_MS;
    let start = 0;
    while (start < room.awareness.length && (room.awareness[start]?.at ?? 0) < cutoff) start++;
    if (start > 0 || room.awareness.length > AWARENESS_RING) {
      room.awareness = room.awareness.slice(Math.max(start, room.awareness.length - AWARENESS_RING));
    }
  }

  /** For tests/metrics. */
  size(): number {
    return this.rooms.size;
  }
}
