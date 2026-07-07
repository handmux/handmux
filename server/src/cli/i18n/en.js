// English catalog (the fallback locale). Keys are grouped by command/area. `{var}` placeholders are filled
// by translate(). Keep this in lockstep with zh.js — a missing zh key silently falls back to the line here.
export default {
  // generic
  'err.generic': '✗ {msg}',
  'err.configNotFound': '✗ --config {path}: not found',
  'err.badConfig': '✗ bad config {path}: {msg}',
  'err.namedNotProvisioned': '✗ named tunnel not provisioned — run `handmux setup` first',

  // config line printed at the top of start / service install
  'config.loaded': 'config: {path}',
  'config.none': '(none — flags + defaults)',

  // ssh preflight
  'ssh.confirmSetup': 'passwordless SSH to {host} is not set up. Configure it now?',
  'ssh.notSetup': 'passwordless SSH not set up — run: {bin} setup-key {host}',

  // tmux presence / version
  'tmux.notFound': '✗ tmux not found.',
  'tmux.explain1': '  handmux runs on top of tmux (a terminal multiplexer) — it drives your real tmux',
  'tmux.explain2': '  panes from your phone, so you need tmux on this machine first.',
  'tmux.install': '  Install it:  {hint}',
  'tmux.thenStart': '  Then run `handmux start` again.',
  'open.usage': 'usage: handmux open <session>   attach the tmux session (creates it if missing)',
  'open.insideTmux': "you're already inside tmux — switch sessions with tmux itself (e.g. `tmux switch-client -t <session>`), don't nest.",
  'tmux.tooOld': '⚠ tmux {raw} is below the tested minimum {min}; terminal rendering may be off',

  // start — already running
  'start.running.same': 'handmux is already running — open the address below.',
  'start.running.changedHead': 'handmux is already running (tunnel: {tunnel}). A running instance does NOT pick up config changes on its own:',
  'start.running.changedRow': '  • {key}: {from} → {to} (what you asked for now)',
  'start.running.switchQ': 'Switch to the new settings now? (restarts handmux)',
  'start.running.hint': "Leaving it as-is. Run 'handmux restart' whenever you want to apply the new settings.",

  // start — launching
  'start.overrides': '  ↳ --tunnel {flag} overrides config ({file}) for this run only',
  'start.foreground': 'starting handmux (tunnel: {tunnel}, port: {port}) — Ctrl-C to stop',
  'start.starting': 'starting handmux (tunnel: {tunnel}, port: {port}) …',

  // stop / status
  'stop.notRunning': 'handmux not running',
  'stop.stopped': 'stopped handmux (pid {pid})',
  'status.stopped': '● handmux stopped',
  'status.running': '● handmux running',

  // logs
  'logs.none': '(no log yet — start handmux first)',

  // update
  'update.available': '  ⬆  handmux {latest} is available (you have {current})',
  'update.how': '     upgrade:  handmux update   (or npm i -g handmux@latest)',
  'update.running': 'Upgrading handmux (npm i -g handmux@latest)…',
  'update.done': '✓ handmux updated.',
  'update.restartHint': '  run `handmux restart` to run the new version.',
  'update.failed': '✗ Upgrade failed. Try manually: npm i -g {pkg}@latest (may need sudo).',

  // cloudflared auto-download
  'cf.downloading': '  ↓ downloading cloudflared ({file}) …',

  // natapp / cpolar client binaries
  'client.downloading': '  ↓ downloading {name} ({file}) …',
  'client.cpolarManual': '✗ cpolar not available — install it from https://www.cpolar.com/download (unzip the binary into ~/.handmux/bin/), then re-run.',
  'client.cpolarAuthFail': '✗ cpolar rejected the authtoken — double-check it at https://dashboard.cpolar.com',
  'client.natappManual': '✗ natapp not found — download it from https://natapp.cn (login first, it is not a public download), then put the `natapp` binary in {dir} (or anywhere on your PATH) and re-run.',

  // access block (printAccess)
  'access.noState': '  (no state)',
  'access.error': '  ✗ {msg}',
  'access.tunnel': '  tunnel   {tunnel}   ·   pid {pid}',
  'access.open': '  🌐 open   {url}',
  'access.pending': '(pending…)',
  'access.lan': '  📶 lan    {url}',
  'access.local': '  💻 local  {url}',
  'access.token': '  🔑 token  {token}',
  'access.reachable': '  ✓ reachable',
  'access.unreachable': '  ⚠ tunnel up but {url} did not answer — check the server-side reverse proxy / DNS',
  'access.hint': '  handmux status | stop',

  // hooks
  'hooks.confirmEnable': 'Enable coding-agent notifications (inbox)?',
  'hooks.installedShort': '✓ Agent hooks installed.',
  'hooks.noClaude': 'Claude Code not detected (~/.claude missing) — nothing to install.',
  'hooks.noAgents': 'No coding agent detected (no ~/.claude, and codex not on PATH) — nothing to install.',
  'hooks.installed': '✓ Claude hooks installed → ~/.claude/settings.json',
  'hooks.installedClaude': '✓ Claude Code hooks installed → ~/.claude/settings.json',
  'hooks.installedCodex': '✓ Codex hooks installed → ~/.codex/config.toml',
  'hooks.installedHint': '  Restart or open a new agent session to load them; the inbox lights up as panes report.',
  'hooks.removed': '✓ Agent hooks removed.',
  'hooks.usage': 'usage: handmux hooks install|uninstall',

  // Claude statusLine usage capturer (powers the phone Usage page's 5h/weekly bars)
  'statusline.confirmEnable': "Show Claude's 5h/weekly usage on the phone? (installs a Claude statusLine)",
  'statusline.installed': '✓ Claude statusLine installed → ~/.claude/settings.json',
  'statusline.reload': '  Open a new Claude session to load it; the Usage page fills in as it reports.',
  'statusline.foreignHint': 'You already have a Claude statusLine — leaving it untouched. To also feed the phone Usage page, pipe it through our capturer:',

  // service
  'service.usage': 'usage: handmux service install [start-flags] | handmux service uninstall',
  'service.installed': "handmux will now start at login. 'handmux service uninstall' to remove.",

  // config command
  'configcmd.file': 'config file: {path}',
  'configcmd.fileNone': '(none — using defaults; run `handmux setup` to create one)',
  'configcmd.legend': '  origin: flag (this run only) · file · env · default',

  // setup wizard
  'setup.confirmStart': 'Start handmux now?',
  'setup.later': "run 'handmux start' when you're ready.",
  'setup.laterRestart': "already running — run 'handmux restart' to apply the changes.",
  'setup.needTty': 'handmux setup needs an interactive terminal',
  'setup.langQ': 'Language / 语言',
  'setup.lang1': '  1) English',
  'setup.lang2': '  2) 中文',
  'setup.askName': 'app name (shown in the browser tab / home-screen icon; blank = default)',
  'setup.tunnelQ': 'How should your phone reach this machine?',
  'setup.tunnel1': '  1) none              — same Wi-Fi / LAN only',
  'setup.tunnel2': '  2) cloudflare        — instant, random temporary https URL',
  'setup.tunnel3': '  3) cloudflare-named  — your domain, stable HTTPS (most hands-off)',
  'setup.tunnel4': '  4) ssh (tunlite)     — your own server / edge',
  'setup.tunnel5': '  5) natapp            — China-usable tunnel (needs a natapp authtoken)',
  'setup.tunnel6': '  6) cpolar            — China-usable tunnel (auto-installs; needs a cpolar authtoken)',
  'setup.choose': 'choose 1-6',
  'setup.invalid': 'invalid choice',
  'setup.askPort': 'server port',
  'setup.askHostname': 'public hostname (e.g. handmux.example.com)',
  'setup.askTunnelName': 'tunnel name',
  'setup.askSshHost': 'ssh host (user@host[:port])',
  'setup.askRemotePort': 'remote port on the ssh host',
  'setup.askPublicUrl': 'public url — http(s):// as appropriate (blank = http://host:remotePort)',
  'setup.natappGuide': 'Where to get the authtoken: register free at https://natapp.cn → create a tunnel → copy its authtoken (the free tier is enough to start).',
  'setup.cpolarGuide': 'Where to get the authtoken: register free at https://cpolar.com → open the dashboard → Verify → copy your authtoken.',
  'setup.askAuthtoken': 'authtoken',
  'setup.askFixed': 'use a fixed domain? (No = a free temporary domain, changes each restart)',
  'setup.askNatappDomain': 'your reserved domain bound to this authtoken (e.g. myapp.natapp1.cc)',
  'setup.askCpolarDomain': 'your reserved second-level subdomain or bound domain (e.g. myapp.cpolar.top)',
  'setup.askCpolarRegion': 'cpolar region (cn = mainland China, faster domestically; blank = cpolar default)',
  'setup.natappReady': '✓ natapp client ready',
  'setup.cpolarReady': '✓ cpolar client ready',
  // setup hub (menu model)
  'setup.welcome': "handmux is open-source and runs no relay of its own — your phone always connects to your own computer, which keeps it private and secure; on the same Wi-Fi it's a pure direct link and works out of the box (pick none). To reach it from outside too, the options below are built-in ways to do that with your own free account. Not sure? Press Enter on the highlighted option — you can change it anytime.",
  'setup.hubTitle': 'Anything to change? (or just Save & start)',
  'setup.secConnection': 'Connection',
  'setup.secName': 'Name',
  'setup.secPort': 'Port',
  'setup.secLanguage': 'Language',
  'setup.secPush': 'Push',
  'setup.secVoice': 'Voice',
  'setup.default': '(default)',
  'setup.on': 'on',
  'setup.off': 'off',
  'setup.yes': 'Yes',
  'setup.no': 'No',
  'setup.escBack': '(Esc to go back)',
  'setup.actStart': 'Save & start',
  'setup.actRestart': 'Save & restart (apply now)',
  'setup.actSave': 'Save',
  'setup.actExit': 'Exit — discard changes',
  'setup.exited': 'setup cancelled — no changes saved',
  'setup.hintNone': 'same Wi-Fi only — simplest, nothing to set up',
  'setup.hintCf': 'reach it from anywhere, no signup (temporary URL; can be flaky in China)',
  'setup.hintCfNamed': 'your domain, stable HTTPS (most hands-off)',
  'setup.hintSsh': 'you already have a server to route through',
  'setup.hintNatapp': 'reach it from anywhere, works in China (needs a free natapp account)',
  'setup.hintCpolar': 'reach it from anywhere, works in China, auto-installs (needs a free cpolar account)',
  'setup.domainQ': 'temporary or fixed domain?',
  'setup.domainTemp': 'Free temporary domain',
  'setup.domainTempHint': 'changes each restart',
  'setup.domainFixed': 'Fixed / reserved domain',
  'setup.valPort': 'port must be an integer 1–65535',
  'setup.valRequired': '{label} is required',
  'setup.valHost': 'enter a valid domain (e.g. myapp.example.com)',
  'setup.valContact': 'use mailto:you@example.com or https://your.site (a real domain — Apple rejects fake ones)',
  'setup.sumTemp': 'temporary',
  'setup.sumFixed': 'fixed',
  'setup.sumLan': 'LAN',
  // connection mini-hub (per-tunnel field rows)
  'setup.connTunnel': 'Tunnel',
  'setup.connMode': 'Mode',
  'setup.connHostname': 'Hostname',
  'setup.connTunnelName': 'Tunnel name',
  'setup.connSshHost': 'SSH host',
  'setup.connRemotePort': 'Remote port',
  'setup.connPublicUrl': 'Public URL',
  'setup.connJump': 'Jump host',
  'setup.connDomain': 'Domain',
  'setup.connRegion': 'Region',
  'setup.connNone': '(not set)',
  'setup.connAuto': '(auto)',
  'setup.askSshJump': 'ssh jump host (user@host, blank = none)',
  'setup.cfModeQ': 'cloudflare address',
  'setup.cfTemp': 'Temporary (no login)',
  'setup.cfTempHint': 'instant random https URL, changes each restart',
  'setup.cfNamed': 'Named (your domain)',
  'setup.cfNamedHint': 'stable HTTPS, needs a Cloudflare login',
  'setup.wrote': '✓ wrote {path}',
  'setup.pushKeep': 'keep push notifications configured?',
  'setup.pushSetup': 'Turn on phone notifications? (get pinged when a coding agent finishes)',
  'setup.pushAbout': 'handmux generates a private signing key for you and stores it in ~/.handmux/config.json — it never leaves this machine. The contact below is only an address the push service can reach you at; nobody else sees it.',
  'setup.pushContact': 'contact for the push service — mailto: or https:// (the default is fine; keep the mailto: prefix)',
  'setup.pushGenerated': '✓ generated a signing keypair (kept in your local config)',
  'setup.pushContactLabel': 'Contact',
  'setup.pushRegen': 'Regenerate keys',
  'setup.pushRegenHint': 'resets every phone subscription',
  'setup.pushRegenConfirm': 'Regenerate the keypair? Every phone that already subscribed stops getting notifications until it re-opens the web app and subscribes again. Only needed if the key leaked.',
  'setup.pushRegenerated': '✓ regenerated keys — existing phones must re-subscribe',
  'setup.pushOff': 'Turn off push',
  'setup.voiceOff': 'Turn off voice',
  'setup.voiceKeep': 'keep voice input configured?',
  'setup.voiceSetup': 'Turn on voice input? (talk to your phone → text; needs an iFlytek/xfyun account)',
  'setup.voiceAppId': 'xfyun appId',
  'setup.voiceApiKey': 'xfyun apiKey',
  'setup.voiceApiSecret': 'xfyun apiSecret',
  'setup.voiceSkipped': '  (skipped — missing fields)',
  'setup.cfLogin': '→ logging in to Cloudflare (a browser will open) …',
  'setup.cfReuse': '✓ reusing existing tunnel {name} ({id})',
  'setup.cfCredMissing1': '⚠ credentials file {file} not found on this machine — the tunnel was likely',
  'setup.cfCredMissing2': '  created elsewhere. Run `{bin} tunnel delete {name}` and re-run setup to recreate it here.',
  'setup.cfCreate': '→ creating tunnel {name} …',
  'setup.cfRoute': '→ routing {host} → tunnel …',
  'setup.cfRouteFail': "⚠ route dns failed — is {domain}'s DNS hosted on Cloudflare?",
  'setup.cfRouteFail2': '  Add the domain on Cloudflare (free) and point its nameservers there, then re-run setup.',
  'setup.sshReady': '✓ passwordless SSH already set up',
  'setup.sshSetup': "→ setting up passwordless SSH to {host} (you'll enter the password once) …",
  'setup.sshHelp1': 'Server side (one-time): point a reverse proxy at the forwarded loopback port.',
  'setup.sshHelpNginx': '  nginx:  proxy_pass http://127.0.0.1:{port};  (add client_max_body_size 60m; proxy_read_timeout 90s;)',
  'setup.sshHelpCaddy': '  caddy:  {url} {  reverse_proxy 127.0.0.1:{port}  }',
  'setup.previewHelp1': 'Optional — dynamic port preview (open a dev server by port on your phone):',
  'setup.previewHelp2': '  set  "previewDomain": "..."  in the config, and route the wildcard preview domain to the gateway.',
  'setup.previewTlsCf': "  TLS: Cloudflare's free cert covers ONE level (*.example.com); deeper (*.preview.example.com) needs Advanced Certificate Manager.",
  'setup.previewTlsEdge': "  TLS: your edge serves the wildcard cert (e.g. a Let's Encrypt *.preview.your.domain).",

  // help
  'help.body': `handmux — drive your tmux from your phone

  handmux start            run it (defaults to LAN-only; no config needed)
  handmux open <session>   attach a tmux session, creating it if missing — incl. ones made on the phone
  handmux setup            configure tunnel / name / notifications (writes config; re-run to change)
  handmux stop | restart | status
  handmux logs [--follow] [--lines N]
  handmux update           upgrade to the latest published version (npm i -g handmux@latest)

New here? run 'handmux setup' — it walks you through remote access + phone notifications.
The model: 'start' runs · 'setup' configures (writes ~/.handmux/config.json) · re-run setup to change.

more:
  handmux config                          show the effective config + where each value came from
  handmux hooks install|uninstall         enable/disable agent notifications (inbox)
  handmux service install|uninstall       start at login (launchd/systemd)
  handmux help flags                      one-run flags + env vars (scripting / headless / Docker)
  --config PATH · --lang en|zh · --version, -v
`,
  'help.flags': `handmux flags — one-run overrides & headless config

Precedence: flag > file (~/.handmux/config.json) > env (HANDMUX_*) > default.
A flag overrides one value for THIS run only and never persists — for persistence use 'handmux setup'.
env vars are the headless interface (Docker / systemd / CI) and DO carry across runs.

start flags (matching env var in parens):
  --tunnel none|cloudflare|cloudflare-named|ssh|natapp|cpolar   expose method (default: none)
  --port N                      server port (HANDMUX_PORT, default: 19999)
  --host H                      bind host (HANDMUX_HOST, default: 0.0.0.0)
  --token S                     auth token (HANDMUX_TOKEN, default: generated each start)
  --name "My Box"               app name in the browser tab + home-screen icon (HANDMUX_APP_NAME)
  --public-url URL              public url to advertise (HANDMUX_PUBLIC_URL; any tunnel, incl. none if
                                you run your own; ssh defaults to http://host:remotePort; for
                                natapp/cpolar this is your fixed/reserved domain — omit for a temporary one)
  --ssh-host user@host[:port]   ssh tunnel target (HANDMUX_SSH_HOST)
  --remote-port N               port bound on the ssh host (HANDMUX_REMOTE_PORT, default: --port)
  --ssh-jump u@h[,…]            optional bastion for ssh (HANDMUX_SSH_JUMP)
  --cf-hostname H               public hostname for cloudflare-named (HANDMUX_CF_HOSTNAME)
  --cf-tunnel-name N            tunnel name for cloudflare-named (HANDMUX_CF_TUNNEL_NAME, default: handmux)
  --authtoken T                 authtoken for natapp / cpolar (HANDMUX_AUTHTOKEN)
  --cpolar-region R             cpolar edge region, e.g. cn (HANDMUX_CPOLAR_REGION)
  --preview-domain D            enable dynamic previews, needs wildcard subdomain (HANDMUX_PREVIEW_DOMAIN)
  --foreground, -f              run in the foreground (don't daemonize)
  --no-qr                       don't render the QR code

rarely needed (env or flag): --static-dir / --upload-exts / --preview-ttl
  (HANDMUX_STATIC_DIR / HANDMUX_UPLOAD_EXTS / HANDMUX_PREVIEW_TTL)

'handmux service install' accepts these same start flags — they're baked into the autostart entry.
`,
};
