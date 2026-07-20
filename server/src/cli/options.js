// Pure CLI option handling: a tiny hand-rolled flag parser (no dependency) + config resolution.
// Resolution order is flags > config file > env > built-in default. The token is ALWAYS materialised
// (generated when unset) so a public tunnel can never come up token-less.
import crypto from 'node:crypto';
import { normalizeShortcuts } from '../shortcutConfig.js';

export const TUNNELS = ['none', 'cloudflare', 'cloudflare-named', 'ssh', 'natapp', 'cpolar'];

const camel = (s) => s.replace(/-([a-z])/g, (_, c) => c.toUpperCase());

// argv = process.argv.slice(2). `command` is the first bare word; flags are `--key value`,
// `--key` (boolean true), `--no-key` (boolean false), and `-f` (alias for --foreground).
export function parseArgs(argv) {
  const [command = 'help', ...rest] = argv;
  const flags = {};
  const positionals = [];
  const unknownShortFlags = [];
  const multiFlags = new Set(['session']);
  const assign = (key, value) => {
    if (!multiFlags.has(key) || flags[key] === undefined) { flags[key] = value; return; }
    flags[key] = Array.isArray(flags[key]) ? [...flags[key], value] : [flags[key], value];
  };
  for (let i = 0; i < rest.length; i++) {
    const a = rest[i];
    if (a === '-f') { flags.foreground = true; continue; }
    if (!a.startsWith('--')) {
      if (a.startsWith('-')) unknownShortFlags.push(a);
      else positionals.push(a);
      continue;
    }
    const key = a.slice(2);
    if (key.startsWith('no-')) { assign(camel(key.slice(3)), false); continue; }
    const next = rest[i + 1];
    if (next === undefined || next.startsWith('--')) { assign(camel(key), true); }
    else { assign(camel(key), next); i++; }
  }
  return {
    command,
    flags,
    ...(positionals.length ? { positionals } : {}),
    ...(unknownShortFlags.length ? { unknownShortFlags } : {}),
  };
}

// ssh 回退公网地址:SSH 不生成 URL,无 --public-url 时用 host:remotePort(去掉 user@ 与 :sshPort)。
export function sshPublicFallback(sshHost, remotePort) {
  const host = String(sshHost).replace(/^[^@]*@/, '').replace(/:\d+$/, '');
  return `http://${host}:${remotePort}`;
}

