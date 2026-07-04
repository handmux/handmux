# handmux

**[handmux.com](https://handmux.com)** · *[中文文档 → README.zh-CN.md](README.zh-CN.md)*

[![npm](https://img.shields.io/npm/v/handmux?color=cb3837&logo=npm)](https://www.npmjs.com/package/handmux) [![CI](https://github.com/yuanyuanzijin/handmux/actions/workflows/test.yml/badge.svg)](https://github.com/yuanyuanzijin/handmux/actions/workflows/test.yml) [![license: AGPL-3.0](https://img.shields.io/badge/license-AGPL--3.0-blue)](LICENSE) [![node](https://img.shields.io/badge/node-%E2%89%A518-339933?logo=node.js&logoColor=white)](https://nodejs.org)

> **Drive your agent, ditch the desk.** *Keep your creativity in hand* — one command on your
> computer, scan a QR, and your live terminal (agent and all) goes wherever you do.

handmux puts the *same* live **tmux** session that's on your computer into your phone's browser —
**real panes, not a read-only mirror**. Spin up a brand-new session right from your phone, or pick up
one already running at your desk — then keep steering it from the couch, the train, a queue at the
coffee shop. The agent never stops; you just change screens.
**Nothing to install on the phone — open a link and you're in**, or add it to your home screen as a
PWA that runs full-screen, basically like a native app. It works with any shell or TUI, and
goes deepest with **Claude Code**: it pushes you the moment a pane needs a decision, and you approve
with your thumb.

<p align="center">
  <img src="assets/handmux-run.gif" alt="handmux: say what you need, Claude Code writes it, then tap the filename to preview the result" width="280">
  &nbsp;&nbsp;
  <img src="assets/handmux-doc.gif" alt="handmux: a push pings you when a pane needs you, and you review the git repo and each agent's usage" width="280">
  <br>
  <em>Real phone browser, real panes — say what you need and Claude Code writes it, then tap a filename to preview (left); a push pings you when needed, and you review the git repo &amp; each agent's usage (right).</em>
</p>

## Why handmux

- **🚀 One command to go live.** `handmux start`, scan the QR — done. No account, no App Store, no
  native app to sideload. Just a link your phone opens in any browser.
- **🧶 Your real session, in your pocket.** Not a fresh shell and not a screenshot — the *exact* tmux
  panes from your computer, agent still running. Desk → phone → desk, same session the whole way.
- **🤖 Made for vibe coding with agents.** Deepest with Claude Code: a push the instant it needs you,
  an inbox of which pane is *working / waiting on you / done*, and plan & permission approvals you tap
  through. Codex, aider, any shell/TUI work too.

## Get started in 2 minutes

You need two things **on the computer** (the phone needs only a browser). If you already live in tmux,
you're basically there:

```bash
node -v     # need Node ≥ 18    — get it at https://nodejs.org
tmux -V     # need tmux ≥ 3.0   — `brew install tmux`  /  `apt install tmux`
```

Then install and run:

```bash
npm i -g handmux     # install once
handmux start        # run it — local / same-wifi only, nothing exposed
```

`start` prints a **QR code** (plus the URL and a token). **Scan the QR with your phone** — it carries
the token, so you're signed in on the first load. That's it: you'll see your real tmux sessions, tap
one, and you're driving it.

Want to reach it from **anywhere**, not just your wifi? One flag spins up a free public HTTPS link:

```bash
handmux start --tunnel cloudflare   # instant public URL (auto-installs cloudflared)
handmux setup                       # or configure tunnel + name + notifications once, saved
```

```
  tunnel   cloudflare   ·   pid 21352
  🌐 open   https://elementary-incidents.trycloudflare.com/
  💻 local  http://localhost:19999/
  🔑 token  aicbHOGW…
```

The printed links are token-free — safe to screenshot or share. Only the **QR** carries the token, and
the `🔑 token` line is your password: paste it to sign in when you open a plain link instead of scanning.

### On Windows? Use WSL2

handmux drives **tmux**, which is Unix-only — there's no native Windows build. Run it inside **WSL2**
(a real Linux kernel with real tmux) and everything above works unchanged:

```powershell
wsl --install     # one-time, in PowerShell (admin): installs WSL2 + Ubuntu, then reboot
```

Then open the Ubuntu terminal and follow the steps above (`apt install tmux`, install Node,
`npm i -g handmux`). Two WSL-specific notes:

- **Use a tunnel.** WSL2 is a NAT'd VM with its own IP, so the same-wifi LAN URL won't reach your
  phone. Start with `handmux start --tunnel cloudflare` — the public link works regardless.
- **Autostart needs systemd.** `handmux service` uses systemd; enable it once by adding
  `[boot]` / `systemd=true` to `/etc/wsl.conf`, then `wsl --shutdown`. Without it, just run
  `handmux start` in a terminal you keep open.

## Features

Not just a remote shell — a full **mobile cockpit** for your terminal and your coding agents.

**Built around Claude Code**

- **Pinged when it needs you** — a push the moment a pane hits a permission prompt, a plan approval, or finishes, even with the tab closed.
- **Agent inbox** — every Claude pane tagged *working / waiting on you / done*; jump straight to the one that's blocked.
- **Approve with your thumb** — answer permission prompts and plan approvals from the phone; it drives the real keys, so a tap is a real keystroke.
- **Voice input** — dictate the next prompt hands-free (optional; bring your own iFlytek keys).

**A real cockpit, on your phone**

- **Git viewer** — VS Code-style: changes, commit history, any branch, full-screen colored diffs, multi-repo tabs. Read-only, never touches your working tree.
- **Live preview** — preview a static site from a folder, or a running service by port, with routing/API/HMR intact; phone or desktop viewport.
- **Docs** — tap a path in the terminal to open it; Markdown rendered, font zoom, read-aloud with sentence-by-sentence highlight.
- **Files both ways** — multi-select upload from the chat box (paths auto-filled), download with confirm, share into the app, copy absolute paths.
- **Ideas & commands** — a per-window to-do list (voice in, one-tap insert) plus a command palette with frequent/recent and slash shortcuts (`/compact`, `/model`, `/loop`…).
- **Image viewer** — pinch-zoom, save/share, inline GIFs.

**Solid on a phone**

- Real tmux panes — any TUI, shell or agent — not a read-only mirror.
- Reconnect with backoff, a connection-lost banner, an offline fallback page, polling paused when hidden.
- Reflow-safe cursor, drag-to-select copy, auto-repeat key bar, keyboard auto-lift.
- Nothing to install — runs in the phone browser; optional add-to-home-screen PWA. Bilingual (English / 中文).

## Once you're in

- You'll see your real tmux sessions — tap one to attach. Type in the terminal; use the on-screen
  key bar for arrows / Ctrl / Tab / Esc, and switch sessions, windows and panes from the top bar.
- **Add to Home Screen** (Safari/Chrome share menu) to run it full-screen like an app.
- The screen survives flaky networks — it keeps the last good frame, shows a "connection lost" banner
  after repeated failures, and pauses while the tab is hidden.

## Commands

```
handmux start [flags]                 start server (+ tunnel), in the background
handmux setup                         configure tunnel / name / notifications (writes config; re-run to change)
handmux stop                          stop everything
handmux restart
handmux status                        show state + current access URL
handmux logs [--follow] [--lines N]   tail the supervisor log
handmux config                        show the effective config + where each value came from
handmux hooks install|uninstall       enable/disable Claude Code notifications (inbox)
handmux service install [start-flags] start at login (launchd / systemd --user)
handmux service uninstall             remove the autostart entry
handmux --version                     print the version
```

**The whole config story is two doors:** `handmux start` just runs it (no config needed — defaults to
LAN-only, auto-generates a token, prints a QR), and `handmux setup` is the one place to configure
persistently. Re-run `setup` to change anything. That's it; everything below is detail.

### Claude Code notifications (inbox)

The agent inbox and "pinged when it needs you" push are driven by Claude Code lifecycle hooks. They're
**opt-in** — `handmux hooks install` copies a tiny notify script into `~/.claude/hooks/` and registers six
hook events in `~/.claude/settings.json` (idempotent; leaves your own hooks alone). `handmux setup` offers
this too, and you can turn it on from the phone the first time you open the inbox. `handmux hooks uninstall`
removes it. If you don't use Claude Code, this is skipped — nothing touches `~/.claude`.

### start flags

Flags override the config file for **one run** and never persist — handy for a quick try
(`handmux start --tunnel cloudflare`) without touching your saved setup. For anything permanent, use
`handmux setup`.

```
--tunnel none|cloudflare|cloudflare-named|ssh   how to expose it (default: none — local/LAN only)
--port N                   server port (default: 19999)
--host H                   bind host (default: 0.0.0.0)
--token S                  auth token (default: generated, printed on start)
--name "My Box"            app name in the browser tab + home-screen icon label
--preview-domain D         enable dynamic port previews (needs a wildcard subdomain)
--config PATH              use this config file instead of ~/.handmux/config.json (dev / multiple configs)
--foreground, -f           run in the foreground instead of daemonizing
--no-qr                    don't render the QR code

# ssh tunnel (--tunnel ssh):
--ssh-host user@host[:port]   the server to reverse-forward to (tunlite)
--remote-port N               port bound on that server (default: same as --port)
--ssh-jump user@host[,…]      optional bastion/jump host(s)
--public-url URL              the public URL to advertise (default: http://<host>:<remote-port>)
# cloudflare-named (--tunnel cloudflare-named):
--cf-hostname H               your Cloudflare hostname (e.g. handmux.example.com)
--cf-tunnel-name N            named-tunnel name (default: handmux)
```

### Configuration

There are **two layers**, and that's the whole model:

- **The config file** is your machine's persistent setup (tunnel, token, push/voice keys). There is one
  location — `~/.handmux/config.json` — written by `handmux setup`. Pass `--config PATH` to use a
  different file (e.g. keep `dev.json` / `prod.json` side by side and pick one). No merging or inheritance:
  at most one file is read.
- **Flags** override individual settings **for that one run only** and are never written back.

Precedence for a setting: **flag > config file > built-in default.** `start` prints which file it loaded
(`config: …`), and `handmux config` shows the value each setting resolves to **and where it came from**
(flag / file / env / default), so flag-vs-file is never a mystery.

You normally never hand-edit the file — `handmux setup` writes it (and re-running edits it). If you do
want to, it's plain JSON; optional integrations live in the **same file** (no separate `.env`):

```jsonc
{
  "tunnel": "none",              // none | cloudflare | cloudflare-named | ssh
  "port": 19999,
  "host": "0.0.0.0",
  "name": "My Box",              // browser-tab / home-screen label; omit → default
  "token": "…",                  // omit/empty → auto-generated on first start
  "previewDomain": "preview.example.com",
  "vapid": { "public": "…", "private": "…", "subject": "mailto:you@example.com" },  // push
  "xfyun": { "appId": "…", "apiKey": "…", "apiSecret": "…" }                        // voice
  // ssh tunnel adds: "sshHost", "remotePort", "sshJump", "publicUrl"
  // cloudflare-named adds: "cfHostname", "cfTunnelName"
}
```

The file is written `0600` because it holds a token and push/voice secrets.

## Networking: two paths

| mode | edge | TLS / hostname | best for |
|------|------|----------------|----------|
| **cloudflare** | Cloudflare's global edge (free quick tunnel) | automatic, random `*.trycloudflare.com` | quick start, zero config |
| **self-hosted (ssh)** | *your own VPS* | your domain + cert (Caddy auto-HTTPS recommended) | stable access, your own domain, regions where Cloudflare is unreliable |

> The `ssh` self-hosted tunnel (engine: [`tunlite run`](https://www.npmjs.com/package/tunlite), bundled) is
> available now — run `handmux setup` (or `--tunnel ssh --ssh-host user@host`). A `cloudflare-named` tunnel
> (stable HTTPS on your own Cloudflare domain) is available the same way.

### Self-hosted ssh tunnel: server-side reverse proxy

`tunlite` reverse-forwards your local port to your own server (bound to `127.0.0.1:<remote-port>` by
default — not exposed to the public internet until you put a reverse proxy in front of it).

**nginx (existing install):**

```nginx
server {
  server_name handmux.example.com;
  client_max_body_size 60m;            # prevents "file too large" on mobile uploads
  location / {
    proxy_pass http://127.0.0.1:19999; # = handmux --remote-port
    proxy_http_version 1.1;
    proxy_set_header Upgrade $http_upgrade;
    proxy_set_header Connection "upgrade";
    proxy_read_timeout 90s;            # tolerates long-polling
  }
}
# Run certbot for TLS; add an A record pointing your domain at this server.
```

**No nginx — Caddy (automatic Let's Encrypt, two lines):**

```caddy
handmux.example.com {
  reverse_proxy 127.0.0.1:19999
}
```

No TLS needed? Bind tunlite to `0.0.0.0` and set `GatewayPorts yes` in sshd, then access via
`http://<host>:<remote-port>` directly (unencrypted).

## Autostart

```bash
handmux service install --tunnel cloudflare   # comes back after reboot/login
```

macOS uses a launchd LaunchAgent; Linux uses a `systemd --user` unit (for autostart
before you log in: `loginctl enable-linger "$USER"`). While the service is installed,
`handmux stop` is temporary (the OS restarts it) — use `service uninstall` to stop for good.

## Security

The access URL is public when you use a tunnel, so a **token is always required** (one is
generated if you don't pass `--token`). The printed plain link is token-free and safe to share;
treat the token (and the token-bearing QR) like a password.

Found a security issue? Please report it privately — see [SECURITY.md](SECURITY.md), not a public issue.

## Voice input (optional)

Tapping the mic dictates into the input box. It's powered by [iFlytek](https://www.xfyun.cn/) and is
**off until you add your own keys** — open a "语音听写 (IAT)" app at the iFlytek console, then add an
`"xfyun": { "appId": "…", "apiKey": "…", "apiSecret": "…" }` block to your config file (see *Configuration*).
The secret stays on the server; the phone only ever gets a short-lived signed URL. With no keys configured
the mic button simply doesn't show.

## Push notifications (optional)

The "pinged when a pane needs you / finishes" push is **off until you add a VAPID key pair** (the standard
Web Push credential). Generate one with the bundled `web-push`:

```bash
npx web-push generate-vapid-keys
```

Add a `"vapid": { "public": "…", "private": "…", "subject": "mailto:you@example.com" }` block to your
config file (see *Configuration*). With both keys set, `/api/push/vapid` serves the public key and the
phone can subscribe; with none, the endpoint returns 503 and the bell stays hidden. Push also requires the
Claude Code hooks (so a pane has a state to push) — see *Claude Code notifications* above.

## Dynamic port previews (advanced)

Set `--preview-domain` (or `"previewDomain"` in the config) to expose other local dev
servers (e.g. a Vite app on `:3000`) to your phone, each on its own subdomain. This needs a
**wildcard subdomain** (`*.your.domain`) pointed at the gateway, so it only works on the
self-hosted path, not a quick tunnel. `handmux setup` does not wire this for you — set it up
yourself and point `previewDomain` at it.

**TLS depth (Cloudflare):** a browser reaches the preview over HTTPS, so the wildcard needs a
cert. Cloudflare's free Universal SSL covers **one level** — `*.example.com` works (previews at
`<port>.example.com`), but a deeper `*.preview.example.com` needs **Advanced Certificate
Manager**. So either keep previews one level deep, or enable ACM. (On the ssh/own-edge path you
provide the wildcard cert yourself — e.g. a Let's Encrypt `*.preview.your.domain`.)

## License

AGPL-3.0
