import { describe, it, expect, vi } from 'vitest';
import { renderHook, act, waitFor } from '@testing-library/react';
import { usePushToTalk } from '../src/voice/usePushToTalk.js';
import type {
  PushToTalkDependencies,
  VoiceSocket,
  VoiceSocketConstructor,
} from '../src/voice/usePushToTalk.js';
import type { VoiceRecorder } from '../src/voice/recorder.js';

interface FakeFrame {
  common?: { app_id?: string };
  data: { status: number; audio?: string };
}

interface FakeVoiceSocket extends VoiceSocket {
  sent: FakeFrame[];
  onopen?: () => void;
}

let activeWs: FakeVoiceSocket;

// Fake WS we can drive from the test.
function makeFakeWs(): FakeVoiceSocket {
  const ws: FakeVoiceSocket = {
    sent: [],
    readyState: 1,
    close: vi.fn(),
    send: (message: string) => { ws.sent.push(JSON.parse(message) as FakeFrame); },
    onmessage: null,
    onerror: null,
    onclose: null,
  };
  activeWs = ws;
  return ws;
}
const FakeWebSocket = vi.fn(function FakeWebSocketFactory() {
  return activeWs;
}) as unknown as VoiceSocketConstructor;

function makeDeps(): {
  ws: FakeVoiceSocket;
  fireChunk: (base64: string) => void;
  deps: PushToTalkDependencies;
  recorder: VoiceRecorder & { stop: ReturnType<typeof vi.fn> };
} {
  const ws = makeFakeWs();
  let onChunk: ((base64: string) => void) | null = null;
  const recorder = {
    start: vi.fn(async (callback: (base64: string) => void) => { onChunk = callback; }),
    stop: vi.fn(async () => null),
  } satisfies VoiceRecorder;
  return {
    ws,
    fireChunk: (base64: string) => { onChunk?.(base64); },
    deps: {
      signAsr: vi.fn(async () => ({ url: 'wss://x/v2/iat?a=1', appId: 'APP1' })),
      WebSocketCtor: FakeWebSocket,
      makeRecorder: () => recorder,
    },
    recorder,
  };
}

