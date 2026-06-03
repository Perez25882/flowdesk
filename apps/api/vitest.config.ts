import path from 'node:path';
import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    globals: false,
    environment: 'node',
  },
  resolve: {
    alias: {
      '@flowdesk/shared': path.resolve(import.meta.dirname, '../../packages/shared/src/index.ts'),
    },
  },
});
