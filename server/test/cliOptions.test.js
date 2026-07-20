import { describe, it, expect } from 'vitest';
import { parseArgs, resolveConfig, explainConfig } from '../src/cli/options.js';

describe('parseArgs', () => {
  it('reads the command and flag values', () => {
    expect(parseArgs(['start', '--tunnel', 'cloudflare', '--port', '8080']))
      .toEqual({ command: 'start', flags: { tunnel: 'cloudflare', port: '8080' } });
  });
  it('treats a bare --flag as boolean true and --no-flag as false', () => {
    expect(parseArgs(['start', '--foreground', '--no-qr']).flags).toEqual({ foreground: true, qr: false });
  });
  it('aliases -f to foreground and camel-cases dashed keys', () => {
    expect(parseArgs(['start', '-f', '--preview-domain', 'p.example.com']).flags)
      .toEqual({ foreground: true, previewDomain: 'p.example.com' });
  });
  it('defaults the command to help when empty', () => {
    expect(parseArgs([]).command).toBe('help');
  });
  it('collects repeated --session values without changing ordinary repeated flags', () => {
    expect(parseArgs(['restore', '--session', 'api', '--session', 'web', '--session', 'docs']).flags.session)
      .toEqual(['api', 'web', 'docs']);
    expect(parseArgs(['start', '--port', '3000', '--port', '4000']).flags.port).toBe('4000');
  });
  it('preserves extra positional arguments and unknown short flags for command-specific validation', () => {
    expect(parseArgs(['restore', 'extra', '-x', '--dry-run'])).toEqual({
      command: 'restore', flags: { dryRun: true }, positionals: ['extra'], unknownShortFlags: ['-x'],
    });
    expect(parseArgs(['open', 'main'])).toMatchObject({ command: 'open', positionals: ['main'] });
  });
});

