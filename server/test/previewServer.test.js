import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import request from 'supertest';
import express from 'express';
import { promises as fsp } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createPreview, rewritePreviewText } from '../src/previewServer.js';

describe('rewritePreviewText', () => {
  const prefix = '/preview/site/capability/';

  it('keeps absolute HTML, CSS, srcset, and module imports inside the capability path', () => {
    const html = '<link href="/assets/app.css"><img srcset="/a.png 1x, /b.png 2x"><style>.x{background:url(/bg.png)}</style><script type="module">import "/main.js"</script>';
    const output = rewritePreviewText(html, '.html', prefix);
    expect(output).toContain('href="/preview/site/capability/assets/app.css"');
    expect(output).toContain('srcset="/preview/site/capability/a.png 1x, /preview/site/capability/b.png 2x"');
    expect(output).toContain('url(/preview/site/capability/bg.png)');
    expect(output).toContain('import "/preview/site/capability/main.js"');
  });

  it('rewrites external CSS roots and static module imports without changing remote URLs', () => {
    expect(rewritePreviewText('.x{src:url("/font.woff2")} .y{src:url(https://cdn.example/font)}', '.css', prefix))
      .toContain('url("/preview/site/capability/font.woff2")');
    expect(rewritePreviewText('import x from "/x.js"; import y from "https://cdn.example/y.js";', '.js', prefix))
      .toBe('import x from "/preview/site/capability/x.js"; import y from "https://cdn.example/y.js";');
  });
});

describe('createPreview static serving', () => {
  let site;
  let app;
  const previews = {
    get: (name) => name === 'live' ? { state: 'active', entry: { dir: site, accessToken: 'good' } }
      : name === 'dead' ? { state: 'expired' } : { state: 'missing' },
  };

  beforeAll(async () => {
    site = await fsp.mkdtemp(join(tmpdir(), 'pvsite-'));
    await fsp.writeFile(join(site, 'index.html'), '<h1>hi</h1><script src="/assets/app.js"></script>');
    await fsp.mkdir(join(site, 'assets'));
    await fsp.writeFile(join(site, 'assets', 'app.js'), 'console.log(1)');
    const { router, refererFallback } = createPreview({ previews });
    app = express();
    app.use('/preview', router);
    app.use(refererFallback);
    app.use((req, res) => res.status(599).send('FELL_THROUGH'));
  });

  afterAll(async () => { await fsp.rm(site, { recursive: true, force: true }); });

  it('requires credentials', async () => {
    await request(app).get('/preview/live/').expect(401);
  });
  it('rejects the main app token and accepts only the preview capability path', async () => {
    await request(app).get('/preview/live/?token=good').expect(401);
    await request(app).get('/preview/live/app-token/').expect(401);
    await request(app).get('/preview/live/good/').expect(200);
  });
  it('serves the directory and its assets without caching', async () => {
    const page = await request(app).get('/preview/live/good/').expect(200);
    expect(page.text).toContain('hi');
    expect(page.text).toContain('src="/preview/live/good/assets/app.js"');
    expect(page.headers['cache-control']).toBe('no-store');
    expect(page.headers['referrer-policy']).toBe('same-origin');
    expect(page.headers['content-security-policy']).toContain('sandbox allow-scripts');
    expect(page.headers['access-control-allow-origin']).toBe('null');
    const asset = await request(app).get('/preview/live/good/assets/app.js').expect(200);
    expect(asset.text).toContain('console.log');
  });
  it('redirects a no-slash preview path', async () => {
    const res = await request(app).get('/preview/live/good').expect(301);
    expect(res.headers.location).toBe('/preview/live/good/');
  });
  it('reports expired and missing previews', async () => {
    await request(app).get('/preview/dead/good/').expect(410);
    await request(app).get('/preview/ghost/good/').expect(404);
  });
  it('serves an absolute asset path only with an authenticated preview referer', async () => {
    const asset = await request(app).get('/assets/app.js')
      .set('Referer', 'http://x/preview/live/good/').expect(200);
    expect(asset.text).toContain('console.log');
    await request(app).get('/assets/app.js').set('Referer', 'http://x/preview/live/wrong/').expect(599);
    await request(app).get('/assets/app.js').expect(599);
  });
});
