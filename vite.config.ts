import { defineConfig } from 'vite';

// base: './' so the same build works from file:// (Electron) and from the
// Android WebView asset host (capacitor://localhost).
export default defineConfig({
  base: './',
  build: {
    outDir: 'dist',
    target: 'es2022',
    sourcemap: false,
    chunkSizeWarningLimit: 2048,
  },
  server: {
    port: 5173,
    strictPort: false,
  },
});
