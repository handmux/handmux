import { createHmac } from 'node:crypto';

export interface IatSignOptions {
  appId: string;
  apiKey: string;
  apiSecret: string;
  host?: string;
  date: string;
}

// Build a fully-signed iFlytek IAT v2 WebSocket URL. The secret (apiSecret) is used only here on the
// server — the browser receives only the resulting URL (HMAC output, not the key). `host`/`date` are
// injectable so this is deterministic and unit-testable; production passes host='iat-api.xfyun.cn'
// and date=new Date().toUTCString() (RFC1123 GMT, iFlytek allows ±300s skew).
export function buildIatSignedUrl({
  appId, apiKey, apiSecret, host = 'iat-api.xfyun.cn', date,
}: IatSignOptions): { url: string; appId: string } {
  const requestLine = 'GET /v2/iat HTTP/1.1';
  const signatureOrigin = `host: ${host}\ndate: ${date}\n${requestLine}`;
  const signature = createHmac('sha256', apiSecret).update(signatureOrigin).digest('base64');
  const authorizationOrigin =
    `api_key="${apiKey}", algorithm="hmac-sha256", headers="host date request-line", signature="${signature}"`;
  const authorization = Buffer.from(authorizationOrigin, 'utf8').toString('base64');
  const qs = new URLSearchParams({ authorization, date, host });
  return { url: `wss://${host}/v2/iat?${qs.toString()}`, appId };
}
