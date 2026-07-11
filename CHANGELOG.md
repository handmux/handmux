# Changelog

All notable changes to handmux. Format follows [Keep a Changelog](https://keepachangelog.com).

## [Unreleased]

### Added
- **Name a session when taking over an orphan.** The takeover sheet now has an editable name field for a
  new session (prefilled with the same `<agent>-<dir>-1` default the server would auto-pick), and the
  "continue on the computer" hint shows the exact command with the real name filled in — `handmux open
  <name>` instead of the old `tmux attach -t <session>` placeholder. A user-typed name is sanitized to
  tmux rules and gets a numeric suffix if it collides with an existing session.
- **Homebrew install for machines without Node.** `brew install handmux/tap/handmux` installs handmux
  plus Node and tmux in one command — the zero-prerequisite path for people without a Node toolchain
  (published via the new `handmux/homebrew-tap`). If you already have Node, `npm i -g handmux` stays the
  lighter option (it reuses your existing Node). Documented in the Quick start.

## [0.12.2] - 2026-07-11

### Fixed
- **A changed app icon / manifest now actually reaches returning users.** The server was sending every
  static file — including the hand-authored, stable-URL `icons/*`, `manifest.webmanifest` and favicon —
  as `Cache-Control: immutable, max-age=1y`, which is only correct for Vite's content-hashed `/assets/*`
  bundles. A stable-URL asset marked `immutable` gets pinned in every returning browser for a year, so a
  new icon or manifest would never show up. `staticCache.js` now pins only `/assets/*` and serves the
  stable-URL assets `no-cache` (revalidate → cheap 304 when unchanged, instant pickup when changed). A
  one-time `?v=2` on the icon / manifest / og-image references breaks browsers out of the already-cached
  `immutable` copies (index.html is `no-store`, so the new refs reach them immediately); Android updates
  an installed PWA's icon automatically, while an icon already on an iOS home screen is frozen at
  add-time and needs a one-time remove + re-add.
- **README banner's bottom corners are now rounded.** At an exact window==card fit, headless Chrome
  clipped the card's bottom rounding, so the lower two corners rendered square while the top two were
  round. The banner is now a fixed-size card centered in a taller window and centre-cropped back, so
  all four corners round.

## [0.12.1] - 2026-07-11

### Changed
- **New app icon / brand logo.** Swapped in a new glowing terminal-window mark and regenerated every
  brand surface from it — PWA/home-screen `icon-192`/`icon-512`, the 180px `apple-touch-icon`, the
  cold-launch boot splash, the landing-page header mark (`site/logo-mark.png`, a rounded app chip),
  the browser-tab favicon (`site/favicon.svg`, now the new mark), and the OG /
  Twitter share cards (en + zh, rebuilt from a reusable `tools/og` template). The push badge (a
  monochrome notification silhouette) is unchanged. The home-screen icon ships as both an `any`
  variant (full-bleed art for iOS / desktop) and a dedicated `maskable` variant with a safe-zone
  margin, so Android's adaptive-icon masking no longer crops or over-enlarges it.
- **Brand wordmark.** A two-tone “handmux” wordmark — rounded, single-story-a (self-hosted Fredoka),
  `hand` in white and `mux` in a teal→green gradient — now stands in for the old solid green pill and
  is used consistently across the landing header + footer, the OG / Twitter share cards, and the
  app's cold-launch boot splash. On the landing pages it's preloaded and set `font-display: block` so
  it paints in Fredoka directly, with no flash of a fallback font first.
- **README title is now the brand banner.** Both READMEs (en + zh) swap the plain-text `handmux`
  heading for a rendered banner (rounded terminal mark + the Fredoka two-tone wordmark on a dark card)
  — GitHub strips CSS + web-fonts from READMEs, so the branded title can only ship as an image.

## [0.12.0] - 2026-07-11

### Fixed
- **Back from a doc preview now retraces how you actually got there — and never exits the app.** Back
  used to force any open preview to the 目录 page of that file's directory, even when you never browsed
  there (opened straight from a terminal link or 最近). That invented level consumed the sheet's only
  history entry, so the NEXT Back — which should have minimized the sheet — fell out of the app
  entirely. The sheet now records each real forward action (a dir move, a preview opened from inside
  the sheet) and Back pops them in reverse: a doc opened from browsing returns to home exactly as you
  left it (最近 stays 最近), and a doc opened directly just hides the sheet in one press.

### Added
- **Feedback channels, linked from everywhere.** Settings gains a 反馈与交流 section — GitHub Issues
  (always) and the WeChat user group (zh locales) — and the same two channels are now in both READMEs,
  the landing page (new #community section with the group QR), the docs (Feedback section), and the
  GitHub issue chooser. The QR image lives only on the site, so rotating it never needs an app release.
- **The chat composer's unsent draft survives leaving the app.** Whatever is typed in the chat box is
  mirrored to local storage on every keystroke and written back into the box on the next open — so an
  accidental swipe-away, a tab kill, or a crash no longer eats a half-written prompt. Sending (or 填入)
  clears the stored draft along with the box.
- **Swipe now scrolls full-screen apps (vim / htop / less / mouse-mode TUIs), plus a page up/down button.**
  Those apps run on the terminal's alternate screen, which has no scrollback — so a vertical swipe used to
  have nothing to move and instead nudged the browser page a little (the nav chrome peeking in on old iOS).
  Now a vertical drag is forwarded to the app as scroll input: when it's reporting mouse (the usual case —
  mouse mode on), as real mouse-wheel events it scrolls on exactly like a desktop wheel; otherwise as arrow
  keys, which scroll any pager (less / man / git log) line-by-line (in an editor arrows move the cursor
  instead — the deliberate trade-off for making the common pager case swipe-scroll). The scrolled frame
  repaints immediately. A floating page up/down control (frosted capsule, right edge) is shown on every
  full-screen pane for precise, always-available paging. On the normal screen, swipe-scroll through the
  captured scrollback is unchanged. Server-side: the pane reports its mouse state (`#{mouse_any_flag}` /
  `#{mouse_sgr_flag}`) and a new `POST /api/scroll` injects wheel events — re-checking mouse mode before
  injecting so the escape bytes can never leak into a shell as literal text.

## [0.11.1] - 2026-07-09

### Fixed
- **CLI crashed on Node 18** — the 0.11.0 setup menu's prompt library (`@clack/prompts` 1.7) uses
  `util.styleText`, which only exists from Node 20.12, so `import` died before any command ran.
  Pinned to 0.11.0 — the last release without that import (every 1.x has it top-level); the prompt
  API we use is identical. CI now also tests Node 22.

## [0.11.0] - 2026-07-08

### Fixed
- **File browser refreshes its listing when you reopen the sheet.** The sheet stays mounted while
  minimized, so reopening to the same directory kept showing the listing captured on first open. Both the
  directory browser and the 最近 (recents) view now re-fetch on every reopen, so you see the current
  contents (a `cd`, new files, or a newly-opened doc) instead of a stale snapshot.
- **Chat mode: long-pressing a quick-command chip now types into the terminal, not the chat box.** These
  chips are terminal commands, so a long-press (edit-before-run) now types the command into the pane's input
  line without Enter — the same as command mode's hold — instead of staging it in the chat composer.
- **`handmux setup` on a running instance now actually applies your changes.** The run-action used to read
  "Save & start" even when handmux was already up — and picking it just re-ran `start`, which sees the
  running instance and does nothing (only tunnel/port changes were ever detected), so an edited name / push
  / voice / ssh setting was written to disk but silently never took effect. Now that action reads **"Save &
  restart (apply now)"** when an instance is running and performs a real stop→start into the new config;
  choosing plain **Save** while running prints "run `handmux restart` to apply" instead of "run start".

### Changed
- **Setup's `none` tunnel now reads "Direct" (直连), and its description is accurate.** The LAN-only option
  was labeled with the raw flag value `none`, which says nothing to a newcomer; the picker, the connection
  summary, and the welcome copy now call it **Direct / 直连** (the `--tunnel none` flag and config value are
  unchanged). Its hint no longer claims "same Wi-Fi only" — a direct connection also works when the machine
  has its own public IP — and the hub summary now says **no relay / 无中转** instead of "LAN".
- **Setup's language row is clearer about its scope and easy to spot.** It's relabeled **CLI language /
  命令行语言** — bilingual so either audience recognizes it even if the CLI is currently in the other
  language (switching re-localizes the whole hub on the spot), and scoped to handmux's own terminal output
  rather than the phone app. Moved to the bottom of the settings, just above the actions, since it's a tool
  preference rather than an app setting.
- **`handmux setup` push section now explains itself.** Turning notifications on shows a one-line note that
  handmux generates a private signing key locally (`~/.handmux/config.json`, never leaves the machine) and
  that the "contact" is only an address the push service can reach you at. The contact field is validated
  (must be a real `mailto:`/`https://`, `.local` rejected — Apple's APNs silently drops fake ones), and
  **Regenerate keys** now carries a "resets every phone subscription" hint and a confirm gate spelling out
  that every already-subscribed phone must re-subscribe (only needed if the private key leaked).
- **Tiered `handmux` help.** The bare `handmux` / `handmux help` screen is now short — the six verbs, the
  mental model, and a "New here? run `handmux setup`" nudge — with the full flag wall moved behind
  `handmux help flags`. That flag reference now doubles as the **headless config guide**: every flag lists
  its matching `HANDMUX_*` env var, and the precedence line is corrected to **flag > file > env > default**
  (env sits between file and default — it was previously mis-documented as "flag > file > default", which
  hid that env vars work at all). The rarely-needed `--static-dir` / `--upload-exts` / `--preview-ttl` are
  documented there too. Flags stay the scriptable/headless interface; `setup` remains the interactive
  path — neither replaces the other.
- **`handmux setup` is now a menu hub, not a linear questionnaire.** Every setting is a row showing its
  current value; arrow to a section to edit just that (Connection / Name / Port / Language / Push / Voice),
  then return to the hub and pick Save / Save & start / Exit. Re-configuring one thing no longer means
  Entering through every prompt. **Connection is two levels** — first pick the tunnel type (and, for
  cloudflare, temporary vs named), then that tunnel's config fields appear *inside* it as value-showing
  rows (secrets masked) you edit one at a time; **Push / Voice** are likewise mini-hubs over their current
  values instead of a "keep it? [y/n]" gate. cloudflare's quick vs named is now one **cloudflare** entry
  with the temporary-vs-named choice inside (mirroring natapp/cpolar's temporary-vs-fixed); the `--tunnel
  cloudflare` / `cloudflare-named` flags are unchanged at the config level. **Built for a newcomer who
  won't read docs**: a first run walks language → a one-line welcome → "how does your phone reach this
  machine?" (options framed by outcome — *works in China*, *no signup*, *simplest*), then lands the cursor
  on **Save & start** so the essentials are obviously done and the rest reads as optional; push/voice are
  described by what they do ("get pinged when an agent finishes", "talk to your phone → text") and the
  natapp/cpolar prompts say exactly where to register free and copy the authtoken. Enumerated choices are
  arrow-key selectable; inputs validate inline (port range, domain shape); Esc backs out a level. Built on
  `@clack/prompts`, isolated behind `src/cli/prompt.js`.

### Added
- **Two China-usable tunnels: `--tunnel natapp` and `--tunnel cpolar`.** When Cloudflare's edge is
  unreliable from mainland China, these ngrok-derived domestic tunnels get the phone to your machine.
  Unified, minimal parameter model: one shared `--authtoken` (or `HANDMUX_AUTHTOKEN`) is the only new
  required flag; a **fixed/reserved domain is just `--public-url`** (bare host accepted — normalised to
  `https://`), and omitting it uses the provider's free temporary domain (scraped from the client's
  output, like the Cloudflare quick tunnel). cpolar also takes an optional `--cpolar-region` (e.g. `cn`).
  cpolar's client **auto-downloads** (PATH → `~/.handmux/bin` → fetch+unzip, with a friendly manual
  fallback); natapp's is login-gated so it resolves an installed binary and otherwise tells you exactly
  where to drop it. `handmux setup` gained both as menu options 5/6, each with in-context guidance on
  where to get the authtoken and a temporary-vs-fixed-domain prompt.

## [0.10.0] - 2026-07-06

### Added
- **`handmux open <session>` — one-command attach on the computer.** Attaches the named tmux session,
  creating it if missing; inside tmux it refuses with a hint (don't nest tmux in tmux). Deliberately
  decoupled from the server lifecycle (never starts/stops anything) — its main job is taking back a
  session you created from the phone, without needing to know `tmux new -A -s`. The phone's bind/create
  dialog now carries a quiet hint teaching exactly that (all 5 languages), and the docs gained a
  `handmux open` section.

### Fixed
- **A document always shows the latest content now — no stale cached copy.** A doc tab cached the bytes
  it was first opened with; re-opening the same path only re-activated the tab and *discarded* the
  freshly-refetched content (`openDocState` dedupe), so an updated file kept showing the old version.
  Now every way of returning to a doc refetches it: re-tapping the file, **switching to its tab**, and
  re-opening the file sheet from the topbar. Tab switches stay instant (activate first, refresh in the
  background) and a refetch that lands after you've switched away updates the tab in place without
  stealing focus back. The refresh is a **conditional GET** keyed on the file's mtime: an unchanged
  file answers `{ notModified }` (text/markdown via `/api/file?mtime=`) or `304` (images via
  `/api/download?mtime=`, `X-Mtime` header carrying the current mtime) — so nothing is re-transferred
  or re-rendered when nothing changed (your scroll position and read-aloud stay put, and an unchanged
  image keeps its exact object URL: no re-download, no flash). A changed image swaps in a fresh blob
  and revokes the old one.

### Changed
- **The in-app changelog is now keyed by release version, not date.** Each entry carries a `version`
  (`0.9.1`) shown as "v0.9.1 · 2026-07-06", plus a one-line `highlight`; the pre-1.0 internal builds are
  merged into a single dateless "Early builds" entry. `LATEST_RELEASE` / the unread-dot id now use the
  version. (Existing users see the gear dot light once as the stored "seen" id switches format.)

### Added
- **The phone shows *what's new* before you upgrade, not just the version number.** The release now
  mirrors the changelog's concise per-version highlights into `server/package.json` `whatsNew` (via a
  new `server/scripts/gen-whatsnew.mjs`, run by `release.sh`). The existing hourly update check fetches
  it in the same `npm view handmux@latest version whatsNew --json` call — so it rides the user's own npm
  (China-mirror-friendly), no GitHub reach. `GET /api/version` returns `whatsNew` trimmed to the versions
  strictly newer than the installed one, and Settings lists them under the "vX available" card so a user
  knows what the trip to the computer buys before running `handmux update`.

## [0.9.1] - 2026-07-06

### Added
- **"Add to Home Screen" coach.** On first open in a browser tab (never once installed, and
  remembered as dismissed), a light, dismissible strip at the top of the screen nudges you to install
  handmux as a full-screen PWA — a non-modal `role="status"` banner you flick away with the ✕, not a
  blocking dialog. Android gets a one-tap install via `beforeinstallprompt`; iOS Safari gets the
  compact Share → More → Add to Home Screen hint, and other iOS browsers are pointed at Safari — the
  only iOS browser that can install a PWA, and the path iOS push requires.

## [0.9.0] - 2026-07-05

### Changed
- Chat composer: once the text grows past one line, the textarea takes the full pill width and the
  mic/send buttons float in the pill's bottom-right corner instead of reserving a right-hand column
  on every line; the box hugs the text, and only when the last line actually reaches the buttons
  does it open an extra strip for them (last-line position measured via a hidden mirror div). The
  pill also gained a little vertical breathing room above and below.
- The landing site moved to its own repo, `handmux/handmux.github.io` (still served at handmux.com);
  the code repo's `gh-pages` branch is retired once the domain cutover completes.
- The public repository moved to its own organization: `github.com/handmux/handmux`. Old
  `yuanyuanzijin/handmux` links redirect permanently; README badges, package metadata, the security
  policy, issue templates and the landing page now point at the new home.

### Fixed
- The bundled terminal fonts (Nerd icons / symbol fills) could stay missing for a whole session
  when their one network fetch failed on a flaky link — a failed `@font-face` is never retried by
  the browser. The app now supersedes a failed face with a fresh JS FontFace and retries with
  backoff, rebuilding the terminal glyph atlas when the font finally lands.

## [0.8.0] - 2026-07-05

### Added
- **Update notice on the phone: know when the installed CLI is behind npm.** A new token-gated
  `GET /api/version` returns `{ current, latest, updateAvailable }` — `current` is this server's installed
  version, `latest` comes from the same hourly npm cache the CLI keeps (`~/.handmux/update-check.json`),
  refreshed asynchronously (never blocking the request) when stale. The web app checks it **once per launch**
  (not polled): if a newer release exists, the settings gear lights its dot and Settings shows a
  「有新版本 vX 可用 · 在电脑上运行 `handmux update`」card (the upgrade is computer-side, so it's a notice,
  not a button). The gear's dot is shared with the changelog-unread signal — update-available before you
  upgrade, then the changelog it brought after — and clears once you've opened Settings for that version
  (`tw_version_seen`), relighting only when npm publishes a newer one. Settings also now shows the current
  version number.
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
- **Video files are now uploadable.** The upload allow-list (both the `accept` hint and the server's
  `DEFAULT_UPLOAD_EXTS`) gained the common video extensions (`mp4`, `m4v`, `mov`, `webm`, `mkv`, `avi`,
  `wmv`, `flv`, `3gp`, `ogv`, `mpeg`, `mpg`).
- **Uploading a name that already exists auto-renames instead of failing.** The server picks the first
  free Finder-style `name (1).ext`, `name (2).ext`, … — it never overwrites, and the response carries the
  actual final name so the pasted path is correct. (Previously a clash returned 409 → a bare 「上传失败」.)
- **Git panel can browse repos outside `$HOME` (under `/tmp`, `$TMPDIR`).** It now shares the same
  multi-root allow-list the file/doc browser already used, so a repo an agent is working in under `/tmp`
  opens on the phone instead of erroring out.

### Changed
- **Touch targets raised toward the 44pt HIG minimum.** The file-browser bar's up/cwd/mkdir/upload squares
  are now 44×44, and list-row action icons (favourite/copy/delete/reorder, session unbind, idea delete, file
  download) get a ≥44pt-tall hit box while keeping their compact glyphs. The topbar stays deliberately compact
  — its icon buttons are a comfortable 34×34 (bigger than before, but the bar itself is tighter) with the
  unread badges re-anchored to hug each glyph. Also left compact: the command keyboard grid, window tabs,
  dock input buttons, quick-command chips and the preview head. CSS-only.
- **Sheet/modal close buttons unified to one iOS style.** Every panel's close control (`.settings-close`
  across the modals, `.cmd-close` across the bottom sheets) is now the same subtle filled-grey circle with a
  centred X — regardless of whether it renders the `✕` glyph or the `<XIcon/>` SVG — instead of a bare grey
  glyph at mixed sizes. Sheet titles aligned to 16px. CSS-only.
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
  text/code + documents + video) so the native picker guides you toward valid files, and pre-check the
  picked files client-side: a disallowed pick (an executable, `.zip`, an extensionless binary) is
  dropped with an instant 「不支持的文件类型」note instead of failing halfway with a server 415. Mirrors
  the server's extension allow-list (`server/src/uploadTypes.js`), which remains the real enforcement.
