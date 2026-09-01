import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { installPiExtension, piExtensionFile } from '../src/cli/piExtension.js';
import { hooksStatus } from '../src/cli/claudeHooks.js';
import {
  defaultAgentIntegrationContext,
  shouldOfferClaudeIntegration,
} from '../src/cli/agentIntegration.js';
import { tmpHome } from './tmphome.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const CLI = path.resolve(here, '../bin/handmux.js');

function fakeAgent(home: string, name: 'pi' | 'claude' | 'codex'): void {
  const bin = path.join(home, 'bin');
  fs.mkdirSync(bin, { recursive: true });
  fs.writeFileSync(
    path.join(bin, name),
    `#!${process.execPath}\nif (process.argv.includes('--version')) process.stdout.write('2.1.207');\n`,
    { mode: 0o755 },
  );
}

function initClaude(home: string): void {
  fakeAgent(home, 'claude');
  fs.mkdirSync(path.join(home, '.claude'), { recursive: true });
}

function legacyCodexHooks(home: string): string {
  const codexDir = path.join(home, '.codex');
  const hooksDir = path.join(codexDir, 'hooks');
  fs.mkdirSync(hooksDir, { recursive: true });
  const config = path.join(codexDir, 'config.toml');
  fs.writeFileSync(config, [
    'model = "gpt-5"',
    '# >>> handmux codex-hooks >>>',
    'legacy = true',
    '# <<< handmux codex-hooks <<<',
    '',
  ].join('\n'));
  fs.writeFileSync(path.join(hooksDir, 'handmux-notify.sh'), 'legacy');
  return config;
}

function run(home: string, ...args: string[]) {
  return spawnSync(process.execPath, [CLI, ...args], {
    env: {
      ...process.env,
      HOME: home,
      LANG: 'en_US.UTF-8',
      PATH: path.join(home, 'bin'),
    },
    encoding: 'utf8',
    timeout: 8_000,
  });
}

