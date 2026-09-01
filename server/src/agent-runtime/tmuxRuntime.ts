import { executablePath } from '../agents/processIdentity.js';
import { defaultRun, etimeToMs, normTty } from '../agents/scanUtils.js';
import type { RunCommand } from '../agents/scanUtils.js';
import type {
  ForegroundProcessIdentity,
  LivePane,
  ProcessContext,
  ReadonlyPaneSource,
} from './adapter.js';

interface TmuxLivePane {
  id: string;
  cmd: string;
  tty: string;
  session: string;
  window: string;
  windowName: string;
}

export interface AgentTmuxCommands {
  listLivePanes(): Promise<TmuxLivePane[]>;
}

export interface TmuxAgentPaneSourceOptions {
  commands: AgentTmuxCommands;
  pollMs?: number;
}

function pane(value: TmuxLivePane): LivePane {
  return {
    paneId: value.id,
    sessionName: value.session,
    windowId: value.window,
    windowName: value.windowName,
    currentCommand: value.cmd,
    ...(value.tty ? { tty: value.tty } : {}),
  };
}

// Tmux has no lifecycle subscription. One shared, non-overlapping poller publishes complete snapshots;
// an unavailable tmux command preserves the last trusted snapshot instead of fabricating process exits.
export class TmuxAgentPaneSource implements ReadonlyPaneSource {
  readonly #commands: AgentTmuxCommands;
  readonly #pollMs: number;
  readonly #listeners = new Set<(snapshot: readonly LivePane[]) => void>();
  #timer: NodeJS.Timeout | undefined;
  #signature = '';
  #polling = false;

  constructor({ commands, pollMs = 1_000 }: TmuxAgentPaneSourceOptions) {
    if (!commands || typeof commands.listLivePanes !== 'function'
      || !Number.isSafeInteger(pollMs) || pollMs < 100) {
      throw new TypeError('Tmux Agent pane source requires commands and a bounded poll interval');
    }
    this.#commands = commands;
    this.#pollMs = pollMs;
  }

