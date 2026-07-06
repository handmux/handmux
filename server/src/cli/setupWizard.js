// `handmux setup` wizard. Pure mappers (config shape, cloudflared config.yml, parsing tunnel create
// output) are split out and unit-tested; the readline/spawn shell (runSetup, added in the next task) is
// thin glue on top.

import fs from 'node:fs';
import path from 'node:path';
import { homedir } from 'node:os';
import { spawnSync } from 'node:child_process';
import { createInterface } from 'node:readline';
import webpush from 'web-push';
import { configPath, pocketHome } from './state.js';
import { resolveCloudflared } from './cloudflared.js';
import { resolveTunlite, checkSshAuth } from './tunlite.js';
import { resolveNatapp, resolveCpolar } from './tunnelClients.js';
import { t, setLocale, getLocale } from './i18n/index.js';

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
  const hit = arr.find((t) => t && t.name === name);
  return hit?.id || null;
}

// The config keys the wizard owns: everything it asks about. mergeConfig wipes these from the existing
// config before re-applying the answers, so a blank answer (or an unselected tunnel) cleanly clears the
// old value instead of leaving a stale field behind. Anything NOT here (token, staticDir, previewDomain…)
// is preserved untouched.
const WIZARD_KEYS = [
  'lang', 'name', 'port', 'tunnel',
  'sshHost', 'remotePort', 'sshJump', 'cfHostname', 'cfTunnelName', 'publicUrl',
  'authtoken', 'cpolarRegion',
  'vapid', 'xfyun',
];

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

const ask = (rl, q, dflt) => new Promise((res) =>
  rl.question(dflt ? `${q} [${dflt}] ` : `${q} `, (a) => res((a.trim() || dflt || ''))));

// [y/N] / [Y/n] prompt. `dfltYes` sets which way a bare Enter goes.
const askYesNo = async (rl, q, dfltYes) => {
  const a = (await ask(rl, `${q} ${dfltYes ? '[Y/n]' : '[y/N]'}`, '')).trim().toLowerCase();
  if (a === '') return dfltYes;
  return a === 'y' || a === 'yes';
};

function readExisting(file) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return {}; }
}

