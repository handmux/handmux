<p align="center"><img src="assets/readme-banner.png" alt="handmux" width="420"></p>

<p align="center">🌐 <b>English</b> &nbsp;·&nbsp; 🇨🇳 <a href="README.zh-CN.md"><b>中文</b></a></p>

<p align="center"><a href="https://handmux.com"><b>handmux.com</b></a></p>

<p align="center">
  <a href="https://www.npmjs.com/package/handmux"><img src="https://img.shields.io/npm/v/handmux?color=cb3837&logo=npm" alt="npm"></a>
  <a href="https://github.com/handmux/handmux/actions/workflows/test.yml"><img src="https://github.com/handmux/handmux/actions/workflows/test.yml/badge.svg" alt="CI"></a>
  <a href="LICENSE"><img src="https://img.shields.io/badge/license-AGPL--3.0-blue" alt="license: AGPL-3.0"></a>
  <a href="https://nodejs.org"><img src="https://img.shields.io/badge/node-%E2%89%A518-339933?logo=node.js&logoColor=white" alt="node"></a>
</p>

> **One phone, a whole mobile vibe-coding cockpit.** Built on tmux — one command on your computer, scan a QR, and your live session, Claude Code, Codex, git, previews and docs are all in your hand, creativity ready wherever you are.

handmux is more than a terminal on your phone. It puts the *same* live **tmux** session running on your computer into your phone's browser (real panes, not a read-only mirror), then builds a whole **mobile vibe-coding cockpit** around it: **Claude Code / Codex** push you the moment a pane needs a decision — approve with your thumb, or fire off a new instruction by voice; browse a full-screen colored **git** diff; **preview** a running site in one tap; hear a **doc** read aloud line by line; move files both ways. Nothing to install on the phone — open a link and you're in; "Add to Home Screen" and it runs full-screen as a **PWA**, basically a native app. Curl up on the couch or squeeze onto the train — the vibe coding never stops, your creativity stays in hand.

<p align="center">
  <img src="assets/handmux-run.gif" alt="handmux: say what you need, Claude Code writes it, then tap the filename to preview the result" width="280">
  &nbsp;&nbsp;
  <img src="assets/handmux-doc.gif" alt="handmux: a push pings you when a pane needs you, and you review the git repo and each agent's usage" width="280">
  <br>
  <em>Real phone browser, real panes — say what you need and Claude Code writes it, then tap a filename to preview (left); a push pings you when needed, and you review the git repo &amp; each agent's usage (right).</em>
</p>