describe('resolveConfig', () => {
  const gen = () => 'GENERATED';
  it('defaults to the none tunnel on port 19999 and generates a token', () => {
    const c = resolveConfig({}, {}, {}, gen);
    expect(c).toMatchObject({ tunnel: 'none', port: 19999, host: '0.0.0.0', token: 'GENERATED', qr: true });
  });
  it('honours flags over file over env', () => {
    const c = resolveConfig({ port: '3000' }, { port: 4000, host: '127.0.0.1' }, { HANDMUX_PORT: '5000' }, gen);
    expect(c.port).toBe(3000);
    expect(c.host).toBe('127.0.0.1');
  });
  it('keeps an explicit token instead of generating', () => {
    expect(resolveConfig({ token: 'abc' }, {}, {}, gen).token).toBe('abc');
  });
  it('resolves the app name from flag > env, null when unset', () => {
    expect(resolveConfig({}, {}, {}, gen).name).toBeNull();
    expect(resolveConfig({ name: 'My Box' }, {}, {}, gen).name).toBe('My Box');
    expect(resolveConfig({}, {}, { HANDMUX_APP_NAME: 'EnvBox' }, gen).name).toBe('EnvBox');
    expect(resolveConfig({ name: 'Flag' }, {}, { HANDMUX_APP_NAME: 'EnvBox' }, gen).name).toBe('Flag');
  });
  it('rejects an unknown tunnel', () => {
    expect(() => resolveConfig({ tunnel: 'wat' }, {}, {}, gen)).toThrow(/unknown tunnel/);
  });
  it('rejects a bad port', () => {
    expect(() => resolveConfig({ port: '70000' }, {}, {}, gen)).toThrow(/bad port/);
  });
  it('removes the ssh not-available guard and resolves ssh config', () => {
    const c = resolveConfig({ tunnel: 'ssh', sshHost: 'me@box.example.com' }, {}, {}, gen);
    expect(c).toMatchObject({
      tunnel: 'ssh', sshHost: 'me@box.example.com', remotePort: 19999,
      publicUrl: 'http://box.example.com:19999', sshJump: null,
    });
  });
  it('ssh requires an ssh-host', () => {
    expect(() => resolveConfig({ tunnel: 'ssh' }, {}, {}, gen)).toThrow(/ssh-host/);
  });
  it('ssh remote-port defaults to port, public-url overrides the fallback, jump passes through', () => {
    const c = resolveConfig(
      { tunnel: 'ssh', sshHost: 'me@h:2222', remotePort: '8443', publicUrl: 'https://my.dev', sshJump: 'me@b' },
      {}, {}, gen);
    expect(c).toMatchObject({ remotePort: 8443, publicUrl: 'https://my.dev', sshJump: 'me@b' });
  });
  it('ssh fallback strips user@ and :sshport from the host', () => {
    const c = resolveConfig({ tunnel: 'ssh', sshHost: 'me@h.example.com:2222', remotePort: '9000' }, {}, {}, gen);
    expect(c.publicUrl).toBe('http://h.example.com:9000');
  });
  it('resolves cloudflare-named with hostname + default tunnel name', () => {
    const c = resolveConfig({ tunnel: 'cloudflare-named', cfHostname: 'handmux.example.com' }, {}, {}, gen);
    expect(c).toMatchObject({
      tunnel: 'cloudflare-named', cfHostname: 'handmux.example.com',
      cfTunnelName: 'handmux', publicUrl: 'https://handmux.example.com',
    });
  });
  it('cloudflare-named requires a hostname and honours a custom tunnel name', () => {
    expect(() => resolveConfig({ tunnel: 'cloudflare-named' }, {}, {}, gen)).toThrow(/cf-hostname/);
    const c = resolveConfig({ tunnel: 'cloudflare-named', cfHostname: 'h.x.com', cfTunnelName: 'box' }, {}, {}, gen);
    expect(c.cfTunnelName).toBe('box');
  });

  it('publicUrl is null by default (tunnel none → no advertised url yet)', () => {
    expect(resolveConfig({}, {}, {}, gen).publicUrl).toBeNull();
  });
  it('honours an explicit publicUrl even with tunnel none (you run your own tunnel)', () => {
    expect(resolveConfig({}, { tunnel: 'none', publicUrl: 'https://my.domain' }, {}, gen).publicUrl).toBe('https://my.domain');
    expect(resolveConfig({ publicUrl: 'https://flag.dev' }, {}, {}, gen).publicUrl).toBe('https://flag.dev');
    expect(resolveConfig({}, {}, { HANDMUX_PUBLIC_URL: 'https://env.dev' }, gen).publicUrl).toBe('https://env.dev');
  });
  it('an explicit publicUrl overrides the cloudflare-named derived url', () => {
    const c = resolveConfig({ tunnel: 'cloudflare-named', cfHostname: 'h.x.com', publicUrl: 'https://vanity.dev' }, {}, {}, gen);
    expect(c.publicUrl).toBe('https://vanity.dev');
  });

  it('does NOT carry a file publicUrl across a flag tunnel switch (guard)', () => {
    // File was set up for ssh with its own url; a one-run --tunnel cloudflare-named must advertise the
    // cf-named url, not the stale ssh one.
    const c = resolveConfig(
      { tunnel: 'cloudflare-named', cfHostname: 'h.x.com' },
      { tunnel: 'ssh', sshHost: 'me@box', publicUrl: 'https://my.ssh.dev' }, {}, gen);
    expect(c.publicUrl).toBe('https://h.x.com');
  });
  it('keeps the file publicUrl when the resolved tunnel still matches the file', () => {
    const c = resolveConfig({}, { tunnel: 'none', publicUrl: 'https://my.byo.dev' }, {}, gen);
    expect(c.publicUrl).toBe('https://my.byo.dev');
  });
  it('a flag/env publicUrl wins even across a tunnel switch', () => {
    const c = resolveConfig(
      { tunnel: 'cloudflare-named', cfHostname: 'h.x.com', publicUrl: 'https://flag.dev' },
      { tunnel: 'ssh', publicUrl: 'https://file.dev' }, {}, gen);
    expect(c.publicUrl).toBe('https://flag.dev');
  });
  it('natapp/cpolar require an authtoken', () => {
    expect(() => resolveConfig({ tunnel: 'natapp' }, {}, {}, gen)).toThrow(/authtoken/);
    expect(() => resolveConfig({ tunnel: 'cpolar' }, {}, {}, gen)).toThrow(/authtoken/);
  });
  it('natapp resolves the authtoken (flag > env) and stays temporary without a public url', () => {
    expect(resolveConfig({ tunnel: 'natapp', authtoken: 'tok1' }, {}, {}, gen))
      .toMatchObject({ tunnel: 'natapp', authtoken: 'tok1', publicUrl: null });
    expect(resolveConfig({ tunnel: 'natapp' }, {}, { HANDMUX_AUTHTOKEN: 'envtok' }, gen).authtoken).toBe('envtok');
  });
  it('a fixed domain is just --public-url, and a bare host is normalised to https://', () => {
    const c = resolveConfig({ tunnel: 'natapp', authtoken: 't', publicUrl: 'myapp.natapp1.cc' }, {}, {}, gen);
    expect(c.publicUrl).toBe('https://myapp.natapp1.cc');
    const c2 = resolveConfig({ tunnel: 'cpolar', authtoken: 't', publicUrl: 'https://x.cpolar.top' }, {}, {}, gen);
    expect(c2.publicUrl).toBe('https://x.cpolar.top'); // already a url — untouched
  });
  it('cpolar takes an optional region (flag > env)', () => {
    expect(resolveConfig({ tunnel: 'cpolar', authtoken: 't', cpolarRegion: 'cn' }, {}, {}, gen).cpolarRegion).toBe('cn');
    expect(resolveConfig({ tunnel: 'cpolar', authtoken: 't' }, {}, { HANDMUX_CPOLAR_REGION: 'us' }, gen).cpolarRegion).toBe('us');
    expect(resolveConfig({ tunnel: 'cpolar', authtoken: 't' }, {}, {}, gen).cpolarRegion).toBeNull();
  });
  it('ingests the unified config fields (vapid/xfyun/staticDir) from the config file', () => {
    const fileCfg = {
      staticDir: '/srv/dist',
      vapid: { public: 'pub', private: 'priv', subject: 'mailto:me@x.dev' },
      xfyun: { appId: 'A', apiKey: 'K', apiSecret: 'S' },
    };
    const c = resolveConfig({}, fileCfg, {}, gen);
    expect(c.staticDir).toBe('/srv/dist');
    expect(c.vapid).toEqual({ public: 'pub', private: 'priv', subject: 'mailto:me@x.dev' });
    expect(c.xfyun).toEqual({ appId: 'A', apiKey: 'K', apiSecret: 'S' });
  });
  it('leaves the unified fields null when absent (so the integration stays off)', () => {
    const c = resolveConfig({}, {}, {}, gen);
    expect(c.staticDir).toBeNull();
    expect(c.vapid).toBeNull();
    expect(c.xfyun).toBeNull();
  });
  it('normalizes shortcuts from the config file and keeps explicit empty lists', () => {
    const c = resolveConfig({}, {
      shortcuts: { command: [{ type: 'text', text: 'pwd', enter: true }], chat: [] },
    }, {}, gen);
    expect(c.shortcuts).toEqual({
      command: [{ type: 'text', text: 'pwd', enter: true }],
      chat: [],
    });
  });
});

