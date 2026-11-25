import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vite';

const packageRoot = fileURLToPath(new URL('.', import.meta.url));

export default defineConfig({
  base: './',
  root: packageRoot,
  build: {
    emptyOutDir: true,
    lib: {
      entry: resolve(packageRoot, 'src/index.ts'),
      formats: ['es'],
      fileName: 'index',
    },
    outDir: resolve(packageRoot, 'dist'),
    rollupOptions: {
      output: {
        assetFileNames: 'assets/[name]-[hash][extname]',
        chunkFileNames: 'chunks/[name]-[hash].js',
        entryFileNames: '[name].js',
      },
    },
  },
});
