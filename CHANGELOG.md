# Changelog

All notable changes to handmux. Format follows [Keep a Changelog](https://keepachangelog.com).

## [Unreleased]

### Added
- **Command mode: saved commands split into GLOBAL + THIS-WINDOW lists.** The command page's quick-bar
  now shows your global commands (grey, first) followed by the current tmux window's own commands (green),
  keyed by the stable window id. The trailing ＋ became a ⚙ that opens a taller editor with two sections,
  each reorderable with ▲▼. Adding lives in its own centred iOS-style card, opened by a ＋ in the editor
  header, so the panel itself is just a clean list; the card stacks its controls vertically (命令/按键 tab ·
  a 全局/窗口 segmented switch for which list · the field · an iOS toggle for 带回车) and rides above the
  soft keyboard instead of being pushed off-screen. **Tap any saved row to re-open the card pre-filled and
  edit it in place** (a key fav's chord is decoded back into its 粘滞键 + base key).
  - **命令**: type it; a 「带回车」toggle stores whether a tap types-and-runs it (shown with a trailing ⏎)
    or just types it into the shell.
  - **按键**: build a key combo (e.g. Ctrl+C) from a 粘滞键 dropdown (None / Ctrl / Shift / Alt / Ctrl+Shift
    / Ctrl+Alt, default None) + a base key (a letter, or a named key like `Up`/`Tab`); saved as a chip (⌃C)
    that fires the real terminal key on tap.
  The old flat command list carries over unchanged as the global one.
- **Chat mode: the quick-bar is now user-customizable, same as command mode.** A ⚙ at the end of the chat
  quick-bar opens the same centred iOS card editor (chat variant): a single global list, a 消息/按键 tab, and
  tap-a-row-to-edit + ▲▼ reorder. 消息 saves a line sent to the agent (a leading `/` marks it a slash-command,
  kind `cmd`, otherwise a `reply`); 按键 reuses the 粘滞键 + base-key pickers to bind a real terminal key
  (ESC, Tab, Ctrl+C, …). The seeded ESC/Tab/⌫ defaults are now proper key favs so they render and edit like
  any other. Chat has no per-window list and no 带回车 toggle (a chat tap always sends).

### Changed
- **Segmented controls unified to one iOS style.** The settings preview-type switch (`.preview-seg`) and the
  file home-tab switch (`.file-seg`, 最近/新增) now use the same faint-track + raised-pill look as the saved-
  command editor's `.cmd-seg`, instead of three different bordered/boxed treatments. CSS-only, markup
  unchanged. Also bumped legacy 6px radii to 8px and softened bottom-sheet corners to 16px.
- **App-wide colour unification to iOS system accents.** Consolidated the scattered accent palette (7 blues,
  6 greens, 6 error reds) down to one system blue (`#0a84ff`), one green (`#34c759`) and one red (`#ff453a`),
  exposed as `:root` tokens (`--blue`/`--green`/`--red` + `-rgb` variants) and referenced throughout
  `styles.css`. Semantic colour sets (git badges, inbox states, chat-chip categories, usage gauge) are left
  intact. Pure restyle — no behaviour change.
- **Upload picker now filters to allowed types and rejects an unsupported pick up front.** Both upload
  entries (chat composer ＋附件 and the file-browser upload button) carry an `accept` hint (images +
  text/code + documents) so the native picker guides you toward valid files, and pre-check the picked
  files client-side: a disallowed pick (an executable, `.zip`, a video, an extensionless binary) is
  dropped with an instant 「不支持的文件类型」note instead of failing halfway with a server 415. Mirrors
  the server's extension allow-list (`server/src/uploadTypes.js`), which remains the real enforcement.

### Fixed
- **Saved key combos with a modifier + a named key (Ctrl+Arrow, Ctrl+Tab, …) were silently dropped** — the
  `/keys` allowlist only accepted a modifier on a single letter/digit (`C-r`) or a bare named key (`Up`,
  `Tab`), so `C-Up`/`M-Up`/`C-Tab`/`C-S-Up` failed server-side validation and nothing reached tmux. The
  allowlist now permits any Ctrl/Alt/Shift prefix combo (canonical `C- M- S-` order) on a named key, so the
  按键 editor can bind Ctrl+Arrow, Alt+Arrow, Ctrl+Tab, Ctrl+Space, Alt+Enter, etc. (Plain arrows/Tab
  already worked — type the name, e.g. `Up` / `Tab`, as the base key.)
- **Swiping between key/chat mode leaked the other page** — the neighbouring page (e.g. chat's green
  chips) showed through at rest and the height mismatch read as a gap mid-swipe. The dock track is a
  composited layer (`will-change` + `translate3d`), and iOS Safari lets a composited child escape a plain
  `overflow: hidden` clip; adding `contain: paint` to `.dock-pager` forces it to clip the track.
- **History (send log) kept vanishing moments after a send** — the window-level history was keyed by the
  tmux window NAME, which tmux auto-renames to the running command; the moment the name changed the read
  key drifted and `getRecent` returned nothing, so the list "cleared itself." Now keyed by the stable
  window ID (`@N`) for both read and write.
- **Dock could get stuck resting between the two pages** — the swipe track's transform used to be
  imperative even at REST, and rest was only re-asserted on a React render (rare in command mode), so an
  interrupted gesture (browser-hijacked touch, missed `touchend`, or a press-and-hold on the ◀ arrow whose
  finger jittered) could leave it parked off a page boundary — half keyboard, half composer — with no way
  to recover. Root fix: the resting position is now owned by React/CSS (a `.at-chat` class → a CSS
  transform + transition); the finger drag only overrides with an inline transform that's cleared on
  release, so at rest the track is ALWAYS exactly on a page and can't get stuck. Also: a swipe only locks
  when the drag is clearly horizontal and past a 16px gate, so a key press no longer starts a page drag.
- **Agent logos (Claude/Codex) invisible in iOS home-screen PWA** — `AgentMark` was the only icon
  rendered as `<img src="data:image/svg+xml,…">`; iOS standalone WKWebView doesn't reliably render
  percent-encoded svg+xml data-URIs in `<img>`, so those two logos vanished while every other (inline
  `<svg>`) icon showed. Now inlined as a real DOM `<svg>` (`?raw` import), which every engine renders;
  still rides the content-hashed JS so a changed logo busts the cache.

### Changed
- **Chat composer: quick-command bar above the pill** — moved the ＋ upload and ▤ 常用 out of the input
  pill into a dedicated row above it. The row's left holds two fixed, text-only actions (`添加附件` ·
  `历史记录`, styled distinctly from the commands); its right is a horizontally-scrollable strip of
  user-editable vibe commands (`ESC 继续 ok 1 2 3 /compact …`). Tapping a command sends it immediately —
  `ESC` fires the Escape key (interrupt), the rest type + Enter. Add/remove commands via 历史记录 (they
  persist per-mode and feed the strip). The strip scrolls without hijacking the page swipe.
- **Command keyboard: two key rows + a quick-bar (mirrors the chat layout)** — the command keyboard is
  now a fixed **2×7 grid** (row 1 `Esc Tab ~ / ▲ @ ⌫`, row 2 `Ctrl Shift Alt ◀ ▼ ▶ Enter` — Esc/Tab
  top-left, ⌫ top-right, Enter bottom-right, the inverted-T arrows just left of it) above a **quick-bar**
  like chat's: its left is a fixed text button that **展开/收起键盘** (toggles the system keyboard, label
  follows state), its right a horizontally-scrollable strip of your **own saved commands** — a list kept
  **separate from** the chat one; tap = type + Enter into the shell (`ESC` fires the key), the trailing ＋
  adds/removes entries. All the buried shell symbols (`| \ _ > < & ; *`) are gone; only `~ / @` stay.
  Ctrl/Shift/Alt are still sticky modifiers — tap arms for the next key (composing `C-<x>` / `BTab` /
  `M-<x>` / `S-<arrow>`), double-tap locks. `/keys` accepts `C-`/`M-<letter|digit>` and `S-<arrow>`.
