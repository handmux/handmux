// `handmux push <title> <body> [--session X]... [--device K]... [--tag T] [--url U]` — fire one
// notification to the phone through the already-running server (loopback + the server's own token).
// Scope is mutually exclusive: --device (by key) or --session, else all. Pure parse + injectable
// runner so it unit-tests without spawning or real fetch.
import { readState } from './state.js';
import { sanitizeNotificationUrl } from '../urlPolicy.js';

const collect = (acc: string[], value: unknown): string[] =>
  acc.concat(String(value ?? '').split(',').map((item) => item.trim()).filter(Boolean));

export interface PushPayload {
  error?: never;
  title: string;
  body: string;
  sessions?: string[];
  devices?: string[];
  tag?: string;
  url?: string;
}

export interface PushArgsError {
  error: string;
  title?: never;
  body?: never;
  sessions?: never;
  devices?: never;
  tag?: never;
  url?: never;
}

export type ParsedPushArgs = PushPayload | PushArgsError;

interface PushHttpResponse {
  ok: boolean;
  status?: number;
  json(): Promise<unknown>;
}

interface PushRequestInit {
  method: 'POST';
  headers: { Authorization: string; 'Content-Type': 'application/json' };
  body: string;
}

export type PushFetch = (url: string, init: PushRequestInit) => Promise<PushHttpResponse>;

interface RunPushOptions {
  argv: readonly string[];
  home: string;
  fetchImpl?: PushFetch;
  log?: (message: string) => void;
  err?: (message: string) => void;
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);
const finiteNumber = (value: unknown): number =>
  typeof value === 'number' && Number.isFinite(value) ? value : 0;

// argv is process.argv.slice(2), i.e. ['push', title, body, ...flags]. The shared parseArgs() drops bare
// words after the command, so title/body are taken positionally; --session/--device may repeat.
export function parsePushArgs(argv: readonly string[]): ParsedPushArgs {
  const rest = argv.slice(1);
  const positional: string[] = [];
  let sessions: string[] = [];
  let devices: string[] = [];
  let tag: string | undefined;
  let url: string | undefined;
  for (let i = 0; i < rest.length; i++) {
    const a = rest[i] ?? '';
    if (a === '--session') { sessions = collect(sessions, rest[++i]); }
    else if (a === '--device') { devices = collect(devices, rest[++i]); }
    else if (a === '--tag') { tag = rest[++i]; }
    else if (a === '--url') { url = rest[++i]; }
    else if (!a.startsWith('--')) positional.push(a);
  }
  const [title, body] = positional;
  if (!title || !body) return { error: 'usage: handmux push <title> <body> [--session X]... [--device K]... [--tag T] [--url U]' };
  if (sessions.length && devices.length) return { error: 'use --session or --device, not both' };
  const safeUrl = url == null ? null : sanitizeNotificationUrl(url);
  if (url != null && !safeUrl) return { error: '--url must be an http(s) URL or a relative path' };
  const out: PushPayload = { title, body };
  if (sessions.length) out.sessions = sessions;
  if (devices.length) out.devices = devices;
  if (tag) out.tag = tag;
  if (safeUrl) out.url = safeUrl;
  return out;
}

export async function runPush({
  argv, home, fetchImpl = globalThis.fetch, log = console.log, err = console.error,
}: RunPushOptions): Promise<0 | 1> {
  const parsed = parsePushArgs(argv);
  if (parsed.error) { err(parsed.error); return 1; }
  const st = readState(home);
  if (!st || typeof st.localUrl !== 'string' || !st.localUrl
    || typeof st.token !== 'string' || !st.token) {
    err('handmux is not running — run `handmux start` first.');
    return 1;
  }
  try {
    const res = await fetchImpl(`${st.localUrl}/api/push/send-local`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${st.token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(parsed),
    });
    if (!res.ok) { err(`push failed: ${res.status ?? 'unknown'}`); return 1; }
    const raw = await res.json();
    const out = isRecord(raw) ? raw : {};
    if (out.configured === false) { err('push is not configured (no VAPID keys) — run `handmux setup`.'); return 1; }
    const sent = finiteNumber(out.sent);
    const failed = finiteNumber(out.failed);
    const gone = finiteNumber(out.gone);
    const counts = `sent: ${sent}, failed: ${failed}, gone: ${gone}`;
    if (sent === 0) { err(`no notification delivered (${counts})`); return 1; }
    if (failed > 0) { err(`push partially failed (${counts})`); return 1; }
    log(`pushed (${counts})`);
    return 0;
  } catch (e) { err(`push failed: ${e instanceof Error ? e.message : String(e)}`); return 1; }
}
