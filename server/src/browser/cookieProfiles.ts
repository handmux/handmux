const MUTATION_METHODS = ['setByServer', 'setByClient', 'setCookies', 'deleteCookies'];
const DAY = 24 * 60 * 60 * 1000;
const MAX_TIMER_DELAY = 2_147_483_647;

type RetentionDays = 1 | 7 | 30 | null;
interface ProfilePreferences { persist: boolean; retentionDays: RetentionDays }
interface ProfileMetadata extends ProfilePreferences { noLeaseSince: number | null }
interface InternalCookie {
  domain?: string;
  hostOnly?: boolean;
  expires?: unknown;
  maxAge?: unknown;
  sameSite?: unknown;
}
interface ExternalCookie {
  expires?: unknown;
  maxAge?: unknown;
  sameSite?: unknown;
  [key: string]: unknown;
}
export interface CookieContainer extends Record<string, unknown> {
  _cookieJar: unknown;
  _pendingSyncCookies: unknown[];
  setJar(serialized: string | null): void;
  serializeJar(): string;
  _getAllCookiesSync(): InternalCookie[];
  _convertToExternalCookies(cookies: InternalCookie[]): ExternalCookie[];
  setByServer(...args: unknown[]): unknown;
  setByClient(...args: unknown[]): unknown;
  setCookies(...args: unknown[]): unknown;
  deleteCookies(...args: unknown[]): unknown;
}
interface ProfilePersistence {
  read(deviceId: string): Promise<string | null>;
  write(deviceId: string, serialized: string): Promise<unknown>;
  remove(deviceId: string): Promise<unknown>;
  readMetadata?(deviceId: string): Promise<ProfileMetadata | null>;
  writeMetadata?(deviceId: string, metadata: ProfileMetadata): Promise<unknown>;
  removeMetadata?(deviceId: string): Promise<unknown>;
  close(): Promise<unknown>;
}
type TimerHandle = ReturnType<typeof setTimeout> | number;
type SetTimer = (callback: () => void, delay: number) => TimerHandle;
type ClearTimer = (timer: TimerHandle) => void;
interface DeviceProfile {
  cookies: CookieContainer;
  attached: Set<CookieContainer>;
  persist: boolean;
  retentionDays: RetentionDays;
  loaded: boolean;
  used: boolean;
  active: boolean;
  idleSince: number | null;
  retentionTimer: TimerHandle | null;
  flushTimer: TimerHandle | null;
  dirty: boolean;
  operationPromise: Promise<unknown>;
  configurePromise: Promise<unknown>;
  useVersion: number;
  retentionEpoch: number;
}

const noPersistence: ProfilePersistence = {
  async read() { return null; },
  async write() {},
  async remove() {},
  async readMetadata() { return null; },
  async writeMetadata() {},
  async removeMetadata() {},
  async close() {},
};

