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

function readExisting(file) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return {}; }
}

// The hub. Pre-fills from the existing config so a re-run edits/switches rather than starts over; a brand-
// new config first walks Connection, then everyone lands on the hub (edit any section, then Save/Start/Exit).
// Returns { cfg, start } (start = the user chose "save & start"), or null on cancel/exit. `home` and the
// write `target` are injectable for tests / `--config`.
export async function runSetup({ home = homedir(), target = configPath(home), log = console } = {}) {
  if (!process.stdin.isTTY) { log.error(t('setup.needTty')); return null; }
  const existing = readExisting(target);
  const isNew = !existing || Object.keys(existing).length === 0;
  let a = answersFromConfig(existing);
  setLocale(a.lang);

  intro('handmux setup');
  try {
    if (isNew) {
      a.lang = await editLanguage(a);
      a = await editConnection(a, { home, log });
    }
    for (;;) {
      const choice = await ask(select({
        message: t('setup.hubTitle'),
        options: [
          { value: 'connection', label: t('setup.secConnection'), hint: summarizeConnection(a) },
          { value: 'name', label: t('setup.secName'), hint: a.name || t('setup.default') },
          { value: 'port', label: t('setup.secPort'), hint: String(a.port) },
          { value: 'language', label: t('setup.secLanguage'), hint: a.lang === 'zh' ? '中文' : 'English' },
          { value: 'push', label: t('setup.secPush'), hint: a.vapid ? t('setup.on') : t('setup.off') },
          { value: 'voice', label: t('setup.secVoice'), hint: a.xfyun ? t('setup.on') : t('setup.off') },
          { value: 'start', label: t('setup.actStart') },
          { value: 'save', label: t('setup.actSave') },
          { value: 'exit', label: t('setup.actExit') },
        ],
        initialValue: 'start',
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
      if (choice === 'connection') a = await editConnection(a, { home, log });
      else if (choice === 'name') a.name = await editName(a);
      else if (choice === 'port') a.port = await editPort(a);
      else if (choice === 'language') a.lang = await editLanguage(a);
      else if (choice === 'push') a.vapid = await editPush(a);
      else if (choice === 'voice') a.xfyun = await editVoice(a);
    }
  } catch (e) {
    if (e === CANCELLED) { cancel(t('setup.exited')); return null; }
    throw e;
  }
}

async function editLanguage(a) {
  const lang = await ask(select({
    message: t('setup.langQ'),
    options: [{ value: 'en', label: 'English' }, { value: 'zh', label: '中文' }],
    initialValue: a.lang === 'zh' ? 'zh' : 'en',
  }));
  setLocale(lang);   // apply immediately so the rest of the hub speaks the chosen language
  return lang;
}

async function editName(a) {
  const v = await ask(text({ message: t('setup.askName'), placeholder: a.name || t('setup.default'), defaultValue: a.name || '' }));
  return (v || '').trim();
}

async function editPort(a) {
  const v = await ask(text({ message: t('setup.askPort'), placeholder: String(a.port), defaultValue: String(a.port), validate: validatePort }));
  return Number(v);
}

// Pick the tunnel, ask ONLY its fields, and run its provisioning in place. Clears the previous tunnel's
// keys first so a switch never advertises a stale hostname/token.
async function editConnection(a, { home, log }) {
  const tunnel = await ask(select({
    message: t('setup.tunnelQ'),
    options: [
      { value: 'none', label: 'none', hint: t('setup.hintNone') },
      { value: 'cloudflare', label: 'cloudflare', hint: t('setup.hintCf') },
      { value: 'cloudflare-named', label: 'cloudflare-named', hint: t('setup.hintCfNamed') },
      { value: 'ssh', label: 'ssh (tunlite)', hint: t('setup.hintSsh') },
      { value: 'natapp', label: 'natapp', hint: t('setup.hintNatapp') },
      { value: 'cpolar', label: 'cpolar', hint: t('setup.hintCpolar') },
    ],
    initialValue: a.tunnel || 'cloudflare',
  }));
  const next = { ...a, tunnel };
  for (const k of TUNNEL_KEYS) delete next[k];

  if (tunnel === 'cloudflare-named') {
    next.cfHostname = await ask(text({ message: t('setup.askHostname'), defaultValue: a.cfHostname || '', validate: validateHost }));
    next.cfTunnelName = (await ask(text({ message: t('setup.askTunnelName'), defaultValue: a.cfTunnelName || 'handmux' }))) || 'handmux';
    await provisionCloudflareNamed({ home, hostname: next.cfHostname, tunnelName: next.cfTunnelName, port: next.port, log });
  } else if (tunnel === 'ssh') {
    next.sshHost = await ask(text({ message: t('setup.askSshHost'), defaultValue: a.sshHost || '', validate: validateNonEmpty('ssh host') }));
    next.remotePort = Number(await ask(text({ message: t('setup.askRemotePort'), defaultValue: String(a.remotePort || next.port), validate: validatePort })));
    const pub = await ask(text({ message: t('setup.askPublicUrl'), defaultValue: a.publicUrl || '' }));
    if (pub) next.publicUrl = pub;
    await provisionSsh({ sshHost: next.sshHost, log });
  } else if (tunnel === 'natapp' || tunnel === 'cpolar') {
    note(t(tunnel === 'natapp' ? 'setup.natappGuide' : 'setup.cpolarGuide'));
    next.authtoken = await ask(password({ message: t('setup.askAuthtoken'), validate: validateNonEmpty('authtoken') }));
    const fixed = await ask(select({
      message: t('setup.domainQ'),
      options: [
        { value: false, label: t('setup.domainTemp'), hint: t('setup.domainTempHint') },
        { value: true, label: t('setup.domainFixed') },
      ],
      initialValue: !!a.publicUrl,
    }));
    if (fixed) {
      next.publicUrl = await ask(text({
        message: t(tunnel === 'natapp' ? 'setup.askNatappDomain' : 'setup.askCpolarDomain'),
        defaultValue: a.publicUrl || '', validate: validateHost,
      }));
    }
    if (tunnel === 'cpolar') {
      const rg = await ask(text({ message: t('setup.askCpolarRegion'), defaultValue: a.cpolarRegion || '' }));
      if (rg) next.cpolarRegion = rg;
    }
    await provisionNgrokClient({ tunnel, home, authtoken: next.authtoken, log });
  }
  return next;
}

// Push notifications need a VAPID keypair. If one already exists we offer to keep it (regenerating would
// invalidate every existing phone subscription); otherwise we generate one on the spot. Returns the vapid
// object, or undefined to leave push off.
// Localise clack's Yes/No toggle for every confirm().
const yesno = () => ({ active: t('setup.yes'), inactive: t('setup.no') });

async function editPush(a) {
  if (a.vapid) return (await ask(confirm({ message: t('setup.pushKeep'), initialValue: true, ...yesno() }))) ? a.vapid : undefined;
  if (!await ask(confirm({ message: t('setup.pushSetup'), initialValue: false, ...yesno() }))) return undefined;
  const subject = await ask(text({ message: t('setup.pushContact'), defaultValue: 'mailto:admin@example.com' }));
  const { publicKey, privateKey } = webpush.generateVAPIDKeys();
  note(t('setup.pushGenerated'));
  return { public: publicKey, private: privateKey, subject };
}

// Voice input (iFlytek/xfyun) — three credentials from their console; the two secrets are masked.
async function editVoice(a) {
  if (a.xfyun) return (await ask(confirm({ message: t('setup.voiceKeep'), initialValue: true, ...yesno() }))) ? a.xfyun : undefined;
  if (!await ask(confirm({ message: t('setup.voiceSetup'), initialValue: false, ...yesno() }))) return undefined;
  const appId = await ask(text({ message: t('setup.voiceAppId'), validate: validateNonEmpty('appId') }));
  const apiKey = await ask(password({ message: t('setup.voiceApiKey'), validate: validateNonEmpty('apiKey') }));
  const apiSecret = await ask(password({ message: t('setup.voiceApiSecret'), validate: validateNonEmpty('apiSecret') }));
  return { appId, apiKey, apiSecret };
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
