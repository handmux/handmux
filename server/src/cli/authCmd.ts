import { text, select, confirm, isCancel } from '@clack/prompts';
import { connectAuthControl } from '../deviceAuth/control.js';
import { parseExpire, validateName } from '../deviceAuth/service.js';
import { t } from './i18n/index.js';

export interface AuthCommand { op: 'add' | 'list' | 'edit' | 'revoke' | 'token-status' | 'token-enable' | 'token-disable' | 'trusted-origin-status' | 'trusted-origin-set'; id?: string; code?: string; name?: string; expire?: string; origin?: string; allowEmpty?: boolean }
export function parseAuthArgs(argv: readonly string[], interactive: boolean): AuthCommand {
  let [op, ...rest] = argv;
  if (op === 'token') { const sub = rest.shift(); op = sub ? `token-${sub}` : ''; }
  if (op === 'trusted-origin') { const sub = rest.shift(); op = sub ? `trusted-origin-${sub}` : ''; }
  if (op !== 'add' && op !== 'list' && op !== 'edit' && op !== 'revoke' && op !== 'token-status' && op !== 'token-enable' && op !== 'token-disable' && op !== 'trusted-origin-status' && op !== 'trusted-origin-set') throw new Error('Usage: handmux auth add ... | list | edit ... | revoke ... | token status|enable|disable | trusted-origin status|set <origin>');
  if (op === 'trusted-origin-status') return { op };
  if (op === 'trusted-origin-set') { if (rest.length !== 1 || !rest[0]) throw new Error('Provide an origin, for example https://handmux.example.com'); return { op, origin: rest[0] }; }
  if (op === 'token-status' || op === 'token-enable' || op === 'token-disable') return { op };
  const result: AuthCommand = { op };
  for (let i = 0; i < rest.length; i++) {
    const arg = rest[i]!;
    if (arg === '--code' || arg === '--name' || arg === '--expire') {
      const key = arg === '--code' ? 'code' : arg === '--name' ? 'name' : 'expire'; const value = rest[++i];
      if (!value || value.startsWith('--') || result[key] !== undefined) throw new Error(`Provide ${arg} exactly once with a value`);
      result[key] = value;
    } else if (arg.startsWith('-') || result.id !== undefined) throw new Error(`Unexpected argument: ${arg}`);
    else if (op === 'add') throw new Error('Use --code for non-interactive add; interactive add reads the code after handmux auth add');
    else result.id = arg;
  }
  if (op === 'list' && (result.id || result.code || result.name !== undefined || result.expire !== undefined)) throw new Error('Usage: handmux auth list');
  if (op !== 'add' && result.code !== undefined) throw new Error('The --code flag is only valid for handmux auth add');
  if (op === 'revoke' && (result.name !== undefined || result.expire !== undefined)) throw new Error('Usage: handmux auth revoke <device-id>');
  if ((op === 'edit' || op === 'revoke') && !result.id) throw new Error('Provide the exact device ID from handmux auth list');
  if (op === 'edit' && result.name === undefined && result.expire === undefined) throw new Error('Provide --name or --expire');
  if (result.name !== undefined) result.name = validateName(result.name);
  if (result.expire !== undefined) parseExpire(result.expire);
  if (op === 'add') {
    if (result.code !== undefined && !/^\d{6}$/.test(result.code)) throw new Error('Code must be exactly 6 digits, preserving leading zeros');
    if (!interactive && (result.code === undefined || result.name === undefined || result.expire === undefined)) throw new Error('Non-interactive add requires --code, --name and --expire; no code has been consumed');
  }
  return result;
}
const safeText = (value: unknown): string => String(value ?? '').replace(/[\x00-\x1f\x7f-\x9f]/g, '');
const iso = (value: unknown): string => typeof value === 'number' ? new Date(value).toISOString() : 'never';
function outputDevice(value: unknown): string {
  const d = value as Record<string, unknown>;
  return `${safeText(d.id)}\t${safeText(d.name)}\t${safeText(d.status)}\t${iso(d.expires_at)}\t${iso(d.authorized_at)}\t${iso(d.last_used_at)}\t${safeText(d.browser_summary)}${'previousExpiresAt' in d ? `\tprevious expiry: ${iso(d.previousExpiresAt)}` : ''}`;
}
const canceled = Symbol('canceled');
async function ask<T>(promise: Promise<T | symbol>): Promise<T> { const result = await promise; if (isCancel(result)) throw canceled; return result as T; }
export async function runAuthCommand({ argv, home, interactive = !!process.stdin.isTTY, log = console.log, err = console.error, connect = connectAuthControl }: {
  argv: readonly string[]; home: string; interactive?: boolean; log?: (message: string) => void; err?: (message: string) => void; connect?: typeof connectAuthControl;
}): Promise<0 | 1> {
  let client: Awaited<ReturnType<typeof connectAuthControl>> | undefined;
  try {
    const args = parseAuthArgs(argv, interactive);
    if (args.op === 'trusted-origin-status' || args.op === 'trusted-origin-set') {
      client = await connect(home); const result = await client.request({ op: args.op, origin: args.origin });
      log(`可信访问地址: ${safeText((result as { origin?: string | null }).origin) || '未配置'}`); return 0;
    }
    if (args.op === 'token-status' || args.op === 'token-enable' || args.op === 'token-disable') {
      client = await connect(home);
      const status = await client.request({ op: 'token-status' }) as { enabled: boolean; devices?: unknown[] };
      if (args.op === 'token-status') { log(`固定 Token 登录: 始终启用\n可信设备: ${Array.isArray(status.devices) ? status.devices.length : 0}`); return 0; }
      if (args.op === 'token-enable') { log('固定 Token 登录始终启用，无需切换。'); return 0; }
      log('固定 Token 登录始终启用，不能禁用可信设备保护。请使用 handmux auth add 为浏览器恢复可信设备。');
      return 1;
    }
    if (args.op !== 'add') {
      client = await connect(home); const result = await client.request(args as unknown as Record<string, unknown>);
      log('ID\tNAME\tSTATUS\tEXPIRES\tADDED\tLAST ACCESS\tBROWSER');
      if (Array.isArray(result)) result.forEach(d => log(outputDevice(d))); else log(outputDevice(result));
      return 0;
    }
    log(t('auth.safety'));
    if (!args.code) args.code = await ask(text({ message: t('auth.code'), validate: v => /^\d{6}$/.test(v ?? '') ? undefined : 'Enter exactly 6 digits' }));
    client = await connect(home);
    const claimed = await client.request({ op: 'claim', code: args.code }) as { id: string; browserSummary: string };
    const needsPrompt = args.name === undefined || args.expire === undefined;
    log(t('auth.claimed')); log(safeText(claimed.browserSummary));
    if (args.name === undefined) {
      const fallback = safeText(claimed.browserSummary).slice(0, 80) || 'Browser';
      args.name = await ask(text({ message: t('auth.name'), defaultValue: fallback, placeholder: fallback, validate: v => { try { validateName(v || fallback); } catch (e) { return (e as Error).message; } return undefined; } }));
      args.name = args.name || fallback;
    }
    if (args.expire === undefined) {
      const expire = await ask(select({ message: t('auth.expire'), initialValue: '30d', options: [
        ...['1h', '1d', '7d', '30d'].map(value => ({ value, label: value })),
        { value: 'custom', label: t('auth.custom') }, { value: 'never', label: t('auth.never') },
      ] }));
      args.expire = expire === 'custom' ? await ask(text({ message: t('auth.duration'), validate: v => { try { parseExpire(v); } catch (e) { return (e as Error).message; } return undefined; } })) : expire;
    }
    if (needsPrompt && !await ask(confirm({ message: t('auth.confirm'), initialValue: true }))) throw canceled;
    const result = await client.request({ op: 'authorize', id: claimed.id, name: args.name, expire: args.expire });
    log('ID\tNAME\tSTATUS\tEXPIRES\tADDED\tLAST ACCESS\tBROWSER'); log(outputDevice(result)); return 0;
  } catch (error) {
    if (error === canceled) err(t('auth.canceled'));
    else err(error instanceof Error ? safeText(error.message) : 'Authentication command failed');
    return 1;
  } finally { client?.close(); }
}
