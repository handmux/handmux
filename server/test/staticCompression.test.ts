import express from 'express';
import request from 'supertest';
import { describe, expect, it } from 'vitest';
import { compressStaticAssets } from '../src/staticCompression.js';

const largeJavascript = `console.log("${'x'.repeat(8_000)}");`;

function createApp(): express.Express {
  const app = express();
  app.use(compressStaticAssets);
  app.get('/assets/app.js', (_req, res) => res.type('js').send(largeJavascript));
  app.get('/api/large', (_req, res) => res.type('text').send(largeJavascript));
  return app;
}

describe('static asset compression', () => {
  it('gzip-compresses large hashed assets when the browser accepts it', async () => {
    const res = await request(createApp())
      .get('/assets/app.js')
      .set('Accept-Encoding', 'gzip')
      .expect(200);

    expect(res.headers['content-encoding']).toBe('gzip');
    expect(Number(res.headers['content-length'] || 0)).toBe(0);
  });

  it('does not touch API responses', async () => {
    const res = await request(createApp())
      .get('/api/large')
      .set('Accept-Encoding', 'gzip')
      .expect(200);

    expect(res.headers['content-encoding']).toBeUndefined();
  });
});
