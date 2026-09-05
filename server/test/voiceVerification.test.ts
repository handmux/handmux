import { EventEmitter } from 'node:events';
import { describe, expect, it, vi } from 'vitest';
import { verifyTencentAsr } from '../src/asr/providers/tencent.js';
import { verifyXfyunAsr } from '../src/asr/providers/xfyun.js';
import type { TencentAsrConfig, XfyunAsrConfig } from '../src/asr/providerRegistry.js';
import type { VoiceProbeSocket } from '../src/asr/verify.js';

class FakeSocket extends EventEmitter {
  readonly sent: Array<string | Uint8Array> = [];
  terminated = false;
  onSend?: () => void;

  send(data: string | Uint8Array): void {
    this.sent.push(data);
    this.onSend?.();
  }

  terminate(): void { this.terminated = true; }
}

const asProbeSocket = (socket: FakeSocket): VoiceProbeSocket => socket as unknown as VoiceProbeSocket;

function successfulTencentSocket(): FakeSocket {
  const socket = new FakeSocket();
  socket.onSend = () => {
    if (socket.sent.length === 2) {
      queueMicrotask(() => socket.emit('message', JSON.stringify({ code: 0, message: 'success' })));
    }
  };
  return socket;
}

describe('voice provider verification', () => {
  it('verifies Tencent real-time credentials through a signed WebSocket probe', async () => {
    const socket = successfulTencentSocket();
    let signedUrl = '';
    const config: TencentAsrConfig = {
      provider: 'tencent', mode: 'streaming', appId: '123456',
      secretId: 'AKID-example', secretKey: 'DO-NOT-LEAK', engineModelType: '16k_zh',
    };
    const verification = verifyTencentAsr(config, {
      socketFactory: (url) => {
        signedUrl = url;
        queueMicrotask(() => socket.emit('open'));
        return asProbeSocket(socket);
      },
    });
    await expect(verification).resolves.toBeUndefined();
    expect(new URL(signedUrl).pathname).toBe('/asr/v2/123456');
    expect(signedUrl).not.toContain(config.secretKey);
    expect(socket.sent[0]).toBeInstanceOf(Uint8Array);
    expect(socket.sent[1]).toBe(JSON.stringify({ type: 'end' }));
    expect(socket.terminated).toBe(true);
  });

  it('verifies Tencent sentence credentials, permissions, and model with one second of silent PCM', async () => {
    const socket = successfulTencentSocket();
    const fetchMock = vi.fn(async (_input: string | URL | Request, _init?: RequestInit) => new Response(JSON.stringify({
      Response: { Result: '', RequestId: 'verify-1' },
    }), { status: 200, headers: { 'Content-Type': 'application/json' } }));
    const config: TencentAsrConfig = {
      provider: 'tencent', mode: 'sentence', appId: '123456',
      secretId: 'AKID-example', secretKey: 'DO-NOT-LEAK', engineModelType: '16k_zh',
    };
    await expect(verifyTencentAsr(config, {
      fetch: fetchMock as typeof fetch,
      socketFactory: () => {
        queueMicrotask(() => socket.emit('open'));
        return asProbeSocket(socket);
      },
    }))
      .resolves.toBeUndefined();
    const init = fetchMock.mock.calls[0]?.[1];
    expect(JSON.parse(String(init?.body))).toMatchObject({
      DataLen: 32_000, VoiceFormat: 'pcm', EngSerViceType: '16k_zh',
    });
    expect(String(init?.body)).not.toContain(config.secretKey);
  });

  it('rejects a Tencent sentence configuration when its AppId fails the streaming probe', async () => {
    const socket = new FakeSocket();
    socket.onSend = () => {
      if (socket.sent.length === 2) {
        queueMicrotask(() => socket.emit('message', JSON.stringify({
          code: 4002, message: 'AppID does not match',
        })));
      }
    };
    const fetchMock = vi.fn();
    const config: TencentAsrConfig = {
      provider: 'tencent', mode: 'sentence', appId: 'wrong-app-id',
      secretId: 'AKID-example', secretKey: 'DO-NOT-LEAK', engineModelType: '16k_zh',
    };
    await expect(verifyTencentAsr(config, {
      fetch: fetchMock as typeof fetch,
      socketFactory: () => {
        queueMicrotask(() => socket.emit('open'));
        return asProbeSocket(socket);
      },
    })).rejects.toMatchObject({ code: 'tencent_4002' });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('verifies XFYUN with its real first and end frames and surfaces a provider rejection', async () => {
    const config: XfyunAsrConfig = {
      provider: 'xfyun', mode: 'streaming', appId: 'app', apiKey: 'key', apiSecret: 'DO-NOT-LEAK',
    };
    const successSocket = new FakeSocket();
    successSocket.onSend = () => {
      if (successSocket.sent.length === 2) {
        queueMicrotask(() => successSocket.emit('message', Buffer.from(JSON.stringify({ code: 0 }))));
      }
    };
    await expect(verifyXfyunAsr(config, {
      socketFactory: () => {
        queueMicrotask(() => successSocket.emit('open'));
        return asProbeSocket(successSocket);
      },
    })).resolves.toBeUndefined();
    expect(JSON.parse(String(successSocket.sent[0]))).toMatchObject({
      common: { app_id: 'app' }, data: { status: 0, encoding: 'raw' },
    });
    expect(JSON.parse(String(successSocket.sent[1]))).toMatchObject({ data: { status: 2 } });

    const rejectedSocket = new FakeSocket();
    rejectedSocket.onSend = () => {
      if (rejectedSocket.sent.length === 2) {
        queueMicrotask(() => rejectedSocket.emit('message', JSON.stringify({
          code: 10_005, message: 'invalid credentials',
        })));
      }
    };
    let caught: unknown;
    try {
      await verifyXfyunAsr(config, {
        socketFactory: () => {
          queueMicrotask(() => rejectedSocket.emit('open'));
          return asProbeSocket(rejectedSocket);
        },
      });
    } catch (error) { caught = error; }
    expect(caught).toMatchObject({ code: 'xfyun_10005' });
    expect(String(caught)).not.toContain(config.apiSecret);
  });
});
