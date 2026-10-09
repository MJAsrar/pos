import { resolve } from 'node:path';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';
import { defineConfig, externalizeDepsPlugin } from 'electron-vite';

/**
 * Three separate builds: the Electron main process, the preload bridge, and the
 * React renderer.
 *
 * `externalizeDepsPlugin` leaves runtime `dependencies` out of the bundle so the
 * native modules (better-sqlite3, argon2) load from node_modules at their real
 * paths — bundling a .node binary does not work. `@pos/shared` is excluded from
 * that rule and bundled in, because it is a workspace symlink rather than a real
 * installed package and would not resolve inside a packaged asar.
 */
export default defineConfig({
  main: {
    plugins: [externalizeDepsPlugin({ exclude: ['@pos/shared'] })],
    build: {
      lib: { entry: resolve(__dirname, 'electron/main/index.ts') },
      rollupOptions: { output: { format: 'cjs' } },
    },
    resolve: {
      alias: { '~': resolve(__dirname, 'electron') },
    },
  },

  preload: {
    plugins: [externalizeDepsPlugin({ exclude: ['@pos/shared'] })],
    build: {
      lib: { entry: resolve(__dirname, 'electron/preload/index.ts') },
      rollupOptions: { output: { format: 'cjs' } },
    },
  },

  renderer: {
    root: resolve(__dirname, 'src'),
    plugins: [react(), tailwindcss()],
    resolve: {
      alias: { '@': resolve(__dirname, 'src') },
    },
    build: {
      rollupOptions: { input: resolve(__dirname, 'src/index.html') },
    },
    server: {
      // The counter PC is offline most of the time; never let the dev server
      // try to reach the network to resolve anything.
      host: '127.0.0.1',
    },
  },
});
