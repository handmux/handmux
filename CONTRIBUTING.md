# Contributing

Thanks for your interest in handmux. This is a small two-package repo.

## Layout

- `server/` — Node server. Talks to tmux via `capture-pane` / `send-keys`, serves the API and the built
  web client, and hosts the `handmux` CLI (`server/bin/handmux.js`). No build step.
- `web/` — React + Vite + xterm.js mobile client. Built with Vite.
- `server/tmux/` — optional tmux status-dot integration (see `server/tmux/README.md`).

## Running locally

```bash
# server (needs tmux >= 3.0 on the host)
cd server && npm install
npm run dev                                     # compiles Server source, then runs the same CLI as a global install

# web (separate terminal)
cd web && npm install && npm run dev            # Vite dev server, proxies /api to the server
```

Config is one JSON file. For development, drop a `./config.json` at the repo root (copy
`config.example.json`) — running the CLI from the repo loads it (it prints `config: …` on start);
a global install / running from elsewhere uses `~/.handmux/config.json` instead. Optional integrations
(voice, push, previews, tunnels) are all off until configured in that file — see the README.

## Tests

```bash
cd server && npm test          # vitest; runs test files sequentially (see server/vitest.config.js)
cd web    && npx vitest run     # MUST run from web/ (jsdom config + test/ live there)
```

Please add or update tests for any behavior change. Pure logic is unit-tested; terminal rendering is
verified by replaying real capture bytes through `@xterm/headless` (see `web/test/terminalRefresh.test.js`).

## Shipping a user-facing feature

When a user-felt feature lands, add one concise entry to `web/src/changelog.js` (newest first; the top entry
drives the unread dot on the settings gear). Skip pure bug fixes.

## Notes

- `./deploy.sh` is the maintainer's production deploy (bundles the web client into `server/public` via
  `npm pack`, reinstalls the package globally, then restarts the prod process). Contributors don't need it.
- Optional integrations gate themselves: when their config is absent the API returns 503 and the UI hides
  the control. Follow that pattern (`/api/config` capability flag + client-side hide) for any new one.
