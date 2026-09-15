import { text, select, confirm, isCancel } from '@clack/prompts';
import { AuthControlError, connectAuthControl } from '../deviceAuth/control.js';
import { DeviceAuthError, parseExpire, validateName } from '../deviceAuth/service.js';
import { tokenWarning } from './authDefaults.js';
import { t } from './i18n/index.js';

type DeviceAction = 'status' | 'on' | 'off' | 'add' | 'list' | 'edit' | 'revoke';
type AddressAction = 'status' | 'on' | 'off' | 'list' | 'add' | 'remove';
const usage = (target?: 'device' | 'address'): string => target === 'device'
  ? 'Usage: handmux auth device status|on|off|add|list|edit|revoke'
  : target === 'address'
    ? 'Usage: handmux auth address status|on|off|list|add|remove'
    : 'Usage: handmux auth device <action> | handmux auth address <action>';
export interface AuthCommand {
  target: 'device' | 'address';
  action: DeviceAction | AddressAction;
  id?: string; code?: string; name?: string; expire?: string; origin?: string;
}

export function parseAuthArgs(argv: readonly string[], interactive: boolean): AuthCommand {
  const [target, action, ...rest] = argv;
  if (target !== 'device' && target !== 'address') {
    throw new Error(usage());
  }
  const deviceActions: readonly DeviceAction[] = ['status', 'on', 'off', 'add', 'list', 'edit', 'revoke'];
  const addressActions: readonly AddressAction[] = ['status', 'on', 'off', 'list', 'add', 'remove'];
  const allowed = target === 'device' ? deviceActions : addressActions;
  if (!action || !allowed.includes(action as never)) throw new Error(usage(target));
  const result: AuthCommand = { target, action: action as AuthCommand['action'] };
  if (target === 'address') {
    if (action === 'add' || action === 'remove') {
      if (rest.length !== 1 || !rest[0]) throw new Error(`Usage: handmux auth address ${action} <origin>`);
      result.origin = rest[0];
    } else if (rest.length) throw new Error(`Usage: handmux auth address ${action}`);
    return result;
  }
  if (['status', 'on', 'off', 'list'].includes(action)) {
    if (rest.length) throw new Error(`Usage: handmux auth device ${action}`);
    return result;
  }
  for (let i = 0; i < rest.length; i++) {
    const arg = rest[i]!;
    if (arg === '--code' || arg === '--name' || arg === '--expire') {
      const key = arg === '--code' ? 'code' : arg === '--name' ? 'name' : 'expire';
      const value = rest[++i];
      if (!value || value.startsWith('--') || result[key] !== undefined) throw new Error(`Provide ${arg} exactly once with a value`);
      result[key] = value;
    } else if (arg.startsWith('-') || result.id !== undefined) throw new Error(`Unexpected argument: ${arg}`);
    else if (action === 'add') throw new Error('Use --code for non-interactive add; interactive add reads the code after handmux auth device add');
    else result.id = arg;
  }
  if (action === 'list' && (result.id || result.code || result.name !== undefined || result.expire !== undefined)) throw new Error('Usage: handmux auth device list');
  if (action !== 'add' && result.code !== undefined) throw new Error('The --code flag is only valid for handmux auth device add');
  if (action === 'revoke' && (result.name !== undefined || result.expire !== undefined)) throw new Error('Usage: handmux auth device revoke <device-id>');
  if ((action === 'edit' || action === 'revoke') && !result.id) throw new Error('Provide the exact device ID from handmux auth device list');
  if (action === 'edit' && result.name === undefined && result.expire === undefined) throw new Error('Provide --name or --expire');
  if (result.name !== undefined) result.name = validateName(result.name);
  if (result.expire !== undefined) parseExpire(result.expire);
  if (action === 'add') {
    if (result.code !== undefined && !/^\d{6}$/.test(result.code)) throw new Error('Code must be exactly 6 digits, preserving leading zeros');
    if (!interactive && (result.code === undefined || result.name === undefined || result.expire === undefined)) throw new Error('Non-interactive add requires --code, --name and --expire; no code has been consumed');
  }
  return result;
}

