import { describe, it, expect } from 'vitest';
import { getDriver, DRIVERS } from '../src/cli/drivers.js';
import { extractCloudflareUrl } from '../src/cli/cloudflareUrl.js';
import { extractNatappUrl } from '../src/cli/natappUrl.js';
import { extractCpolarUrl, cpolarNamedArgs } from '../src/cli/cpolarUrl.js';
import { hostOf, hostIn } from '../src/cli/urlHost.js';
import { lanUrl, publicUrlWithToken } from '../src/cli/supervisor.js';

describe('drivers', () => {
  it('none needs no process', () => {
    expect(DRIVERS.none.needsProcess).toBe(false);
    expect(DRIVERS.none.proc({ port: 1 })).toBeNull();
  });
  it('cloudflare spawns cloudflared against the local port', () => {
    expect(DRIVERS.cloudflare.proc({ port: 8080 }))
      .toEqual({ cmd: 'cloudflared', args: ['tunnel', '--grace-period', '0s', '--url', 'http://localhost:8080'] });
  });
  it('ssh spawns tunlite run with a reverse forward and --json', () => {
    expect(DRIVERS.ssh.proc({ tunliteBin: 'tunlite', sshHost: 'me@h', port: 19999, remotePort: 8443 }))
      .toEqual({ cmd: 'tunlite', args: ['run', '--to', 'me@h', '-R', '8443:localhost:19999', '--name', 'handmux', '--json'] });
  });
  it('ssh appends --jump when a jump host is set', () => {
    const spec = DRIVERS.ssh.proc({ sshHost: 'me@h', port: 1, remotePort: 1, sshJump: 'me@b' });
    expect(spec.cmd).toBe('tunlite');
    expect(spec.args).toContain('--jump');
    expect(spec.args[spec.args.indexOf('--jump') + 1]).toBe('me@b');
  });
  it('ssh matchUrl returns publicUrl only after a connected NDJSON line', () => {
    const cfg = { publicUrl: 'https://my.dev' };
    expect(DRIVERS.ssh.matchUrl('{"state":"starting"}', cfg)).toBeNull();
    expect(DRIVERS.ssh.matchUrl('{"state":"connected"}', cfg)).toBe('https://my.dev');
  });
  it('cloudflare-named runs the named tunnel and reveals https://hostname when ready', () => {
    expect(DRIVERS['cloudflare-named'].proc({ cloudflaredBin: 'cloudflared', cfTunnelName: 'handmux' }))
      .toEqual({ cmd: 'cloudflared', args: ['tunnel', '--grace-period', '0s', 'run', 'handmux'] });
    const cfg = { publicUrl: 'https://handmux.example.com' };
    expect(DRIVERS['cloudflare-named'].matchUrl('Starting tunnel', cfg)).toBeNull();
    expect(DRIVERS['cloudflare-named'].matchUrl('Registered tunnel connection', cfg)).toBe('https://handmux.example.com');
  });
  it('natapp spawns with authtoken + stdout logging and scrapes the free url', () => {
    expect(DRIVERS.natapp.proc({ natappBin: 'natapp', authtoken: 'tok' }))
      .toEqual({ cmd: 'natapp', args: ['-authtoken=tok', '-log=stdout'] });
    // free tier: no publicUrl → scrape the natappfree.cc host
    expect(DRIVERS.natapp.matchUrl('Forwarding  http://ywy9n8.natappfree.cc', {})).toBe('http://ywy9n8.natappfree.cc');
    // fixed domain: gate on the known host echoing in the log
    const cfg = { publicUrl: 'https://myapp.natapp1.cc' };
    expect(DRIVERS.natapp.matchUrl('Tunnel Status Online', cfg)).toBeNull();
    expect(DRIVERS.natapp.matchUrl('Forwarding https://myapp.natapp1.cc', cfg)).toBe('https://myapp.natapp1.cc');
  });
  it('cpolar runs http with stdout logging, appends region/subdomain/hostname, and scrapes the zone url', () => {
    // free tier
    expect(DRIVERS.cpolar.proc({ cpolarBin: 'cpolar', port: 19999 }))
      .toEqual({ cmd: 'cpolar', args: ['http', '-log=stdout', '19999'] });
    // reserved cpolar subdomain + region
    expect(DRIVERS.cpolar.proc({ port: 8080, publicUrl: 'https://myapp.cpolar.top', cpolarRegion: 'cn' }))
      .toEqual({ cmd: 'cpolar', args: ['http', '-log=stdout', '-subdomain=myapp', '-region=cn', '8080'] });
    // bound custom domain → -hostname
    expect(DRIVERS.cpolar.proc({ port: 8080, publicUrl: 'https://tmux.example.com' }))
      .toEqual({ cmd: 'cpolar', args: ['http', '-log=stdout', '-hostname=tmux.example.com', '8080'] });
    // scrape wins (learns the region-qualified host cpolar actually serves)
    expect(DRIVERS.cpolar.matchUrl('Forwarding https://myapp.r2.cpolar.top -> localhost', { publicUrl: 'https://myapp.cpolar.top' }))
      .toBe('https://myapp.r2.cpolar.top');
    // custom domain is off-zone → gate on the known host
    const cfg = { publicUrl: 'https://tmux.example.com' };
    expect(DRIVERS.cpolar.matchUrl('starting', cfg)).toBeNull();
    expect(DRIVERS.cpolar.matchUrl('Forwarding https://tmux.example.com -> localhost', cfg)).toBe('https://tmux.example.com');
  });
  it('getDriver rejects unknown names', () => {
    expect(() => getDriver('nope')).toThrow(/unknown tunnel/);
  });
});

