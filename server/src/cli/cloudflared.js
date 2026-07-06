// Resolve a usable `cloudflared` binary so `--tunnel cloudflare` is truly one-click (no brew/manual
// install). Order: $PATH → ~/.handmux/bin/ → download the latest release for this OS/arch from GitHub.
// `which`/`fetchImpl` are injectable so the pure mapping (assetFor) unit-tests offline.
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { pocketHome } from './state.js';
import { t } from './i18n/index.js';

const fmtMB = (n) => (n / 1048576).toFixed(1);

// Stream a fetch response into a Buffer, reporting progress per chunk as onProgress(received, total).
// `total` is the content-length (0 if the server didn't send one). Falls back to arrayBuffer() when the
// response isn't a readable stream (older/mock fetch), so callers still get the bytes.
export async function drain(res, onProgress) {
  const total = Number(res.headers?.get?.('content-length')) || 0;
  if (!res.body?.getReader) {
    const b = Buffer.from(await res.arrayBuffer());
    onProgress?.(b.length, total || b.length);
    return b;
  }
  const reader = res.body.getReader();
  const chunks = [];
  let received = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    const c = Buffer.from(value);
    chunks.push(c);
    received += c.length;
    onProgress?.(received, total);
  }
  return Buffer.concat(chunks);
}

// Default progress renderer: a single \r-updated line on a TTY (throttled to ~10/s), e.g.
// `  cloudflared  45%  (9.2/20.4 MB)`. Non-TTY (piped/logged) gets nothing — the start line already
// announced the download and a spammy animation would just fill the log with control chars.
export function defaultProgress(out = process.stdout, name = 'cloudflared') {
  if (!out.isTTY) return () => {};
  let last = 0;
  return (received, total) => {
    const done = total && received >= total;
    const now = Date.now();
    if (!done && now - last < 100) return;
    last = now;
    const body = total
      ? `${Math.floor((received / total) * 100)}%  (${fmtMB(received)}/${fmtMB(total)} MB)`
      : `${fmtMB(received)} MB`;
    out.write(`\r  ${name}  ${body}   `);
    if (done) out.write('\n');
  };
}

// Map Node's platform/arch to cloudflared's release asset. Linux/Windows ship a bare binary; macOS
// ships a .tgz that contains a `cloudflared` executable.
export function assetFor(platform = process.platform, arch = process.arch) {
  const a = { x64: 'amd64', arm64: 'arm64', arm: 'arm', ia32: '386' }[arch] || arch;
  if (platform === 'darwin') return { file: `cloudflared-darwin-${a}.tgz`, archive: 'tgz', bin: 'cloudflared' };
  if (platform === 'win32') return { file: `cloudflared-windows-${a}.exe`, archive: null, bin: 'cloudflared.exe' };
  return { file: `cloudflared-linux-${a}`, archive: null, bin: 'cloudflared' };
}

export function onPath(exec = 'cloudflared') {
  const finder = process.platform === 'win32' ? 'where' : 'which';
  const r = spawnSync(finder, [exec], { encoding: 'utf8' });
  return r.status === 0 ? String(r.stdout).trim().split(/\r?\n/)[0] : null;
}

export async function resolveCloudflared(home, { which = onPath, fetchImpl, log = console, progress } = {}) {
  const found = which('cloudflared');
  if (found) return found;

  const dir = path.join(pocketHome(home), 'bin');
  const asset = assetFor();
  const dest = path.join(dir, asset.bin);
  if (fs.existsSync(dest)) return dest;

  const doFetch = fetchImpl || globalThis.fetch;
  if (!doFetch) throw new Error('no fetch available to download cloudflared (Node 18+ required)');
  fs.mkdirSync(dir, { recursive: true });
  const url = `https://github.com/cloudflare/cloudflared/releases/latest/download/${asset.file}`;
  log.log?.(t('cf.downloading', { file: asset.file }));
  const res = await doFetch(url, { redirect: 'follow' });
  if (!res.ok) throw new Error(`cloudflared download failed: HTTP ${res.status} (${url})`);
  const buf = await drain(res, progress || defaultProgress(process.stdout));

  if (asset.archive === 'tgz') {
    const tmp = path.join(dir, asset.file);
    fs.writeFileSync(tmp, buf);
    const r = spawnSync('tar', ['xzf', tmp, '-C', dir], { encoding: 'utf8' });
    fs.unlinkSync(tmp);
    if (r.status !== 0) throw new Error(`failed to extract cloudflared: ${r.stderr || r.status}`);
  } else {
    fs.writeFileSync(dest, buf);
  }
  fs.chmodSync(dest, 0o755);
  return dest;
}
