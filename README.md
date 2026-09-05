<p align="center"><img src="assets/readme-banner.png" alt="handmux" width="420"></p>

<p align="center">🌐 <b>English</b> &nbsp;·&nbsp; 🇨🇳 <a href="README.zh-CN.md"><b>中文</b></a></p>

<p align="center"><a href="https://handmux.com"><b>handmux.com</b></a></p>

<p align="center">
  <a href="https://www.npmjs.com/package/handmux"><img src="https://img.shields.io/npm/v/handmux?color=cb3837&logo=npm" alt="npm"></a>
  <a href="https://github.com/handmux/handmux/actions/workflows/test.yml"><img src="https://github.com/handmux/handmux/actions/workflows/test.yml/badge.svg" alt="CI"></a>
  <a href="LICENSE"><img src="https://img.shields.io/badge/license-AGPL--3.0-blue" alt="license: AGPL-3.0"></a>
  <a href="https://nodejs.org"><img src="https://img.shields.io/badge/node-%E2%89%A522.16-339933?logo=node.js&logoColor=white" alt="node"></a>
</p>

> **One phone, a whole mobile vibe-coding cockpit.** Built on tmux — one command on your computer, scan a QR, and your live session, Claude Code, Codex, git, previews and docs are all in your hand, creativity ready wherever you are.

handmux puts the *same live tmux workspace* from your computer in any phone or desktop browser. Keep coding with Claude Code, Codex, Pi, or any terminal tool; review changes, answer prompts, preview apps, and move files without starting a separate remote session. It is self-hosted, open-source, and needs no phone app or handmux account.

<p align="center">
  <img src="assets/handmux-run.gif" alt="handmux: say what you need, Claude Code writes it, then tap the filename to preview the result" width="280">
  &nbsp;&nbsp;
  <img src="assets/handmux-doc.gif" alt="handmux: a push pings you when a pane needs you, and you review the git repo and each agent's usage" width="280">
  <br>
  <em>Real phone browser, real panes — say what you need and Claude Code writes it, then tap a filename to preview (left); a push pings you when needed, and you review the git repo &amp; each agent's usage (right).</em>
</p>

**[📖 Docs](https://handmux.com/docs)** · **[🧭 Roadmap](ROADMAP.md)** · **[📝 Changelog](CHANGELOG.md)** · **[📦 npm](https://www.npmjs.com/package/handmux)**

## Quick start · about a minute

Your computer needs tmux and Node ≥ 22.16; the phone just needs a browser. Pick one:

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

- **🧶 One workspace, everywhere.** Your phone drives the real tmux panes already running on your computer—not a screenshot or a separate cloud session.
- **🔔 Stop babysitting agents.** See which panes are working or waiting, get notified when you are needed, and approve from your phone.
- **🧰 A complete coding cockpit.** Terminal, Agent conversations, Git, previews, docs, files, usage, and idea capture stay together.
- **🔒 Self-hosted by design.** Your browser connects to your computer; handmux runs no account service or relay in between.

## Features

- **Live terminal** — use the same tmux pane from phone and desktop, with history, physical-keyboard input, and native copy/paste.
- **Agent conversations** — work with Codex in a streaming chat view; optional Claude Code and Pi integrations bring the same workspace into their supported conversation flows.
- **Inbox and approvals** — follow multiple panes, receive push notifications, and answer permission or plan prompts remotely.
- **Git and previews** — review repositories and open running sites, intranet pages, or static folders from the browser.
- **Docs and files** — open readable files, listen to documents, and upload, download, or share files in either direction.
- **Ideas and voice** — keep notes per window and dictate text through supported iFlytek or Tencent recognition modes.
- **Usage at a glance** — view supported Agent subscription limits and configured API-provider balances without exposing full keys to the browser.
- **Resilient sessions** — reconnect across weak networks and restore saved tmux workspace structure after a restart.
- **Script push** — send a notification to your phone from local scripts or CI with `handmux push`.
- **Zero-install PWA** — add it to your home screen for a full-screen experience in English, Chinese, Japanese, or Korean.

## Agent integration

Codex integration is built in. Pi and Claude Code integration are optional:

```bash
handmux codex [args...]
handmux pi [args...]
handmux agent enable pi
handmux agent enable claude
```

See the **[Agent integration guide](https://handmux.com/docs#cmd-agent)** for status, disable, compatibility, and reload behavior.

## Connectivity

The default is a direct connection to your own computer. For access away from home or work, use a public address or a tunnel on your own Cloudflare, natapp, cpolar, or SSH setup. See the **[connectivity guide](https://handmux.com/docs#tunnels)**.

## Requirements

Your computer needs **Node ≥ 22.16** and **tmux ≥ 3.0**; the phone just needs a browser. On **Windows**, run it inside **WSL2** (a real Linux kernel + real tmux) — see the [docs](https://handmux.com/docs#windows).

## Feedback & community

Hit a bug, or wish handmux did something? [**Open an issue**](https://github.com/handmux/handmux/issues) — that's the channel that actually gets tracked (Chinese or English both welcome). Users in China can also join the [**WeChat user group**](https://handmux.com/#community).

## More

**[📖 Docs](https://handmux.com/docs)** · **[🧭 Roadmap](ROADMAP.md)** · **[📝 Changelog](CHANGELOG.md)** · **[🔒 Security](SECURITY.md)** · License **AGPL-3.0**

Found a security issue? Please report it privately (see [SECURITY.md](SECURITY.md)), not via a public issue.