- **Multi-pane window tab is more compact** — the expanded `name │ ① cmd ▾` tab now caps the name and
  command widths (ellipsis) and tightens padding, so a long command no longer blows the tab wide. The
  full command still shows in the pane menu.
- **Multi-pane window tab is more compact** — the expanded `name │ ① cmd ▾` tab now caps the name and
  command widths (ellipsis) and tightens padding, so a long command no longer blows the tab wide. The
  full command still shows in the pane menu.

### Added
- **Command mode (type straight into the terminal)** — the dock now has two input modes. **Command**:
  every keystroke streams straight into the pane like a real shell (the capture field stays empty, the
  terminal is the display); the system keyboard's ⌫/↵ delete/run in the shell, an IME commits whole
  words, and an armed Ctrl composes the next typed letter into `C-<x>`. **Agent (chat)**: the existing
  multi-line composer for prose prompts (voice, upload, 常用). The mode defaults from whether a coding
  agent is live in the pane (`states.agent`) and sticks per-pane; switch it with the `命令 | 对话`
  segmented control or by tapping the terminal body (which drops into command mode and pops the keyboard).
  (Optimistic at-cursor echo is a later stage — for now a typed char appears after one round-trip.)
- **「常用」drawer (mode-aware, customizable)** — the 常用 button opens a bottom drawer whose contents
  follow the mode: **agent** shows one-tap reply chips (ok / 继续 / yes / no) and Claude slash-commands
  (`/compact` `/clear` `/model`); **command** shows your saved commands. Tap sends immediately; you can
  add and delete your own entries, kept in two separate per-mode lists.