  async list(): Promise<readonly LivePane[]> {
    return (await this.#commands.listLivePanes()).map(pane);
  }

  subscribe(listener: (snapshot: readonly LivePane[]) => void): () => void {
    if (typeof listener !== 'function') throw new TypeError('Agent pane listener must be a function');
    this.#listeners.add(listener);
    if (this.#listeners.size === 1) {
      this.#poll();
      this.#timer = setInterval(() => this.#poll(), this.#pollMs);
      this.#timer.unref?.();
    }
    return () => {
      this.#listeners.delete(listener);
      if (!this.#listeners.size && this.#timer) {
        clearInterval(this.#timer);
        this.#timer = undefined;
      }
    };
  }

  #poll(): void {
    if (this.#polling) return;
    this.#polling = true;
    void (async () => {
      let snapshot: readonly LivePane[];
      try { snapshot = await this.list(); } catch { return; }
      const signature = JSON.stringify(snapshot);
      if (signature === this.#signature) return;
      this.#signature = signature;
      for (const listener of this.#listeners) listener(structuredClone(snapshot));
    })().finally(() => {
      this.#polling = false;
    }).catch(() => {});
  }
}

interface ForegroundRow {
  pid: number;
  ppid: number;
  stat: string;
  elapsedMs: number;
  tty: string;
  command: string;
}

const AMBIGUOUS_LAUNCHERS = new Set(['node', 'python', 'python3', 'java']);

function foregroundRows(value: unknown): ForegroundRow[] {
  const rows: ForegroundRow[] = [];
  for (const line of String(value).split('\n')) {
    const match = line.match(/^\s*(\d+)\s+(\d+)\s+(\S+)\s+(\S+)\s+(\S+)(?:\s+(.*))?$/);
    if (!match) continue;
    const [, rawPid, rawPpid, stat, elapsed, tty, command = ''] = match;
    const pid = Number(rawPid);
    const ppid = Number(rawPpid);
    if (!Number.isSafeInteger(pid) || pid <= 0 || !Number.isSafeInteger(ppid) || ppid < 0
      || !stat || !elapsed || !tty
      || !stat.includes('+') || stat.startsWith('T') || stat.startsWith('Z')) continue;
    rows.push({ pid, ppid, stat, elapsedMs: etimeToMs(elapsed), tty: normTty(tty), command });
  }
  return rows;
}

function commandName(command: string): string {
  const token = command.trim().split(/\s+/, 1)[0]?.replace(/^-/, '') ?? '';
  return token.split('/').at(-1) ?? '';
}

function foregroundLeaf(
  rows: readonly ForegroundRow[],
  tty: string,
  paneCommand: string,
): ForegroundRow | null {
  const all = rows.filter((row) => row.tty === tty);
  const exact = AMBIGUOUS_LAUNCHERS.has(paneCommand) ? []
    : all.filter((row) => commandName(row.command) === paneCommand);
  // Exact pane commands identify their stable owner directly (for example Claude), so descendants running
  // tools must not displace them. Ambiguous launchers such as Node need a real child executable instead.
  // Prefer the longest-lived non-launcher in that foreground tree: the Agent process starts before any
  // transient tool/code-mode child, while a shallow-depth tie handles children spawned in the same second.
  // Selecting the deepest leaf here made managed Codex flicker out whenever such a child became foreground.
  const nonLaunchers = all.filter((row) => !AMBIGUOUS_LAUNCHERS.has(commandName(row.command)));
  const candidates = exact.length ? exact : (nonLaunchers.length ? nonLaunchers : all);
  if (!candidates.length) return null;
  const byPid = new Map(candidates.map((row) => [row.pid, row]));
  const parents = new Set(candidates.map((row) => row.ppid));
  const depth = (row: ForegroundRow): number => {
    let value = 0;
    let current: ForegroundRow | undefined = row;
    const visited = new Set<number>();
    while (current && !visited.has(current.pid)) {
      visited.add(current.pid);
      current = byPid.get(current.ppid);
      if (current) value += 1;
    }
    return value;
  };
  const leaves = candidates.filter((row) => !parents.has(row.pid));
  if (exact.length) {
    return (leaves.length ? leaves : candidates)
      .sort((first, second) => depth(second) - depth(first) || second.pid - first.pid)[0] ?? null;
  }
  return [...candidates]
    .sort((first, second) => second.elapsedMs - first.elapsedMs
      || depth(first) - depth(second) || second.pid - first.pid)[0] ?? null;
}

export function createLocalAgentProcessContext({
  run = defaultRun,
}: {
  run?: RunCommand;
} = {}): ProcessContext {
  return {
    async inspectForeground(pane: LivePane): Promise<ForegroundProcessIdentity | null> {
      const tty = normTty(pane.tty);
      if (!tty) return null;
      let output = await run('ps', ['-t', tty, '-o', 'pid=,ppid=,stat=,etime=,tty=,command=']);
      if (!String(output).trim()) {
        output = await run('ps', ['-Ao', 'pid=,ppid=,stat=,etime=,tty=,command=']);
      }
      const row = foregroundLeaf(foregroundRows(output), tty, pane.currentCommand);
      if (!row) return null;
      const rawStartedAt = String(await run('ps', ['-p', String(row.pid), '-o', 'lstart='])).trim();
      const parsedStartedAt = Date.parse(rawStartedAt);
      const executable = await executablePath(run, row.pid);
      return {
        pid: row.pid,
        ...(Number.isFinite(parsedStartedAt) ? { startedAt: parsedStartedAt } : {}),
        tty: pane.tty ?? `/dev/${tty}`,
        ...(executable ? { executable } : {}),
        ...(row.command ? { commandLine: row.command } : {}),
      };
    },
  };
}