**[📖 Docs](https://handmux.com/docs)** · **[📝 Changelog](CHANGELOG.md)** · **[📦 npm](https://www.npmjs.com/package/handmux)**

## Quick start · about a minute

Your computer needs tmux and Node ≥ 18; the phone just needs a browser. Pick one:

**Homebrew — macOS (recommended)** · installs Node + tmux for you:

```bash
brew install handmux/tap/handmux
```

**npm — any platform** · if you already have Node:

```bash
npm i -g handmux
```

Then run it:

```bash
handmux start        # local / same-wifi, nothing exposed
```

`start` prints a **QR code** (plus a URL and token). **Scan it with your phone** — the token rides in the code, so you're signed in on first open. You'll see your real tmux session; tap one and start driving.

Want to reach it from **anywhere**? Add one flag for a free public HTTPS link:

```bash
handmux start --tunnel cloudflare   # instant public URL (cloudflared auto-installed)
```

> Tunnel types, self-hosting, Windows/WSL2, and the full command & flag reference → see the **[docs](https://handmux.com/docs)**.

## Why handmux

- **🧰 More than a terminal — a whole mobile vibe-coding cockpit in your pocket.** Full-screen colored git diffs, one-tap preview of a running site, docs read aloud line by line, files moved both ways — a whole dev kit in hand, no hopping between apps.
- **🚀 One minute from zero to coding on your phone.** One `handmux start`, one scan, done — no sign-up, no App Store, no app to sideload; just a link. "Add to Home Screen" and it's a full-screen **PWA**, as smooth as a native app.
- **🧶 Walk away, keep working.** Your phone drives the *one* live tmux pane on your desk (not a new shell, not a screenshot). Close the laptop and keep watching from your thumb — exact same state.
- **🔔 When it needs you, your phone rings.** Claude Code / Codex push the moment they need a decision; add it to your home screen and they come through as system notifications. An inbox tags each pane working / needs-you / done — many projects at a glance — and you approve permissions and plans with a tap, so you stop babysitting the screen.
- **🔒 Your code goes through no middleman.** Free and fully open-source; we run no server in the middle — your data travels straight between your computer and your phone, so it stays secure.

## Features

- **Claude Code / Codex, deeply** — an inbox status ledger, thumb-approve permissions & plans, per-agent usage bars.
- **Chat view (experimental)** — read and drive a Claude session as a chat instead of a terminal: bubbles with Markdown, tool cards with colored diffs, question cards you answer with a tap, warm colour tones. Experimental — may be unstable: enable it in Settings → 启用对话视图 / Enable chat view, then switch views from the window bar.
- **Command & chat modes** — one bottom bar, two modes: type straight into the terminal, or talk to the agent in natural language. Both default quick bars include `Ctrl+C`. `handmux shortcuts` configures shared key/text items; each phone's ⚙ editor shows the effective quick-bar order, interleaves shared and local items, and can remove a shared item from that device only with immediate undo. Server changes apply live and phones reload them on foreground—no restart or polling required.
- **Script push** — notify your phone from any script or CI step with `handmux push`; target all devices, a named session, or a specific device.
- **Workspace recovery** — handmux silently keeps the metadata needed to rebuild your latest tmux workspace. After a computer or tmux-server restart, restore it beside any new sessions from the phone or with `handmux restore`; existing sessions are never replaced.
- **Git viewer** — changes / commit history / any branch / full-screen colored diff, multi-repo tabs, read-only, never touches your tree.
- **Site preview** — a static folder, or a running HTTP/HTTPS service by port (routing / APIs / live-reload intact), in a phone or desktop viewport. Set its bare preview domain once in `handmux setup`.
- **Docs** — tap a path in the terminal to open it; Markdown rendered, font zoom, sentence-by-sentence read-aloud.
- **Select & copy text** — long-press to select in the terminal, drag iOS-style handles to fine-tune, copy the selection / a whole line / a whole paragraph.
- **Files both ways** — multi-select upload from the chat box, download, share in, copy any absolute path.
- **Ideas — catch every one** — a thought the moment it strikes: a per-window idea/to-do list, jot one by voice and drop it straight into the prompt.
- **Built for flaky networks** — backoff reconnect, connection-lost banner, offline page, polling that pauses in the background; a reflow-safe cursor.
- **Zero-install PWA** — runs in the browser; add to home screen for full-screen. Multilingual — English, 简体 / 繁體中文, 日本語, 한국어.

## Workspace recovery

handmux continuously maintains two redundant copies of the latest workspace metadata. They are not browsing history: ordinary changes and deletions handmux can confirm simply update the current state. A selectable checkpoint is archived only when the computer or tmux environment changes. If the final tmux session disappears outside handmux, tmux cannot distinguish an intentional deletion from a crash, so handmux retains the last state and can offer recovery immediately, without waiting for a new tmux server or session. Every checkpoint from the latest 24 hours is kept; older history is then trimmed to the newest 10, while the latest valid checkpoint never expires just because of age.

After such a restart, the phone shows **Restore last workspace** for one hour when a checkpoint has work left to restore; if tmux has no sessions it opens the confirmation directly. Choosing **Ignore this backup** suppresses that checkpoint only on that phone; an ordinary close does not. When recovery finishes, the phone reports the actual sessions, windows, and panes restored, but does not automatically open or bind them; choose **Bind restored sessions** if you want them on that phone. The CLI remains available after the phone prompt expires:

```bash
handmux restore --dry-run                         # preview the latest plan
handmux restore                                  # restore; TTY picker, otherwise latest
handmux restore --list                           # list retained checkpoints
handmux restore --checkpoint <id> --session api  # select history / restore one session
```

Restore is additive and idempotent. It never stops, renames, replaces, or changes the topology of a current session; a name collision becomes `name-restored`, then `name-restored-2`. Windows, panes, working directories and layouts are rebuilt where safe. Only verified Claude Code/Codex sessions are resumed from their persisted session IDs; ordinary panes reopen as shells in their saved directories, without replaying commands or scrollback. Metadata lives under `~/.handmux/workspaces/`; it can include paths, tmux names/layout and agent session IDs, but not pane output.

## Script push

Send a push notification to your phone from any script, CI step, or build hook:

```bash
handmux push "Build done" "Took 3m12s"
```

Runs **on your computer** against the already-running `handmux` server (loopback + local server token — no config, no remote endpoint). Web Push must be enabled first (`handmux setup`).

**Syntax**

```
handmux push <title> <body> [options]
```

| Flag | Description |
|---|---|
| `--session <name>` | Target all devices subscribed to this tmux session (repeatable; comma-separated values OK) |
| `--device <key>` | Target a specific device by its key (repeatable; comma-separated values OK) |
| `--tag <T>` | Notification tag (collapses duplicates) |
| `--url <U>` | HTTP(S) URL or same-origin relative path to open when the notification is tapped |

**Scopes — pick at most one:**

- _(default)_ — all subscribed devices
- `--session` — only devices subscribed to the named session(s)
- `--device` — only the specified device(s) by key

`--session` and `--device` are mutually exclusive.

The **device key** is shown in the phone app under Settings → Script push. It is an addressing identifier, not a secret — the security boundary is the local server token.

> **Reliability:** Web Push is best-effort. For delivery-critical alerts use a dedicated messaging app (WeChat, Slack, etc.).

## Networking: one decision

No tunnel by default — the phone connects **straight to your own computer**, nothing exposed and no middleman. To reach it from outside, just ask: **does your machine already have a public address?**

- **Yes** (cloud box / public IP / forwarded port) — no tunnel needed, connect directly; fastest and most private.
- **No** — open a tunnel. Each runs on **your own free third-party account** — handmux just wires it up and operates no relay of its own: `cloudflare` (zero-config, up in seconds, but its public edge can be slow or unreliable in some regions) · `cloudflare-named` (your own domain, steadier) · `natapp` / `cpolar` (domestic providers that stay reachable inside mainland China) · `ssh` self-hosted (through your own server).

> Tunnel config, server-side reverse proxy, autostart, voice/push credentials, and port previews → see the **[docs](https://handmux.com/docs)**.

Once autostart is installed, `handmux start` / `stop` / `restart` coordinate with that same launchd/systemd service (including after an upgrade). A lifecycle lock prevents concurrent launches; `status` shows the running version and warns with PIDs if stale/duplicate supervisors exist, while `stop` reaps every copy.

## Requirements

Your computer needs **Node ≥ 18** and **tmux ≥ 3.0**; the phone just needs a browser. On **Windows**, run it inside **WSL2** (a real Linux kernel + real tmux) — see the [docs](https://handmux.com/docs#windows).

## Feedback & community

Hit a bug, or wish handmux did something? [**Open an issue**](https://github.com/handmux/handmux/issues) — that's the channel that actually gets tracked (Chinese or English both welcome). Users in China can also join the [**WeChat user group**](https://handmux.com/#community).

## More

**[📖 Docs](https://handmux.com/docs)** · **[📝 Changelog](CHANGELOG.md)** · **[🔒 Security](SECURITY.md)** · License **AGPL-3.0**

Found a security issue? Please report it privately (see [SECURITY.md](SECURITY.md)), not via a public issue.
