// Pure model for `handmux setup`: the answer↔config mappers, the wizard-owned key sets, the connection
// summary, the cloudflared provisioning text helpers, and the clack validators. Extracted from the
// interactive shell (setupWizard.ts) so the tested, side-effect-free logic stands on its own. Depends only
// on i18n (t/getLocale) for user-facing strings — otherwise deterministic given its inputs.
import { t, getLocale } from './i18n/index.js';
import { providerMode, voiceProviderRegistry } from '../asr/providerRegistry.js';
import { TUNNELS } from './options.js';
import type {
  Tunnel, VapidConfig, VoiceConfig, VoiceProviderConfig, XfyunConfig,
} from './options.js';

export interface ConnectionAnswers {
  tunnel: Tunnel;
  lang?: string;
  name?: string;
  token?: string;
  previewDomain?: string;
  sshHost?: string;
  remotePort?: number;
  sshJump?: string;
  cfHostname?: string;
  cfTunnelName?: string;
  publicUrl?: string;
  authtoken?: string;
  cpolarRegion?: string;
  vapid?: VapidConfig;
  voice?: VoiceConfig;
}

export interface SetupAnswers extends ConnectionAnswers { port: number }
export type SetupConfig = Record<string, unknown>;

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);
const isTunnel = (value: unknown): value is Tunnel =>
  typeof value === 'string' && TUNNELS.includes(value as Tunnel);
const optionalString = (value: unknown): string | undefined => typeof value === 'string' && value ? value : undefined;
const stringObject = <T extends object>(value: unknown, keys: readonly string[]): T | undefined => {
  if (!isRecord(value)) return undefined;
  const result: Record<string, string> = {};
  for (const key of keys) if (typeof value[key] === 'string') result[key] = value[key];
  return result as T;
};

// ~/.cloudflared/config.yml for a named tunnel: route the hostname to the local handmux port.
export function cfConfigYaml({
  tunnelName, credentialsFile, hostname, port,
}: { tunnelName: string; credentialsFile: string; hostname: string; port: number }): string {
  return [
    `tunnel: ${tunnelName}`,
    `credentials-file: ${credentialsFile}`,
    'ingress:',
    `  - hostname: ${hostname}`,
    `    service: http://localhost:${port}`,
    '  - service: http_status:404',
    '',
  ].join('\n');
}

// Extract the tunnel UUID + credentials path from `cloudflared tunnel create <name>` stdout.
export function parseTunnelCreate(out: unknown): { id: string | null; credentialsFile: string | null } {
  const s = String(out || '');
  const id = (s.match(/Created tunnel \S+ with id ([0-9a-fA-F-]+)/) || [])[1] || null;
  const credentialsFile = (s.match(/credentials written to (\S+\.json)/i) || [])[1]?.replace(/\.$/, '') || null;
  return { id, credentialsFile };
}

// Find an existing named tunnel's UUID in `cloudflared tunnel list --output json`. A named tunnel is a
// PERSISTENT object in the Cloudflare account, so a second `setup` would hit `cloudflared tunnel create`'s
// "tunnel with name X already exists" error — which used to force a rename and pile up junk tunnels in the
// account. Looking it up first lets provisioning REUSE it idempotently. Tolerates non-JSON / errors → null.
export function findTunnelId(listJsonOut: unknown, name: string): string | null {
  let arr: unknown;
  try { arr = JSON.parse(String(listJsonOut || '')); } catch { return null; }
  if (!Array.isArray(arr)) return null;
  const hit = arr.find((candidate) => isRecord(candidate) && candidate.name === name);
  return isRecord(hit) && typeof hit.id === 'string' && hit.id ? hit.id : null;
}

// The config keys the wizard owns: everything it can set. mergeConfig wipes these from the existing config
// before re-applying the answers, so switching a tunnel (or clearing an optional field) cleanly drops the
// old value instead of leaving a stale field behind. Anything NOT here (staticDir, uploadExts…) is
// preserved untouched. `token` IS owned so the Token row can pin one AND clear it back to auto — but it
// round-trips through answersFromConfig, so a re-run that never touches the row still writes it back.
const WIZARD_KEYS = [
  'lang', 'name', 'port', 'tunnel', 'token', 'previewDomain',
  'sshHost', 'remotePort', 'sshJump', 'cfHostname', 'cfTunnelName', 'publicUrl',
  'authtoken', 'cpolarRegion',
  'vapid', 'voice', 'xfyun',
] as const;

