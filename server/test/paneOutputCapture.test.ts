import { EventEmitter } from 'node:events';
import { describe, expect, it, vi } from 'vitest';
import { TmuxPaneOutputCapture } from '../src/tmux/paneOutputCapture.js';

class FakeStdin extends EventEmitter {
  constructor(readonly writes: string[]) { super(); }

  write(value: string, callback?: (error?: Error | null) => void): boolean {
    this.writes.push(value);
    callback?.();
    return true;
  }
}

class FakeChild extends EventEmitter {
  readonly stdout = new EventEmitter();
  readonly stderr = new EventEmitter();
  readonly writes: string[] = [];
  readonly stdin = new FakeStdin(this.writes);
  readonly kill = vi.fn();

  lines(...lines: string[]): void {
    this.stdout.emit('data', Buffer.from(`${lines.join('\n')}\n`));
  }
}

describe('TmuxPaneOutputCapture', () => {
  async function startCapture(capture: TmuxPaneOutputCapture, child: FakeChild): Promise<void> {
    const started = capture.start();
    child.lines('%begin 1 1 0', '%end 1 1 0', '%session-changed $1 work');
    await started;
  }

  it('uses the send-keys command end as the freshness boundary, including one control chunk', async () => {
    const child = new FakeChild();
    const spawnControl = vi.fn(() => child);
    const capture = new TmuxPaneOutputCapture({
      pane: '%7', session: '$1', spawnControl,
    });
    expect(spawnControl).toHaveBeenCalledWith(
      'tmux', ['-C', 'attach-session', '-E', '-t', '$1'], { stdio: ['pipe', 'pipe', 'pipe'] },
    );
    await startCapture(capture, child);
    child.lines('%output %7 stale-notice');

    const interrupted = capture.sendKey('C-c');
    await vi.waitFor(() => expect(child.writes.at(-1)).toContain('send-keys -t %7 C-c'));
    child.lines(
      '%output %7 before-boundary',
      '%begin 2 2 1',
      '%end 2 2 1',
      '%output %7 fresh\\040notice\\015\\012',
    );
    await interrupted;

    expect(capture.output()).toEqual(Buffer.from('fresh notice\r\n'));
    capture.close();
  });

  it('concatenates split UTF-8 and escaped output without inventing line breaks', async () => {
    const child = new FakeChild();
    const capture = new TmuxPaneOutputCapture({
      pane: '%8', session: '$1', spawnControl: () => child,
    });
    await startCapture(capture, child);
    const interrupted = capture.sendKey('C-c');
    await vi.waitFor(() => expect(child.writes.at(-1)).toContain('send-keys -t %8 C-c'));
    child.lines('%begin 2 2 1', '%end 2 2 1');
    await interrupted;
    child.lines(
      '%output %8 To\\040continue\\040this\\040session,\\040run\\040codex\\040res',
      '%output %8 ume,\\040then\\040select\\040标题\\040(12345678-1234-1234-1234-',
      '%output %8 123456789abc)\\015\\012',
    );
    expect(capture.output()?.toString('utf8')).toBe(
      'To continue this session, run codex resume, then select 标题 '
      + '(12345678-1234-1234-1234-123456789abc)\r\n',
    );
    const frames = capture.outputFrames();
    expect(frames?.map((frame) => frame.toString('utf8'))).toEqual([
      'To continue this session, run codex res',
      'ume, then select 标题 (12345678-1234-1234-1234-',
      '123456789abc)\r\n',
    ]);
    if (frames?.[0]) frames[0][0] = 0x58;
    expect(capture.output()?.toString('utf8')).toMatch(/^To continue/);
    capture.close();
  });

  it('restarts the freshness boundary on a second interrupt', async () => {
    const child = new FakeChild();
    const capture = new TmuxPaneOutputCapture({
      pane: '%10', session: '$1', spawnControl: () => child,
    });
    await startCapture(capture, child);
    const first = capture.sendKey('C-c');
    await vi.waitFor(() => expect(child.writes).toHaveLength(1));
    child.lines('%begin 2 2 1', '%end 2 2 1', '%output %10 first');
    await first;
    expect(capture.output()?.toString()).toBe('first');

    const second = capture.sendKey('C-c');
    await vi.waitFor(() => expect(child.writes).toHaveLength(2));
    child.lines(
      '%output %10 old-after-first',
      '%begin 3 3 1',
      '%end 3 3 1',
      '%output %10 second',
    );
    await second;
    expect(capture.output()?.toString()).toBe('second');
    capture.close();
  });

  it('fails closed after overflow or control connection failure', async () => {
    const child = new FakeChild();
    const capture = new TmuxPaneOutputCapture({
      pane: '%9', session: '$1', maxBytes: 4, spawnControl: () => child,
    });
    await startCapture(capture, child);
    const interrupted = capture.sendKey('C-c');
    await vi.waitFor(() => expect(child.writes.at(-1)).toContain('send-keys -t %9 C-c'));
    child.lines('%begin 2 2 1', '%end 2 2 1', '%output %9 12345');
    await interrupted;
    expect(capture.output()).toBeNull();
    expect(capture.outputFrames()).toBeNull();
    child.emit('exit', 1);
    expect(capture.output()).toBeNull();
    expect(capture.outputFrames()).toBeNull();
    capture.close();
  });

  it('rejects an in-flight command and kills the control client when closed', async () => {
    const child = new FakeChild();
    const capture = new TmuxPaneOutputCapture({
      pane: '%11', session: '$1', spawnControl: () => child,
    });
    await startCapture(capture, child);
    const interrupted = capture.sendKey('C-c');
    await vi.waitFor(() => expect(child.writes).toHaveLength(1));

    capture.close();

    await expect(interrupted).rejects.toThrow(/closed/);
    expect(child.kill).toHaveBeenCalledOnce();
  });

  it('rejects startup and kills the control client when closed before attach', async () => {
    const child = new FakeChild();
    const capture = new TmuxPaneOutputCapture({
      pane: '%12', session: '$1', spawnControl: () => child,
    });
    const started = capture.start();

    capture.close();

    await expect(started).rejects.toThrow(/closed/);
    expect(child.kill).toHaveBeenCalledOnce();
  });

  it('fails closed without an unhandled error when the control stdin races with exit', async () => {
    const child = new FakeChild();
    const capture = new TmuxPaneOutputCapture({
      pane: '%13', session: '$1', spawnControl: () => child,
    });
    await startCapture(capture, child);
    const interrupted = capture.sendKey('C-c');
    await vi.waitFor(() => expect(child.writes).toHaveLength(1));

    child.stdin.emit('error', new Error('write EPIPE'));

    await expect(interrupted).rejects.toThrow(/EPIPE/);
    expect(capture.output()).toBeNull();
    capture.close();
    capture.close();
    expect(child.kill).toHaveBeenCalledOnce();
  });
});
