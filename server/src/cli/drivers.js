// Tunnel driver registry. A driver only DESCRIBES how to expose the local server (what process to spawn,
// how to read the public URL out of its output); the supervisor owns process lifecycle (spawn, restart,
// kill). Declarative → unit-testable without spawning. matchUrl receives (chunk, cfg): cloudflare scrapes
// a random URL from logs; ssh / cloudflare-named already KNOW the URL (cfg.publicUrl) and only gate it on
// a readiness signal so the QR isn't shown before the tunnel is live.
import { extractCloudflareUrl } from './cloudflareUrl.js';
import { isTunnelConnected } from './sshTunnel.js';
import { cfNamedReady } from './cfNamed.js';
import { extractNatappUrl } from './natappUrl.js';
import { extractCpolarUrl, cpolarNamedArgs } from './cpolarUrl.js';
import { hostIn } from './urlHost.js';

export const DRIVERS = {
  none: {
    name: 'none',
    needsProcess: false,
    proc: () => null,
    matchUrl: () => null,
  },
  cloudflare: {
    name: 'cloudflare',
    needsProcess: true,
    notFoundHint: 'cloudflared not found — install it (brew install cloudflared)',
    proc: (cfg) => ({
      cmd: cfg.cloudflaredBin || 'cloudflared',
      // --grace-period 0s: drop the edge connection immediately on SIGTERM instead of draining for the 30s
      // default, so `stop`/`restart` don't leave the tunnel lingering on Cloudflare's side (it would look
      // "still running" remotely and overlap a restart). See supervisor.shutdown for the local-process side.
      args: ['tunnel', '--grace-period', '0s', '--url', `http://localhost:${cfg.port}`],
    }),
    matchUrl: (chunk) => extractCloudflareUrl(chunk),
  },
  'cloudflare-named': {
    name: 'cloudflare-named',
    needsProcess: true,
    notFoundHint: 'cloudflared not found — run `handmux setup` to provision the named tunnel',
    proc: (cfg) => ({
      cmd: cfg.cloudflaredBin || 'cloudflared',
      // --grace-period 0s goes BEFORE the `run` subcommand (it's a `cloudflared tunnel` flag). Same reason as
      // the quick tunnel: disconnect immediately on stop so the named tunnel doesn't linger on the edge.
      args: ['tunnel', '--grace-period', '0s', 'run', cfg.cfTunnelName],
    }),
    matchUrl: (chunk, cfg) => (cfNamedReady(chunk) ? cfg.publicUrl : null),
  },
  ssh: {
    name: 'ssh',
    needsProcess: true,
    notFoundHint: 'tunlite not found — install it (npm i -g tunlite / npx tunlite install)',
    proc: (cfg) => ({
      cmd: cfg.tunliteBin || 'tunlite',
      args: ['run', '--to', cfg.sshHost, '-R', `${cfg.remotePort}:localhost:${cfg.port}`,
        '--name', 'handmux', '--json', ...(cfg.sshJump ? ['--jump', cfg.sshJump] : [])],
    }),
    matchUrl: (chunk, cfg) => (isTunnelConnected(chunk) ? cfg.publicUrl : null),
  },
  // natapp / cpolar — ngrok-derived domestic tunnels (China-usable when cloudflare's edge isn't). Both take a
  // stable `authtoken`; both default to a full-screen TUI, so we force `-log=stdout` to get scrapeable text.
  // FREE tier = random domain we scrape; a fixed/reserved domain arrives via publicUrl (see cfg.publicUrl).
  natapp: {
    name: 'natapp',
    needsProcess: true,
    notFoundHint: 'natapp not found — download it from https://natapp.cn (login required) into ~/.handmux/bin/',
    proc: (cfg) => ({
      cmd: cfg.natappBin || 'natapp',
      args: [`-authtoken=${cfg.authtoken}`, '-log=stdout'],
    }),
    // The reserved/paid zone is arbitrary (natapp1.cc / your own) so we can't scrape it — gate on the known
    // host echoing in the log. Free tier has no publicUrl → scrape the natappfree.cc URL.
    matchUrl: (chunk, cfg) => (cfg.publicUrl
      ? (hostIn(chunk, cfg.publicUrl) ? cfg.publicUrl : null)
      : extractNatappUrl(chunk)),
  },
  cpolar: {
    name: 'cpolar',
    needsProcess: true,
    notFoundHint: 'cpolar not found — install it (or run `handmux setup`, which auto-downloads it)',
    proc: (cfg) => ({
      cmd: cfg.cpolarBin || 'cpolar',
      // authtoken is seeded into cpolar's own config beforehand (handmux.js / setup); a reserved subdomain or
      // bound domain becomes -subdomain/-hostname; -region selects the edge (cn = mainland China).
      args: ['http', '-log=stdout',
        ...cpolarNamedArgs(cfg.publicUrl),
        ...(cfg.cpolarRegion ? [`-region=${cfg.cpolarRegion}`] : []),
        String(cfg.port)],
    }),
    // A reserved subdomain is still on the cpolar zone, so scrape it (learns the region-qualified host cpolar
    // serves); a bound custom domain is off-zone → gate on its known host from publicUrl.
    matchUrl: (chunk, cfg) => extractCpolarUrl(chunk)
      || (cfg.publicUrl && hostIn(chunk, cfg.publicUrl) ? cfg.publicUrl : null),
  },
};

export function getDriver(name) {
  const d = DRIVERS[name];
  if (!d) throw new Error(`unknown tunnel: ${name}`);
  return d;
}