// Interactive wizard — the one place to configure handmux. Pre-fills from the existing config so a re-run
// edits/switches rather than starts over, asks name → tunnel → push → voice, and merges the answers back
// (preserving fields it didn't ask about). Returns the resolved config (or null on abort). `home` and the
// write `target` are injectable for tests / `--config`.
export async function runSetup({ home = homedir(), target = configPath(home), log = console } = {}) {
  if (!process.stdin.isTTY) { log.error(t('setup.needTty')); return null; }
  const cur = readExisting(target);
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  try {
    // Language first — pick it, apply it immediately, so the rest of the wizard speaks the chosen language.
    // Default reflects the locale already resolved (from config/shell); Enter keeps it.
    log.log(t('setup.langQ'));
    log.log(t('setup.lang1'));
    log.log(t('setup.lang2'));
    const langPick = await ask(rl, t('setup.choose').replace('1-6', '1-2'), getLocale() === 'zh' ? '2' : '1');
    const lang = { 1: 'en', 2: 'zh' }[langPick] || getLocale();
    setLocale(lang);

    const name = await ask(rl, t('setup.askName'), cur.name || '');

    log.log(t('setup.tunnelQ'));
    log.log(t('setup.tunnel1'));
    log.log(t('setup.tunnel2'));
    log.log(t('setup.tunnel3'));
    log.log(t('setup.tunnel4'));
    log.log(t('setup.tunnel5'));
    log.log(t('setup.tunnel6'));
    // Default to the CURRENT tunnel when re-running; for a brand-new user (no config) default to '2'
    // (cloudflare quick tunnel — zero-config, instant public URL) rather than '3' (cloudflare-named),
    // which a bare-Enter newcomer can't complete without a Cloudflare login + their own domain.
    const curPick = { none: '1', cloudflare: '2', 'cloudflare-named': '3', ssh: '4', natapp: '5', cpolar: '6' }[cur.tunnel] || '2';
    const pick = await ask(rl, t('setup.choose'), curPick);
    const tunnel = { 1: 'none', 2: 'cloudflare', 3: 'cloudflare-named', 4: 'ssh', 5: 'natapp', 6: 'cpolar' }[pick];
    if (!tunnel) { log.error(t('setup.invalid')); return null; }
    const port = Number(await ask(rl, t('setup.askPort'), String(cur.port || 19999)));

    const answers = { lang, name, tunnel, port };
    if (tunnel === 'cloudflare-named') {
      answers.cfHostname = await ask(rl, t('setup.askHostname'), cur.cfHostname || '');
      answers.cfTunnelName = await ask(rl, t('setup.askTunnelName'), cur.cfTunnelName || 'handmux');
      await provisionCloudflareNamed({ home, hostname: answers.cfHostname, tunnelName: answers.cfTunnelName, port, log });
    } else if (tunnel === 'ssh') {
      answers.sshHost = await ask(rl, t('setup.askSshHost'), cur.sshHost || '');
      answers.remotePort = Number(await ask(rl, t('setup.askRemotePort'), String(cur.remotePort || port)));
      answers.publicUrl = await ask(rl, t('setup.askPublicUrl'), cur.publicUrl || '');
      await provisionSsh({ sshHost: answers.sshHost, log });
    } else if (tunnel === 'natapp' || tunnel === 'cpolar') {
      // Guide the user to their authtoken, then let them choose a temporary (random) or fixed domain.
      log.log(t(tunnel === 'natapp' ? 'setup.natappGuide' : 'setup.cpolarGuide'));
      answers.authtoken = await ask(rl, t('setup.askAuthtoken'), cur.authtoken || '');
      if (await askYesNo(rl, t('setup.askFixed'), false)) {
        answers.publicUrl = await ask(rl, t(tunnel === 'natapp' ? 'setup.askNatappDomain' : 'setup.askCpolarDomain'), cur.publicUrl || '');
      }
      if (tunnel === 'cpolar') answers.cpolarRegion = await ask(rl, t('setup.askCpolarRegion'), cur.cpolarRegion || '');
      await provisionNgrokClient({ tunnel, home, authtoken: answers.authtoken, log });
    }

    answers.vapid = await askPush(rl, cur.vapid, log);
    answers.xfyun = await askVoice(rl, cur.xfyun, log);

    const cfg = mergeConfig(cur, answers);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, JSON.stringify(cfg, null, 2) + '\n', { mode: 0o600 });
    log.log(t('setup.wrote', { path: target }));
    if (tunnel === 'ssh') printSshServerHelp(answers, log);
    if (tunnel === 'cloudflare-named' || tunnel === 'ssh') printPreviewHelp(tunnel, log);
    return cfg;
  } finally { rl.close(); }
}

// Push notifications need a VAPID keypair. If one already exists we offer to keep it (regenerating would
// invalidate every existing phone subscription); otherwise we generate one on the spot — the only painful
// part of push setup, done for the user. Returns the vapid object, or undefined to leave push off.
async function askPush(rl, existing, log) {
  if (existing) {
    if (await askYesNo(rl, t('setup.pushKeep'), true)) return existing;
    return undefined;
  }
  if (!await askYesNo(rl, t('setup.pushSetup'), false)) return undefined;
  const { publicKey, privateKey } = webpush.generateVAPIDKeys();
  const subject = await ask(rl, t('setup.pushContact'), 'mailto:admin@example.com');
  log.log(t('setup.pushGenerated'));
  return { public: publicKey, private: privateKey, subject };
}

// Voice input (iFlytek/xfyun) — three credentials from their console; no generation possible, just paste.
async function askVoice(rl, existing, log) {
  if (existing) {
    if (await askYesNo(rl, t('setup.voiceKeep'), true)) return existing;
    return undefined;
  }
  if (!await askYesNo(rl, t('setup.voiceSetup'), false)) return undefined;
  const appId = await ask(rl, t('setup.voiceAppId'));
  const apiKey = await ask(rl, t('setup.voiceApiKey'));
  const apiSecret = await ask(rl, t('setup.voiceApiSecret'));
  if (!appId || !apiKey || !apiSecret) { log.log(t('setup.voiceSkipped')); return undefined; }
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

// Get the client binary ready (cpolar auto-downloads; natapp must be pre-installed) and, for cpolar, seed the
// authtoken into its config. NON-FATAL: if the binary isn't there yet we print the hint and still write the
// config, so the user can install it later and just `handmux start` — the wizard never dead-ends on this.
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
