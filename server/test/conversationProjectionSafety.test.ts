import { describe, expect, it } from 'vitest';
import {
  clipConversationText,
  MAX_CONVERSATION_TEXT_BYTES,
  MAX_TOOL_INPUT_BYTES,
  sanitizeConversationToolItem,
  safeProviderDiffPath,
  safeProviderPathLabel,
  safeRelativeProviderPath,
  sanitizeToolInput,
  sanitizeToolInputWithMetadata,
  sanitizeToolResultText,
  sanitizeToolText,
} from '../src/agents/conversationProjectionSafety.js';

describe('Conversation adapter projection safety', () => {
  it('clips on UTF-8 code-point boundaries without replacement characters', () => {
    const source = `${'你'.repeat(100_000)}🙂tail`;
    const clipped = clipConversationText(source, 256 * 1024 - 1);

    expect(clipped.truncated).toBe(true);
    expect(clipped.originalBytes).toBe(Buffer.byteLength(source));
    expect(Buffer.byteLength(clipped.text)).toBeLessThanOrEqual(256 * 1024 - 1);
    expect(clipped.text).not.toContain('\uFFFD');
  });

  it('removes credentials and local endpoints while keeping useful commands and public URLs', () => {
    const safe = sanitizeToolInput({
      apiKey: 'api-secret', accessToken: 'access-secret', cookie: 'sid=cookie-secret',
      Authorization: 'Bearer auth-secret', credentialsFile: '/Users/alice/.config/keys.json',
      cwd: '/Users/alice/project', savedPath: 'C:\\Users\\alice\\result.png',
      file_path: 'src/app.ts', token_budget: 4_096,
      url: 'https://docs.example.com/reference',
      privateUrl: 'http://127.0.0.1:3000/rpc',
      credentialUrl: 'https://alice:password@example.com/rpc',
      endpoint: 'http://localhost:7777/mcp',
      publicEndpoint: 'https://mcp.example.com/rpc',
      cmd: 'node /Users/alice/project/script.js --config config/local.json',
    });
    const serialized = JSON.stringify(safe);

    expect(safe).toMatchObject({
      cwd: '~/project', savedPath: '~/result.png',
      file_path: 'src/app.ts', token_budget: 4_096,
      url: 'https://docs.example.com/reference',
      publicEndpoint: 'https://mcp.example.com/rpc',
      cmd: 'node ~/project/script.js --config config/local.json',
    });
    expect(serialized).not.toContain('api-secret');
    expect(serialized).not.toContain('access-secret');
    expect(serialized).not.toContain('cookie-secret');
    expect(serialized).not.toContain('auth-secret');
    expect(serialized).not.toContain('/Users/alice');
    expect(serialized).not.toContain('C:\\Users\\alice');
    expect(serialized).not.toContain('127.0.0.1');
    expect(serialized).not.toContain('localhost');
    expect(serialized).not.toContain('alice:password');
    expect(Buffer.byteLength(serialized)).toBeLessThanOrEqual(MAX_TOOL_INPUT_BYTES);
  });

  it('sanitizes and byte-bounds structured and plain tool results', () => {
    const structured = sanitizeToolResultText(JSON.stringify({
      output: '中'.repeat(100_000), token: 'result-secret',
      cwd: '/private/tmp/provider-work', endpoint: 'http://localhost:9000/mcp',
      documentationUrl: 'https://docs.example.com/tool',
    }));
    const plain = sanitizeToolResultText(
      'Authorization: Bearer plain-secret\nfile=/Users/alice/output.txt\n'
        + 'https://bob:password@example.com/private',
    );

    expect(structured.truncated).toBe(true);
    expect(structured.originalBytes).toBeGreaterThan(MAX_CONVERSATION_TEXT_BYTES);
    expect(Buffer.byteLength(structured.text)).toBeLessThanOrEqual(MAX_CONVERSATION_TEXT_BYTES);
    expect(structured.text).not.toContain('\uFFFD');
    expect(structured.text).not.toContain('result-secret');
    expect(structured.text).toContain('/private/tmp/provider-work');
    expect(structured.text).not.toContain('localhost');
    expect(structured.text).toContain('https://docs.example.com/tool');
    expect(plain.text).not.toContain('plain-secret');
    expect(plain.text).not.toContain('/Users/alice');
    expect(plain.text).toContain('~/output.txt');
    expect(plain.text).not.toContain('bob:password');
  });

  it('redacts tool data without presenting redaction as content truncation', () => {
    const input = sanitizeToolInputWithMetadata({
      query: 'keep', token: 'secret', cwd: '/Users/alice/work',
    });
    const item = sanitizeConversationToolItem({
      id: 'pi:tool-1', sessionId: 'session-1', status: 'truncated', kind: 'tool_call',
      truncation: { reason: 'redacted', originalBytes: 100 },
      callId: 'pi:call-1', name: 'mcp', input: { token: 'raw-secret', query: 'keep' },
      extensions: {
        'pi.live': true,
        'conversation.tool': { input: { token: 'extension-secret' }, result: '/Users/alice/out' },
      },
    });

    expect(input).toMatchObject({
      redacted: true, truncated: false, value: { query: 'keep', cwd: '~/work' },
    });
    expect(item).toMatchObject({
      status: 'complete', input: { query: 'keep' },
      extensions: { 'pi.live': true },
    });
    expect(item).not.toHaveProperty('truncation');
    const serialized = JSON.stringify(item);
    expect(serialized).not.toContain('conversation.tool');
    expect(serialized).not.toContain('raw-secret');
    expect(serialized).not.toContain('extension-secret');
    expect(serialized).not.toContain('/Users/alice');
  });

  it('continues to mark genuine size-limit clipping as truncated', () => {
    const item = sanitizeConversationToolItem({
      id: 'pi:large-result', sessionId: 'session-1', status: 'complete', kind: 'tool_result',
      callId: 'pi:call-large', content: [{ type: 'text', text: 'x'.repeat(300 * 1024) }],
    });

    expect(item).toMatchObject({
      status: 'truncated',
      truncation: { reason: 'size_limit', originalBytes: 300 * 1024 },
    });
  });

  it('keeps public endpoint text and rejects signed, credentialed, and private URL variants', () => {
    const publicText = sanitizeToolText(
      'endpoint=https://api.example.com/mcp base_url=https://cdn.example.com/assets',
    );
    const privateText = sanitizeToolText([
      'endpoint=http://100.64.10.2/mcp',
      'base_url=http://service.internal/rpc',
      'server_url=https://user:pass@example.com/rpc',
    ].join('\n'));
    const urls = sanitizeToolInput({
      publicUrl: 'https://api.example.com/mcp#section',
      signedQuery: 'https://api.example.com/mcp?signature=secret',
      signedFragment: 'https://api.example.com/mcp#token=secret',
      cgnat: 'http://100.64.10.2/mcp',
      mapped: 'http://[::ffff:c0a8:101]/mcp',
      metadata: 'http://metadata:8080/credentials',
      localDomain: 'http://provider.local/mcp',
      internalDomain: 'http://provider.internal/mcp',
      lanDomain: 'http://provider.lan/mcp',
    });

    expect(publicText).toEqual({
      text: 'endpoint=https://api.example.com/mcp base_url=https://cdn.example.com/assets',
      redacted: false,
    });
    expect(privateText.redacted).toBe(true);
    expect(privateText.text).not.toContain('100.64.10.2');
    expect(privateText.text).not.toContain('service.internal');
    expect(privateText.text).not.toContain('user:pass');
    expect(urls).toMatchObject({ publicUrl: 'https://api.example.com/mcp#section' });
    const serialized = JSON.stringify(urls);
    expect(serialized).not.toContain('signature=secret');
    expect(serialized).not.toContain('token=secret');
    expect(serialized).not.toContain('100.64.10.2');
    expect(serialized).not.toContain('c0a8:101');
    expect(serialized).not.toContain('metadata:8080');
    expect(serialized).not.toContain('provider.local');
    expect(serialized).not.toContain('provider.internal');
    expect(serialized).not.toContain('provider.lan');
  });

  it('keeps safe relative and absolute paths while abbreviating user homes', () => {
    expect(safeRelativeProviderPath('src/app.ts')).toBe('src/app.ts');
    for (const unsafe of [
      '/Users/alice/app.ts', 'C:\\Users\\alice\\app.ts', '\\\\server\\share\\app.ts',
      '~/project/app.ts', '../project/app.ts', 'src/../secret', 'file:///Users/alice/app.ts',
    ]) expect(safeRelativeProviderPath(unsafe)).toBeUndefined();

    const projected = sanitizeToolInputWithMetadata({
      file_path: '/Users/alice/project/app.ts',
      outputPath: 'C:\\Users\\alice\\build\\result.json',
      relativePath: 'src/components/View.tsx',
      unsafePath: 'src/../secret.ts',
    });
    expect(projected).toMatchObject({
      redacted: true,
      value: {
        file_path: '~/project/app.ts', outputPath: '~/build/result.json',
        relativePath: 'src/components/View.tsx',
      },
    });
    expect(projected.value).not.toHaveProperty('unsafePath');
    expect(JSON.stringify(projected.value)).not.toContain('/Users/alice');
    expect(JSON.stringify(projected.value)).not.toContain('C:\\Users');
    expect(sanitizeToolInput({ file_path: '/Users/a/../secret.ts' })).toEqual({});
    expect(sanitizeToolInput({ file_path: 'C:\\a\\..\\secret.ts' })).toEqual({});
    expect(safeProviderPathLabel('file:///Users/alice/project/app.ts')).toBe('~/project/app.ts');
    expect(safeProviderPathLabel('file://remote-host/share/app.ts')).toBeUndefined();
    expect(safeProviderDiffPath('src/app.ts')).toBe('src/app.ts');
    expect(safeProviderDiffPath('/Users/alice/project/app.ts')).toBe('~/project/app.ts');
    expect(safeProviderDiffPath('/private/tmp/generated.patch')).toBeUndefined();
    expect(safeProviderDiffPath('C:\\temp\\generated.patch')).toBeUndefined();

    const item = sanitizeConversationToolItem({
      id: 'pi:result-link', sessionId: 'session-1', status: 'complete', kind: 'tool_result',
      callId: 'pi:call-link', content: [
        { type: 'external_link', url: 'https://user:pass@example.com/private' },
        { type: 'external_link', url: 'https://docs.example.com/public' },
      ],
    });
    expect(item).toMatchObject({
      status: 'complete',
      content: [{ type: 'external_link', url: 'https://docs.example.com/public' }],
    });
    expect(item).not.toHaveProperty('truncation');
    expect(JSON.stringify(item)).not.toContain('user:pass');
  });
});
