export type ProviderType = 'deepseek' | 'moonshot';
export const providerTypes = ['deepseek', 'moonshot'] as const;
export function isProviderType(value: unknown): value is ProviderType {
  return typeof value === 'string' && (providerTypes as readonly string[]).includes(value);
}
export type ProviderErrorCode = 'invalid_credential' | 'rate_limited' | 'provider_timeout'
  | 'provider_unreachable' | 'unsupported_response';

export interface StoredCredential { kind: 'apiKey'; value: string }

export interface DeepSeekBalanceResult {
  providerType: 'deepseek';
  isAvailable: boolean;
  balances: Array<{
    currency: string;
    totalBalance: string;
    toppedUpBalance: string;
    grantedBalance: string;
  }>;
}

export interface MoonshotBalanceResult {
  providerType: 'moonshot';
  currency: 'CNY';
  availableBalance: number;
  voucherBalance: number;
  cashBalance: number;
}

export type ProviderResult = DeepSeekBalanceResult | MoonshotBalanceResult;

export class ProviderQueryError extends Error {
  readonly code: ProviderErrorCode;
  readonly retryAfterSeconds?: number;
  constructor(code: ProviderErrorCode, retryAfterSeconds?: number) {
    super(code);
    this.name = 'ProviderQueryError';
    this.code = code;
    if (retryAfterSeconds !== undefined) this.retryAfterSeconds = retryAfterSeconds;
  }
}

export interface ProviderDefinition<T extends ProviderType = ProviderType> {
  type: T;
  label: string;
  queryBalance(credential: StoredCredential, signal: AbortSignal): Promise<ProviderResult>;
}

const DECIMAL = /^\d{1,128}(?:\.\d{1,128})?$/;
const MAX_RESPONSE_BYTES = 64 * 1024;
const MAX_MOONSHOT_BALANCE = 1_000_000_000_000_000;

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function hasExactKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
  const actual = Object.keys(value).sort();
  const expected = [...keys].sort();
  return actual.length === expected.length && actual.every((key, index) => key === expected[index]);
}

async function boundedResponseText(response: Response): Promise<string> {
  const declared = Number(response.headers.get('content-length'));
  if (Number.isFinite(declared) && declared > MAX_RESPONSE_BYTES) throw new ProviderQueryError('unsupported_response');
  if (!response.body) return '';
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > MAX_RESPONSE_BYTES) {
      await reader.cancel();
      throw new ProviderQueryError('unsupported_response');
    }
    chunks.push(value);
  }
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
  return new TextDecoder().decode(bytes);
}

function decimalString(value: unknown): value is string {
  return typeof value === 'string' && DECIMAL.test(value);
}

function boundedAmount(value: unknown, allowNegative = false): value is number {
  return typeof value === 'number' && Number.isFinite(value) && Math.abs(value) <= MAX_MOONSHOT_BALANCE
    && (allowNegative || value >= 0);
}

function parseDeepSeekBalance(value: unknown): DeepSeekBalanceResult {
  if (!isRecord(value) || typeof value.is_available !== 'boolean'
    || !Array.isArray(value.balance_infos) || value.balance_infos.length > 32) {
    throw new ProviderQueryError('unsupported_response');
  }
  const balances = value.balance_infos.map((candidate) => {
    if (!isRecord(candidate)
      || !hasExactKeys(candidate, ['currency', 'total_balance', 'topped_up_balance', 'granted_balance'])
      || typeof candidate.currency !== 'string'
      || candidate.currency.length < 1 || candidate.currency.length > 32
      || !decimalString(candidate.total_balance)
      || !decimalString(candidate.topped_up_balance)
      || !decimalString(candidate.granted_balance)) {
      throw new ProviderQueryError('unsupported_response');
    }
    return {
      currency: candidate.currency,
      totalBalance: candidate.total_balance,
      toppedUpBalance: candidate.topped_up_balance,
      grantedBalance: candidate.granted_balance,
    };
  });
  return { providerType: 'deepseek', isAvailable: value.is_available, balances };
}

function parseMoonshotBalance(value: unknown): MoonshotBalanceResult {
  if (!isRecord(value) || !hasExactKeys(value, ['code', 'data', 'scode', 'status'])
    || value.code !== 0 || value.status !== true || typeof value.scode !== 'string') {
    throw new ProviderQueryError('unsupported_response');
  }
  const data = value.data;
  if (!isRecord(data) || !hasExactKeys(data, ['available_balance', 'voucher_balance', 'cash_balance'])
    || !boundedAmount(data.available_balance) || !boundedAmount(data.voucher_balance)
    || !boundedAmount(data.cash_balance, true)) {
    throw new ProviderQueryError('unsupported_response');
  }
  return {
    providerType: 'moonshot', currency: 'CNY',
    availableBalance: data.available_balance,
    voucherBalance: data.voucher_balance,
    cashBalance: data.cash_balance,
  };
}