- **Usage bars: time-progress marker** — each quota bar now draws a thin vertical line at the fraction
  of its reset window that has elapsed. Usage fill left of the line = burning slower than the clock;
  past it = faster. Derived from `resetsAt` + the window length (Claude 5h/weekly; Codex `windowMinutes`).

## [0.7.0] - 2026-07-03

### Added
- **Usage page (per-agent quota/limits)** — a new top-bar page shows Claude's 5-hour and weekly
  rate-limit bars (with reset countdowns) and Codex's quota windows, read entirely from local
  files on the host — no account login, no API calls. `GET /api/usage`. Codex is zero-config (its
  rollout's `token_count` events carry `rate_limits` + cumulative tokens). Claude's 5h/weekly %
  live only in Claude Code's statusLine stdin (the one documented local source — see
  code.claude.com/docs/en/statusline), so a new `handmux-statusline.cjs` capturer snapshots them
  to `~/.handmux/claude-usage.json`. Installing it is opt-in via `handmux setup` / `hooks install`
  and **non-destructive**: it only auto-installs when no statusLine exists; an existing custom
  statusLine is never clobbered (the CLI prints a one-line TEE compose snippet instead). Uninstall
  reverts only our own.

### Removed
- **The per-window tmux status dot is gone.** The Claude hook used to also write a colour into each
  tmux window's `@claude_dot` option, and `handmux setup`/`hooks install` offered to patch
  `~/.tmux.conf` to render it. It's removed end-to-end (writer, `~/.tmux.conf` patcher, seed/seen
  scripts, CLI offer, docs): it was Claude-only (no Codex), keyed per-window while agents run
  per-pane (so it mis-rendered with split panes), went stale on hard-kills, and overwrote your PC's
  tmux status bar — all to duplicate, worse, what the phone inbox already shows accurately.

### Changed
- **`handmux setup` defaults a new user to the zero-config tunnel** — the tunnel prompt now defaults
  to `cloudflare` (quick tunnel, instant public URL) for a first-time user with no config, instead of
  `cloudflare-named` (which a bare-Enter newcomer can't finish without a Cloudflare login + their own
  domain). Re-running `setup` still defaults to your current tunnel.

