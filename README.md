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

Two deployment paths are supported: a Docker image, or a plain Node.js process managed by pm2.
Either way, put a TLS-terminating reverse proxy in front for anything beyond localhost: service
workers and WebCrypto require a secure context. The proxy must allow WebSocket upgrades on `/ws`
and keep idle HTTP connections open for at least 30 s (long-polls wait up to 25 s). Set
`NOTEPAD_TRUST_PROXY=1` so rate limiting sees client addresses.

### Option A: Docker

```bash
cp .env.example .env            # set NOTEPAD_CREATE_SECRET
docker compose up --build       # http://localhost:3000
```

### Option B: build locally, copy a bundle over SSH, run with pm2

The server bundle is self-contained (dependencies are compiled in), so the target machine needs
only Node.js and pm2. No `npm install` happens on the server.

**On the server, once**

```bash
# Node.js 24 or newer (node:sqlite is built in) and pm2
curl -fsSL https://deb.nodesource.com/setup_24.x | sudo -E bash - && sudo apt-get install -y nodejs
sudo npm install -g pm2

# Deploy directory: releases/ holds bundles, current -> active release, shared/ survives releases
sudo mkdir -p /srv/notepad/releases /srv/notepad/shared/data /srv/notepad/shared/logs
sudo chown -R "$USER" /srv/notepad

# Secrets and settings live outside the releases; Node loads this file itself
cat > /srv/notepad/shared/.env <<'ENV'
NOTEPAD_CREATE_SECRET=replace-with-a-long-random-string
PORT=3000
NOTEPAD_TRUST_PROXY=1
ENV
chmod 600 /srv/notepad/shared/.env
```

A good secret: `node -e "console.log(require('node:crypto').randomBytes(18).toString('base64url'))"`.
Devices need it once to create vaults; joining a vault never needs it.

**On your machine, for every release**

```bash
npm run bundle                           # builds client + server, prints dist/notepad-<version>-<stamp>.tar.gz
scp dist/notepad-0.1.0-20261006150302.tar.gz user@host:/srv/notepad/releases/
```

**On the server, for every release**

```bash
cd /srv/notepad/releases
release=notepad-0.1.0-20261006150302                       # the file you just uploaded
mkdir -p "$release" && tar -xzf "$release.tar.gz" -C "$release" --strip-components=1 && rm "$release.tar.gz"
ln -sfn "/srv/notepad/releases/$release" /srv/notepad/current

cd /srv/notepad/current
NOTEPAD_HOME=/srv/notepad pm2 startOrReload ecosystem.config.cjs --update-env
pm2 save                                                   # remember the process list across reboots
curl -fsS http://127.0.0.1:3000/api/health                 # {"ok":true}
```

The first time, also register pm2 as a system service so Notepad comes back after a reboot:

```bash
pm2 startup                              # prints one sudo command; run it
pm2 save
```

Useful afterwards: `pm2 status`, `pm2 logs notepad`, `pm2 reload notepad --update-env` (after editing
`shared/.env`), `pm2 stop notepad`. To roll back, point the `current` symlink at a previous release
directory and run the `pm2 startOrReload` command again. Old release directories can simply be deleted.

How the pieces fit: `ecosystem.config.cjs` (shipped in every bundle) runs `server/dist/index.js`
from `<NOTEPAD_HOME>/current` as a single fork-mode process, passes
`--env-file-if-exists=<NOTEPAD_HOME>/shared/.env` to Node, stores the SQLite database in
`<NOTEPAD_HOME>/shared/data` and logs in `<NOTEPAD_HOME>/shared/logs`. Keep it at one instance:
live-collaboration rooms are held in memory and SQLite has one writer. `NOTEPAD_HOME` defaults to
two directories above the ecosystem file, so it is only needed if you deviate from the layout above.

**Reverse proxy example (nginx)**

```nginx
map $http_upgrade $connection_upgrade { default upgrade; '' close; }

server {
    listen 443 ssl http2;
    server_name notes.example.com;
    # ssl_certificate / ssl_certificate_key ...

    location / {
        proxy_pass http://127.0.0.1:3000;
        proxy_http_version 1.1;
        proxy_set_header Host $host;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
        proxy_set_header Upgrade $http_upgrade;       # WebSocket on /ws
        proxy_set_header Connection $connection_upgrade;
        proxy_read_timeout 90s;                       # long-polls hold up to 25 s
        proxy_buffering off;
    }
}
```

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
npm run bundle                             # release tarball for the pm2 deployment path
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
