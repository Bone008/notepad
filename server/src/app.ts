import http from 'node:http';
import express, { type ErrorRequestHandler } from 'express';
import helmet from 'helmet';
import type { WebSocketServer } from 'ws';
import type { Config } from './config.js';
import { Repo, openDatabase } from './db.js';
import { createLimiters } from './limits.js';
import { Rooms } from './rooms.js';
import { healthRouter } from './routes/health.js';
import { pairRouter } from './routes/pair.js';
import { vaultsRouter } from './routes/vaults.js';
import { serveClient } from './static.js';
import { attachWebSocket } from './ws.js';

export interface App {
  app: express.Express;
  server: http.Server;
  wss: WebSocketServer;
  repo: Repo;
  rooms: Rooms;
  close(): Promise<void>;
}

export function createApp(config: Config): App {
  const repo = new Repo(openDatabase(config.dbPath));
  const rooms = new Rooms();
  const limiters = createLimiters(config.rateLimits);
  const app = express();

  app.disable('x-powered-by');
  app.set('trust proxy', config.trustProxy);
  app.use(
    helmet({
      contentSecurityPolicy: {
        useDefaults: false,
        directives: {
          'default-src': ["'self'"],
          'script-src': ["'self'"],
          // CodeMirror injects its styles via style-mod at runtime.
          'style-src': ["'self'", "'unsafe-inline'"],
          'img-src': ["'self'", 'data:', 'blob:'],
          'font-src': ["'self'", 'data:'],
          'connect-src': ["'self'", 'ws:', 'wss:'],
          'worker-src': ["'self'"],
          'manifest-src': ["'self'"],
          'frame-ancestors': ["'none'"],
          'base-uri': ["'self'"],
          'form-action': ["'self'"],
          'object-src': ["'none'"],
        },
      },
      crossOriginEmbedderPolicy: false,
    }),
  );

  app.use('/api', limiters.api, healthRouter(), vaultsRouter({ config, repo, rooms, limiters }), pairRouter(config, repo, limiters));
  app.use('/api', (_req, res) => {
    res.status(404).json({ error: 'not_found' });
  });

  let staticServed = false;
  if (config.staticDir) staticServed = serveClient(app, config.staticDir);

  const errorHandler: ErrorRequestHandler = (err, _req, res, _next) => {
    const e = err as { type?: string; status?: number; message?: string };
    if (e.type === 'entity.too.large') {
      res.status(413).json({ error: 'too_large' });
      return;
    }
    if (e.type === 'entity.parse.failed' || e.status === 400) {
      res.status(400).json({ error: 'bad_request' });
      return;
    }
    if (config.logLevel !== 'silent') console.error(err);
    res.status(500).json({ error: 'internal' });
  };
  app.use(errorHandler);

  const server = http.createServer(app);
  // Long-polls hold connections up to ~25 s; keep Node's defaults (headersTimeout 60 s, requestTimeout 300 s).
  server.keepAliveTimeout = 65_000;
  const wss = attachWebSocket(server, { config, repo, rooms });

  const sweeper = setInterval(() => repo.sweepPairings(), 60_000);
  sweeper.unref();

  if (config.logLevel !== 'silent') {
    console.log(
      `[notepad] db=${config.dbPath} static=${staticServed ? config.staticDir : 'off'} create=${config.createSecret ? 'secret' : 'INSECURE-OPEN'}`,
    );
  }

  return {
    app,
    server,
    wss,
    repo,
    rooms,
    async close() {
      clearInterval(sweeper);
      for (const c of wss.clients) c.terminate();
      await new Promise<void>((resolve) => wss.close(() => resolve()));
      await new Promise<void>((resolve) => server.close(() => resolve()));
      repo.close();
    },
  };
}
