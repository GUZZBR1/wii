import { defineConfig } from 'vitest/config';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { autoUpgradePlugin } from './scripts/auto-upgrade-plugin';

const projectRoot = fileURLToPath(new URL('.', import.meta.url));

export default defineConfig(({ mode }) => ({
  plugins: [react(), tailwindcss(), autoUpgradePlugin(resolve(projectRoot, '.auto-upgrade/inbox'))],
  base: '/',
  resolve: {
    alias:
      mode === 'test'
        ? []
        : [{ find: /^@nevergear\/spatial-core$/, replacement: resolve(projectRoot, 'packages/core/src/index.ts') }],
  },
  test: {
    environment: 'node',
    include: ['tests/**/*.test.{ts,tsx}'],
    clearMocks: true,
  },
}));
