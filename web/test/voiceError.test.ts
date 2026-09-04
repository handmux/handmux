import { describe, expect, it } from 'vitest';
import { ApiError } from '../src/apiErrors.js';
import { voiceErrorText } from '../src/voice/error.js';

describe('voice error messages', () => {
  it('turns missing Tencent CAM permission into an actionable message', () => {
    const message = voiceErrorText(new ApiError(
      'not authorized', 502, 'not authorized', 'AuthFailure.UnauthorizedOperation', 'request-1',
    ));
    expect(message).toContain('asr:SentenceRecognition');
    expect(message).toContain('SecretId');
  });

  it('explains browser microphone permission failures', () => {
    expect(voiceErrorText(new DOMException('denied', 'NotAllowedError'))).toContain('麦克风权限');
  });

  it('does not expose an unknown provider response body', () => {
    const message = voiceErrorText(new ApiError(
      'sensitive provider body', 502, 'sensitive provider body', 'ProviderRejected', 'request-2',
    ));
    expect(message).toContain('ProviderRejected');
    expect(message).not.toContain('sensitive provider body');
  });
});
