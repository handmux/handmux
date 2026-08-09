import { describe, it, expect } from 'vitest';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { tmpHome } from './tmphome.js';

const SCRIPT = path.resolve(__dirname, '../hooks/handmux-statusline.cjs');

// Run the capturer with a stdin payload; returns { stdout, snap } where snap is the parsed usage file (or null).
function run(stdin, { tee = false, file = path.join(tmpHome('sl-cap-'), '.handmux', 'claude-usage.json') } = {}) {
  const stdout = execFileSync('node', [SCRIPT, file], {
    input: stdin,
    env: { ...process.env, ...(tee ? { HANDMUX_STATUS_TEE: '1' } : {}) },
    encoding: 'utf8',
  });
  const snap = fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, 'utf8')) : null;
  return { stdout, snap, file };
}

const FULL = JSON.stringify({
  session_id: 'session-1',
  model: { display_name: 'Opus 4.8 (1M)' },
  workspace: { current_dir: '/Users/x/proj' },
  context_window: { used_percentage: 34.2 },
  rate_limits: {
    five_hour: { used_percentage: 42.5, resets_at: 1711540800 },
    seven_day: { used_percentage: 15.3, resets_at: 1712059200 },
    seven_day_opus: { used_percentage: 12 },
    seven_day_sonnet: { used_percentage: 8 },
  },
});

describe('handmux-statusline.cjs', () => {
  it('snapshots rate_limits + context + model to the usage file', () => {
    const { snap, file } = run(FULL);
    expect(snap.model).toBe('Opus 4.8 (1M)');
    expect(snap.context).toEqual({ usedPercent: 34.2 });
    expect(snap.rateLimits.fiveHour).toEqual({ usedPercent: 42.5, resetsAt: 1711540800 });
    expect(snap.rateLimits.sevenDay).toEqual({ usedPercent: 15.3, resetsAt: 1712059200 });
    expect(snap.rateLimits.sevenDayOpus).toEqual({ usedPercent: 12 });
    expect(snap.rateLimits.sevenDaySonnet).toEqual({ usedPercent: 8 });
    expect(typeof snap.updatedAt).toBe('number');
    const context = path.join(path.dirname(file), 'context', 'session-1.json');
    expect(fs.statSync(path.dirname(file)).mode & 0o777).toBe(0o700);
    expect(fs.statSync(file).mode & 0o777).toBe(0o600);
    expect(fs.statSync(path.dirname(context)).mode & 0o777).toBe(0o700);
    expect(fs.statSync(context).mode & 0o777).toBe(0o600);
  });

  it('renders a compact status line by default', () => {
    const { stdout } = run(FULL);
    expect(stdout).toContain('proj');
    expect(stdout).toContain('Opus 4.8 (1M)');
    expect(stdout).toContain('Ctx 34%');
    expect(stdout).toContain('5h 43%'); // Math.round(42.5)
    expect(stdout).toContain('Wk 15%');
  });

  it('TEE mode re-emits stdin verbatim (for composing) and still snapshots', () => {
    const { stdout, snap } = run(FULL, { tee: true });
    expect(stdout).toBe(FULL);
    expect(snap.rateLimits.fiveHour.usedPercent).toBe(42.5); // still captured
  });

  it('omits missing windows (partial payload: no rate_limits yet)', () => {
    const { snap } = run(JSON.stringify({ model: { display_name: 'Sonnet' }, context_window: { used_percentage: 5 } }));
    expect(snap.model).toBe('Sonnet');
    expect(snap.rateLimits).toEqual({}); // nothing present
  });

  it('does not replace the machine-wide quota with a new session empty snapshot', () => {
    const { snap: before, file } = run(FULL);
    fs.chmodSync(path.dirname(file), 0o755);
    fs.chmodSync(file, 0o644);
    const { snap: after } = run(
      JSON.stringify({ model: { display_name: 'Sonnet' }, context_window: { used_percentage: 5 } }),
      { file },
    );
    expect(after).toEqual(before);
    expect(fs.statSync(path.dirname(file)).mode & 0o777).toBe(0o700);
    expect(fs.statSync(file).mode & 0o777).toBe(0o600);
  });

  it('never crashes on non-JSON stdin (writes nothing meaningful, exits 0)', () => {
    const { snap } = run('not json at all');
    // snapshot may be written with nulls but the process must not throw
    expect(snap === null || typeof snap === 'object').toBe(true);
  });
});
