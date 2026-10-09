import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    globals: true,
    environment: 'node',
    include: ['tests/**/*.test.ts', 'src/**/*.test.ts'],
    // The DB-backed integration/property suites each rebuild the schema in
    // `beforeAll` with `drop schema if exists public cascade; create schema
    // public` against ONE shared database (TEST_DATABASE_URL). Running those
    // files concurrently races on the same `public` schema — producing
    // "no schema has been selected to create in" and duplicate pg_namespace
    // key errors as one worker drops the schema another is mid-DDL on.
    //
    // Serialize test files so only one suite owns the schema at a time. The
    // default no-DB run is tiny and fast, so forcing single-file execution has
    // negligible cost there while making the full WITH-DB run deterministic.
    fileParallelism: false,
    maxWorkers: 1,
    minWorkers: 1,
    coverage: {
      provider: 'v8',
      reporter: ['text', 'html'],
      include: ['src/**/*.ts'],
      exclude: ['src/**/*.test.ts', 'src/server.ts'],
    },
  },
});
