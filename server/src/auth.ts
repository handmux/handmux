import crypto from 'node:crypto';
import type { RequestHandler } from 'express';

export function loadToken(env: NodeJS.ProcessEnv = process.env): string {
  let token = env.HANDMUX_TOKEN;
  if (!token) {
    token = crypto.randomBytes(24).toString('base64url');
    console.log(`[handmux] no HANDMUX_TOKEN set; generated token: ${token}`);
  }
  return token;
}

const sha = (value: unknown): Buffer => crypto.createHash('sha256').update(String(value)).digest();

export function tokenEquals(a: unknown, b: unknown): boolean {
  return crypto.timingSafeEqual(sha(a), sha(b));
}

export function bearerFrom(header: string | null | undefined): string | null {
  if (!header) return null;
  const m = /^Bearer (.+)$/.exec(header);
  return m ? m[1] : null;
}

export function expressAuth(token: string): RequestHandler {
  return (req, res, next) => {
    const provided = bearerFrom(req.get('authorization'));
    if (provided && tokenEquals(provided, token)) return next();
    res.status(401).json({ error: 'unauthorized' });
  };
}
