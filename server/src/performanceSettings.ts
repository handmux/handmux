// Performance settings shared by the CLI (config.json, flags, HANDMUX_* env) and the server, which reads
// them from the env the supervisor injects. A server started without the supervisor gets the defaults.
//
//   codebuddy    Run the CodeBuddy integration: its Runtime adapter and its Hook Bridge, a 250ms poller
//                that probes every pane for a CodeBuddy process. `false` skips both.
//   paneCacheMs  How old the pane list shared by the background Inbox pollers may be. `0` (the default)
//                makes them read tmux on every poll; higher values delay noticing a new or closed pane.
export const DEFAULT_CODEBUDDY = true;
export const DEFAULT_PANE_CACHE_MS = 0;
export const MAX_PANE_CACHE_MS = 5_000;

export interface PerformanceSettings {
  codebuddy: boolean;
  paneCacheMs: number;
}

// Flags and env vars carry booleans as text (`--codebuddy false`, HANDMUX_CODEBUDDY=0).
export function parseBooleanSetting(value: unknown, name: string): boolean {
  if (value === true || value === 'true' || value === '1') return true;
  if (value === false || value === 'false' || value === '0') return false;
  throw new Error(`bad ${name}: expected true or false`);
}

export function parsePaneCacheMs(value: unknown): number {
  const number = typeof value === 'string' && value.trim() !== '' ? Number(value) : value;
  if (typeof number !== 'number' || !Number.isInteger(number) || number < 0 || number > MAX_PANE_CACHE_MS) {
    throw new Error(`bad pane-cache-ms: expected an integer from 0 to ${MAX_PANE_CACHE_MS}`);
  }
  return number;
}

// An unset value (a server started by hand) gets the default; an invalid one gets it with a warning.
export function performanceSettingsFromEnv(
  env: NodeJS.ProcessEnv,
  warn: (message: string) => void = () => {},
): PerformanceSettings {
  const read = <T>(key: string, parse: (raw: string) => T, fallback: T): T => {
    const raw = env[key];
    if (raw === undefined || raw === '') return fallback;
    try { return parse(raw); } catch (error) {
      warn(`Ignoring ${key}=${raw} (${error instanceof Error ? error.message : String(error)}); using ${String(fallback)}`);
      return fallback;
    }
  };
  return {
    codebuddy: read('HANDMUX_CODEBUDDY', (raw) => parseBooleanSetting(raw, 'codebuddy'), DEFAULT_CODEBUDDY),
    paneCacheMs: read('HANDMUX_PANE_CACHE_MS', parsePaneCacheMs, DEFAULT_PANE_CACHE_MS),
  };
}
