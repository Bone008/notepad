import { createApp } from './app.js';
import { loadConfig } from './config.js';

const config = loadConfig();
const { server, close } = createApp(config);

server.listen(config.port, () => {
  console.log(`[notepad] listening on http://0.0.0.0:${config.port}`);
});

let shuttingDown = false;
for (const sig of ['SIGINT', 'SIGTERM'] as const) {
  process.on(sig, () => {
    if (shuttingDown) return;
    shuttingDown = true;
    console.log(`[notepad] ${sig} received, shutting down`);
    const t = setTimeout(() => process.exit(1), 5000);
    t.unref();
    void close().then(() => process.exit(0));
  });
}