function createApiKeyProvider<T extends ProviderType>({
  type, label, endpoint, parse, fetchImpl,
}: {
  type: T;
  label: string;
  endpoint: string;
  parse: (value: unknown) => ProviderResult;
  fetchImpl: typeof fetch;
}): ProviderDefinition<T> {
  return {
    type, label,
    async queryBalance(credential, signal) {
      let response: Response;
      try {
        response = await fetchImpl(endpoint, {
          method: 'GET', signal,
          headers: { Accept: 'application/json', Authorization: `Bearer ${credential.value}` },
        });
      } catch (error) {
        if (signal.aborted || (error instanceof Error && error.name === 'AbortError')) {
          throw new ProviderQueryError('provider_timeout');
        }
        throw new ProviderQueryError('provider_unreachable');
      }
      if (response.status === 401 || response.status === 403) throw new ProviderQueryError('invalid_credential');
      if (response.status === 429) {
        const raw = Number(response.headers.get('retry-after'));
        throw new ProviderQueryError('rate_limited', Number.isFinite(raw) && raw > 0 ? Math.ceil(raw) : undefined);
      }
      if (!response.ok) throw new ProviderQueryError('provider_unreachable');
      const text = await boundedResponseText(response);
      let parsed: unknown;
      try { parsed = JSON.parse(text); } catch { throw new ProviderQueryError('unsupported_response'); }
      return parse(parsed);
    },
  };
}

export function createDeepSeekProvider(fetchImpl: typeof fetch = fetch): ProviderDefinition<'deepseek'> {
  return createApiKeyProvider({
    type: 'deepseek', label: 'DeepSeek', endpoint: 'https://api.deepseek.com/user/balance',
    parse: parseDeepSeekBalance, fetchImpl,
  });
}

export function createMoonshotProvider(fetchImpl: typeof fetch = fetch): ProviderDefinition<'moonshot'> {
  return createApiKeyProvider({
    type: 'moonshot', label: 'Moonshot (Kimi)', endpoint: 'https://api.moonshot.cn/v1/users/me/balance',
    parse: parseMoonshotBalance, fetchImpl,
  });
}

export const builtInApiAccountProviders = (): ProviderDefinition[] => [
  createDeepSeekProvider(), createMoonshotProvider(),
];

function validDeepSeekResult(value: Record<string, unknown>): boolean {
  return hasExactKeys(value, ['providerType', 'isAvailable', 'balances'])
    && value.providerType === 'deepseek' && typeof value.isAvailable === 'boolean'
    && Array.isArray(value.balances) && value.balances.length <= 32
    && value.balances.every((balance) => isRecord(balance)
      && hasExactKeys(balance, ['currency', 'totalBalance', 'toppedUpBalance', 'grantedBalance'])
      && typeof balance.currency === 'string' && balance.currency.length >= 1 && balance.currency.length <= 32
      && decimalString(balance.totalBalance) && decimalString(balance.toppedUpBalance)
      && decimalString(balance.grantedBalance));
}

function validMoonshotResult(value: Record<string, unknown>): boolean {
  return hasExactKeys(value, [
    'providerType', 'currency', 'availableBalance', 'voucherBalance', 'cashBalance',
  ]) && value.providerType === 'moonshot' && value.currency === 'CNY'
    && boundedAmount(value.availableBalance) && boundedAmount(value.voucherBalance)
    && boundedAmount(value.cashBalance, true);
}

export function validProviderResult(value: unknown, providerType?: ProviderType): value is ProviderResult {
  if (!isRecord(value)) return false;
  const valid = value.providerType === 'deepseek' ? validDeepSeekResult(value)
    : value.providerType === 'moonshot' ? validMoonshotResult(value) : false;
  return valid && (providerType === undefined || value.providerType === providerType);
}

export function publicProviderResult(result: ProviderResult): ProviderResult {
  switch (result.providerType) {
    case 'deepseek': return {
      providerType: 'deepseek', isAvailable: result.isAvailable,
      balances: result.balances.map((balance) => ({
        currency: balance.currency, totalBalance: balance.totalBalance,
        toppedUpBalance: balance.toppedUpBalance, grantedBalance: balance.grantedBalance,
      })),
    };
    case 'moonshot': return {
      providerType: 'moonshot', currency: 'CNY', availableBalance: result.availableBalance,
      voucherBalance: result.voucherBalance, cashBalance: result.cashBalance,
    };
  }
}
