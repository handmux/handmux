import { createHash, createHmac } from 'node:crypto';
import type { TencentAsrConfig } from './providerRegistry.js';

const HOST = 'asr.tencentcloudapi.com';
const ENDPOINT = `https://${HOST}`;
const ACTION = 'SentenceRecognition';
const VERSION = '2019-06-14';
const SERVICE = 'asr';
const ALGORITHM = 'TC3-HMAC-SHA256';
const CONTENT_TYPE = 'application/json; charset=utf-8';

type FetchLike = typeof fetch;

export interface TencentSentenceDependencies {
  fetch?: FetchLike;
  timestamp?: number;
}

export interface TencentSentenceResult {
  text: string;
  requestId?: string;
}

export class TencentSentenceError extends Error {
  readonly code: string;
  readonly requestId?: string;

  constructor(code: string, message: string, requestId?: string) {
    super(message);
    this.name = 'TencentSentenceError';
    this.code = code;
    if (requestId) this.requestId = requestId;
  }
}

const isRecord = (value: unknown): value is Record<string, unknown> => (
  value !== null && typeof value === 'object' && !Array.isArray(value)
);
const sha256 = (value: string): string => createHash('sha256').update(value).digest('hex');
const hmac = (key: string | Buffer, value: string): Buffer => (
  createHmac('sha256', key).update(value).digest()
);

function utcDate(timestamp: number): string {
  return new Date(timestamp * 1000).toISOString().slice(0, 10);
}

export function buildTencentSentenceRequest(
  config: TencentAsrConfig,
  audio: Uint8Array,
  timestamp = Math.floor(Date.now() / 1000),
): { url: string; headers: Record<string, string>; body: string } {
  const body = JSON.stringify({
    ProjectId: 0,
    SubServiceType: 2,
    EngSerViceType: config.engineModelType,
    SourceType: 1,
    VoiceFormat: 'pcm',
    Data: Buffer.from(audio).toString('base64'),
    DataLen: audio.byteLength,
  });
  const canonicalHeaders = `content-type:${CONTENT_TYPE}\nhost:${HOST}\n`;
  const signedHeaders = 'content-type;host';
  const canonicalRequest = [
    'POST', '/', '', canonicalHeaders, signedHeaders, sha256(body),
  ].join('\n');
  const date = utcDate(timestamp);
  const credentialScope = `${date}/${SERVICE}/tc3_request`;
  const stringToSign = [
    ALGORITHM, String(timestamp), credentialScope, sha256(canonicalRequest),
  ].join('\n');
  const secretDate = hmac(`TC3${config.secretKey}`, date);
  const secretService = hmac(secretDate, SERVICE);
  const secretSigning = hmac(secretService, 'tc3_request');
  const signature = createHmac('sha256', secretSigning).update(stringToSign).digest('hex');
  const authorization = `${ALGORITHM} Credential=${config.secretId}/${credentialScope}, `
    + `SignedHeaders=${signedHeaders}, Signature=${signature}`;
  return {
    url: ENDPOINT,
    headers: {
      Authorization: authorization,
      'Content-Type': CONTENT_TYPE,
      Host: HOST,
      'X-TC-Action': ACTION,
      'X-TC-Timestamp': String(timestamp),
      'X-TC-Version': VERSION,
    },
    body,
  };
}

export async function recognizeTencentSentence(
  config: TencentAsrConfig,
  audio: Uint8Array,
  { fetch: fetchImpl = fetch, timestamp }: TencentSentenceDependencies = {},
): Promise<TencentSentenceResult> {
  const request = buildTencentSentenceRequest(config, audio, timestamp);
  let response: Response;
  try {
    response = await fetchImpl(request.url, {
      method: 'POST', headers: request.headers, body: request.body,
    });
  } catch (error) {
    throw new TencentSentenceError(
      'TencentNetworkError',
      `Tencent Cloud ASR could not be reached: ${error instanceof Error ? error.message : String(error)}`,
    );
  }

  let value: unknown;
  try { value = await response.json(); }
  catch {
    throw new TencentSentenceError(
      'TencentInvalidResponse',
      `Tencent Cloud ASR returned HTTP ${response.status} with an invalid response`,
    );
  }
  const root = isRecord(value) && isRecord(value.Response) ? value.Response : null;
  const requestId = typeof root?.RequestId === 'string' ? root.RequestId : undefined;
  const cloudError = isRecord(root?.Error) ? root.Error : null;
  if (cloudError) {
    const code = typeof cloudError.Code === 'string' ? cloudError.Code : 'TencentCloudError';
    const message = typeof cloudError.Message === 'string' ? cloudError.Message : 'Tencent Cloud ASR rejected the request';
    throw new TencentSentenceError(code, message, requestId);
  }
  if (!response.ok || !root || typeof root.Result !== 'string') {
    throw new TencentSentenceError(
      'TencentInvalidResponse',
      `Tencent Cloud ASR returned an invalid response (HTTP ${response.status})`,
      requestId,
    );
  }
  return { text: root.Result, ...(requestId ? { requestId } : {}) };
}
