export interface BrowserSessionInput extends Record<string, unknown> {
  id: string;
  mode?: 'direct' | 'proxy';
}
export interface BrowserSession extends Record<string, unknown> {
  id: string;
  mode: 'direct' | 'proxy';
  visible: boolean;
  hiddenAt: number | null;
  expiresAt: number | null;
}
type TimerHandle = ReturnType<typeof setTimeout> | number;
interface StoredBrowserSession extends BrowserSession { timer: TimerHandle | null }
type SetTimer = (callback: () => void, delay: number) => TimerHandle;
type ClearTimer = (timer: TimerHandle) => void;

export function createBrowserSessionStore({
  now = Date.now,
  setTimer = setTimeout,
  clearTimer = clearTimeout,
  onExpire = () => {},
}: {
  now?: () => number;
  setTimer?: SetTimer;
  clearTimer?: ClearTimer;
  onExpire?: (tab: BrowserSession, reason: 'expired') => unknown;
} = {}) {
  const tabs = new Map<string, StoredBrowserSession>();

  const cancel = (tab: StoredBrowserSession): void => {
    if (tab.timer != null) clearTimer(tab.timer);
    tab.timer = null;
    tab.hiddenAt = null;
    tab.expiresAt = null;
  };

  const remove = (id: string): BrowserSession | null => {
    const tab = tabs.get(id);
    if (!tab) return null;
    if (tab.timer != null) clearTimer(tab.timer);
    tabs.delete(id);
    const { timer: _timer, ...out } = tab;
    return out;
  };

  const view = (tab: StoredBrowserSession | undefined): BrowserSession | null => {
    if (!tab) return null;
    const { timer: _timer, ...out } = tab;
    return out;
  };

  return {
    add(input: BrowserSessionInput): BrowserSession {
      if (tabs.has(input.id)) throw new Error(`browser tab already exists: ${input.id}`);
      const mode = input.mode === 'direct' ? 'direct' : 'proxy';
      const tab: StoredBrowserSession = { ...input, mode, visible: true, hiddenAt: null, expiresAt: null, timer: null };
      tabs.set(tab.id, tab);
      return view(tab) as BrowserSession;
    },

    get(id: string): BrowserSession | null { return view(tabs.get(id)); },

    list(): BrowserSession[] { return [...tabs.values()].map((tab) => view(tab) as BrowserSession); },

    update(id: string, patch: Partial<BrowserSession>): BrowserSession | null {
      const tab = tabs.get(id);
      if (!tab) return null;
      Object.assign(tab, patch);
      return view(tab);
    },

    setVisible(id: string, visible: unknown, closeAfterMinutes: number | null): BrowserSession | null {
      const tab = tabs.get(id);
      if (!tab) return null;
      cancel(tab);
      tab.visible = !!visible;
      if (!tab.visible) {
        tab.hiddenAt = now();
        if (closeAfterMinutes != null) {
          const delay = closeAfterMinutes * 60_000;
          tab.expiresAt = tab.hiddenAt + delay;
          tab.timer = setTimer(() => {
            const expired = remove(id);
            if (expired) onExpire(expired, 'expired');
          }, delay);
        }
      }
      return view(tab);
    },

    remove,

    close(): Array<BrowserSession | null> {
      const removed: Array<BrowserSession | null> = [];
      for (const id of [...tabs.keys()]) removed.push(remove(id));
      return removed;
    },
  };
}
