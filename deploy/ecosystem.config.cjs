// pm2 process file, shipped inside every release bundle (see README "Deploy without Docker").
//
// Expected layout on the server:
//   <NOTEPAD_HOME>/current  -> releases/<release>   (this file lives in each release)
//   <NOTEPAD_HOME>/shared/.env                      (NOTEPAD_CREATE_SECRET, PORT, ...)
//   <NOTEPAD_HOME>/shared/data                      (SQLite database)
const path = require('node:path');

const home = process.env.NOTEPAD_HOME || path.resolve(__dirname, '..', '..');

module.exports = {
  apps: [
    {
      name: 'notepad',
      cwd: path.join(home, 'current'),
      script: 'server/dist/index.js',
      // Must stay a single process: live-collaboration rooms are held in memory and
      // SQLite is opened by exactly one writer.
      instances: 1,
      exec_mode: 'fork',
      // Secrets live outside the release directory; Node loads the file itself.
      node_args: [`--env-file-if-exists=${path.join(home, 'shared', '.env')}`],
      env: {
        NODE_ENV: 'production',
        NOTEPAD_DATA_DIR: path.join(home, 'shared', 'data'),
      },
      max_memory_restart: '512M',
      kill_timeout: 6000,
      time: true,
      out_file: path.join(home, 'shared', 'logs', 'out.log'),
      error_file: path.join(home, 'shared', 'logs', 'err.log'),
      merge_logs: true,
    },
  ],
};
