import { defineConfig } from 'vitest/config';
import { existsSync } from 'node:fs';
import path from 'node:path';

// TypeScript's NodeNext resolver intentionally lets source import `./module.js` while the implementation
// is `module.ts`, because tsc emits the exact `.js` specifier Node needs. Vite does not perform that
// substitution for JS importers, so bridge it only when the requested JS file is absent and a migrated TS
// sibling exists. This keeps mixed JS/TS tests working throughout the incremental migration.
function resolveMigratedTypeScript() {
  return {
    name: 'resolve-migrated-typescript',
    enforce: 'pre',
    resolveId(source, importer) {
      if (!importer || !/^\.\.?\/.*\.js$/.test(source)) return null;
      const candidate = path.resolve(
        path.dirname(importer.split('?')[0]),
        source.replace(/\.js$/, '.ts'),
      );
      return existsSync(candidate) ? candidate : null;
    },
  };
}

export default defineConfig({
  plugins: [resolveMigratedTypeScript()],
  test: {
    environment: 'node',
    include: ['test/**/*.test.{js,ts}'],
    // Run test files sequentially. Many suites use supertest, which spins up an ephemeral HTTP server per
    // request; under parallel file execution the box oversaturates and superagent intermittently reads a
    // malformed response ("Parse Error: Expected HTTP/", or a spurious 403) — a harness-only flake (~1/5
    // full runs) that never reflects a real route bug. Sequential is ~3x slower (≈21s vs ≈8s) but green
    // every run. Verified: 0 flakes across repeated sequential runs.
    fileParallelism: false,
  },
});