// The tunnel-specific keys, cleared whenever the tunnel changes so a switch never carries a stale field.
export const TUNNEL_KEYS = ['sshHost', 'remotePort', 'sshJump', 'cfHostname', 'cfTunnelName', 'publicUrl', 'authtoken', 'cpolarRegion'] as const;

// Wizard answers → the config fragment the user actually set (omit empty optional fields).
export function configFromAnswers(a: SetupAnswers): SetupConfig {
  const cfg: SetupConfig = { tunnel: a.tunnel, port: a.port };
  if (a.lang) cfg.lang = a.lang;
  if (a.name) cfg.name = a.name;
  if (a.token) cfg.token = a.token;   // blank = don't pin one → the server mints a fresh token each start
  if (a.previewDomain) cfg.previewDomain = a.previewDomain;
  if (a.tunnel === 'ssh') {
    cfg.sshHost = a.sshHost;
    cfg.remotePort = a.remotePort;
    if (a.publicUrl) cfg.publicUrl = a.publicUrl;
    if (a.sshJump) cfg.sshJump = a.sshJump;
  }
  if (a.tunnel === 'cloudflare-named') {
    cfg.cfHostname = a.cfHostname;
    cfg.cfTunnelName = a.cfTunnelName;
  }
  if (a.tunnel === 'natapp' || a.tunnel === 'cpolar') {
    if (a.authtoken) cfg.authtoken = a.authtoken;
    if (a.publicUrl) cfg.publicUrl = a.publicUrl;      // fixed/reserved domain (blank = temporary random)
    if (a.cpolarRegion) cfg.cpolarRegion = a.cpolarRegion;
  }
  if (a.vapid) cfg.vapid = a.vapid;
  if (a.voice) cfg.voice = a.voice;
  return cfg;
}

// Fold this run's answers into an existing config: preserve every non-wizard field, replace the wizard's
// own fields wholesale. This is why re-running `setup` to switch tunnels (or edit the name) never drops
// your token / push keys / static dir, yet also never leaves the previous tunnel's stale keys around.
export function mergeConfig(existing: unknown = {}, answers: SetupAnswers): SetupConfig {
  const out: SetupConfig = isRecord(existing) ? { ...existing } : {};
  for (const k of WIZARD_KEYS) delete out[k];
  return { ...out, ...configFromAnswers(answers) };
}

// Seed the working answers from an existing config so the hub shows current values and each edit starts
// from what's already there. A brand-new config yields safe defaults (none/LAN, port 19999).
export function answersFromConfig(config: unknown = {}): SetupAnswers {
  const cfg = isRecord(config) ? config : {};
  const a: SetupAnswers = {
    lang: optionalString(cfg.lang) || getLocale(),
    name: optionalString(cfg.name) || '',
    token: optionalString(cfg.token) || '',   // '' = not pinned (auto each start); seeded so an untouched re-run rewrites it
    previewDomain: optionalString(cfg.previewDomain) || '',
    tunnel: isTunnel(cfg.tunnel) ? cfg.tunnel : 'none',
    port: Number(cfg.port) || 19999,
  };
  const stringKeys = ['sshHost', 'sshJump', 'cfHostname', 'cfTunnelName', 'publicUrl', 'authtoken', 'cpolarRegion'] as const;
  for (const key of stringKeys) {
    const value = optionalString(cfg[key]);
    if (value) a[key] = value;
  }
  if (typeof cfg.remotePort === 'number' && Number.isFinite(cfg.remotePort)) a.remotePort = cfg.remotePort;
  const vapid = stringObject<VapidConfig>(cfg.vapid, ['public', 'private', 'subject']);
  const voice = voiceFromConfig(cfg.voice);
  const xfyun = stringObject<XfyunConfig>(cfg.xfyun, ['appId', 'apiKey', 'apiSecret']);
  if (vapid) a.vapid = vapid;
  if (voice) a.voice = voice;
  else if (xfyun) a.voice = { provider: 'xfyun', mode: 'streaming', providers: { xfyun } };
  return a;
}