describe('handmux agent management command', () => {
  it('lists every built-in Agent and always exits zero', () => {
    const home = tmpHome('hm-agent-');
    const implicit = run(home, 'agent');
    const explicit = run(home, 'agent', 'list');
    for (const result of [implicit, explicit]) {
      expect(result.status).toBe(0);
      expect(result.stdout).toContain('codex: not installed');
      expect(result.stdout).toContain('pi: not installed');
      expect(result.stdout).toContain('claude: not installed');
    }
  });

  it('uses the five fixed public states and the status 0/1/2 exit contract', () => {
    const readyHome = tmpHome('hm-agent-ready-');
    fakeAgent(readyHome, 'codex');
    const ready = run(readyHome, 'agent', 'status', 'codex');
    expect(ready.status).toBe(0);
    expect(ready.stdout).toContain('ready');

    const missingHome = tmpHome('hm-agent-missing-');
    const missing = run(missingHome, 'agent', 'status', 'pi');
    expect(missing.status).toBe(1);
    expect(missing.stdout).toContain('not installed');

    const disabledHome = tmpHome('hm-agent-disabled-');
    fakeAgent(disabledHome, 'pi');
    const disabled = run(disabledHome, 'agent', 'status', 'pi');
    expect(disabled.status).toBe(1);
    expect(disabled.stdout).toContain('not enabled');

    const repairHome = tmpHome('hm-agent-repair-');
    fakeAgent(repairHome, 'pi');
    const oldEntry = path.join(repairHome, 'old-entry.js');
    fs.writeFileSync(oldEntry, 'export default function extension() {}\n');
    installPiExtension(repairHome, { entryFile: oldEntry });
    fs.unlinkSync(oldEntry);
    const repair = run(repairHome, 'agent', 'status', 'pi');
    expect(repair.status).toBe(1);
    expect(repair.stdout).toContain('needs repair');

    const conflictHome = tmpHome('hm-agent-conflict-');
    fakeAgent(conflictHome, 'pi');
    fs.mkdirSync(path.dirname(piExtensionFile(conflictHome)), { recursive: true });
    fs.writeFileSync(piExtensionFile(conflictHome), 'export default function mine() {}\n');
    const conflict = run(conflictHome, 'agent', 'status', 'pi');
    expect(conflict.status).toBe(1);
    expect(conflict.stdout).toContain('conflict');

    expect(run(readyHome, 'agent', 'status', 'gemini').status).toBe(2);
    expect(run(readyHome, 'agent', 'status').status).toBe(2);
    expect(run(readyHome, 'agent', 'list', 'extra').status).toBe(2);
  });

  it('does not create Pi directories when upstream Pi is missing', () => {
    const home = tmpHome('hm-agent-missing-');
    const result = run(home, 'agent', 'enable', 'pi');
    expect(result.status).toBe(1);
    expect(result.stdout).toContain('not installed');
    expect(fs.existsSync(path.join(home, '.pi'))).toBe(false);
  });

  it('guides an installed but uninitialized Claude without creating ~/.claude', () => {
    const home = tmpHome('hm-agent-claude-uninitialized-');
    fakeAgent(home, 'claude');
    for (const result of [
      run(home, 'agent', 'status', 'claude'),
      run(home, 'agent', 'enable', 'claude'),
    ]) {
      expect(result.status).toBe(1);
      expect(result.stdout).toContain('claude: not enabled');
      expect(result.stdout).toContain('Run Claude Code once to initialize ~/.claude');
      expect(result.stdout).toContain('handmux agent enable claude');
      expect(result.stdout).not.toContain('Install claude first');
    }
    expect(fs.existsSync(path.join(home, '.claude'))).toBe(false);
  });

  it('does not offer setup integration before Claude initializes ~/.claude', () => {
    const home = tmpHome('hm-setup-claude-uninitialized-');
    const context = defaultAgentIntegrationContext({
      home,
      piEntryFile: '/unused/pi.js',
      hooksSrcDir: '/unused/hooks',
      claudeStateFile: path.join(home, '.handmux/claude-state.json'),
    });
    context.executableAvailable = (name) => name === 'claude';
    expect(shouldOfferClaudeIntegration(context)).toBe(false);
    fs.mkdirSync(path.join(home, '.claude'));
    expect(shouldOfferClaudeIntegration(context)).toBe(true);
  });

  it('enables, repairs, and disables the owned Pi wrapper idempotently', () => {
    const home = tmpHome('hm-agent-pi-');
    fakeAgent(home, 'pi');
    const first = run(home, 'agent', 'enable', 'pi');
    expect(first.status).toBe(0);
    expect(fs.readFileSync(piExtensionFile(home), 'utf8')).toContain('/dist/connectors/pi/index.js');
    expect(run(home, 'agent', 'enable', 'pi').status).toBe(0);
    expect(run(home, 'agent', 'status', 'pi').status).toBe(0);

    fs.writeFileSync(piExtensionFile(home), fs.readFileSync(piExtensionFile(home), 'utf8').replace(
      /file:[^\n]+/,
      'file:///definitely/missing/handmux-pi-entry.js',
    ));
    expect(run(home, 'agent', 'status', 'pi').stdout).toContain('needs repair');
    expect(run(home, 'agent', 'enable', 'pi').status).toBe(0);
    expect(run(home, 'agent', 'status', 'pi').status).toBe(0);

    expect(run(home, 'agent', 'disable', 'pi').status).toBe(0);
    expect(fs.existsSync(piExtensionFile(home))).toBe(false);
    expect(run(home, 'agent', 'disable', 'pi').status).toBe(0);
  });

  it('never overwrites or removes a foreign Pi target', () => {
    const home = tmpHome('hm-agent-pi-conflict-');
    fakeAgent(home, 'pi');
    const file = piExtensionFile(home);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, 'export default function userOwned() {}\n');

    expect(run(home, 'agent', 'enable', 'pi').status).toBe(1);
    expect(run(home, 'agent', 'disable', 'pi').status).toBe(1);
    expect(fs.readFileSync(file, 'utf8')).toContain('userOwned');
  });

  it('manages Claude hooks idempotently while keeping statusLine optional in non-TTY runs', () => {
    const home = tmpHome('hm-agent-claude-');
    initClaude(home);
    fs.writeFileSync(path.join(home, '.claude/settings.json'), JSON.stringify({
      hooks: { Stop: [{ hooks: [{ command: '/my/own-hook' }] }] },
    }));

    expect(run(home, 'agent', 'enable', 'claude').status).toBe(0);
    expect(hooksStatus(home)).toBe('installed');
    let settings = JSON.parse(fs.readFileSync(path.join(home, '.claude/settings.json'), 'utf8'));
    expect(settings.statusLine).toBeUndefined();
    expect(JSON.stringify(settings)).toContain('/my/own-hook');
    expect(run(home, 'agent', 'enable', 'claude').status).toBe(0);

    settings.statusLine = {
      type: 'command',
      command: `node ${path.join(home, '.claude/hooks/handmux-statusline.cjs')} ${path.join(home, '.handmux/claude-usage.json')}`,
    };
    fs.writeFileSync(path.join(home, '.claude/settings.json'), JSON.stringify(settings));
    expect(run(home, 'agent', 'disable', 'claude').status).toBe(0);
    settings = JSON.parse(fs.readFileSync(path.join(home, '.claude/settings.json'), 'utf8'));
    expect(settings.statusLine).toBeUndefined();
    expect(JSON.stringify(settings)).toContain('/my/own-hook');
    expect(hooksStatus(home)).toBe('absent');
  });

  it('reports and repairs incomplete Claude hook deployments', () => {
    const home = tmpHome('hm-agent-claude-repair-');
    initClaude(home);
    expect(run(home, 'agent', 'enable', 'claude').status).toBe(0);
    fs.unlinkSync(path.join(home, '.claude/hooks/handmux-notify.sh'));

    const broken = run(home, 'agent', 'status', 'claude');
    expect(broken.status).toBe(1);
    expect(broken.stdout).toContain('needs repair');
    expect(run(home, 'agent', 'enable', 'claude').status).toBe(0);
    expect(run(home, 'agent', 'status', 'claude').status).toBe(0);
  });

  it('normalizes stale Handmux-owned Claude hook commands without touching foreign hooks', () => {
    const home = tmpHome('hm-agent-claude-path-repair-');
    initClaude(home);
    expect(run(home, 'agent', 'enable', 'claude').status).toBe(0);
    const settingsFile = path.join(home, '.claude/settings.json');
    const settings = JSON.parse(fs.readFileSync(settingsFile, 'utf8'));
    settings.hooks.Stop.unshift({ hooks: [{ command: '/my/foreign-stop.sh' }] });
    for (const groups of Object.values(settings.hooks) as Array<Array<{ hooks?: Array<{ command?: string }> }>>) {
      for (const group of groups) {
        for (const hook of group.hooks || []) {
          if (hook.command?.includes('handmux-notify.sh')) {
            hook.command = hook.command.replace(/\S*handmux-notify\.sh/, '/wrong/handmux-notify.sh');
          }
        }
      }
    }
    fs.writeFileSync(settingsFile, JSON.stringify(settings));

    const broken = run(home, 'agent', 'status', 'claude');
    expect(broken.status).toBe(1);
    expect(broken.stdout).toContain('needs repair');
    expect(run(home, 'agent', 'enable', 'claude').status).toBe(0);
    expect(run(home, 'agent', 'status', 'claude').status).toBe(0);
    const repaired = fs.readFileSync(settingsFile, 'utf8');
    expect(repaired).not.toContain('/wrong/handmux-notify.sh');
    expect(repaired).toContain('/my/foreign-stop.sh');
    expect(repaired).toContain(path.join(home, '.claude/hooks/handmux-notify.sh'));
  });

  it('repairs a correctly located Claude hook with non-canonical matcher and command shape', () => {
    const home = tmpHome('hm-agent-claude-shape-repair-');
    initClaude(home);
    expect(run(home, 'agent', 'enable', 'claude').status).toBe(0);
    const settingsFile = path.join(home, '.claude/settings.json');
    const settings = JSON.parse(fs.readFileSync(settingsFile, 'utf8'));
    const stopGroup = settings.hooks.Stop.find((group: { hooks?: Array<{ command?: string }> }) => (
      group.hooks?.some((hook) => hook.command?.includes('handmux-notify.sh'))
    ));
    stopGroup.matcher = 'WrongMatcher';
    Object.assign(stopGroup.hooks[0], { type: 'prompt', async: false, timeout: 99 });
    stopGroup.hooks.unshift({ type: 'command', command: '/my/foreign-stop.sh' });
    fs.writeFileSync(settingsFile, JSON.stringify(settings));

    expect(run(home, 'agent', 'status', 'claude').stdout).toContain('needs repair');
    expect(run(home, 'agent', 'enable', 'claude').status).toBe(0);
    expect(run(home, 'agent', 'status', 'claude').status).toBe(0);
    const repaired = JSON.parse(fs.readFileSync(settingsFile, 'utf8'));
    const canonical = repaired.hooks.Stop.find((group: { hooks?: Array<{ command?: string }> }) => (
      group.hooks?.some((hook) => hook.command?.includes('handmux-notify.sh'))
    ));
    expect(canonical).toMatchObject({
      matcher: '',
      hooks: [{ type: 'command', async: true, timeout: 5 }],
    });
    expect(JSON.stringify(repaired)).toContain('/my/foreign-stop.sh');
  });

  it('keeps hooks install/uninstall as an equivalent Claude alias', () => {
    const agentHome = tmpHome('hm-agent-claude-new-');
    const aliasHome = tmpHome('hm-agent-claude-alias-');
    initClaude(agentHome);
    initClaude(aliasHome);

    expect(run(agentHome, 'agent', 'enable', 'claude').status).toBe(0);
    expect(run(aliasHome, 'hooks', 'install').status).toBe(0);
    expect(hooksStatus(agentHome)).toBe('installed');
    expect(hooksStatus(aliasHome)).toBe('installed');

    expect(run(agentHome, 'agent', 'disable', 'claude').status).toBe(0);
    expect(run(aliasHome, 'hooks', 'uninstall').status).toBe(0);
    expect(hooksStatus(agentHome)).toBe('absent');
    expect(hooksStatus(aliasHome)).toBe('absent');
  });

  it('keeps hooks alias installation detection, exit codes, and legacy cleanup compatible', () => {
    const absent = tmpHome('hm-hooks-no-claude-');
    const noClaude = run(absent, 'hooks', 'install');
    expect(noClaude.status).toBe(0);
    expect(noClaude.stdout).toContain('~/.claude missing');
    expect(fs.existsSync(path.join(absent, '.claude'))).toBe(false);

    const installHome = tmpHome('hm-hooks-no-path-');
    fs.mkdirSync(path.join(installHome, '.claude'));
    const installConfig = legacyCodexHooks(installHome);
    expect(run(installHome, 'hooks', 'install').status).toBe(0);
    expect(hooksStatus(installHome)).toBe('installed');
    expect(fs.readFileSync(installConfig, 'utf8')).not.toContain('handmux codex-hooks');
    expect(fs.existsSync(path.join(installHome, '.codex/hooks/handmux-notify.sh'))).toBe(false);

    const uninstallHome = tmpHome('hm-hooks-legacy-uninstall-');
    fs.mkdirSync(path.join(uninstallHome, '.claude'));
    const uninstallConfig = legacyCodexHooks(uninstallHome);
    expect(run(uninstallHome, 'hooks', 'uninstall').status).toBe(0);
    expect(fs.readFileSync(uninstallConfig, 'utf8')).not.toContain('handmux codex-hooks');
    expect(fs.existsSync(path.join(uninstallHome, '.codex/hooks/handmux-notify.sh'))).toBe(false);
  });

  it('keeps hooks alias extra arguments backward-compatible', () => {
    const home = tmpHome('hm-hooks-extra-');
    fs.mkdirSync(path.join(home, '.claude'));
    expect(run(home, 'hooks', 'install', 'ignored', '--future-flag').status).toBe(0);
    expect(hooksStatus(home)).toBe('installed');
    expect(run(home, 'hooks', 'uninstall', 'ignored').status).toBe(0);
    expect(hooksStatus(home)).toBe('absent');
  });

  it('preserves a user-owned composed statusLine when disabling Claude', () => {
    const home = tmpHome('hm-agent-claude-composed-');
    initClaude(home);
    expect(run(home, 'agent', 'enable', 'claude').status).toBe(0);
    const settingsFile = path.join(home, '.claude/settings.json');
    const settings = JSON.parse(fs.readFileSync(settingsFile, 'utf8'));
    const script = path.join(home, '.claude/hooks/handmux-statusline.cjs');
    fs.writeFileSync(script, 'capturer');
    settings.statusLine = {
      type: 'command',
      command: `HANDMUX_STATUS_TEE=1 node ${script} ${path.join(home, '.handmux/claude-usage.json')} | bash ${path.join(home, '.claude/my-renderer.sh')}`,
    };
    fs.writeFileSync(settingsFile, JSON.stringify(settings));

    expect(run(home, 'agent', 'disable', 'claude').status).toBe(0);
    const after = JSON.parse(fs.readFileSync(settingsFile, 'utf8'));
    expect(after.statusLine).toEqual(settings.statusLine);
    expect(fs.existsSync(script)).toBe(true);
  });

  it('counts removal of a bare owned statusLine, but not a composed one, as a disable change', () => {
    const bareHome = tmpHome('hm-agent-claude-bare-statusline-');
    initClaude(bareHome);
    const bareSettings = path.join(bareHome, '.claude/settings.json');
    const bareScript = path.join(bareHome, '.claude/hooks/handmux-statusline.cjs');
    fs.mkdirSync(path.dirname(bareScript), { recursive: true });
    fs.writeFileSync(bareScript, 'capturer');
    fs.writeFileSync(bareSettings, JSON.stringify({ statusLine: {
      type: 'command',
      command: `node ${bareScript} ${path.join(bareHome, '.handmux/claude-usage.json')}`,
    } }));
    const bare = run(bareHome, 'agent', 'disable', 'claude');
    expect(bare.status).toBe(0);
    expect(bare.stdout).toContain('integration disabled');
    expect(JSON.parse(fs.readFileSync(bareSettings, 'utf8')).statusLine).toBeUndefined();

    const composedHome = tmpHome('hm-agent-claude-composed-only-');
    initClaude(composedHome);
    const composedSettings = path.join(composedHome, '.claude/settings.json');
    const composedScript = path.join(composedHome, '.claude/hooks/handmux-statusline.cjs');
    fs.mkdirSync(path.dirname(composedScript), { recursive: true });
    fs.writeFileSync(composedScript, 'capturer');
    const command = `HANDMUX_STATUS_TEE=1 node ${composedScript} ${path.join(composedHome, '.handmux/claude-usage.json')} | bash ~/.claude/my-renderer.sh`;
    fs.writeFileSync(composedSettings, JSON.stringify({
      statusLine: { type: 'command', command },
    }));
    const composed = run(composedHome, 'agent', 'disable', 'claude');
    expect(composed.status).toBe(0);
    expect(composed.stdout).toContain('already disabled');
    expect(JSON.parse(fs.readFileSync(composedSettings, 'utf8')).statusLine.command).toBe(command);
    expect(fs.existsSync(composedScript)).toBe(true);
  });

  it('treats Codex enable as a no-write no-op and rejects disable with native bypass guidance', () => {
    const home = tmpHome('hm-agent-codex-');
    fakeAgent(home, 'codex');
    const before = fs.readdirSync(home);
    const enabled = run(home, 'agent', 'enable', 'codex');
    expect(enabled.status).toBe(0);
    expect(enabled.stdout).toContain('built in');
    expect(fs.readdirSync(home)).toEqual(before);

    const disabled = run(home, 'agent', 'disable', 'codex');
    expect(disabled.status).toBe(1);
    expect(disabled.stderr).toContain('native `codex`');
    expect(fs.readdirSync(home)).toEqual(before);
  });

  it('reports missing Codex and rejects enable without writing, while disable stays unsupported', () => {
    const home = tmpHome('hm-agent-codex-missing-');
    const before = fs.readdirSync(home);
    expect(run(home, 'agent', 'status', 'codex').status).toBe(1);
    const enabled = run(home, 'agent', 'enable', 'codex');
    expect(enabled.status).toBe(1);
    expect(enabled.stdout).toContain('not installed');
    expect(fs.readdirSync(home)).toEqual(before);
    const disabled = run(home, 'agent', 'disable', 'codex');
    expect(disabled.status).toBe(1);
    expect(disabled.stderr).toContain('native `codex`');
    expect(fs.readdirSync(home)).toEqual(before);
  });
});
