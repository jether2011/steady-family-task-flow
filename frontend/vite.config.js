import { fileURLToPath, URL } from 'node:url'
import react from '@vitejs/plugin-react'
import { defineConfig } from 'vite'

// https://vite.dev/config/
export default defineConfig({
  plugins: [
    react(),
  ],
  resolve: {
    alias: {
      // "@" -> ./src, mirroring jsconfig.json "paths". Previously provided by
      // the Base44 Vite plugin; defined explicitly now that it has been removed.
      '@': fileURLToPath(new URL('./src', import.meta.url)),
    },
  },
});
