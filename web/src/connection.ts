// Connection-health state machine for the pane poll loop. Pure/DOM-free so it unit-tests on its
// own. `connected === false` drives the disconnect banner. A single failure doesn't trip the
// banner — we wait for `threshold` consecutive failures so a one-off 1s blip doesn't flash it.
export interface TerminalConnectionState {
  failCount: number;
  connected: boolean;
}

export const initialConnection: TerminalConnectionState = { failCount: 0, connected: true };

export function nextConnection(
  state: TerminalConnectionState,
  event: unknown,
  { threshold = 2 }: { threshold?: number } = {},
): TerminalConnectionState {
  switch (event) {
    case 'ok':
    case 'reset':
      return { failCount: 0, connected: true };
    case 'fail': {
      const failCount = state.failCount + 1;
      return { failCount, connected: failCount < threshold };
    }
    default:
      return state;
  }
}
