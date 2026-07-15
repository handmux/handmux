import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'node',
    include: ['test/**/*.test.js'],
    // Run test files sequentially. Many suites use supertest, which spins up an ephemeral HTTP server per
    // request; under parallel file execution the box oversaturates and superagent intermittently reads a
    // malformed response ("Parse Error: Expected HTTP/", or a spurious 403) — a harness-only flake (~1/5
    // full runs) that never reflects a real route bug. Sequential is ~3x slower (≈21s vs ≈8s) but green
    // every run. Verified: 0 flakes across repeated sequential runs.
    fileParallelism: false,
  },
});
