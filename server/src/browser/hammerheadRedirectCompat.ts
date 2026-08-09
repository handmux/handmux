import { createRequire } from 'node:module';
import { randomBytes } from 'node:crypto';

const require = createRequire(import.meta.url);
const MARKER = 'x-handmux-browser-rebind';
const MARKER_SECRET = randomBytes(32).toString('base64url');
const PATCHED = Symbol.for('handmux.hammerhead.raw-rebind-location');

type LocationTransform = ((src: unknown, ctx: unknown) => unknown) & Record<symbol, unknown>;
interface ResponseTransforms extends Record<string | symbol, unknown> { location: LocationTransform }

const recordOf = (value: unknown): Record<string | symbol, unknown> | null => (
  value && typeof value === 'object' ? value as Record<string | symbol, unknown> : null
);

export function hammerheadRebindHeaders(location: string): Record<string, string> {
  return { location, [MARKER]: MARKER_SECRET };
}

export function patchHammerheadRebindLocation(
  input: unknown,
  markerSecret = MARKER_SECRET,
): boolean {
  const responseTransforms = recordOf(input) as ResponseTransforms | null;
  const original = responseTransforms?.location;
  if (typeof original !== 'function') throw new Error('unsupported Hammerhead location transform');
  if (!responseTransforms) throw new Error('unsupported Hammerhead response transforms');
  const transform = original as LocationTransform;
  if (transform[PATCHED]) return false;

  function location(src: unknown, ctx: unknown): unknown {
    const destination = recordOf(recordOf(ctx)?.destRes);
    const headers = recordOf(destination?.headers);
    if (headers?.[MARKER] === markerSecret) return src;
    return transform(src, ctx);
  }
  Object.defineProperty(location, PATCHED, { value: true });
  responseTransforms.location = location as LocationTransform;
  responseTransforms[MARKER] = () => undefined;
  return true;
}

export function installHammerheadRebindLocationCompat(): boolean {
  const loaded = require(
    'testcafe-hammerhead/lib/request-pipeline/header-transforms/transforms',
  ) as unknown;
  return patchHammerheadRebindLocation(recordOf(loaded)?.responseTransforms, MARKER_SECRET);
}

export { MARKER as HAMMERHEAD_REBIND_HEADER };
