import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    projects: [
      { test: { name: 'shared', root: './shared', environment: 'node', include: ['test/**/*.test.ts'] } },
      { test: { name: 'server', root: './server', environment: 'node', include: ['test/**/*.test.ts'], fileParallelism: false } },
      {
        test: {
          name: 'client',
          root: './client',
          environment: 'node',
          include: ['test/**/*.test.ts'],
          setupFiles: ['./test/setup.ts'],
        },
      },
    ],
  },
});
