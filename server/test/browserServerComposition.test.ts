import fs from 'node:fs';
import { describe, expect, it } from 'vitest';

describe('browser worker server composition', () => {
  const source = fs.readFileSync(new URL('../src/server.ts', import.meta.url), 'utf8');

  it('keeps Hammerhead and browser state out of the main process', () => {
    expect(source).toContain("import { createBrowserWorkerClient } from './browser/workerClient.js'");
    expect(source).not.toContain("from './browser/manager.js'");
    expect(source).not.toContain("from './browser/bootstrap.js'");
    expect(source).not.toContain("from './browser/publicProxy.js'");
  });

  it('authenticates browser APIs before raw proxying and leaves normal APIs alone', () => {
    expect(source).toContain("app.use('/api/browser-proxy', apiRequestContext(), expressAuth(token), express.json(), browserWorker.apiHandler)");
    expect(source.indexOf("app.use('/api/browser-proxy'")).toBeLessThan(source.indexOf("app.use('/api', createApiRouter"));
    expect(source).toContain('app.use(browserWorker.publicHandler)');
  });

  it('delegates upgrades and graceful shutdown to the worker client', () => {
    expect(source).toContain('browserWorker.onUpgrade(req, socket, head)');
    expect(source).toContain('createGracefulShutdown({ events, workspace, browser: browserWorker, server })');
  });
});
