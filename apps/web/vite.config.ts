import path from 'node:path';
import react from '@vitejs/plugin-react';
import { defineConfig, loadEnv } from 'vite';

export default defineConfig(({ mode }) => {
  // The monorepo root holds the single .env shared by the API and tooling.
  const env = loadEnv(mode, path.resolve(import.meta.dirname, '../..'), '');

  // 127.0.0.1 rather than "localhost": Node resolves localhost to ::1 first,
  // but the API listens on 0.0.0.0 (IPv4), so the proxy silently fails to
  // connect and every request returns an empty response.
  const apiProxyTarget = env.API_PROXY_TARGET ?? 'http://127.0.0.1:3000';

  return {
    plugins: [react()],
    resolve: {
      alias: {
        '@': path.resolve(import.meta.dirname, './src'),
      },
    },
    build: {
      // Vendor code changes far less often than app code, so splitting it out
      // means a deploy does not invalidate the whole cached bundle — which
      // matters a great deal on a metered 3G connection.
      rollupOptions: {
        output: {
          manualChunks: {
            react: ['react', 'react-dom', 'react-router-dom'],
            query: ['@tanstack/react-query'],
            dnd: ['@dnd-kit/core', '@dnd-kit/sortable', '@dnd-kit/utilities'],
          },
        },
      },
      chunkSizeWarningLimit: 600,
    },
    server: {
      allowedHosts: true,
      proxy: {
        '/api/v1': {
          target: apiProxyTarget,
          changeOrigin: true,
        },
      },
    },
  };
});