describe('natapp/cpolar url helpers', () => {
  it('extractNatappUrl pulls only the free natappfree.cc zone', () => {
    expect(extractNatappUrl('… url=http://ab12cd.natappfree.cc live')).toBe('http://ab12cd.natappfree.cc');
    expect(extractNatappUrl('https://myapp.natapp1.cc')).toBeNull(); // paid zone is not scraped
    expect(extractNatappUrl('nothing here')).toBeNull();
  });
  it('extractCpolarUrl pulls a cpolar zone url incl. region prefixes', () => {
    expect(extractCpolarUrl('Forwarding https://x.cpolar.top -> y')).toBe('https://x.cpolar.top');
    expect(extractCpolarUrl('Forwarding https://x.r2.cpolar.top -> y')).toBe('https://x.r2.cpolar.top');
    expect(extractCpolarUrl('https://tmux.example.com')).toBeNull();
  });
  it('cpolarNamedArgs derives -subdomain for the zone and -hostname for custom domains', () => {
    expect(cpolarNamedArgs('https://myapp.cpolar.top')).toEqual(['-subdomain=myapp']);
    expect(cpolarNamedArgs('https://myapp.r2.cpolar.top')).toEqual(['-subdomain=myapp']);
    expect(cpolarNamedArgs('https://tmux.example.com')).toEqual(['-hostname=tmux.example.com']);
    expect(cpolarNamedArgs(null)).toEqual([]);
  });
  it('hostOf / hostIn parse and match a url host', () => {
    expect(hostOf('https://a.b.com/x')).toBe('a.b.com');
    expect(hostOf('not a url')).toBeNull();
    expect(hostIn('… a.b.com …', 'https://a.b.com')).toBe(true);
    expect(hostIn('nothing', 'https://a.b.com')).toBe(false);
  });
});

describe('extractCloudflareUrl', () => {
  it('pulls the hostname out of a real-shaped log line', () => {
    const line = '2026-06-18T10:19 INF +-----+ |  https://simple-oldest-putting-installed.trycloudflare.com  | +-----+';
    expect(extractCloudflareUrl(line)).toBe('https://simple-oldest-putting-installed.trycloudflare.com');
  });
  it('returns null when no url present', () => {
    expect(extractCloudflareUrl('QUIC connection successful')).toBeNull();
    expect(extractCloudflareUrl(null)).toBeNull();
  });
});

describe('url helpers', () => {
  it('lanUrl picks the first external IPv4', () => {
    const ifaces = {
      lo0: [{ family: 'IPv4', address: '127.0.0.1', internal: true }],
      en0: [{ family: 'IPv4', address: '192.168.1.42', internal: false }],
    };
    expect(lanUrl(8080, ifaces)).toBe('http://192.168.1.42:8080');
  });
  it('embeds the token in the query string', () => {
    expect(publicUrlWithToken('https://x.trycloudflare.com', 'a b'))
      .toBe('https://x.trycloudflare.com/?token=a%20b');
  });
});
