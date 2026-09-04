import { useRef } from 'react';
import type { PointerEvent as ReactPointerEvent } from 'react';
import { MicIcon } from './icons.jsx';
import { t } from '../i18n';

const LEVEL_BARS = [0.42, 0.85, 1, 0.58] as const;

// 内嵌在输入框右内侧的点按麦克风(微信式)。灰色 = 待命,录音时显示绿色实时音量波形。一点开始听写、再点停止。
// `disabled` 用于请求麦克风权限期间,防重复触发。纯受控,无内部状态。
// 多行时本按钮悬浮在文字上方(.input-wrap.multi),拖光标手柄的触摸可能落在按钮上——pointer capture
// 会让拖走后的 up 仍回到按钮、连 click 都照发。所以不用 onClick,改带位移门槛的 pointer 事件:
// 位移超过 10px 就是拖动、不是点按,松手不触发(和 HoldButton/发送键同款守门)。
export interface MicButtonProps {
  active: boolean;
  recognizing?: boolean;
  waveform?: boolean;
  level?: number;
  disabled?: boolean;
  onToggle: () => void;
}

export default function MicButton({
  active, recognizing = false, waveform = false, level = 0, disabled = false, onToggle,
}: MicButtonProps) {
  const pt = useRef({ x: 0, y: 0, moved: false });
  const down = (event: ReactPointerEvent<HTMLButtonElement>): void => {
    pt.current = { x: event.clientX, y: event.clientY, moved: false };
  };
  const move = (event: ReactPointerEvent<HTMLButtonElement>): void => {
    const p = pt.current;
    if (!p.moved && Math.hypot(event.clientX - p.x, event.clientY - p.y) > 10) p.moved = true;
  };
  const up = (): void => { if (!pt.current.moved) onToggle(); };
  const normalizedLevel = Math.max(0, Math.min(1, level));
  return (
    <button
      type="button"
      className={`input-mic${active ? ' on' : ''}${recognizing ? ' recognizing' : ''}`}
      aria-label={recognizing ? t('mic.recognizing') : active ? t('mic.stop') : t('mic.start')}
      aria-pressed={active}
      aria-busy={recognizing || undefined}
      disabled={disabled || recognizing}
      onPointerDown={down}
      onPointerMove={move}
      onPointerUp={up}
    >
      {recognizing ? <span className="input-mic-spinner" aria-hidden="true" />
        : waveform && active ? (
          <span className="input-mic-wave" aria-hidden="true" data-level={normalizedLevel.toFixed(2)}>
            {LEVEL_BARS.map((factor, index) => (
              <span key={index} style={{ height: `${3 + normalizedLevel * 12 * factor}px` }} />
            ))}
          </span>
        ) : <MicIcon />}
    </button>
  );
}
