import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

export default defineConfig({
  plugins: [react()],
  // Electron loads the built renderer from the filesystem, where absolute
  // asset paths resolve against the drive root and 404. Relative paths work in
  // both the dev server and file://.
  base: './',
  server: { port: 5173, strictPort: true },
  build: {
    outDir: 'dist',
    emptyOutDir: true,
    sourcemap: true,
  },
});
