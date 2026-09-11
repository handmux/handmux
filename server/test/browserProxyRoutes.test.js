import express from 'express';
import request from 'supertest';
import { describe, expect, it, vi } from 'vitest';
import { browserRoutes } from '../src/browser/routes.js';

const DEVICE = 'device_abcdefghijklmnopqrstuvwxyz123456';
const asDevice = (req) => req.set('X-Handmux-Browser-Device', DEVICE);

function appFor(browser) {
  const app = express();
  app.use(express.json());
  app.use(browserRoutes({
    browser,
    previewDomain: 'preview.example',
    browserBootstrap: { issue: vi.fn(({ url }) => `https://bootstrap.example/?next=${encodeURIComponent(url)}`) },
  }));
  return app;
}

function browserFake() {
  return {
    putLease: vi.fn(async ({ tabId, url }) => ({
      tabId, originalUrl: new URL(url).toString(),
      url: 'https://b-app.preview.example/_browser-client-a/target',
      channel: 'channel-a',
    })),
    navigateLease: vi.fn(async (_tabId, url) => ({
      tabId: 'client-a', originalUrl: new URL(url).toString(),
      url: 'https://b-next.preview.example/_browser-client-a/next',
      channel: 'channel-a',
    })),
    deleteLease: vi.fn(() => true),
    configureDeviceProfile: vi.fn(async (_device, prefs) => prefs),
    clearDeviceProfile: vi.fn(async () => ({ closedTabIds: [] })),
  };
}

describe('browser proxy lease routes', () => {
  it('puts an idempotent client-owned lease and returns a bootstrap URL', async () => {
    const browser = browserFake();
    const response = await asDevice(request(appFor(browser)).put('/leases/client-a'))
      .send({ url: 'https://app.example/path' })
      .expect(200);

    expect(browser.putLease).toHaveBeenCalledWith(expect.objectContaining({
      tabId: 'client-a',
      deviceId: DEVICE,
      url: 'https://app.example/path',
      origin: expect.stringMatching(/^https:\/\/b-[0-9a-z]{13}\.preview\.example$/),
    }));
    expect(response.body).toMatchObject({
      tabId: 'client-a',
      originalUrl: 'https://app.example/path',
      channel: 'channel-a',
    });
    expect(response.body).not.toHaveProperty('generation');
  });

  it('navigates and deletes only an existing lease', async () => {
    const browser = browserFake();
    const app = appFor(browser);

    await asDevice(request(app).post('/leases/client-a/navigate'))
      .send({ url: 'https://next.example/' })
      .expect(200);
    await asDevice(request(app).delete('/leases/client-a')).expect(204);

    expect(browser.navigateLease).toHaveBeenCalledWith(
      'client-a',
      'https://next.example/',
      DEVICE,
      expect.stringMatching(/^https:\/\/b-[0-9a-z]{13}\.preview\.example$/),
      'mobile',
      '',
    );
    expect(browser.deleteLease).toHaveBeenCalledWith('client-a', DEVICE);
  });

  it('validates and forwards the requested website version', async () => {
    const browser = browserFake();
    const app = appFor(browser);

    await asDevice(request(app).put('/leases/client-a'))
      .set('User-Agent', 'Desktop Browser')
      .send({ url: 'https://app.example/', siteVersion: 'desktop' })
      .expect(200);
    await asDevice(request(app).put('/leases/client-b'))
      .send({ url: 'https://app.example/', siteVersion: 'tablet' })
      .expect(400, { error: 'bad browser site version' });

    expect(browser.putLease).toHaveBeenCalledWith(expect.objectContaining({
      siteVersion: 'desktop',
      sourceUserAgent: 'Desktop Browser',
    }));
  });

  it('keeps profile endpoints under browser-proxy', async () => {
    const browser = browserFake();
    const app = appFor(browser);

    await asDevice(request(app).put('/profile'))
      .send({ persist: true, retentionDays: 7 })
      .expect(200, { persist: true, retentionDays: 7 });
    await asDevice(request(app).post('/profile/clear'))
      .send({ origin: null })
      .expect(200, { closedTabIds: [] });
  });
});