- **Upload progress is honest, and the transfer is cancellable.** The bar used to jump to 100% the
  instant the browser flushed the bytes to the socket/proxy, then sit there through the real wait
  (server receive + disk write + response — the bulk of a big file behind nginx/a tunnel). It now runs
  in two phases: a real % while sending, then an indeterminate 「服务器接收中…」spinner once bytes are
  flushed. During a transfer an app-wide overlay blocks stray taps (HIG: don't leave a long op without an
  out) — the only control is **Cancel**, which aborts the in-flight request and stops the batch (files
  already uploaded are kept). Covers both upload entries (chat ＋附件 and the file browser).

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
- **Git panel showed a red error where it shouldn't.** A legit repo under `/tmp` (outside `$HOME`) failed
  with a red 「无法读取仓库」 (the git browser was still home-only while the file browser had moved to a
  multi-root allow-list — see Added). And picking a directory with no repo, or one genuinely outside the
  accessible area, rendered in the red error line too. Now: repos under `/tmp`/`$TMPDIR` just open;
  no-repo / out-of-scope are soft grey **instructive** notes (say why + what to do: pick another dir,
  `git init`, or move it under home) — red is reserved for real failures.
- **Upload failures now say why.** A failed upload showed a bare 「上传失败」; it now surfaces the specific
  reason (file too large, unsupported type, …) per file, in both the chat composer and the file browser.

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
