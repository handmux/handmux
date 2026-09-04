import { ApiError } from '../apiErrors.js';
import { t } from '../i18n';

const namedError = (value: unknown): { name: string; message: string } => {
  if (value instanceof Error) return { name: value.name, message: value.message };
  if (value && typeof value === 'object') {
    const record = value as Record<string, unknown>;
    return {
      name: typeof record.name === 'string' ? record.name : '',
      message: typeof record.message === 'string' ? record.message : '',
    };
  }
  return { name: '', message: String(value ?? '') };
};

// Voice failures originate in three different places: browser capture, a provider WebSocket, or the
// sentence-recognition API. Normalize them here so every composer shows the same actionable message.
export function voiceErrorText(error: unknown): string {
  if (error instanceof ApiError) {
    if (error.code === 'AuthFailure.UnauthorizedOperation') return t('mic.error.tencentPermission');
    if (error.code?.startsWith('AuthFailure.') || error.code?.includes('SecretId')) {
      return t('mic.error.tencentCredentials');
    }
    if (error.code === 'audio_too_large') return t('mic.error.tooLong');
    if (error.code === 'sentence_asr_not_selected') return t('mic.error.notSelected');
    if (error.code === 'TencentNetworkError' || /timeout/i.test(error.message)) return t('mic.error.network');
    if (error.code) return t('mic.error.provider', { reason: error.code });
    return t('mic.error.generic');
  }

  const { name, message } = namedError(error);
  if (name === 'NotAllowedError') return t('mic.error.browserPermission');
  if (name === 'NotFoundError' || name === 'DevicesNotFoundError'
    || name === 'NotReadableError' || name === 'TrackStartError') return t('mic.error.device');
  if (name === 'SecurityError' || name === 'TypeError'
    && (typeof navigator === 'undefined' || !navigator.mediaDevices?.getUserMedia)) {
    return t('mic.error.secureContext');
  }
  if (/timeout|network|failed to fetch|websocket/i.test(message)) return t('mic.error.network');
  return t('mic.error.generic');
}
