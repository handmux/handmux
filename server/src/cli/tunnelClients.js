// Resolve the natapp / cpolar client binaries, mirroring cloudflared.js. The two providers differ in one
// hard way: cpolar publishes stable per-OS/arch zips, so we can AUTO-DOWNLOAD it (PATH → ~/.handmux/bin →
// fetch+unzip); natapp gates its downloads behind a login, so there's no stable URL to fetch — we resolve an
// already-installed binary and otherwise throw a clear "download it yourself into ~/.handmux/bin" message.
// Pure mappers (assetForCpolar) are unit-tested offline; `which`/`fetchImpl` are injectable.
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { pocketHome } from './state.js';
import { onPath, drain, defaultProgress } from './cloudflared.js';
import { t } from './i18n/index.js';

// cpolar release asset for this OS/arch. Linux/macOS ship a bare binary inside a .zip; Windows ships a
// `-setup.zip` INSTALLER (not a bare binary), so we don't auto-extract it — Windows users install manually.
const CPOLAR_VERSION = '3.3.12';
export function assetForCpolar(platform = process.platform, arch = process.arch) {
  const a = { x64: 'amd64', arm64: 'arm64', arm: 'arm', ia32: '386' }[arch] || arch;
  const base = `https://www.cpolar.com/static/downloads/releases/${CPOLAR_VERSION}`;
  if (platform === 'win32') return { bin: 'cpolar.exe', url: null };            // installer-only → manual
  const file = `cpolar-stable-${platform === 'darwin' ? 'darwin' : 'linux'}-${a}.zip`;
  return { bin: 'cpolar', file, url: `${base}/${file}` };
}

// PATH → ~/.handmux/bin/cpolar → download+unzip. Any download/extract failure surfaces the friendly manual
// hint (t('client.cpolarManual')) so the worst case is "install it yourself", never a silent dead child.
export async function resolveCpolar(home, { which = onPath, fetchImpl, log = console, progress } = {}) {
  const found = which('cpolar');
  if (found) return found;

  const dir = path.join(pocketHome(home), 'bin');
  const asset = assetForCpolar();
  const dest = path.join(dir, asset.bin);
  if (fs.existsSync(dest)) return dest;
  if (!asset.url) throw new Error(t('client.cpolarManual'));                    // windows / unknown platform

  const doFetch = fetchImpl || globalThis.fetch;
  if (!doFetch) throw new Error(t('client.cpolarManual'));
  fs.mkdirSync(dir, { recursive: true });
  log.log?.(t('client.downloading', { name: 'cpolar', file: asset.file }));
  let res;
  try { res = await doFetch(asset.url, { redirect: 'follow' }); }
  catch { throw new Error(t('client.cpolarManual')); }
  if (!res.ok) throw new Error(t('client.cpolarManual'));
  const buf = await drain(res, progress || defaultProgress(process.stdout, 'cpolar'));

  const tmp = path.join(dir, asset.file);
  fs.writeFileSync(tmp, buf);
  const r = spawnSync('unzip', ['-o', tmp, '-d', dir], { encoding: 'utf8' });
  try { fs.unlinkSync(tmp); } catch { /* best-effort cleanup */ }
  if (r.status !== 0 || !fs.existsSync(dest)) throw new Error(t('client.cpolarManual'));
  fs.chmodSync(dest, 0o755);
  return dest;
}

// natapp: PATH → ~/.handmux/bin/natapp, else a clear manual-download hint (no auto-download — login-gated).
export function resolveNatapp(home, { which = onPath } = {}) {
  const found = which('natapp');
  if (found) return found;
  const dest = path.join(pocketHome(home), 'bin', process.platform === 'win32' ? 'natapp.exe' : 'natapp');
  if (fs.existsSync(dest)) return dest;
  throw new Error(t('client.natappManual', { dir: path.join(pocketHome(home), 'bin') }));
}