describe('explainConfig', () => {
  it('traces each value to flag > file > env > default', () => {
    const rows = explainConfig({ port: '3000' }, { host: '127.0.0.1' }, '/cfg.json', { HANDMUX_APP_NAME: 'EnvBox' });
    const by = Object.fromEntries(rows.map((r) => [r.key, r]));
    expect(by.port).toMatchObject({ display: '3000', origin: 'flag' });
    expect(by.host).toMatchObject({ display: '127.0.0.1', origin: '/cfg.json' });
    expect(by.name).toMatchObject({ display: 'EnvBox', origin: 'env' });
    expect(by.tunnel).toMatchObject({ display: 'none', origin: 'default' });
  });
  it('masks the token and never prints push/voice secrets', () => {
    const rows = explainConfig({ token: 'supersecrettoken1234' }, { vapid: { public: 'p', private: 'x' } }, '/c.json');
    const by = Object.fromEntries(rows.map((r) => [r.key, r]));
    expect(by.token.display).toBe('••••1234');
    expect(by['push (vapid)']).toMatchObject({ display: 'on', origin: '/c.json' });
    expect(by['voice (xfyun)'].display).toBe('off');
  });
  it('shows tunnel-specific rows only for the live tunnel and applies the publicUrl guard', () => {
    const rows = explainConfig({ tunnel: 'cloudflare-named', cfHostname: 'h.x.com' }, { tunnel: 'ssh', publicUrl: 'https://my.ssh' }, '/c.json');
    const by = Object.fromEntries(rows.map((r) => [r.key, r]));
    expect(by.cfHostname).toMatchObject({ display: 'h.x.com', origin: 'flag' });
    expect(by.sshHost).toBeUndefined();
    expect(by.publicUrl.display).toMatch(/derived from tunnel/); // stale ssh url dropped
  });
  it('masks the natapp/cpolar authtoken and shows cpolar region only for cpolar', () => {
    const nat = Object.fromEntries(explainConfig({ tunnel: 'natapp', authtoken: 'supersecrettoken1234' }, {}, '/c.json').map((r) => [r.key, r]));
    expect(nat.authtoken.display).toBe('••••1234');
    expect(nat.cpolarRegion).toBeUndefined();
    const cp = Object.fromEntries(explainConfig({ tunnel: 'cpolar', cpolarRegion: 'cn' }, {}, '/c.json').map((r) => [r.key, r]));
    expect(cp.authtoken.display).toMatch(/required/);
    expect(cp.cpolarRegion).toMatchObject({ display: 'cn', origin: 'flag' });
  });
});
