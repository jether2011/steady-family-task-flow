import { fileURLToPath, URL } from 'node:url';
import react from '@vitejs/plugin-react';
import { defineConfig } from 'vitest/config';

// Vitest configuration for the frontend test suite.
//
// Mirrors the "@" -> ./src alias from vite.config.js / jsconfig.json so test
// files and the code under test resolve imports identically to the app build.
// The jsdom environment is used (per design: "Vitest + React Testing Library
// (jsdom)"); client.ts tests only mock `fetch`, while DOM-based suites
// (auth/login, Wall Mode) render components and rely on it. The React plugin
// compiles JSX in `.jsx`/`.tsx` tests, and the setup file registers jest-dom
// matchers plus between-test cleanup.
export default defineConfig({
  plugins: [react()],
  // Use the automatic JSX runtime so source files that render JSX without
  // importing React (e.g. ProtectedRoute.jsx) transform the same way the Vite
  // app build does. Without this the esbuild default (classic runtime)
  // references an undefined `React` in those files.
  esbuild: {
    jsx: 'automatic',
  },
  resolve: {
    alias: {
      '@': fileURLToPath(new URL('./src', import.meta.url)),
    },
  },
  test: {
    globals: true,
    environment: 'jsdom',
    setupFiles: ['./src/test/setup.js'],
    include: ['src/**/*.test.{ts,tsx,js,jsx}'],
    // Reset mock state between every test so execution order and cross-file
    // parallelism cannot leak call history, `mockResolvedValueOnce` queues, or
    // implementations from one test into the next. Combined with the
    // `afterEach(cleanup)` in the setup file (DOM teardown), this makes each
    // test self-contained and the whole suite order-independent — fixing the
    // intermittent mutation→invalidation→refetch failures observed in
    // useFamily.repoint.test.jsx and parity.test.jsx under parallel runs.
    clearMocks: true,
    restoreMocks: true,
  },
});
