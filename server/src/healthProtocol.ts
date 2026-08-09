const SUBSYSTEM_NAMES = ['workspace', 'codex', 'browser'] as const;
const SUBSYSTEM_STATUSES = ['starting', 'ready', 'degraded', 'disabled'] as const;
const READY_STATUSES = ['starting', 'ready', 'degraded'] as const;

export type HealthSubsystemName = (typeof SUBSYSTEM_NAMES)[number];
export type HealthSubsystemStatus = (typeof SUBSYSTEM_STATUSES)[number];
export type HealthReadyStatus = (typeof READY_STATUSES)[number];

export interface HealthSubsystem {
  status: HealthSubsystemStatus;
  required: boolean;
  detail: string | null;
}

export interface HealthReadySnapshot {
  status: HealthReadyStatus;
  ready: boolean;
  checkedAt: number;
  subsystems: Record<HealthSubsystemName, HealthSubsystem>;
}

export interface HealthLiveSnapshot {
  status: 'live';
  live: true;
  checkedAt: number;
}

function recordOf(value: unknown): Record<string, unknown> | null {
  return value != null && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function parseSubsystem(value: unknown): HealthSubsystem | null {
  const record = recordOf(value);
  if (!record || !SUBSYSTEM_STATUSES.includes(record.status as HealthSubsystemStatus)
    || typeof record.required !== 'boolean'
    || (record.detail !== null && (typeof record.detail !== 'string' || !record.detail))) return null;
  if (record.required && record.status === 'disabled') return null;
  return {
    status: record.status as HealthSubsystemStatus,
    required: record.required,
    detail: record.detail as string | null,
  };
}

export function parseHealthReadySnapshot(value: unknown): HealthReadySnapshot | null {
  const record = recordOf(value);
  const subsystemsValue = recordOf(record?.subsystems);
  if (!record || !subsystemsValue || !READY_STATUSES.includes(record.status as HealthReadyStatus)
    || typeof record.ready !== 'boolean' || typeof record.checkedAt !== 'number'
    || !Number.isFinite(record.checkedAt)) return null;
  const entries = SUBSYSTEM_NAMES.map((name) => [name, parseSubsystem(subsystemsValue[name])] as const);
  if (entries.some(([, subsystem]) => !subsystem)) return null;
  const subsystems = Object.fromEntries(entries) as Record<HealthSubsystemName, HealthSubsystem>;
  const computedReady = Object.values(subsystems)
    .every((subsystem) => !subsystem.required || subsystem.status === 'ready');
  if (computedReady !== record.ready) return null;
  const requiredDegraded = Object.values(subsystems)
    .some((subsystem) => subsystem.required && subsystem.status === 'degraded');
  const anyDegraded = Object.values(subsystems).some((subsystem) => subsystem.status === 'degraded');
  const computedStatus: HealthReadyStatus = computedReady
    ? (anyDegraded ? 'degraded' : 'ready')
    : (requiredDegraded ? 'degraded' : 'starting');
  if (computedStatus !== record.status) return null;
  return {
    status: computedStatus,
    ready: computedReady,
    checkedAt: record.checkedAt,
    subsystems,
  };
}

export function parseHealthLiveSnapshot(value: unknown): HealthLiveSnapshot | null {
  const record = recordOf(value);
  return record?.status === 'live' && record.live === true
    && typeof record.checkedAt === 'number' && Number.isFinite(record.checkedAt)
    ? { status: 'live', live: true, checkedAt: record.checkedAt }
    : null;
}

export class RuntimeHealth {
  readonly #subsystems: Record<HealthSubsystemName, HealthSubsystem>;
  readonly #now: () => number;

  constructor({ browserRequired = false, now = Date.now } = {}) {
    this.#now = now;
    this.#subsystems = {
      workspace: { status: 'starting', required: true, detail: null },
      codex: { status: 'starting', required: true, detail: null },
      browser: browserRequired
        ? { status: 'starting', required: true, detail: null }
        : { status: 'disabled', required: false, detail: null },
    };
  }

  set(name: HealthSubsystemName, status: HealthSubsystemStatus, detail: string | null = null): void {
    if (!SUBSYSTEM_NAMES.includes(name) || !SUBSYSTEM_STATUSES.includes(status)
      || (detail !== null && !detail)) throw new Error('invalid health subsystem state');
    const current = this.#subsystems[name];
    if (current.required && status === 'disabled') throw new Error(`${name} is required`);
    this.#subsystems[name] = { status, required: current.required, detail };
  }

  live(): HealthLiveSnapshot {
    return { status: 'live', live: true, checkedAt: this.#now() };
  }

  snapshot(): HealthReadySnapshot {
    const subsystems = structuredClone(this.#subsystems);
    const ready = Object.values(subsystems)
      .every((subsystem) => !subsystem.required || subsystem.status === 'ready');
    const requiredDegraded = Object.values(subsystems)
      .some((subsystem) => subsystem.required && subsystem.status === 'degraded');
    const anyDegraded = Object.values(subsystems).some((subsystem) => subsystem.status === 'degraded');
    const status: HealthReadyStatus = ready
      ? (anyDegraded ? 'degraded' : 'ready')
      : (requiredDegraded ? 'degraded' : 'starting');
    return { status, ready, checkedAt: this.#now(), subsystems };
  }
}
