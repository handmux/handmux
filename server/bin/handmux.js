#!/usr/bin/env node
// Stable JavaScript launcher. Keep this file free of product imports until the runtime version is known:
// Node <22.16 lacks the native sqlite backup API required by the Project Task store, so importing dist first
// would fail with an opaque module error before HandMux can tell the user what to do.
import { nodeVersionSupport } from './node-version.js';

const support = nodeVersionSupport(process.versions.node);
if (!support.ok) {
  console.error(
    `[handmux] Node.js ${support.actual} is not supported. `
    + `Install Node.js ${support.minimum} or newer, then run HandMux again: https://nodejs.org/`,
  );
  process.exitCode = 1;
} else {
  await import('../dist/bin/handmux.js');
}