## [0.6.0] - 2026-07-03

### Added
- **Codex CLI support (second agent)** — handmux is no longer Claude-only. A new agent-driver
  registry (`server/src/agents/`) lets the inbox, push, and orphan/takeover engine drive any
  coding agent through a descriptor; Claude Code and OpenAI's Codex CLI are the first two.
  `handmux hooks install` now wires both. Codex 0.142+ ships a Claude-parity hook system (same
  events, same stdin payload fields), so handmux registers Codex's lifecycle hooks in
  `~/.codex/config.toml` (a marked region, appended alongside any hooks you already have) and
  reuses the exact Claude hook scripts + classifier — giving the phone full working / 需要你 /
  done states for Codex, not just turn-done. Orphan Codex sessions running outside tmux can be
  taken over with `codex resume`. New `codex` startup-command preset; the inbox/enable copy now
  says "AI session" rather than "Claude". Validated end-to-end against Codex 0.142.5: the
  `UserPromptSubmit`→working and `Stop`→done hooks fire, `$TMUX_PANE` is inherited (state keyed
  to the right pane), payloads are Claude-shaped, and `codex resume`/rollout-cwd resolution parse
  as expected. A codex pane reports `pane_current_command` as its Node launcher (`node`), so
  inbox liveness matches that too (else codex panes were pruned). Every inbox row and the
  current-session topbar now show a per-agent mark (Claude / Codex) so the two are
  distinguishable at a glance. Approving a Codex permission flips the pane straight back to
  进行中 (a PostToolUse un-stick that no-ops mid-turn, so it doesn't fire on every command).
- **CLI now speaks Chinese** — the `handmux` command-line output (help, `start`/`status`/
  `setup` prompts, errors, the access block) is fully localized. Language resolves from
  `--lang en|zh`, a `"lang"` field in the config, or the shell locale (`LANG`/`LC_*` = `zh…`),
  defaulting to English. `handmux setup` now asks for the language first, and `handmux config`
  shows the resolved `lang`.
- **Take over Claude sessions running outside tmux** — the inbox now detects `claude`
  processes that aren't in a tmux pane (so handmux can't steer them) and lists them in a
  collapsible footer with each session's working dir, idle/busy state, and last message. One
  tap opens a takeover sheet: resume the session in a fresh tmux session (or a new window of
  an existing one) via `claude --resume`, optionally ending the original process (default on —
  a resumed session shares the same history file, so a single writer avoids corruption). New
  `GET /api/orphans` + `POST /api/orphans/takeover`. Detection is a process scan (ps + tmux +
  lsof), skipping Ctrl-Z-suspended and background sessions.
- **Upgrade notice + `handmux update`** — `handmux start`/`status` now show a one-line
  "⬆ handmux X.Y.Z available" hint when a newer version is published, and `handmux update`
  (alias `upgrade`) runs the global install for you. The check never blocks or touches the
  network on the hot path: it prints from a once-a-day cache and refreshes in a detached
  background worker, and the version query goes through the user's own `npm` (so it honours a
  configured China mirror / private registry rather than hard-coding registry.npmjs.org).
- **Windows / WSL2 install docs** — README (en + zh) and the landing-page docs now have a
  Windows section: handmux is Unix-only (tmux), so run it inside WSL2, with the two WSL-specific
  gotchas called out — use `--tunnel cloudflare` (WSL2's NAT'd IP breaks the LAN URL) and enable
  systemd in `/etc/wsl.conf` for `handmux service` autostart.

### Changed
- **cloudflared auto-download shows progress** — the first-run `cloudflared` fetch used to buffer
  the whole binary silently, so on a slow link it looked hung. It now streams with a live
  `cloudflared  45%  (9.2/20.4 MB)` line (TTY only; piped output is left clean).
