import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { generateWhatsNew, projectWhatsNew, readChangelog } from '../scripts/gen-whatsnew.mjs';

const SERVER = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

describe('release whatsNew generation', () => {
  it('matches package metadata from its current version while the next release is being prepared', async () => {
    const entries = await readChangelog();
    const packageJson = JSON.parse(fs.readFileSync(path.join(SERVER, 'package.json'), 'utf8'));
    const currentIndex = entries.findIndex((entry) => entry?.version === packageJson.version);

    expect(currentIndex).toBeGreaterThanOrEqual(0);

    const expected = projectWhatsNew(entries.slice(currentIndex));

    expect(expected).toEqual(packageJson.whatsNew);
    expect(expected[0]?.version).toBe(packageJson.version);
  });

  it('writes projected release highlights into package metadata', async () => {
    const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'handmux-whats-new-'));
    const packagePath = path.join(scratch, 'package.json');

    try {
      fs.writeFileSync(packagePath, '{\n  "name": "fixture"\n}\n');
      const expected = projectWhatsNew(await readChangelog());
      await generateWhatsNew({ packagePath });

      expect(JSON.parse(fs.readFileSync(packagePath, 'utf8')).whatsNew).toEqual(expected);
    } finally {
      fs.rmSync(scratch, { recursive: true, force: true });
    }
  });
});
