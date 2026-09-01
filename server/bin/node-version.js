export const MINIMUM_NODE_VERSION = '22.16.0';

function parseVersion(value) {
  const match = /^(\d+)\.(\d+)\.(\d+)/.exec(String(value));
  return match ? match.slice(1, 4).map(Number) : null;
}

export function nodeVersionSupport(actual) {
  const current = parseVersion(actual);
  const minimum = parseVersion(MINIMUM_NODE_VERSION);
  let ok = Boolean(current && minimum);
  if (current && minimum) {
    for (let index = 0; index < minimum.length; index += 1) {
      if (current[index] === minimum[index]) continue;
      ok = current[index] > minimum[index];
      break;
    }
  }
  return { ok, actual: String(actual), minimum: MINIMUM_NODE_VERSION };
}