const safeText = (value: unknown): string => String(value ?? '').replace(/[\x00-\x1f\x7f-\x9f]/g, '');
const controlErrorCopy: Record<string, string> = {
  AUTH_UNAVAILABLE: 'auth.error.unavailable', INVALID_COMMAND: 'auth.error.invalidCommand',
  CODE_INVALID: 'auth.error.codeInvalid', CLAIM_RATE_LIMIT: 'auth.error.rateLimit',
  PAIRING_NOT_FOUND: 'auth.error.pairingGone', PAIRING_INACTIVE: 'auth.error.pairingGone',
  DEVICE_NOT_FOUND: 'auth.error.deviceNotFound', DEVICE_INACTIVE: 'auth.error.deviceInactive',
  DEVICE_CONFLICT: 'auth.error.conflict', INVALID_EDIT: 'auth.error.invalidEdit',
  INVALID_VERSION: 'auth.error.invalidVersion', PAIRING_CAPACITY: 'auth.error.pairingCapacity',
  TOKEN_REQUIRED: 'auth.error.tokenRequired', DEVICE_REQUIRED: 'auth.error.deviceRequired',
  DEVICE_EXPIRY_CLI_ONLY: 'auth.error.expiryCliOnly',
  INVALID_EXPIRE: 'auth.invalidDuration', INVALID_NAME: 'auth.invalidName',
  INVALID_ORIGIN: 'auth.error.invalidOrigin', ORIGIN_LIMIT: 'auth.error.originLimit',
  SESSION_INVALID: 'auth.error.sessionInvalid', DEVICE_AUTH_DISABLED: 'auth.error.unavailable',
};
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
    client = await connect(home);
    if (args.target === 'address') {
      if (args.action === 'status' || args.action === 'list') {
        const result = await client.request({ op: 'address-status' }) as { enabled: boolean; origins: string[] };
        log(`访问地址限制: ${result.enabled ? '已开启' : '未开启'}`);
        if (!result.enabled) log(tokenWarning(t('auth.addressWarning')));
        result.origins.forEach(origin => log(origin)); return 0;
      }
      if (args.action === 'on' || args.action === 'off') {
        if (args.action === 'off' && interactive && !await ask(confirm({ message: t('auth.addressDisableConfirm'), initialValue: false }))) throw canceled;
        const result = await client.request({ op: 'address-policy', enabled: args.action === 'on' }) as { enabled: boolean };
        log(`访问地址限制: ${result.enabled ? '已开启' : '未开启'}`); return 0;
      }
      const result = await client.request({ op: args.action === 'add' ? 'address-add' : 'address-remove', origin: args.origin }) as { origins: string[] };
      log(`访问地址: ${args.action === 'add' ? '已添加' : '已删除'}`); result.origins.forEach(origin => log(origin)); return 0;
    }
    if (args.action === 'status') {
      const result = await client.request({ op: 'device-status' }) as { enabled: boolean; devices: unknown[] };
      log(`可信设备保护: ${result.enabled ? '已开启' : '未开启'}`);
      if (!result.enabled) log(tokenWarning(t('auth.warning')));
      log('ID\tNAME\tSTATUS\tEXPIRES\tADDED\tLAST ACCESS\tBROWSER'); result.devices.forEach(d => log(outputDevice(d))); return 0;
    }
    if (args.action === 'on' || args.action === 'off') {
      if (args.action === 'off' && interactive && !await ask(confirm({ message: t('auth.deviceDisableConfirm'), initialValue: false }))) throw canceled;
      const result = await client.request({ op: 'device-policy', enabled: args.action === 'on' }) as { enabled: boolean };
      log(`可信设备保护: ${result.enabled ? '已开启' : '未开启'}`); return 0;
    }
    if (args.action === 'list') {
      const result = await client.request({ op: 'device-list' }) as unknown[];
      log('ID\tNAME\tSTATUS\tEXPIRES\tADDED\tLAST ACCESS\tBROWSER'); result.forEach(d => log(outputDevice(d))); return 0;
    }
    if (args.action !== 'add') {
      const result = await client.request({ op: `device-${args.action}`, id: args.id, name: args.name, expire: args.expire });
      log('ID\tNAME\tSTATUS\tEXPIRES\tADDED\tLAST ACCESS\tBROWSER'); log(outputDevice(result)); return 0;
    }
    log(t('auth.safety'));
    if (!args.code) args.code = await ask(text({ message: t('auth.code'), validate: v => /^\d{6}$/.test(v ?? '') ? undefined : t('auth.codeInvalid') }));
    const claimed = await client.request({ op: 'claim', code: args.code }) as { id: string; browserSummary: string; origin?: string };
    const needsPrompt = args.name === undefined || args.expire === undefined;
    log(t('auth.claimed')); log(safeText(claimed.browserSummary));
    if (claimed.origin) log(`${t('auth.origin')}: ${safeText(claimed.origin)}`);
    if (args.name === undefined) {
      const fallback = safeText(claimed.browserSummary).slice(0, 80) || 'Browser';
      args.name = await ask(text({ message: t('auth.name'), defaultValue: fallback, placeholder: fallback, validate: v => { try { validateName(v || fallback); } catch (e) { return e instanceof DeviceAuthError && e.code === 'INVALID_NAME' ? t('auth.invalidName') : (e as Error).message; } return undefined; } }));
      args.name = args.name || fallback;
    }
    if (args.expire === undefined) {
      const expire = await ask(select({ message: t('auth.expire'), initialValue: '30d', options: [
        ...['1h', '1d', '7d', '30d'].map(value => ({ value, label: value })),
        { value: 'custom', label: t('auth.custom') }, { value: 'never', label: t('auth.never') },
      ] }));
      args.expire = expire === 'custom' ? await ask(text({ message: t('auth.duration'), validate: v => { try { parseExpire(v); } catch (e) { return e instanceof DeviceAuthError && e.code === 'INVALID_EXPIRE' ? t('auth.invalidDuration') : (e as Error).message; } return undefined; } })) : expire;
    }
    if (needsPrompt && !await ask(confirm({ message: t('auth.confirm'), initialValue: true }))) throw canceled;
    const result = await client.request({ op: 'authorize', id: claimed.id, name: args.name, expire: args.expire });
    log('ID\tNAME\tSTATUS\tEXPIRES\tADDED\tLAST ACCESS\tBROWSER'); log(outputDevice(result)); return 0;
  } catch (error) {
    if (error === canceled) err(t('auth.canceled'));
    else if (error instanceof AuthControlError || error instanceof DeviceAuthError) {
      err(t(controlErrorCopy[error.code] ?? 'auth.error.controlFailed'));
    }
    else err(error instanceof Error ? safeText(error.message) : t('auth.error.controlFailed'));
    return 1;
  } finally { client?.close(); }
}
