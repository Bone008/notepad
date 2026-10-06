# Notepad

A small self-hosted web app for shared markdown notes with live collaboration, where the
server only ever stores ciphertext.

- **Vaults** hold one or more markdown files. A vault starts with a single file in fullscreen "Code" mode.
- **End-to-end encrypted sync**: every change is a Yjs CRDT update encrypted on the device (AES-GCM) before it reaches the server. The server stores an opaque, append-only log per vault and never holds a key.
- **Live collaboration** with remote cursors and an online-device count. A refreshed tab keeps its identity, so it never shows up twice.
- **Add a device without passwords**: an existing device shows a one-time 12-character code (`K7QX-M2PA-9ZRT`), the new device types it. A QR code and a share link are offered too.
- **Offline first**: installable PWA; the document lives in IndexedDB and edits made offline are queued and pushed when the connection returns.
- **WebSocket-free mode**: WebSocket first, automatic fallback to HTTP long-polling, plus a setting that forces HTTP.
- **Stack**: TypeScript, React + Vite + CodeMirror 6 on the client, Express 5 + built-in `node:sqlite` on the server, one Docker image.

## Run it

```bash
cp .env.example .env            # set NOTEPAD_CREATE_SECRET
docker compose up --build       # http://localhost:3000
```

Put a TLS-terminating reverse proxy in front for anything beyond localhost: service workers and
WebCrypto require a secure context. The proxy must allow WebSocket upgrades on `/ws` and keep
idle HTTP connections open for at least 30 s (long-polls wait up to 25 s). Set
`NOTEPAD_TRUST_PROXY=1` so rate limiting sees client addresses.

### Environment

| Variable | Default | Purpose |
|---|---|---|
| `NOTEPAD_CREATE_SECRET` | required | Secret a device must enter once before it may create vaults. Joining never needs it. |
| `PORT` | `3000` | Listen port. |
| `NOTEPAD_DATA_DIR` | `./.data` (`/data` in Docker) | Where the SQLite database lives. |
| `NOTEPAD_DB` | `<data dir>/notepad.sqlite` | Database path, or `:memory:`. |
| `NOTEPAD_TRUST_PROXY` | `0` | Express `trust proxy` setting. |
| `NOTEPAD_MAX_UPDATE_BYTES` | 1 MiB | Largest single encrypted update. |
| `NOTEPAD_MAX_SNAPSHOT_BYTES` | 64 MiB | Largest encrypted snapshot. |
| `NOTEPAD_VAULT_QUOTA_BYTES` | 256 MiB | Storage per vault. |
| `NOTEPAD_LONGPOLL_MAX_WAIT_MS` | 25000 | Long-poll hold time. |
| `NOTEPAD_PAIR_TTL_SEC` | 600 | Lifetime of a pairing code. |
| `NOTEPAD_ALLOW_INSECURE_CREATE` | unset | Set to `1` to allow vault creation without a secret (local development only). |
| `NOTEPAD_RATE_LIMITS` | `1` | Set to `0` to disable rate limiting (tests). |

## Develop

```bash
npm install
NOTEPAD_CREATE_SECRET=dev npm run dev     # Express on :3000, Vite on :5173 (proxies /api and /ws)
npm run typecheck
npm test                                   # Vitest: shared, server, client (client tests run a real server in-process)
npm run build && npm run e2e               # Playwright: two browser contexts collaborate, pair by code, third context with blocked WebSockets
```

The repo is an npm workspace: `shared/` (crypto, pairing codes, protocol types), `server/`, `client/`.

## How it works

**Keys.** A vault has a random 32-byte key that exists only on devices (and inside share links,
after the `#`). From it, HKDF derives a content key (AES-GCM, encrypts updates, snapshots and
presence) and an auth token. The server stores only the SHA-256 of the token and uses it to
authorize reads and writes to that vault's log.

**Sync.** Each vault is an append-only log of encrypted Yjs updates with a per-vault sequence
number. Clients keep a cursor, fetch everything after it on connect, and push local edits from an
outbox that lives in IndexedDB next to the document. Because the server cannot merge ciphertext,
clients periodically upload an encrypted full-state snapshot and the server drops the updates it
covers. A stored "last clean sync" state vector lets a client re-derive anything the server might
lack after a crash.

**Transports.** One JSON message protocol runs over either a WebSocket (`/ws`) or REST + long-poll
(`GET /api/vaults/:id/events`). The client tries WebSocket for four seconds and otherwise uses
HTTP for the rest of the session; Settings has a switch to force HTTP.

**Pairing.** The existing device generates a 60-bit code, derives a lookup id and a wrapping key
from it (PBKDF2 then HKDF), and posts the vault key encrypted under that wrapping key. The new
device derives the same values from the typed code and fetches the record once; it is deleted on
read and expires after ten minutes. The QR code and the link carry the full key directly.

## Security notes and limitations

- Anyone holding a share link, or a pairing code during its window, has full read/write access to
  the vault. There is no per-device revocation: leaving a vault only removes it from that device.
  To exclude someone, create a new vault and move the content.
- The server operator sees vault ids, ciphertext sizes and timing, and which devices are online.
  Content, file names and vault names are encrypted.
- A malicious server could in principle brute-force a pairing code offline during its ten-minute
  window; PBKDF2 makes each guess expensive and the record is purged on claim or expiry.
- The pairing endpoints are rate-limited per IP; put the real client address in `X-Forwarded-For`
  and set `NOTEPAD_TRUST_PROXY` when proxying.
- The PWA updates itself in the background; a page reload may happen shortly after a deploy.
  Edits are already persisted locally when that happens.
