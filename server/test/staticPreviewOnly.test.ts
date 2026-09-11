import fs from 'node:fs';
import express from 'express';
import request from 'supertest';
import { describe, expect, it, vi } from 'vitest';
import { createPreviews } from '../src/previews.js';
import { createPreview } from '../src/previewServer.js';
import { previewRoutes } from '../src/routes/previews.js';

describe('static-only preview replacement', () => {
  it('does not register dynamic ports in the preview registry', async () => {
    const previews = createPreviews({
      home: '/tmp',
      store: '/tmp/handmux-static-preview-only-test.json',
    });

    await expect(previews.register({ name: 'app', port: 5173 })).resolves.toEqual({
      error: 'bad request',
      status: 400,
    });
  });

  it('accepts only a directory in the preview API', async () => {
    const previews = { register: vi.fn(), list: vi.fn(() => []), remove: vi.fn() };
    const app = express();
    app.use(express.json());
    app.use('/api', previewRoutes({ previews }));

    await request(app).post('/api/previews').send({ name: 'app', port: 5173 }).expect(400);
    expect(previews.register).not.toHaveBeenCalled();
  });

  it('exposes only static router and referer fallback from previewServer', () => {
    const preview = createPreview({ previews: { get: vi.fn() } });
    expect(Object.keys(preview).sort()).toEqual(['refererFallback', 'router']);
  });

  it('uses previewDomain only for the browser public origin, not the retired dynamic preview proxy', () => {
    const source = fs.readFileSync(new URL('../src/server.ts', import.meta.url), 'utf8');
    expect(source).toContain('const previewDomain = process.env.HANDMUX_PREVIEW_DOMAIN || null');
    expect(source).toContain('createBrowserWorkerClient({ appToken: token, previewDomain, handmuxOrigin })');
    expect(source).not.toContain('createApiRouter({ token, events, uploadExts, previews, previewDomain,');
    expect(source).not.toContain('dynamicProxy');
    expect(source).not.toContain('preview.onUpgrade');
  });

  it('runs the built-in browser behind an isolated worker instead of inside the main server process', () => {
    const source = fs.readFileSync(new URL('../src/server.ts', import.meta.url), 'utf8');
    expect(source).toContain('createBrowserWorkerClient');
    expect(source).not.toContain('createBrowserPreviewManager');
    expect(source).not.toContain('createBrowserPublicProxy');
  });
});