describe('usePushToTalk', () => {
  it('start → opens ws, first chunk is a status-0 frame with app_id + business', async () => {
    const onText = vi.fn();
    const { ws, fireChunk, deps } = makeDeps();
    const { result } = renderHook(() => usePushToTalk({ onText, deps }));

    await act(async () => { await result.current.start(); });
    act(() => { ws.onopen?.(); });
    act(() => { fireChunk('QUJD'); });

    expect(result.current.state).toBe('recording');
    expect(ws.sent[0].common).toEqual({ app_id: 'APP1' });
    expect(ws.sent[0].data.status).toBe(0);
    expect(ws.sent[0].data.audio).toBe('QUJD');
  });

  it('updates partial from wpgs results', async () => {
    const { ws, fireChunk, deps } = makeDeps();
    const { result } = renderHook(() => usePushToTalk({ onText: vi.fn(), deps }));
    await act(async () => { await result.current.start(); });
    act(() => { ws.onopen?.(); fireChunk('QUJD'); });
    act(() => { ws.onmessage?.({ data: JSON.stringify({ data: { result: { sn: 1, pgs: 'apd', ws: [{ cw: [{ w: '你好' }] }] } } }) }); });
    expect(result.current.partial).toBe('你好');
  });

  it('stop → sends end frame; server final (status 2) → onText(text) and back to idle', async () => {
    const onText = vi.fn();
    const { ws, fireChunk, deps } = makeDeps();
    const { result } = renderHook(() => usePushToTalk({ onText, deps }));
    await act(async () => { await result.current.start(); });
    act(() => { ws.onopen?.(); fireChunk('QUJD'); });
    act(() => { ws.onmessage?.({ data: JSON.stringify({ data: { result: { sn: 1, pgs: 'apd', ws: [{ cw: [{ w: '开始' }] }] } } }) }); });
    await act(async () => { await result.current.stop(); });
    const endFrame = ws.sent[ws.sent.length - 1];
    expect(endFrame.data.status).toBe(2);
    act(() => { ws.onmessage?.({ data: JSON.stringify({ data: { status: 2, result: { sn: 1, pgs: 'apd', ws: [{ cw: [{ w: '开始' }] }] } } }) }); });
    await waitFor(() => expect(result.current.state).toBe('idle'));
    expect(onText).toHaveBeenCalledWith('开始');
  });

  it('sign failure → error state, no throw', async () => {
    const onText = vi.fn();
    const deps: PushToTalkDependencies = {
      signAsr: vi.fn(async () => { throw new Error('503'); }),
      WebSocketCtor: FakeWebSocket,
      makeRecorder: () => ({
        start: vi.fn(async () => {}),
        stop: vi.fn(async () => null),
      }),
    };
    const { result } = renderHook(() => usePushToTalk({ onText, deps }));
    await act(async () => { await result.current.start(); });
    await waitFor(() => expect(result.current.state).toBe('error'));
    expect(onText).not.toHaveBeenCalled();
  });

  it('finalize watchdog: server never returns status 2 → salvages partial via onText, back to idle', async () => {
    vi.useFakeTimers();
    try {
      const onText = vi.fn();
      const { ws, fireChunk, deps } = makeDeps();
      const { result } = renderHook(() => usePushToTalk({ onText, deps }));
      await act(async () => { await result.current.start(); });
      act(() => { ws.onopen?.(); fireChunk('QUJD'); });
      act(() => { ws.onmessage?.({ data: JSON.stringify({ data: { result: { sn: 1, pgs: 'apd', ws: [{ cw: [{ w: '开始' }] }] } } }) }); });
      await act(async () => { await result.current.stop(); });
      expect(result.current.state).toBe('finalizing');
      // 服务器始终不回最终帧:看门狗超时后必须自救,否则永远卡 finalizing(输入框 readOnly 死锁)。
      await act(async () => { await vi.advanceTimersByTimeAsync(5000); });
      expect(result.current.state).toBe('idle');
      expect(onText).toHaveBeenCalledWith('开始');
    } finally {
      vi.useRealTimers();
    }
  });

  it('error is recoverable: after a sign failure, starting again opens a fresh session', async () => {
    const onText = vi.fn();
    const { ws, fireChunk, deps } = makeDeps();
    deps.signAsr = vi.fn()
      .mockRejectedValueOnce(new Error('503'))
      .mockResolvedValue({ url: 'wss://x/v2/iat?a=1', appId: 'APP1' });
    const { result } = renderHook(() => usePushToTalk({ onText, deps }));
    await act(async () => { await result.current.start(); });
    await waitFor(() => expect(result.current.state).toBe('error'));
    // 不能死在 error:再点一次必须能重新起录。
    await act(async () => { await result.current.start(); });
    act(() => { ws.onopen?.(); fireChunk('QUJD'); });
    expect(result.current.state).toBe('recording');
  });

  it('ws closing unexpectedly while recording → salvages partial and returns to idle', async () => {
    const onText = vi.fn();
    const { ws, fireChunk, deps, recorder } = makeDeps();
    const { result } = renderHook(() => usePushToTalk({ onText, deps }));
    await act(async () => { await result.current.start(); });
    act(() => { ws.onopen?.(); fireChunk('QUJD'); });
    act(() => { ws.onmessage?.({ data: JSON.stringify({ data: { result: { sn: 1, pgs: 'apd', ws: [{ cw: [{ w: '半句' }] }] } } }) }); });
    act(() => { ws.onclose?.(); });
    await waitFor(() => expect(result.current.state).toBe('idle'));
    expect(onText).toHaveBeenCalledWith('半句');
    expect(recorder.stop).toHaveBeenCalledTimes(1);
  });

  it('auto-finalizes at the 55s cap (sends end frame, → finalizing) if never released', async () => {
    vi.useFakeTimers();
    try {
      const onText = vi.fn();
      const { ws, fireChunk, deps } = makeDeps();
      const { result } = renderHook(() => usePushToTalk({ onText, deps }));
      await act(async () => { await result.current.start(); });
      act(() => { ws.onopen?.(); fireChunk('QUJD'); });
      expect(result.current.state).toBe('recording');
      await act(async () => { await vi.advanceTimersByTimeAsync(55000); });
      const endFrame = ws.sent[ws.sent.length - 1];
      expect(endFrame.data.status).toBe(2);          // cap actually fired stop()
      expect(result.current.state).toBe('finalizing');
    } finally {
      vi.useRealTimers();
    }
  });
});