export function createDeviceCookieProfiles({
  createCookies,
  onMutation = () => {},
  persistence = noPersistence,
  now = Date.now,
  setTimer = setTimeout,
  clearTimer = clearTimeout,
}: {
  createCookies: () => CookieContainer;
  onMutation?: (deviceId: string) => unknown;
  persistence?: ProfilePersistence;
  now?: () => number;
  setTimer?: SetTimer;
  clearTimer?: ClearTimer;
}) {
  const profiles = new Map<string, DeviceProfile>();
  const pending = new Set<Promise<unknown>>();
  let closing = false;

  const track = <T>(operation: Promise<T>): Promise<T> => {
    pending.add(operation);
    operation.then(() => pending.delete(operation), () => pending.delete(operation));
    return operation;
  };

  const profileFor = (deviceId: string): DeviceProfile => {
    let profile = profiles.get(deviceId);
    if (!profile) {
      profile = {
        cookies: createCookies(),
        attached: new Set(),
        persist: false,
        retentionDays: 30,
        loaded: false,
        used: false,
        active: false,
        idleSince: null,
        retentionTimer: null,
        flushTimer: null,
        dirty: false,
        operationPromise: Promise.resolve(),
        configurePromise: Promise.resolve(),
        useVersion: 0,
        retentionEpoch: 0,
      };
      profiles.set(deviceId, profile);
    }
    return profile;
  };

  const installCookies = (profile: DeviceProfile, cookies: CookieContainer): void => {
    profile.cookies = cookies;
    for (const attached of profile.attached) {
      attached._cookieJar = cookies._cookieJar;
      attached._pendingSyncCookies = [];
    }
  };

  const replaceJar = (profile: DeviceProfile, serialized: string | null): void => {
    profile.cookies.setJar(serialized);
    for (const cookies of profile.attached) {
      cookies._cookieJar = profile.cookies._cookieJar;
      cookies._pendingSyncCookies = [];
    }
  };

  const queueOperation = <T>(profile: DeviceProfile, operation: () => T | Promise<T>): Promise<T> => {
    const result = profile.operationPromise.then(operation);
    profile.operationPromise = result.catch(() => {});
    return track(result);
  };

  const queueWrite = (deviceId: string, profile: DeviceProfile, serialized = profile.cookies.serializeJar()) => (
    queueOperation(profile, () => persistence.write(deviceId, serialized))
  );
  const queueMetadata = (deviceId: string, profile: DeviceProfile) => queueOperation(
    profile,
    () => persistence.writeMetadata?.(deviceId, {
      persist: profile.persist,
      retentionDays: profile.retentionDays,
      noLeaseSince: profile.idleSince,
    }),
  );

  const flush = async (deviceId: string): Promise<void> => {
    const profile = profiles.get(deviceId);
    if (!profile || !profile.persist) return;
    if (!profile.dirty) {
      await profile.operationPromise;
      return;
    }
    if (profile.flushTimer !== null) {
      clearTimer(profile.flushTimer);
      profile.flushTimer = null;
    }
    profile.dirty = false;
    try {
      await queueWrite(deviceId, profile);
    } catch (error) {
      profile.dirty = true;
      throw error;
    }
  };

  const markDirty = (deviceId: string): void => {
    const profile = profileFor(deviceId);
    profile.used = true;
    profile.useVersion += 1;
    onMutation(deviceId);
    if (!profile.persist) return;
    profile.dirty = true;
    if (closing || profile.flushTimer !== null) return;
    profile.flushTimer = setTimer(() => {
      profile.flushTimer = null;
      void flush(deviceId).catch(() => {});
    }, 500);
  };

  const clearRetentionTimer = (profile: DeviceProfile): void => {
    if (profile.retentionTimer === null) return;
    clearTimer(profile.retentionTimer);
    profile.retentionTimer = null;
  };

  const clearExpired = async (
    deviceId: string,
    profile: DeviceProfile,
    expectedEpoch: number,
    expectedIdleSince: number,
  ): Promise<void> => {
    clearRetentionTimer(profile);
    if (profile.dirty) await flush(deviceId);
    else await profile.operationPromise;
    if (profile.active
      || profile.retentionEpoch !== expectedEpoch
      || profile.idleSince !== expectedIdleSince) return;
    installCookies(profile, createCookies());
    profile.used = false;
    profile.useVersion += 1;
    profile.idleSince = null;
    profile.dirty = false;
    await queueOperation(profile, () => persistence.remove(deviceId));
  };

  const scheduleRetention = (deviceId: string, profile: DeviceProfile): Promise<void> | null => {
    clearRetentionTimer(profile);
    if (closing || profile.active || profile.idleSince === null || profile.retentionDays === null) return null;
    const remaining = profile.idleSince + profile.retentionDays * DAY - now();
    if (remaining <= 0) {
      return track(clearExpired(
        deviceId,
        profile,
        profile.retentionEpoch,
        profile.idleSince,
      ));
    }
    profile.retentionTimer = setTimer(() => {
      profile.retentionTimer = null;
      const operation = scheduleRetention(deviceId, profile);
      if (operation) void operation.catch(() => {});
    }, Math.min(remaining, MAX_TIMER_DELAY));
    return null;
  };

  const saveCurrent = async (deviceId: string, profile: DeviceProfile): Promise<void> => {
    if (profile.flushTimer !== null) {
      clearTimer(profile.flushTimer);
      profile.flushTimer = null;
    }
    profile.dirty = false;
    await queueWrite(deviceId, profile);
  };

  const configureImpl = async (deviceId: string, prefs: unknown) => {
    const preferences = prefs && typeof prefs === 'object' && !Array.isArray(prefs)
      ? prefs as Record<string, unknown> : null;
    if (typeof preferences?.persist !== 'boolean'
      || ![1, 7, 30, null].includes(preferences?.retentionDays as RetentionDays)) {
      throw new Error('invalid browser profile preferences');
    }
    const validPreferences = preferences as unknown as ProfilePreferences;
    const profile = profileFor(deviceId);
    const wasPersisting = profile.persist;
    profile.retentionEpoch += 1;
    let warning = null;

    if (validPreferences.persist && !wasPersisting) {
      if (!profile.loaded) {
        const metadata = await persistence.readMetadata?.(deviceId);
        if (metadata?.persist) profile.idleSince = metadata.noLeaseSince;
      }
      profile.persist = true;
      profile.retentionDays = validPreferences.retentionDays;
      if (!profile.loaded && !profile.used) {
        profile.loaded = true;
        const useVersion = profile.useVersion;
        try {
          const serialized = await persistence.read(deviceId);
          if (profile.used || profile.useVersion !== useVersion) {
            await saveCurrent(deviceId, profile);
          } else if (serialized !== null) {
            replaceJar(profile, serialized);
          }
        } catch {
          warning = 'profile-recovery-failed';
          await queueOperation(profile, () => persistence.remove(deviceId));
          if (profile.used || profile.useVersion !== useVersion) {
            await saveCurrent(deviceId, profile);
          } else {
            installCookies(profile, createCookies());
            profile.used = false;
            profile.useVersion += 1;
          }
        }
      } else {
        profile.loaded = true;
        await saveCurrent(deviceId, profile);
      }
    } else if (!validPreferences.persist && wasPersisting) {
      const wasDirty = profile.dirty;
      if (profile.flushTimer !== null) {
        clearTimer(profile.flushTimer);
        profile.flushTimer = null;
      }
      profile.dirty = false;
      try {
        await queueOperation(profile, () => persistence.remove(deviceId));
      } catch (error) {
        profile.dirty ||= wasDirty;
        const retention = scheduleRetention(deviceId, profile);
        if (retention) await retention;
        throw error;
      }
      if (profile.flushTimer !== null) {
        clearTimer(profile.flushTimer);
        profile.flushTimer = null;
      }
      profile.dirty = false;
      profile.persist = false;
      profile.retentionDays = validPreferences.retentionDays;
      await queueOperation(profile, () => persistence.removeMetadata?.(deviceId));
    } else {
      profile.persist = validPreferences.persist;
      profile.retentionDays = validPreferences.retentionDays;
    }

    if (profile.persist) await queueMetadata(deviceId, profile);
    const retention = scheduleRetention(deviceId, profile);
    if (retention) await retention;
    return { persist: profile.persist, retentionDays: profile.retentionDays, warning };
  };

  const configure = (deviceId: string, prefs: unknown) => {
    const profile = profileFor(deviceId);
    // Preference changes span reads, jar restoration, disk removal, and metadata writes. Serialize that
    // whole transaction per device; serializing only the individual file operations lets an older enable
    // finish after a newer disable and silently turn persistence back on.
    const result = profile.configurePromise.catch(() => {}).then(() => configureImpl(deviceId, prefs));
    profile.configurePromise = result.catch(() => {});
    return track(result);
  };

  const setActive = (deviceId: string, active: boolean): void => {
    const profile = profiles.get(deviceId);
    if (!profile) return;
    profile.retentionEpoch += 1;
    if (active) {
      profile.active = true;
      profile.idleSince = null;
      clearRetentionTimer(profile);
      if (profile.persist) void queueMetadata(deviceId, profile).catch(() => {});
      return;
    }
    if (profile.active || profile.idleSince === null) profile.idleSince = now();
    profile.active = false;
    if (profile.persist) void queueMetadata(deviceId, profile).catch(() => {});
    const retention = scheduleRetention(deviceId, profile);
    if (retention) void retention.catch(() => {});
  };

  const attach = (deviceId: string, sessionCookies: CookieContainer): (() => void) => {
    const profile = profileFor(deviceId);
    if (!profile.cookies?._cookieJar || !sessionCookies?._cookieJar) {
      throw new Error('browser cookie profile unsupported');
    }
    profile.used = true;
    profile.useVersion += 1;
    sessionCookies._cookieJar = profile.cookies._cookieJar;
    sessionCookies._pendingSyncCookies = [];
    profile.attached.add(sessionCookies);

    const originals = new Map<string, { hadOwn: boolean; value: unknown }>();
    for (const name of MUTATION_METHODS) {
      const original = sessionCookies[name];
      originals.set(name, {
        hadOwn: Object.prototype.hasOwnProperty.call(sessionCookies, name),
        value: original,
      });
      if (typeof original !== 'function') throw new Error('browser cookie profile unsupported');
      sessionCookies[name] = (...args: unknown[]) => {
        const result = original.apply(sessionCookies, args);
        markDirty(deviceId);
        return result;
      };
    }

    let attached = true;
    return () => {
      if (!attached) return;
      attached = false;
      profile.attached.delete(sessionCookies);
      for (const [name, original] of originals) {
        if (original.hadOwn) sessionCookies[name] = original.value;
        else delete sessionCookies[name];
      }
    };
  };

  const serialize = (deviceId: string): string | null => {
    const profile = profiles.get(deviceId);
    if (!profile) return null;
    profile.used = true;
    profile.useVersion += 1;
    return profile.cookies.serializeJar();
  };

  const clear = (deviceId: string, { url, hostname }: { url?: string; hostname?: string } = {}) => {
    const fullClear = !hostname && !url;
    const profile = profiles.get(deviceId) || (fullClear ? profileFor(deviceId) : null);
    if (!profile) return { cleared: false };
    profile.used = true;
    profile.useVersion += 1;
    let targetHostname = hostname;
    if (!targetHostname && url) {
      try { targetHostname = new URL(url).hostname; } catch { return { cleared: false }; }
    }
    if (!targetHostname) {
      replaceJar(profile, null);
      onMutation(deviceId);
      profile.dirty = false;
      if (profile.flushTimer !== null) {
        clearTimer(profile.flushTimer);
        profile.flushTimer = null;
      }
      return queueOperation(profile, () => persistence.remove(deviceId))
        .then(() => ({ cleared: true }));
    }

    const normalizedHostname = targetHostname.toLowerCase();
    const internalCookies = profile.cookies._getAllCookiesSync().filter((cookie) => {
      const domain = cookie.domain?.replace(/^\./, '').toLowerCase();
      if (!domain) return false;
      if (cookie.hostOnly) return domain === normalizedHostname;
      return normalizedHostname === domain || normalizedHostname.endsWith(`.${domain}`);
    });
    if (!internalCookies.length) return { cleared: false };
    const matches = profile.cookies._convertToExternalCookies(internalCookies);
    for (let index = 0; index < matches.length; index++) {
      matches[index].expires = internalCookies[index].expires;
      matches[index].maxAge = internalCookies[index].maxAge;
      matches[index].sameSite = internalCookies[index].sameSite;
    }
    profile.cookies.deleteCookies(matches);
    markDirty(deviceId);
    return { cleared: true };
  };

  const remove = (deviceId: string): boolean => {
    const profile = profiles.get(deviceId);
    if (!profile) return false;
    clearRetentionTimer(profile);
    if (profile.flushTimer !== null) clearTimer(profile.flushTimer);
    profiles.delete(deviceId);
    if (profile.persist) {
      queueOperation(profile, () => persistence.remove(deviceId));
      queueOperation(profile, () => persistence.removeMetadata?.(deviceId));
    }
    return true;
  };
  const has = (deviceId: string): boolean => profiles.has(deviceId);

  const close = async (): Promise<void> => {
    closing = true;
    for (const profile of profiles.values()) clearRetentionTimer(profile);
    while (true) {
      const flushes: Promise<void>[] = [];
      for (const [deviceId, profile] of profiles) {
        if (profile.dirty) flushes.push(flush(deviceId));
        else if (profile.flushTimer !== null) {
          clearTimer(profile.flushTimer);
          profile.flushTimer = null;
        }
      }
      await Promise.all(flushes);
      const operations = [...pending];
      if (!operations.length) break;
      await Promise.all(operations);
    }
    for (const profile of profiles.values()) clearRetentionTimer(profile);
    await persistence.close();
  };

  return {
    attach, serialize, clear, remove, has, configure, setActive, flush, close,
  };
}
