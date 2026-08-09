import express from 'express';
import type { Request } from 'express';
import { browserLabelForOrigin } from './originLabel.js';
import { browserRequestOrigin } from './publicProxy.js';
import { normalizeSiteVersion } from './siteVersion.js';

const RETENTION_DAYS = new Set<unknown>([1, 7, 30, null]);
const DEVICE_ID = /^[A-Za-z0-9_-]{32,128}$/;
const TAB_ID = /^[A-Za-z0-9_-]{1,128}$/;
const DEVICE_COOKIE = 'tw_browser_device';

interface BrowserLease extends Record<string, unknown> { url: string }
interface BrowserRouteManager {
  putLease(input: Record<string, unknown>): BrowserLease | Promise<BrowserLease>;
  navigateLease(
    tabId: string,
    url: string,
    deviceId: string,
    origin: string,
    siteVersion: 'mobile' | 'desktop',
    sourceUserAgent: string,
  ): BrowserLease | null | Promise<BrowserLease | null>;
  deleteLease(tabId: string, deviceId: string): boolean;
  configureDeviceProfile(deviceId: string, preferences: {
    persist: boolean;
    retentionDays: 1 | 7 | 30 | null;
  }): unknown | Promise<unknown>;
  clearDeviceProfile(deviceId: string, options: { origin: string | null }): unknown | Promise<unknown>;
}
interface BrowserBootstrap {
  issue(input: { url: string; origin: string; deviceId: string }): string;
}

const recordOf = (value: unknown): Record<string, unknown> => (
  value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown> : {}
);

function previewBase(raw: string | null): URL | null {
  if (!raw) return null;
  const value = /^https?:\/\//i.test(raw) ? raw : `https://${raw}`;
  return new URL(value);
}

function wildcardOrigin(base: URL, targetOrigin: string): string {
  const url = new URL(base.origin);
  url.hostname = `${browserLabelForOrigin(targetOrigin)}.${base.hostname}`;
  return url.origin;
}

function normalizedTarget(value: unknown): string | null {
  if (typeof value !== 'string' || !value) return null;
  try {
    const url = new URL(value);
    return url.protocol === 'http:' || url.protocol === 'https:' ? url.toString() : null;
  } catch {
    return null;
  }
}

function normalizedHttpOrigin(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  try {
    const url = new URL(value);
    return url.protocol === 'http:' || url.protocol === 'https:' ? url.origin : null;
  } catch {
    return null;
  }
}

export function browserRoutes({
  browser,
  previewDomain = null,
  browserBootstrap = null,
}: {
  browser?: BrowserRouteManager | null;
  previewDomain?: string | null;
  browserBootstrap?: BrowserBootstrap | null;
}): express.Router {
  const router = express.Router();
  const publicBase = previewBase(previewDomain);

  router.use((req, res, next) => {
    const deviceId = req.get('x-handmux-browser-device');
    if (!DEVICE_ID.test(deviceId || '')) return res.status(400).json({ error: 'browser device id required' });
    (req as Request & { browserDeviceId: string }).browserDeviceId = deviceId as string;
    const origin = browserRequestOrigin(req);
    const secure = origin?.startsWith('https://') ? '; Secure' : '';
    res.append('Set-Cookie', `${DEVICE_COOKIE}=${deviceId}; Path=/; HttpOnly; SameSite=Strict${secure}`);
    return next();
  });

  const deviceId = (req: Request): string => (req as Request & { browserDeviceId: string }).browserDeviceId;
  const responseLease = (lease: BrowserLease | null, requestDeviceId: string): BrowserLease | null => {
    if (!lease) return null;
    if (!browserBootstrap) throw new Error('browser bootstrap unavailable');
    const url = browserBootstrap.issue({
      url: lease.url,
      origin: new URL(lease.url).origin,
      deviceId: requestDeviceId,
    });
    return { ...lease, url };
  };

  router.put('/leases/:tabId', async (req, res, next) => {
    if (!browser || !publicBase || !browserBootstrap) return res.status(503).json({ error: 'browser proxy unavailable' });
    if (!TAB_ID.test(req.params.tabId)) return res.status(400).json({ error: 'bad browser tab id' });
    const body = recordOf(req.body as unknown);
    const url = normalizedTarget(body.url);
    if (!url) return res.status(400).json({ error: 'browser URL must use http or https' });
    const siteVersion = normalizeSiteVersion(body.siteVersion);
    if (!siteVersion) return res.status(400).json({ error: 'bad browser site version' });
    try {
      const origin = wildcardOrigin(publicBase, new URL(url).origin);
      const lease = await browser.putLease({
        tabId: req.params.tabId,
        url,
        origin,
        deviceId: deviceId(req),
        siteVersion,
        sourceUserAgent: req.get('user-agent') || '',
      });
      return res.json(responseLease(lease, deviceId(req)));
    } catch (error) {
      return next(error);
    }
  });

  router.post('/leases/:tabId/navigate', async (req, res, next) => {
    if (!browser || !publicBase || !browserBootstrap) return res.status(503).json({ error: 'browser proxy unavailable' });
    if (!TAB_ID.test(req.params.tabId)) return res.status(400).json({ error: 'bad browser tab id' });
    const body = recordOf(req.body as unknown);
    const url = normalizedTarget(body.url);
    if (!url) return res.status(400).json({ error: 'browser URL must use http or https' });
    const siteVersion = normalizeSiteVersion(body.siteVersion);
    if (!siteVersion) return res.status(400).json({ error: 'bad browser site version' });
    try {
      const origin = wildcardOrigin(publicBase, new URL(url).origin);
      const lease = await browser.navigateLease(
        req.params.tabId,
        url,
        deviceId(req),
        origin,
        siteVersion,
        req.get('user-agent') || '',
      );
      if (!lease) return res.status(404).json({ error: 'browser proxy lease not found' });
      return res.json(responseLease(lease, deviceId(req)));
    } catch (error) {
      return next(error);
    }
  });

  router.delete('/leases/:tabId', (req, res) => {
    if (!browser) return res.status(503).json({ error: 'browser proxy unavailable' });
    if (!browser.deleteLease(req.params.tabId, deviceId(req))) {
      return res.status(404).json({ error: 'browser proxy lease not found' });
    }
    return res.status(204).end();
  });

  router.put('/profile', async (req, res, next) => {
    if (!browser) return res.status(503).json({ error: 'browser proxy unavailable' });
    const { persist, retentionDays } = recordOf(req.body as unknown);
    if (typeof persist !== 'boolean' || !RETENTION_DAYS.has(retentionDays)) {
      return res.status(400).json({ error: 'bad browser profile preferences' });
    }
    try {
      return res.json(await browser.configureDeviceProfile(
        deviceId(req),
        { persist, retentionDays: retentionDays as 1 | 7 | 30 | null },
      ));
    } catch (error) {
      return next(error);
    }
  });

  router.post('/profile/clear', async (req, res, next) => {
    if (!browser) return res.status(503).json({ error: 'browser proxy unavailable' });
    const rawOrigin = recordOf(req.body as unknown).origin;
    const origin = rawOrigin === null ? null : normalizedHttpOrigin(rawOrigin);
    if (origin === null && rawOrigin !== null) {
      return res.status(400).json({ error: 'bad browser profile clear request' });
    }
    try {
      return res.json(await browser.clearDeviceProfile(deviceId(req), { origin }));
    } catch (error) {
      return next(error);
    }
  });

  return router;
}
