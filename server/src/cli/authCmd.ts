import { text, select, confirm, isCancel } from '@clack/prompts';
import { connectAuthControl } from '../deviceAuth/control.js';
import { parseExpire, validateName } from '../deviceAuth/service.js';
import { t } from './i18n/index.js';

export interface AuthCommand { op: 'add' | 'list' | 'edit' | 'revoke' | 'token-status' | 'token-enable' | 'token-disable'; id?: string; name?: string; expire?: string; allowEmpty?: boolean }
export function parseAuthArgs(argv: readonly string[], interactive: boolean): AuthCommand {
  let [op, ...rest] = argv;
  if (op === 'token') { const sub = rest.shift(); op = sub ? `token-${sub}` : ''; }
  if (op !== 'add' && op !== 'list' && op !== 'edit' && op !== 'revoke' && op !== 'token-status' && op !== 'token-enable' && op !== 'token-disable') throw new Error('Usage: handmux auth add ... | list | edit ... | revoke ... | token status|enable|disable');
  if (op === 'token-status' || op === 'token-enable' || op === 'token-disable') return { op };
  const result: AuthCommand = { op };
  for (let i = 0; i < rest.length; i++) {
    const arg = rest[i]!;
    if (arg === '--name' || arg === '--expire') {
      const key = arg === '--name' ? 'name' : 'expire'; const value = rest[++i];
      if (!value || value.startsWith('--') || result[key] !== undefined) throw new Error(`Provide ${arg} exactly once with a value`);
      result[key] = value;
    } else if (arg.startsWith('-') || result.id !== undefined) throw new Error(`Unexpected argument: ${arg}`);
    else result.id = arg;
  }
  if (op === 'list' && (result.id || result.name !== undefined || result.expire !== undefined)) throw new Error('Usage: handmux auth list');
  if (op === 'revoke' && (result.name !== undefined || result.expire !== undefined)) throw new Error('Usage: handmux auth revoke <device-id>');
  if ((op === 'edit' || op === 'revoke') && !result.id) throw new Error('Provide the exact device ID from handmux auth list');
  if (op === 'edit' && result.name === undefined && result.expire === undefined) throw new Error('Provide --name or --expire');
  if (result.name !== undefined) result.name = validateName(result.name);
  if (result.expire !== undefined) parseExpire(result.expire);
  if (op === 'add') {
    if (result.id !== undefined && !/^\d{6}$/.test(result.id)) throw new Error('Code must be exactly 6 digits, preserving leading zeros');
    if (!interactive && (result.id === undefined || result.name === undefined || result.expire === undefined)) throw new Error('Non-interactive add requires code, --name and --expire; no code has been consumed');
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
    if (args.op === 'token-status' || args.op === 'token-enable' || args.op === 'token-disable') {
      client = await connect(home);
      const status = await client.request({ op: 'token-status' }) as { enabled: boolean; devices?: unknown[] };
      if (args.op === 'token-status') { log(`固定 Token 登录: ${status.enabled ? '启用' : '禁用'}\n可信设备: ${Array.isArray(status.devices) ? status.devices.length : 0}`); return 0; }
      log(t('auth.switchWarning'));
      if (args.op === 'token-enable') {
        log('启用固定 Token 登录会增加一个可复用的全局凭据入口，存在泄露风险。');
        if (!interactive || !await ask(confirm({ message: '确认启用固定 Token 登录？', initialValue: false }))) throw canceled;
        await client.request({ op: 'token-enable' }); log('固定 Token 登录已启用。'); return 0;
      }
      const devices = (Array.isArray(status.devices) ? status.devices : []).filter((d) => (d as Record<string, unknown>)?.status === 'active');
      if (devices.length) {
        log(`当前有 ${devices.length} 个可信设备；禁用后只有这些设备可以访问。`);
        devices.forEach(d => log(outputDevice(d)));
        if (!interactive || !await ask(confirm({ message: '确认禁用固定 Token 登录？', initialValue: false }))) throw canceled;
      } else {
        log('当前没有可信设备；禁用后任何设备都无法访问，只能通过 CLI 恢复。');
        if (!interactive || (await ask(text({ message: '请输入 DISABLE TOKEN 以确认' }))) !== 'DISABLE TOKEN') throw canceled;
      }
      await client.request({ op: 'token-disable', allowEmpty: devices.length === 0 }); log('固定 Token 登录已禁用。'); return 0;
    }
    if (args.op !== 'add') {
      client = await connect(home); const result = await client.request(args as unknown as Record<string, unknown>);
      log('ID\tNAME\tSTATUS\tEXPIRES\tADDED\tLAST ACCESS\tBROWSER');
      if (Array.isArray(result)) result.forEach(d => log(outputDevice(d))); else log(outputDevice(result));
      return 0;
    }
    log(t('auth.safety'));
    if (!args.id) args.id = await ask(text({ message: t('auth.code'), validate: v => /^\d{6}$/.test(v ?? '') ? undefined : 'Enter exactly 6 digits' }));
    client = await connect(home);
    const claimed = await client.request({ op: 'claim', code: args.id }) as { id: string; browserSummary: string };
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
