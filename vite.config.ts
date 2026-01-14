
import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// https://vitejs.dev/config/
export default defineConfig({
  plugins: [react()],
  // Use relative base path so it works on any GitHub Pages subpath
  base: './',
  build: {
    outDir: 'docs',
    emptyOutDir: true,
    target: 'esnext'
  }
});