- **Bind-session is now a picker, not a text field** — the bind dialog lists the sessions that
  exist on the host (already-bound ones hidden) as tappable chips; pick one and confirm to bind
  it. A `＋ new session` chip flips the card into the create form (name + start dir + startup
  command). No more typing a name to guess whether it exists, and the misleading "short name"
  placeholder is gone.
- **`handmux start` on an already-running instance is clearer** — instead of a terse "already
  running — use restart", it now reassures when this run's config matches what's live, and when
  it differs (e.g. you changed `--tunnel`) it spells out the difference and offers to restart
  into it (interactive only; non-TTY just prints the `handmux restart` hint). `start` still never
  disrupts a running instance without an explicit yes.

## [0.5.3] - 2026-06-29

### Fixed
- **Git panel: bound repos reset to the default on every reopen** — repos added to a
  window were silently dropped, so reopening the panel fell back to the auto-discovered
  directory. Root cause: a legacy flat-array value under the per-window storage key made
  `readMap` return an array; subsequent writes set an array property that `JSON.stringify`
  drops, so every save vanished. `readMap` now coerces non-object values to `{}`, so
  per-window writes persist. Repos added to a window now survive close/reopen.

### Changed
- **Settings → Language label** — non-English locales now append "Language" to the setting
  label so the option is recognisable regardless of the current UI language.

## [0.5.1] - 2026-06-28

### Added
- **i18n: Traditional Chinese, Japanese, Korean** — three new UI locales; switch in
  Settings → Language. zh-TW browser-language detection also fixed.
- **Idea count badge** — the lightbulb topbar icon shows a count badge when there are
  pending ideas for the current window; count is also shown in the Ideas panel header.
- **Column-width fine control** — Settings now shows the live column count between the
  resize buttons, and adds ±1 buttons alongside the existing ±10 for precise adjustment.
- **SVG icons in command panel** — replaced Unicode glyphs (▤ / ★ / ☆ / ✕) with
  Lucide-style stroke SVGs consistent with the rest of the app's icon set.

### Fixed
- **tmux copy-mode blocks mobile input** — if the PC terminal was in copy/scroll mode,
  text and keys sent from the phone were silently swallowed. The server now exits
  copy-mode (`Escape`) before forwarding any input.
- **"Back to bottom" button** — appeared even when content didn't fill the screen; also
  clicking it during a momentum fling stopped the scroll without reaching the bottom.
  Both are now correct.
- **Boot flash of unstyled content** — on slow connections the boot splash could fade
  before the stylesheet arrived, briefly showing a white unstyled page. The splash now
  waits for the CSS `load` event before hiding.
- **Bind session errors when tmux has no sessions** — `list-sessions` exits non-zero
  when tmux hasn't been started; the server was propagating this as a 500. It now
  returns `[]` so the bind dialog offers to create a new session instead of erroring.

## [0.5.0] - 2026-06-28

First public release.

### Added
- `handmux` CLI: `start` / `stop` / `restart` / `status` / `logs` / `setup` / `config`,
  plus `hooks install|uninstall` and `service install|uninstall` (launchd on macOS,
  `systemd --user` on Linux). `--version` / `-v` prints the version.
- Pluggable tunnel drivers: `none` (default — local/LAN only, nothing exposed) and
  `cloudflare` (free quick tunnel; `cloudflared` is auto-downloaded if missing).
  `ssh` self-hosted tunnel is reserved (engine: `tunlite run`).
- Single supervisor process owns the server and the tunnel as children, restarts them
  with backoff, and records the live public URL into `~/.handmux/state.json`.
- Auth token is always materialised (generated when unset) and baked into the QR for
  one-tap sign-in; the printed plain links stay token-free so they're safe to share.
- Config resolution: flags > `~/.handmux/config.json` > env > defaults.
- Startup tmux check: hard error if tmux is absent, warning if it's older than the tested
  minimum (3.0) — since `capture-pane -e -N` rendering behaviour drifts across tmux versions.
- Test guard `capture-pane keeps SGR (-e) and trailing whitespace (-N)` so that drift surfaces
  as a named failure rather than a mobile-render glitch.
