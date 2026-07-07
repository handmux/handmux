// `handmux setup` — a menu HUB (not a linear wizard): every setting is a row showing its current value;
// you arrow to a section to edit just that, then return to the hub; a Save/Start/Exit action row ends it.
// First run auto-dives into Connection once (the one choice a newcomer must make), then lands on the hub.
// The interactive shell is thin glue over @clack/prompts (via ./prompt.js); the pure mappers below
// (configFromAnswers / mergeConfig / validators / summarizeConnection / answersFromConfig) are unit-tested.

import fs from 'node:fs';
import path from 'node:path';
import { homedir } from 'node:os';
import { spawnSync } from 'node:child_process';
import webpush from 'web-push';
import { configPath, pocketHome } from './state.js';
import { resolveCloudflared } from './cloudflared.js';
import { resolveTunlite, checkSshAuth } from './tunlite.js';
import { resolveNatapp, resolveCpolar } from './tunnelClients.js';
import { t, setLocale, getLocale } from './i18n/index.js';
import { intro, outro, note, cancel, select, text, password, confirm, ask, CANCELLED } from './prompt.js';

// ~/.cloudflared/config.yml for a named tunnel: route the hostname to the local handmux port.
export function cfConfigYaml({ tunnelName, credentialsFile, hostname, port }) {
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
export function parseTunnelCreate(out) {
  const s = String(out || '');
  const id = (s.match(/Created tunnel \S+ with id ([0-9a-fA-F-]+)/) || [])[1] || null;
  const credentialsFile = (s.match(/credentials written to (\S+\.json)/i) || [])[1]?.replace(/\.$/, '') || null;
  return { id, credentialsFile };
}

// Find an existing named tunnel's UUID in `cloudflared tunnel list --output json`. A named tunnel is a
// PERSISTENT object in the Cloudflare account, so a second `setup` would hit `cloudflared tunnel create`'s
// "tunnel with name X already exists" error — which used to force a rename and pile up junk tunnels in the
// account. Looking it up first lets provisioning REUSE it idempotently. Tolerates non-JSON / errors → null.
export function findTunnelId(listJsonOut, name) {
  let arr;
  try { arr = JSON.parse(String(listJsonOut || '')); } catch { return null; }
  if (!Array.isArray(arr)) return null;
  const hit = arr.find((tn) => tn && tn.name === name);
  return hit?.id || null;
}

// The config keys the wizard owns: everything it can set. mergeConfig wipes these from the existing config
// before re-applying the answers, so switching a tunnel (or clearing an optional field) cleanly drops the
// old value instead of leaving a stale field behind. Anything NOT here (token, staticDir, previewDomain…)
// is preserved untouched.
const WIZARD_KEYS = [
  'lang', 'name', 'port', 'tunnel',
  'sshHost', 'remotePort', 'sshJump', 'cfHostname', 'cfTunnelName', 'publicUrl',
  'authtoken', 'cpolarRegion',
  'vapid', 'xfyun',
];

// The tunnel-specific keys, cleared whenever the tunnel changes so a switch never carries a stale field.
const TUNNEL_KEYS = ['sshHost', 'remotePort', 'sshJump', 'cfHostname', 'cfTunnelName', 'publicUrl', 'authtoken', 'cpolarRegion'];

// Wizard answers → the config fragment the user actually set (omit empty optional fields).
export function configFromAnswers(a) {
  const cfg = { tunnel: a.tunnel, port: a.port };
  if (a.lang) cfg.lang = a.lang;
  if (a.name) cfg.name = a.name;
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
  if (a.xfyun) cfg.xfyun = a.xfyun;
  return cfg;
}

// Fold this run's answers into an existing config: preserve every non-wizard field, replace the wizard's
// own fields wholesale. This is why re-running `setup` to switch tunnels (or edit the name) never drops
// your token / push keys / static dir, yet also never leaves the previous tunnel's stale keys around.
export function mergeConfig(existing = {}, answers) {
  const out = { ...existing };
  for (const k of WIZARD_KEYS) delete out[k];
  return { ...out, ...configFromAnswers(answers) };
}

// Seed the working answers from an existing config so the hub shows current values and each edit starts
// from what's already there. A brand-new config yields safe defaults (none/LAN, port 19999).
export function answersFromConfig(cfg = {}) {
  const a = {
    lang: cfg.lang || getLocale(),
    name: cfg.name || '',
    tunnel: cfg.tunnel || 'none',
    port: Number(cfg.port) || 19999,
  };
  for (const k of [...TUNNEL_KEYS, 'vapid', 'xfyun']) if (cfg[k] != null) a[k] = cfg[k];
  return a;
}

// The dim one-line summary shown next to the Connection row (and reused nowhere else). Pure.
export function summarizeConnection(a) {
  const bare = (u) => String(u || '').replace(/^https?:\/\//, '');
  switch (a.tunnel) {
    case 'cloudflare': return `cloudflare · ${t('setup.sumTemp')}`;
    case 'cloudflare-named': return `cloudflare-named · ${a.cfHostname || '?'}`;
    case 'ssh': return `ssh · ${a.sshHost || '?'}`;
    case 'natapp':
    case 'cpolar': return `${a.tunnel} · ${a.publicUrl ? `${t('setup.sumFixed')} ${bare(a.publicUrl)}` : t('setup.sumTemp')}`;
    default: return `none · ${t('setup.sumLan')}`;
  }
}

// ---- validators (clack: return a string to reject + show inline, undefined to accept). Pure. ----
export function validatePort(v) {
  const n = Number(v);
  if (!Number.isInteger(n) || n < 1 || n > 65535) return t('setup.valPort');
  return undefined;
}
export const validateNonEmpty = (label) => (v) => (String(v || '').trim() ? undefined : t('setup.valRequired', { label }));
export function validateHost(v) {
  const s = String(v || '').trim().replace(/^https?:\/\//, '').replace(/\/.*$/, '');
  return /^[a-z0-9-]+(\.[a-z0-9-]+)+$/i.test(s) ? undefined : t('setup.valHost');
}
// VAPID subject: Apple (APNs) rejects a fake/.local domain with BadJwtToken, so require a real-looking
// mailto:you@host.tld or an https:// URL and reject the known-bad .local. Keeps push from silently
// failing on iOS. (Can't fully validate "real" client-side — this just catches the obvious footguns.)
export function validateContact(v) {
  const s = String(v || '').trim();
  const wellFormed = /^mailto:[^@\s]+@[a-z0-9-]+(\.[a-z0-9-]+)+$/i.test(s)
    || /^https:\/\/[a-z0-9-]+(\.[a-z0-9-]+)+/i.test(s);
  if (!wellFormed || /\.local(?:[:/]|$)/i.test(s)) return t('setup.valContact');
  return undefined;
}

function readExisting(file) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return {}; }
}

// The hub. Pre-fills from the existing config so a re-run edits/switches rather than starts over; a brand-
// new config first walks Connection, then everyone lands on the hub (edit any section, then Save/Start/Exit).
// Returns { cfg, start } (start = the user chose the save-and-run action), or null on cancel/exit. When an
// instance is already `running`, that action reads "Save & restart" (the caller stop+starts to apply the new
// config). `home` and the write `target` are injectable for tests / `--config`.
export async function runSetup({ home = homedir(), target = configPath(home), log = console, running = false } = {}) {
  if (!process.stdin.isTTY) { log.error(t('setup.needTty')); return null; }
  const existing = readExisting(target);
  const isNew = !existing || Object.keys(existing).length === 0;
  let a = answersFromConfig(existing);
  setLocale(a.lang);

  intro('handmux setup');
  // First run lands the cursor on "Save & start" — the essential step (connection) is done in onboarding and
  // everything else is optional, so a newcomer sees they can just finish. A re-run starts on the first row so
  // you jump straight to what you came to change.
  let cursor = isNew ? 'start' : 'connection';
  try {
    if (isNew) {
      // First-run onboarding: pick language, orient the newcomer, then ask the ONE thing they must decide —
      // how the phone reaches this machine — going straight to that picker (not the field mini-hub). Esc here
      // drops to the hub with safe defaults, so "Esc goes back" holds everywhere.
      try {
        a.lang = await editLanguage(a);
        note(t('setup.welcome'));
        a = await editConnection(a, { home, log });
      } catch (e) { if (e !== CANCELLED) throw e; }
    }
    for (;;) {
      // Esc / Ctrl-C AT THE HUB (or during first-run onboarding) exits setup — caught by the outer try.
      const choice = await ask(select({
        message: t('setup.hubTitle'),
        options: [
          { value: 'connection', label: t('setup.secConnection'), hint: summarizeConnection(a) },
          { value: 'name', label: t('setup.secName'), hint: a.name || t('setup.default') },
          { value: 'port', label: t('setup.secPort'), hint: String(a.port) },
          { value: 'language', label: t('setup.secLanguage'), hint: a.lang === 'zh' ? '中文' : 'English' },
          { value: 'push', label: t('setup.secPush'), hint: a.vapid ? (a.vapid.subject || t('setup.on')) : t('setup.off') },
          { value: 'voice', label: t('setup.secVoice'), hint: a.xfyun ? (a.xfyun.appId || t('setup.on')) : t('setup.off') },
          { value: 'start', label: running ? t('setup.actRestart') : t('setup.actStart') },
          { value: 'save', label: t('setup.actSave') },
          { value: 'exit', label: t('setup.actExit') },
        ],
        initialValue: cursor,
      }));
      if (choice === 'exit') { cancel(t('setup.exited')); return null; }
      if (choice === 'save' || choice === 'start') {
        const cfg = mergeConfig(existing, a);
        fs.mkdirSync(path.dirname(target), { recursive: true });
        fs.writeFileSync(target, JSON.stringify(cfg, null, 2) + '\n', { mode: 0o600 });
        outro(t('setup.wrote', { path: target }));
        if (a.tunnel === 'ssh') printSshServerHelp(a, log);
        if (a.tunnel === 'cloudflare-named' || a.tunnel === 'ssh') printPreviewHelp(a.tunnel, log);
        return { cfg, start: choice === 'start' };
      }
      cursor = choice;   // remember the row so returning from an edit re-highlights it
      // Esc / Ctrl-C INSIDE a section backs out to the hub, leaving that section unchanged.
      try {
        if (choice === 'connection') a = await editConnection(a, { home, log });
        else if (choice === 'name') a.name = await editName(a);
        else if (choice === 'port') a.port = await editPort(a);
        else if (choice === 'language') a.lang = await editLanguage(a);
        else if (choice === 'push') a.vapid = await editPush(a);
        else if (choice === 'voice') a.xfyun = await editVoice(a);
      } catch (e) {
        if (e !== CANCELLED) throw e;
      }
    }
  } catch (e) {
    if (e === CANCELLED) { cancel(t('setup.exited')); return null; }
    throw e;
  }
}

// clack's footer only shows ↑/↓ + Enter, so append the Esc-backs-out hint to each section's entry prompt —
// otherwise a user inside a section can't tell there's a way back to the hub.
const withBack = (msg) => `${msg}  ${t('setup.escBack')}`;

async function editLanguage(a) {
  const lang = await ask(select({
    message: withBack(t('setup.langQ')),
    options: [{ value: 'en', label: 'English' }, { value: 'zh', label: '中文' }],
    initialValue: a.lang === 'zh' ? 'zh' : 'en',
  }));
  setLocale(lang);   // apply immediately so the rest of the hub speaks the chosen language
  return lang;
}

async function editName(a) {
  // initialValue puts the current name IN the editable field (defaultValue only fills a blank submit, unseen).
  const v = await ask(text({ message: withBack(t('setup.askName')), placeholder: t('setup.default'), initialValue: a.name || '' }));
  return (v || '').trim();
}

async function editPort(a) {
  const v = await ask(text({ message: withBack(t('setup.askPort')), initialValue: String(a.port), validate: validatePort }));
  return Number(v);
}

const bareHost = (u) => String(u || '').replace(/^https?:\/\//, '');
// cloudflare's two drivers are ONE family in the UI: 'cloudflare' (quick, no login) and 'cloudflare-named'
// (your domain, needs a login) are picked as a mode INSIDE cloudflare, not as two separate tunnels.
const cfFamily = (tunnel) => (tunnel === 'cloudflare-named' ? 'cloudflare' : tunnel);

function tunnelOptions() {
  return [
    { value: 'none', label: 'none', hint: t('setup.hintNone') },
    { value: 'cloudflare', label: 'cloudflare', hint: t('setup.hintCf') },
    { value: 'ssh', label: 'ssh (tunlite)', hint: t('setup.hintSsh') },
    { value: 'natapp', label: 'natapp', hint: t('setup.hintNatapp') },
    { value: 'cpolar', label: 'cpolar', hint: t('setup.hintCpolar') },
  ];
}

// Which tunnels have config fields to edit a level deeper (none/cloudflare-quick have nothing to configure).
const hasConnFields = (tunnel) => ['cloudflare-named', 'ssh', 'natapp', 'cpolar'].includes(tunnel);

// The editable field rows for the CURRENT tunnel — the type/mode is chosen a level up (the picker), so this
// lists ONLY that tunnel's config, values shown and secrets masked. Empty for none / cloudflare-quick.
function connectionFieldRows(a) {
  const none = t('setup.connNone');
  if (a.tunnel === 'cloudflare-named') return [
    { value: 'cfHostname', label: t('setup.connHostname'), hint: a.cfHostname || none },
    { value: 'cfTunnelName', label: t('setup.connTunnelName'), hint: a.cfTunnelName || 'handmux' },
  ];
  if (a.tunnel === 'ssh') return [
    { value: 'sshHost', label: t('setup.connSshHost'), hint: a.sshHost || none },
    { value: 'remotePort', label: t('setup.connRemotePort'), hint: String(a.remotePort || a.port) },
    { value: 'publicUrl', label: t('setup.connPublicUrl'), hint: a.publicUrl || t('setup.connAuto') },
    { value: 'sshJump', label: t('setup.connJump'), hint: a.sshJump || none },
  ];
  if (a.tunnel === 'natapp' || a.tunnel === 'cpolar') {
    const rows = [
      { value: 'authtoken', label: 'authtoken', hint: a.authtoken ? maskSecret(a.authtoken) : none },
      { value: 'domain', label: t('setup.connDomain'), hint: a.publicUrl ? bareHost(a.publicUrl) : t('setup.domainTemp') },
    ];
    if (a.tunnel === 'cpolar') rows.push({ value: 'cpolarRegion', label: t('setup.connRegion'), hint: a.cpolarRegion || t('setup.default') });
    return rows;
  }
  return [];
}

// cloudflare mode: temporary quick tunnel (no login) vs a named tunnel on your own domain (needs login).
async function editCfMode(a) {
  const named = await ask(select({
    message: t('setup.cfModeQ'),
    options: [
      { value: false, label: t('setup.cfTemp'), hint: t('setup.cfTempHint') },
      { value: true, label: t('setup.cfNamed'), hint: t('setup.cfNamedHint') },
    ],
    initialValue: a.tunnel === 'cloudflare-named',
  }));
  const n = { ...a };
  if (named) {
    n.tunnel = 'cloudflare-named';
    n.cfHostname = await ask(text({ message: t('setup.askHostname'), initialValue: a.cfHostname || '', validate: validateHost }));
    n.cfTunnelName = (await ask(text({ message: t('setup.askTunnelName'), initialValue: a.cfTunnelName || 'handmux' }))) || 'handmux';
  } else {
    n.tunnel = 'cloudflare';
    delete n.cfHostname; delete n.cfTunnelName;
  }
  return n;
}

// Level 1 — choose the tunnel type (and, for cloudflare, temporary vs named). On a real change, clear the old
// fields and collect the new type's REQUIRED field(s) so a half-set tunnel never reaches the field hub.
// Returns the answers (unchanged if you re-pick the same type — you still drop into its field hub).
async function pickTunnel(a) {
  // Default the cursor to the current tunnel; a brand-new user starts on `none` — the zero-config core that
  // just works on the same Wi-Fi. Tunnels are opt-in help for the user's own "reach it from outside" problem.
  const start = cfFamily(a.tunnel);
  const picked = await ask(select({ message: withBack(t('setup.tunnelQ')), options: tunnelOptions(), initialValue: start }));
  const base = { ...a };
  for (const k of TUNNEL_KEYS) delete base[k];
  // Staying in the cloudflare family keeps its fields as defaults; arriving from another tunnel starts clean.
  if (picked === 'cloudflare') return editCfMode(cfFamily(a.tunnel) === 'cloudflare' ? a : base);
  if (picked === start) return a;   // unchanged type → keep fields, go straight to the field hub
  base.tunnel = picked;
  if (picked === 'ssh') {
    base.sshHost = await ask(text({ message: t('setup.askSshHost'), defaultValue: '', validate: validateNonEmpty('ssh host') }));
  } else if (picked === 'natapp' || picked === 'cpolar') {
    note(t(picked === 'natapp' ? 'setup.natappGuide' : 'setup.cpolarGuide'));
    base.authtoken = await ask(password({ message: t('setup.askAuthtoken'), validate: validateNonEmpty('authtoken') }));
  }
  return base;
}

// Edit one Connection field in place (from its mini-hub row).
async function editConnField(a, field) {
  const n = { ...a };
  const setOpt = (k, v) => { if (v) n[k] = v; else delete n[k]; };
  switch (field) {
    // initialValue pre-fills the field with the current value so you edit in place (and can just Enter to keep
    // it); an empty submit clears the optional ones (setOpt). Secrets use password() — never pre-filled.
    case 'cfHostname': n.cfHostname = await ask(text({ message: t('setup.askHostname'), initialValue: a.cfHostname || '', validate: validateHost })); break;
    case 'cfTunnelName': n.cfTunnelName = (await ask(text({ message: t('setup.askTunnelName'), initialValue: a.cfTunnelName || 'handmux' }))) || 'handmux'; break;
    case 'sshHost': n.sshHost = await ask(text({ message: t('setup.askSshHost'), initialValue: a.sshHost || '', validate: validateNonEmpty('ssh host') })); break;
    case 'remotePort': n.remotePort = Number(await ask(text({ message: t('setup.askRemotePort'), initialValue: String(a.remotePort || a.port), validate: validatePort }))); break;
    case 'publicUrl': setOpt('publicUrl', await ask(text({ message: t('setup.askPublicUrl'), initialValue: a.publicUrl || '' }))); break;
    case 'sshJump': setOpt('sshJump', await ask(text({ message: t('setup.askSshJump'), initialValue: a.sshJump || '' }))); break;
    case 'authtoken': n.authtoken = await ask(password({ message: t('setup.askAuthtoken'), validate: validateNonEmpty('authtoken') })); break;
    case 'cpolarRegion': setOpt('cpolarRegion', await ask(text({ message: t('setup.askCpolarRegion'), initialValue: a.cpolarRegion || '' }))); break;
    case 'domain': {
      const fixed = await ask(select({
        message: t('setup.domainQ'),
        options: [{ value: false, label: t('setup.domainTemp'), hint: t('setup.domainTempHint') }, { value: true, label: t('setup.domainFixed') }],
        initialValue: !!a.publicUrl,
      }));
      if (fixed) n.publicUrl = await ask(text({ message: t(a.tunnel === 'natapp' ? 'setup.askNatappDomain' : 'setup.askCpolarDomain'), initialValue: a.publicUrl || '', validate: validateHost }));
      else delete n.publicUrl;
      break;
    }
  }
  return n;
}

// Run the tunnel's provisioning (browser login / key setup / client download) — idempotent, so it's safe to
// run once on the way OUT of the Connection mini-hub whenever something changed.
async function provisionConnection(a, { home, log }) {
  if (a.tunnel === 'cloudflare-named') await provisionCloudflareNamed({ home, hostname: a.cfHostname, tunnelName: a.cfTunnelName || 'handmux', port: a.port, log });
  else if (a.tunnel === 'ssh') await provisionSsh({ sshHost: a.sshHost, log });
  else if (a.tunnel === 'natapp' || a.tunnel === 'cpolar') await provisionNgrokClient({ tunnel: a.tunnel, home, authtoken: a.authtoken, log });
}

// Level 2 — the field hub for the chosen tunnel: each config field is a row showing its value (secrets
// masked); edit any in place. Esc leaves the field hub. Returns the updated answers.
async function editTunnelFields(a) {
  let next = { ...a };
  let cur;
  for (;;) {
    let pick;
    try {
      pick = await ask(select({ message: withBack(summarizeConnection(next)), options: connectionFieldRows(next), initialValue: cur }));
    } catch (e) {
      if (e !== CANCELLED) throw e;
      return next;
    }
    cur = pick;
    try { next = await editConnField(next, pick); }
    catch (e) { if (e !== CANCELLED) throw e; }   // Esc in a sub-edit → back to the field hub
  }
}

// Connection is TWO levels: FIRST pick the tunnel type (and, for cloudflare, temporary vs named) — level 1;
// THEN that tunnel's config fields appear inside it — level 2. Provisioning (browser login / key setup /
// client download) runs once on the way out, only if something changed. Esc at either level → main hub.
async function editConnection(a, ctx) {
  const before = JSON.stringify(a);
  let next;
  try {
    next = await pickTunnel(a);                          // level 1: type / mode / required fields
  } catch (e) { if (e !== CANCELLED) throw e; return a; }
  if (hasConnFields(next.tunnel)) {
    try { next = await editTunnelFields(next); }         // level 2: this tunnel's fields
    catch (e) { if (e !== CANCELLED) throw e; }
  }
  if (JSON.stringify(next) !== before) await provisionConnection(next, ctx);
  return next;
}

// Push notifications need a VAPID keypair. If one already exists we offer to keep it (regenerating would
// invalidate every existing phone subscription); otherwise we generate one on the spot. Returns the vapid
// object, or undefined to leave push off.
// Localise clack's Yes/No toggle for every confirm().
const yesno = () => ({ active: t('setup.yes'), inactive: t('setup.no') });
// A masked preview of an already-set secret for a sub-menu hint (last 4 shown, like `handmux config`).
const maskSecret = (s) => (String(s || '').length <= 8 ? '••••' : `••••${String(s).slice(-4)}`);

// Composite sections (push/voice) are their OWN mini-hub: when already configured, show the current values
// and let you edit/regenerate/turn-off in place — no "keep it? [y/n]" gate, matching how every other row
// shows its value and edits directly. Esc in the mini-hub returns to the main hub (keeping edits); Esc in a
// sub-edit returns to the mini-hub. Push needs a VAPID keypair, so turning it ON is a genuine one-shot setup.
async function editPush(a) {
  let vapid = a.vapid;
  if (!vapid) {
    let on;
    try { on = await ask(confirm({ message: withBack(t('setup.pushSetup')), initialValue: false, ...yesno() })); }
    catch (e) { if (e === CANCELLED) return undefined; throw e; }
    if (!on) return undefined;
    note(t('setup.pushAbout'));
    const subject = await ask(text({ message: t('setup.pushContact'), initialValue: 'mailto:admin@example.com', validate: validateContact }));
    const { publicKey, privateKey } = webpush.generateVAPIDKeys();
    note(t('setup.pushGenerated'));
    vapid = { public: publicKey, private: privateKey, subject };
  }
  for (;;) {
    let pick;
    try {
      pick = await ask(select({
        message: withBack(t('setup.secPush')),
        options: [
          { value: 'contact', label: t('setup.pushContactLabel'), hint: vapid.subject || '' },
          { value: 'regen', label: t('setup.pushRegen'), hint: t('setup.pushRegenHint') },
          { value: 'off', label: t('setup.pushOff') },
        ],
        initialValue: 'contact',
      }));
    } catch (e) { if (e === CANCELLED) return vapid; throw e; }   // back to the main hub, keeping edits
    if (pick === 'off') return undefined;
    try {
      if (pick === 'contact') vapid = { ...vapid, subject: await ask(text({ message: t('setup.pushContact'), initialValue: vapid.subject || '', validate: validateContact })) };
      else if (pick === 'regen') {
        const ok = await ask(confirm({ message: t('setup.pushRegenConfirm'), initialValue: false, ...yesno() }));
        if (ok) {
          const k = webpush.generateVAPIDKeys();
          vapid = { ...vapid, public: k.publicKey, private: k.privateKey };
          note(t('setup.pushRegenerated'));
        }
      }
    } catch (e) { if (e !== CANCELLED) throw e; }                 // Esc in a sub-edit → back to the mini-hub
  }
}

// Voice input (iFlytek/xfyun) — three credentials; appId is shown/edited in the clear, the two secrets show
// only a masked preview and are replaced (never revealed) when edited.
async function editVoice(a) {
  let x = a.xfyun;
  if (!x) {
    let on;
    try { on = await ask(confirm({ message: withBack(t('setup.voiceSetup')), initialValue: false, ...yesno() })); }
    catch (e) { if (e === CANCELLED) return undefined; throw e; }
    if (!on) return undefined;
    const appId = await ask(text({ message: t('setup.voiceAppId'), validate: validateNonEmpty('appId') }));
    const apiKey = await ask(password({ message: t('setup.voiceApiKey'), validate: validateNonEmpty('apiKey') }));
    const apiSecret = await ask(password({ message: t('setup.voiceApiSecret'), validate: validateNonEmpty('apiSecret') }));
    x = { appId, apiKey, apiSecret };
  }
  for (;;) {
    let pick;
    try {
      pick = await ask(select({
        message: withBack(t('setup.secVoice')),
        options: [
          { value: 'appId', label: 'appId', hint: x.appId || '' },
          { value: 'apiKey', label: 'apiKey', hint: maskSecret(x.apiKey) },
          { value: 'apiSecret', label: 'apiSecret', hint: maskSecret(x.apiSecret) },
          { value: 'off', label: t('setup.voiceOff') },
        ],
        initialValue: 'appId',
      }));
    } catch (e) { if (e === CANCELLED) return x; throw e; }
    if (pick === 'off') return undefined;
    try {
      if (pick === 'appId') x = { ...x, appId: await ask(text({ message: t('setup.voiceAppId'), initialValue: x.appId || '', validate: validateNonEmpty('appId') })) };
      else if (pick === 'apiKey') x = { ...x, apiKey: await ask(password({ message: t('setup.voiceApiKey'), validate: validateNonEmpty('apiKey') })) };
      else if (pick === 'apiSecret') x = { ...x, apiSecret: await ask(password({ message: t('setup.voiceApiSecret'), validate: validateNonEmpty('apiSecret') })) };
    } catch (e) { if (e !== CANCELLED) throw e; }
  }
}

// login (browser) → create → route dns → write config.yml. The only human step is the browser login.
async function provisionCloudflareNamed({ home, hostname, tunnelName, port, log }) {
  const bin = await resolveCloudflared(home);
  const cfDir = path.join(home, '.cloudflared');
  if (!fs.existsSync(path.join(cfDir, 'cert.pem'))) {
    log.log(t('setup.cfLogin'));
    spawnSync(bin, ['tunnel', 'login'], { stdio: 'inherit' });
  }
  // Idempotent: reuse the tunnel if it already exists (re-running setup, or after a stop), else create it.
  // Without this, `tunnel create` errors "already exists" and you'd have to keep renaming — leaving orphan
  // tunnels piling up in the Cloudflare account.
  const listed = spawnSync(bin, ['tunnel', 'list', '--output', 'json'], { encoding: 'utf8' });
  let id = findTunnelId(listed.stdout, tunnelName);
  let credentialsFile = null;
  if (id) {
    log.log(t('setup.cfReuse', { name: tunnelName, id }));
    credentialsFile = path.join(cfDir, `${id}.json`);
    if (!fs.existsSync(credentialsFile)) {
      log.error(t('setup.cfCredMissing1', { file: credentialsFile }));
      log.error(t('setup.cfCredMissing2', { bin, name: tunnelName }));
    }
  } else {
    log.log(t('setup.cfCreate', { name: tunnelName }));
    const created = spawnSync(bin, ['tunnel', 'create', tunnelName], { encoding: 'utf8' });
    process.stdout.write(created.stdout || ''); process.stderr.write(created.stderr || '');
    const parsed = parseTunnelCreate(`${created.stdout || ''}\n${created.stderr || ''}`);
    id = parsed.id;
    credentialsFile = parsed.credentialsFile;
  }
  log.log(t('setup.cfRoute', { host: hostname }));
  // --overwrite-dns: re-running setup (or pointing a hostname already routed) must not error on the DNS step.
  const routed = spawnSync(bin, ['tunnel', 'route', 'dns', '--overwrite-dns', tunnelName, hostname], { encoding: 'utf8' });
  if (routed.status !== 0) {
    process.stderr.write(routed.stderr || '');
    log.error(t('setup.cfRouteFail', { domain: hostname.split('.').slice(-2).join('.') }));
    log.error(t('setup.cfRouteFail2'));
  }
  fs.mkdirSync(cfDir, { recursive: true });
  fs.writeFileSync(path.join(cfDir, 'config.yml'),
    cfConfigYaml({ tunnelName, credentialsFile: credentialsFile || path.join(cfDir, `${id || tunnelName}.json`), hostname, port }));
  log.log(t('setup.wrote', { path: path.join(cfDir, 'config.yml') }));
}

// drive tunlite passwordless setup inline (one password) if not already set up.
async function provisionSsh({ sshHost, log }) {
  const bin = resolveTunlite();
  if (checkSshAuth(sshHost, { bin }) === 0) { log.log(t('setup.sshReady')); return; }
  log.log(t('setup.sshSetup', { host: sshHost }));
  spawnSync(bin, ['setup-key', sshHost], { stdio: 'inherit' });
}

// Get the client binary ready (cpolar auto-downloads; natapp must be pre-installed) and, for cpolar, seed
// the authtoken into its config. NON-FATAL: if the binary isn't there yet we print the hint and still write
// the config, so the user can install it later and just `handmux start` — the wizard never dead-ends here.
async function provisionNgrokClient({ tunnel, home, authtoken, log }) {
  try {
    if (tunnel === 'cpolar') {
      const bin = await resolveCpolar(home);
      if (authtoken) spawnSync(bin, ['authtoken', authtoken], { stdio: 'ignore' });
      log.log(t('setup.cpolarReady'));
    } else {
      resolveNatapp(home);
      log.log(t('setup.natappReady'));
    }
  } catch (e) { log.log(t('err.generic', { msg: e.message })); }
}

function printSshServerHelp(a, log) {
  log.log('');
  log.log(t('setup.sshHelp1'));
  log.log(t('setup.sshHelpNginx', { port: a.remotePort }));
  log.log(t('setup.sshHelpCaddy', { url: a.publicUrl || '<your-domain>', port: a.remotePort }));
  log.log('');
}

// FYI on dynamic port preview: it's optional and NOT wired by this wizard (separate wildcard domain). Print
// the requirement + a TLS note that fits the chosen tunnel — Cloudflare's free cert only covers one level
// (so deeper needs ACM), whereas on the ssh/own-edge path the user serves their own wildcard cert. Shown
// only for wildcard-capable tunnels (a quick tunnel can't do wildcards at all).
function printPreviewHelp(tunnel, log) {
  log.log(t('setup.previewHelp1'));
  log.log(t('setup.previewHelp2'));
  if (tunnel === 'cloudflare-named') {
    log.log(t('setup.previewTlsCf'));
  } else {
    log.log(t('setup.previewTlsEdge'));
  }
  log.log('');
}