function voiceFromConfig(value: unknown): VoiceConfig | undefined {
  if (!isRecord(value) || !isRecord(value.providers)) return undefined;
  const adapter = voiceProviderRegistry.get(value.provider);
  if (!adapter) return undefined;
  const providers: Record<string, VoiceProviderConfig> = {};
  for (const candidate of voiceProviderRegistry.adapters) {
    const config = stringObject<VoiceProviderConfig>(
      value.providers[candidate.id], candidate.fields.map((field) => field.key),
    );
    if (config) providers[candidate.id] = config;
  }
  return {
    ...(value.enabled === false ? { enabled: false } : {}),
    provider: adapter.id,
    mode: providerMode(adapter, value.mode),
    providers,
  };
}

// The dim one-line summary shown next to the Connection row (and reused nowhere else). Pure.
export function summarizeConnection(a: ConnectionAnswers): string {
  const bare = (url: unknown): string => String(url || '').replace(/^https?:\/\//, '');
  switch (a.tunnel) {
    case 'cloudflare': return `cloudflare · ${t('setup.sumTemp')}`;
    case 'cloudflare-named': return `cloudflare-named · ${a.cfHostname || '?'}`;
    case 'ssh': return `ssh · ${a.sshHost || '?'}`;
    case 'natapp':
    case 'cpolar': return `${a.tunnel} · ${a.publicUrl ? `${t('setup.sumFixed')} ${bare(a.publicUrl)}` : t('setup.sumTemp')}`;
    default: return `${t('setup.tunnelNone')} · ${t('setup.sumNoRelay')}`;
  }
}

// ---- validators (clack: return a string to reject + show inline, undefined to accept). Pure. ----
export function validatePort(v: unknown): string | undefined {
  const n = Number(v);
  if (!Number.isInteger(n) || n < 1 || n > 65535) return t('setup.valPort');
  return undefined;
}
export const validateNonEmpty = (label: string) => (value: unknown): string | undefined => (
  String(value || '').trim() ? undefined : t('setup.valRequired', { label })
);
export function validateHost(v: unknown): string | undefined {
  const s = String(v || '').trim().replace(/^https?:\/\//, '').replace(/\/.*$/, '');
  return /^[a-z0-9-]+(\.[a-z0-9-]+)+$/i.test(s) ? undefined : t('setup.valHost');
}
// The built-in browser maps proxy origins below this domain. Blank deliberately leaves proxy mode disabled;
// a URL, wildcard, or port would produce an invalid host when Handmux adds its own stable subdomain.
export function validatePreviewDomain(v: unknown): string | undefined {
  const s = String(v || '').trim();
  if (!s) return undefined;
  return /^[a-z0-9-]+(\.[a-z0-9-]+)+$/i.test(s) ? undefined : t('setup.valPreviewDomain');
}
// VAPID subject: Apple (APNs) rejects a fake/.local domain with BadJwtToken, so require a real-looking
// mailto:you@host.tld or an https:// URL and reject the known-bad .local. Keeps push from silently
// failing on iOS. (Can't fully validate "real" client-side — this just catches the obvious footguns.)
export function validateContact(v: unknown): string | undefined {
  const s = String(v || '').trim();
  const wellFormed = /^mailto:[^@\s]+@[a-z0-9-]+(\.[a-z0-9-]+)+$/i.test(s)
    || /^https:\/\/[a-z0-9-]+(\.[a-z0-9-]+)+/i.test(s);
  if (!wellFormed || /\.local(?:[:/]|$)/i.test(s)) return t('setup.valContact');
  return undefined;
}
// Access token: it rides in the phone's URL as ?token=…, so require something and reject whitespace (a space
// would break the link). Length/charset are otherwise up to the user — a pinned token is used verbatim.
export function validateToken(v: unknown): string | undefined {
  const s = String(v || '').trim();
  if (!s) return t('setup.valToken');
  if (/\s/.test(s)) return t('setup.valTokenSpace');
  return undefined;
}
