import fs from 'node:fs';
import path from 'node:path';
import express, { type Express } from 'express';

const NO_CACHE = new Set(['index.html', 'sw.js', 'manifest.webmanifest', 'registerSW.js', 'workbox-']);

/** Serve the built client: hashed assets cached forever, the shell never, SPA fallback for navigations. */
export function serveClient(app: Express, dir: string): boolean {
  const index = path.join(dir, 'index.html');
  if (!fs.existsSync(index)) return false;

  app.use(
    express.static(dir, {
      index: false,
      etag: true,
      setHeaders(res, filePath) {
        const base = path.basename(filePath);
        if (filePath.includes(`${path.sep}assets${path.sep}`)) {
          res.setHeader('Cache-Control', 'public, max-age=31536000, immutable');
        } else if ([...NO_CACHE].some((n) => base.startsWith(n))) {
          res.setHeader('Cache-Control', 'no-cache');
        }
      },
    }),
  );

  app.get('/{*splat}', (req, res, next) => {
    if (req.path.startsWith('/api/') || req.path === '/ws' || !req.accepts('html')) return next();
    res.setHeader('Cache-Control', 'no-cache');
    res.sendFile(index);
  });
  return true;
}
