import type { IncomingHttpHeaders, OutgoingHttpHeader } from 'node:http';
import type { Request, RequestHandler, Response } from 'express';

const DEVICE_ID = /^[A-Za-z0-9_-]{32,128}$/;

export interface BrowserCoordinatorStatus { ready: boolean; generation: number }
export interface BrowserProxyResponse {
  status: number;
  headers?: Record<string, OutgoingHttpHeader | undefined> | IncomingHttpHeaders;
  body: Buffer;
}
export interface BrowserProxyRequest {
  req: Request;
  method: string;
  path: string;
  body?: unknown;
}
export type BrowserCoordinatorHandler = RequestHandler & { close(): void };

function jsonBody(response: BrowserProxyResponse): Record<string, unknown> | null {
  if (!response.body?.length) return null;
  try {
    const parsed = JSON.parse(response.body.toString('utf8')) as unknown;
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
      ? parsed as Record<string, unknown> : null;
  } catch { return null; }
}

function sendProxy(
  res: Response,
  response: BrowserProxyResponse | null,
  generation: number,
  stampGeneration: boolean,
) {
  if (!response) return res.status(503).json({ error: 'browser unavailable' });
  for (const [name, value] of Object.entries(response.headers || {})) {
    if (value != null && !['connection', 'content-length', 'transfer-encoding'].includes(name.toLowerCase())) {
      res.setHeader(name, value);
    }
  }
  if (stampGeneration && response.status >= 200 && response.status < 300) {
    const payload = jsonBody(response);
    if (payload) return res.status(response.status).json({ ...payload, generation });
  }
  return res.status(response.status).send(response.body);
}

export function createBrowserCoordinator({
  proxyRequest,
  getStatus = () => ({ ready: false, generation: 0 }),
}: {
  proxyRequest: (request: BrowserProxyRequest) => Promise<BrowserProxyResponse | null>;
  getStatus?: () => BrowserCoordinatorStatus;
}): BrowserCoordinatorHandler {
  const handler: BrowserCoordinatorHandler = async (req, res) => {
    if (req.method === 'GET' && req.path === '/status') {
      return res.json(getStatus());
    }
    const deviceId = req.get('x-handmux-browser-device');
    if (!DEVICE_ID.test(deviceId || '')) {
      return res.status(400).json({ error: 'browser device id required' });
    }
    const path = `/api/browser-proxy${req.path}`;
    const response = await proxyRequest({
      req,
      method: req.method,
      path,
      body: ['PUT', 'POST', 'PATCH'].includes(req.method) ? req.body : undefined,
    });
    const stampGeneration = /^\/leases\/[^/]+(?:\/navigate)?$/.test(req.path)
      && ['PUT', 'POST'].includes(req.method);
    return sendProxy(res, response, getStatus().generation, stampGeneration);
  };
  handler.close = (): void => {};
  return handler;
}
