import { spawn as spawnChild } from 'node:child_process';

export const RAW_AGENT_SLUGS = ['codex', 'pi'] as const;
export type RawAgentSlug = typeof RAW_AGENT_SLUGS[number];

export interface RawAgentInvocation {
  slug: RawAgentSlug;
  args: string[];
}

export interface AgentChild {
  once(event: 'error', listener: (error: unknown) => void): unknown;
  once(
    event: 'exit',
    listener: (code: number | null, signal: NodeJS.Signals | null) => void,
  ): unknown;
}

export interface AgentLaunchResult {
  code: number | null;
  signal: NodeJS.Signals | null;
}

export type AgentSpawn = (
  command: string,
  args: readonly string[],
  options: {
    cwd: string;
    env: NodeJS.ProcessEnv;
    stdio: 'inherit';
  },
) => AgentChild;

const RAW_AGENT_SET: ReadonlySet<string> = new Set(RAW_AGENT_SLUGS);

// Only explicit built-in launchers get the raw-argv fast path. Unknown first tokens remain Handmux
// commands (and therefore fall through to help) instead of becoming an arbitrary executable surface.
export function rawAgentInvocation(argv: readonly string[]): RawAgentInvocation | null {
  const slug = argv[0];
  if (!slug || !RAW_AGENT_SET.has(slug)) return null;
  return { slug: slug as RawAgentSlug, args: argv.slice(1) };
}

// Launch a plain Agent without interpreting any of its arguments. cwd/env/stdio are stated explicitly
// here because they are part of the public launcher contract, even though Node's defaults overlap.
export function launchRawAgent(
  slug: Exclude<RawAgentSlug, 'codex'>,
  args: readonly string[],
  {
    cwd = process.cwd(),
    env = process.env,
    spawn = spawnChild as unknown as AgentSpawn,
  }: {
    cwd?: string;
    env?: NodeJS.ProcessEnv;
    spawn?: AgentSpawn;
  } = {},
): Promise<AgentLaunchResult> {
  return new Promise((resolve, reject) => {
    const child = spawn(slug, args, { cwd, env, stdio: 'inherit' });
    child.once('error', reject);
    child.once('exit', (code, signal) => resolve({ code, signal }));
  });
}

export function launchErrorCode(error: unknown): string | null {
  if (typeof error !== 'object' || error === null || !('code' in error)) return null;
  const code = (error as { code?: unknown }).code;
  return typeof code === 'string' ? code : null;
}
