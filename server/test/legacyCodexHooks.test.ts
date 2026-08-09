import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { tmpHome } from './tmphome.js';
import { removeLegacyCodexHooks, stripLegacyCodexHooks } from '../src/cli/legacyCodexHooks.js';

const block: string = `# >>> handmux codex-hooks >>>
[[hooks.Stop]]
[[hooks.Stop.hooks]]
type = "command"
command = "'/home/u/.codex/hooks/handmux-notify.sh' stop codex"
# <<< handmux codex-hooks <<<
`;

describe('legacy Codex Hook cleanup', () => {
  it('removes only the Handmux marker and preserves user Codex configuration', () => {
    const userBefore = 'model = "gpt-5"\n[features]\nweb_search = true\n';
    const userAfter = '\n[[hooks.Stop]]\ncommand = "user-hook"\n';
    const cleaned = stripLegacyCodexHooks(`${userBefore}\n${block}${userAfter}`);
    expect(cleaned).toContain(userBefore);
    expect(cleaned).toContain(userAfter.trim());
    expect(cleaned).not.toContain('handmux codex-hooks');
    expect(cleaned).not.toContain('handmux-notify.sh');
  });

  it('cleans an old install without creating ~/.codex for unaffected users', () => {
    const untouched = tmpHome('legacy-codex-none-');
    expect(removeLegacyCodexHooks(untouched)).toEqual({ changed: false });
    expect(fs.existsSync(path.join(untouched, '.codex'))).toBe(false);

    const home = tmpHome('legacy-codex-');
    const codexDir = path.join(home, '.codex');
    const hooksDir = path.join(codexDir, 'hooks');
    fs.mkdirSync(hooksDir, { recursive: true });
    const configFile = path.join(codexDir, 'config.toml');
    fs.writeFileSync(configFile, `model = "gpt-5"\n\n${block}`, { mode: 0o600 });
    for (const name of ['handmux-notify.sh', 'handmux-write.cjs', 'handmux-codex-usage.cjs', 'handmux-notify.env']) {
      fs.writeFileSync(path.join(hooksDir, name), 'old handmux file');
    }
    fs.writeFileSync(path.join(hooksDir, 'user-hook.sh'), 'keep me');

    expect(removeLegacyCodexHooks(home)).toEqual({ changed: true });
    expect(fs.readFileSync(configFile, 'utf8')).toContain('model = "gpt-5"');
    expect(fs.readFileSync(configFile, 'utf8')).not.toContain('handmux codex-hooks');
    expect(fs.statSync(configFile).mode & 0o777).toBe(0o600);
    expect(fs.existsSync(path.join(hooksDir, 'user-hook.sh'))).toBe(true);
    expect(fs.existsSync(path.join(hooksDir, 'handmux-notify.sh'))).toBe(false);
    expect(removeLegacyCodexHooks(home)).toEqual({ changed: false });
  });
});