export function resolveConfig(flags = {}, fileCfg = {}, env = process.env, gen = defaultGen) {
  const pick = (k, ...fallbacks) => {
    for (const v of [flags[k], fileCfg[k], ...fallbacks]) if (v !== undefined && v !== null) return v;
    return undefined;
  };
  const tunnel = pick('tunnel', 'none');
  if (!TUNNELS.includes(tunnel)) throw new Error(`unknown tunnel: ${tunnel} (use: ${TUNNELS.join(', ')})`);

  const port = Number(pick('port', env.HANDMUX_PORT, 19999));
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error(`bad port: ${pick('port', env.HANDMUX_PORT, 19999)}`);

  const cfg = {
    tunnel,
    port,
    name: pick('name', env.HANDMUX_APP_NAME) || null,
    host: pick('host', env.HANDMUX_HOST, '0.0.0.0'),
    token: pick('token', env.HANDMUX_TOKEN) || gen(),
    previewDomain: pick('previewDomain', env.HANDMUX_PREVIEW_DOMAIN) || null,
    foreground: !!pick('foreground', false),
    qr: pick('qr', true) !== false,
    // Unified config — what used to live in .env. The supervisor injects these into the server child's
    // environment (HANDMUX_STATIC_DIR / VAPID_* / XFYUN_* …), which is exactly where the server reads them.
    staticDir: pick('staticDir', env.HANDMUX_STATIC_DIR) || null,
    uploadExts: pick('uploadExts', env.HANDMUX_UPLOAD_EXTS) || null,
    previewTtl: pick('previewTtl', env.HANDMUX_PREVIEW_TTL) || null,
    vapid: fileCfg.vapid || null,   // { public, private, subject } — push notifications
    xfyun: fileCfg.xfyun || null,   // { appId, apiKey, apiSecret } — voice input
    shortcuts: normalizeShortcuts(fileCfg.shortcuts),
    // An explicit public URL is honoured for ANY tunnel mode — including 'none', so someone who runs their
    // own tunnel/reverse-proxy can still have handmux advertise (print + QR) their real domain. The
    // tunnel-specific blocks below only fill a *fallback* when it wasn't given.
    //
    // Guard: a publicUrl in the FILE was set for the file's tunnel, so it only carries over when the
    // resolved tunnel still matches (or the file pins no tunnel). Otherwise a `--tunnel B` override would
    // advertise tunnel A's URL. A flag/env publicUrl is explicit for THIS run and always wins.
    publicUrl: resolvePublicUrl(flags, fileCfg, env, tunnel),
    // tunnel-specific (null unless the relevant tunnel is selected)
    sshHost: null, remotePort: null, sshJump: null,
    cfHostname: null, cfTunnelName: null,
    authtoken: null, cpolarRegion: null,
  };

  if (tunnel === 'ssh') {
    cfg.sshHost = pick('sshHost', env.HANDMUX_SSH_HOST) || null;
    if (!cfg.sshHost) throw new Error('ssh tunnel needs --ssh-host user@host (or HANDMUX_SSH_HOST)');
    const rp = Number(pick('remotePort', env.HANDMUX_REMOTE_PORT, port));
    if (!Number.isInteger(rp) || rp < 1 || rp > 65535) throw new Error(`bad remote-port: ${pick('remotePort', env.HANDMUX_REMOTE_PORT, port)}`);
    cfg.remotePort = rp;
    cfg.sshJump = pick('sshJump', env.HANDMUX_SSH_JUMP) || null;
    cfg.publicUrl = cfg.publicUrl || sshPublicFallback(cfg.sshHost, rp);
  }

  if (tunnel === 'cloudflare-named') {
    cfg.cfHostname = pick('cfHostname', env.HANDMUX_CF_HOSTNAME) || null;
    if (!cfg.cfHostname) throw new Error('cloudflare-named needs --cf-hostname handmux.example.com (or HANDMUX_CF_HOSTNAME)');
    cfg.cfTunnelName = pick('cfTunnelName', env.HANDMUX_CF_TUNNEL_NAME) || 'handmux';
    cfg.publicUrl = cfg.publicUrl || `https://${cfg.cfHostname}`;
  }

  // natapp / cpolar: one shared credential (--authtoken), and named/fixed mode is just --public-url (the
  // reserved domain) — no separate concept. A bare host is normalised to https:// so the user can paste the
  // domain the provider gave them. cpolar also takes an optional edge --cpolar-region (cn = mainland China).
  if (tunnel === 'natapp' || tunnel === 'cpolar') {
    cfg.authtoken = pick('authtoken', env.HANDMUX_AUTHTOKEN) || null;
    if (!cfg.authtoken) {
      const where = tunnel === 'natapp' ? 'natapp.cn' : 'cpolar.com';
      throw new Error(`${tunnel} needs --authtoken <token> (or HANDMUX_AUTHTOKEN) — get it from ${where} after logging in`);
    }
    if (cfg.publicUrl && !/^https?:\/\//i.test(cfg.publicUrl)) cfg.publicUrl = `https://${cfg.publicUrl}`;
    if (tunnel === 'cpolar') cfg.cpolarRegion = pick('cpolarRegion', env.HANDMUX_CPOLAR_REGION) || null;
  }

  return cfg;
}

// publicUrl resolution with the cross-tunnel guard (see resolveConfig). flag > file(if tunnel matches) > env.
function resolvePublicUrl(flags, fileCfg, env, tunnel) {
  if (flags.publicUrl != null) return flags.publicUrl;
  const fileTunnel = fileCfg.tunnel;
  const fileApplies = fileTunnel == null || fileTunnel === tunnel;
  if (fileApplies && fileCfg.publicUrl != null) return fileCfg.publicUrl;
  if (env.HANDMUX_PUBLIC_URL != null) return env.HANDMUX_PUBLIC_URL;
  return null;
}

// Default token: 8 chars from a typing-friendly alphabet (lowercase + digits, look-alikes 0/o/1/l dropped)
// so it's quick to thumb in on a phone. A user-supplied token (flag/config/env) is used verbatim — any
// length, never regenerated. 8 chars over a 32-char alphabet ≈ 40 bits, fine for a single secret URL.
const TOKEN_ALPHABET = '23456789abcdefghijkmnpqrstuvwxyz';
export function defaultGen() {
  let s = '';
  for (let i = 0; i < 8; i++) s += TOKEN_ALPHABET[crypto.randomInt(TOKEN_ALPHABET.length)];
  return s;
}

// Trace one key's value back to its source through the same flag > file > env > default precedence
// resolveConfig uses. `null`/`undefined` at a layer is "unset" (skip), matching pick(). Returns the
// winning value and a human origin label (the file path for a file hit, so the user sees exactly where).
function trace(flags, fileCfg, env, cfgPath, key, envKey, def) {
  if (flags[key] != null) return { value: flags[key], origin: 'flag' };
  if (fileCfg[key] != null) return { value: fileCfg[key], origin: cfgPath || 'file' };
  if (envKey && env[envKey] != null) return { value: env[envKey], origin: 'env' };
  return { value: def, origin: 'default' };
}

// Build the rows for `handmux config`: the value each key WOULD resolve to plus where it came from.
// Lenient (never throws — unlike resolveConfig — so a half-finished config still prints) and secret-safe
// (token masked; push/voice shown only as on/off). Tunnel-specific rows appear only for the live tunnel.
export function explainConfig(flags = {}, fileCfg = {}, cfgPath = null, env = process.env) {
  const rows = [];
  const mask = (s) => (String(s).length <= 8 ? '••••' : `••••${String(s).slice(-4)}`);
  const add = (key, t, display) => rows.push({ key, origin: t.origin, display: display ?? String(t.value) });

  const tunnel = trace(flags, fileCfg, env, cfgPath, 'tunnel', null, 'none');
  add('tunnel', tunnel);
  add('port', trace(flags, fileCfg, env, cfgPath, 'port', 'HANDMUX_PORT', 19999));
  add('host', trace(flags, fileCfg, env, cfgPath, 'host', 'HANDMUX_HOST', '0.0.0.0'));

  const name = trace(flags, fileCfg, env, cfgPath, 'name', 'HANDMUX_APP_NAME', null);
  add('name', name, name.value == null ? '(default)' : String(name.value));

  const lang = trace(flags, fileCfg, env, cfgPath, 'lang', 'HANDMUX_LANG', null);
  add('lang', lang, lang.value == null ? '(auto — shell locale)' : String(lang.value));

  const token = trace(flags, fileCfg, env, cfgPath, 'token', 'HANDMUX_TOKEN', null);
  add('token', token, token.value == null ? '(generated each start)' : mask(token.value));

  // publicUrl honours the same cross-tunnel guard as resolveConfig (file value only when tunnel matches).
  const t = tunnel.value;
  let pub = trace(flags, fileCfg, env, cfgPath, 'publicUrl', 'HANDMUX_PUBLIC_URL', null);
  if (pub.origin !== 'flag' && pub.origin !== 'env' && fileCfg.tunnel != null && fileCfg.tunnel !== t) {
    pub = { value: null, origin: 'default' };
  }
  add('publicUrl', pub, pub.value == null ? '(none — derived from tunnel if any)' : String(pub.value));

  const preview = trace(flags, fileCfg, env, cfgPath, 'previewDomain', 'HANDMUX_PREVIEW_DOMAIN', null);
  add('previewDomain', preview, preview.value == null ? '(off)' : String(preview.value));

  if (t === 'ssh') {
    add('sshHost', trace(flags, fileCfg, env, cfgPath, 'sshHost', 'HANDMUX_SSH_HOST', null));
    add('remotePort', trace(flags, fileCfg, env, cfgPath, 'remotePort', 'HANDMUX_REMOTE_PORT', '(= port)'));
    const jump = trace(flags, fileCfg, env, cfgPath, 'sshJump', 'HANDMUX_SSH_JUMP', null);
    add('sshJump', jump, jump.value == null ? '(none)' : String(jump.value));
  }
  if (t === 'cloudflare-named') {
    add('cfHostname', trace(flags, fileCfg, env, cfgPath, 'cfHostname', 'HANDMUX_CF_HOSTNAME', null));
    add('cfTunnelName', trace(flags, fileCfg, env, cfgPath, 'cfTunnelName', 'HANDMUX_CF_TUNNEL_NAME', 'handmux'));
  }
  if (t === 'natapp' || t === 'cpolar') {
    const at = trace(flags, fileCfg, env, cfgPath, 'authtoken', 'HANDMUX_AUTHTOKEN', null);
    add('authtoken', at, at.value == null ? '(required — from the provider dashboard)' : mask(at.value));
  }
  if (t === 'cpolar') {
    const rg = trace(flags, fileCfg, env, cfgPath, 'cpolarRegion', 'HANDMUX_CPOLAR_REGION', null);
    add('cpolarRegion', rg, rg.value == null ? '(cpolar default)' : String(rg.value));
  }

  // Integrations live only in the file (secrets); show presence, never the keys.
  rows.push({ key: 'push (vapid)', origin: fileCfg.vapid ? (cfgPath || 'file') : 'default', display: fileCfg.vapid ? 'on' : 'off' });
  rows.push({ key: 'voice (xfyun)', origin: fileCfg.xfyun ? (cfgPath || 'file') : 'default', display: fileCfg.xfyun ? 'on' : 'off' });
  return rows;
}
