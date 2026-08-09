import { useRef } from 'react';
import type { PointerEvent as ReactPointerEvent } from 'react';
import { MicIcon } from './icons.jsx';
import { t } from '../i18n';

// 内嵌在输入框右内侧的点按麦克风(微信式)。灰色 = 待命,绿色(.on)= 正在听。一点开始听写、再点停止。
// `disabled` 用于请求麦克风权限期间,防重复触发。纯受控,无内部状态。
// 多行时本按钮悬浮在文字上方(.input-wrap.multi),拖光标手柄的触摸可能落在按钮上——pointer capture
// 会让拖走后的 up 仍回到按钮、连 click 都照发。所以不用 onClick,改带位移门槛的 pointer 事件:
// 位移超过 10px 就是拖动、不是点按,松手不触发(和 HoldButton/发送键同款守门)。
export interface MicButtonProps {
  active: boolean;
  disabled?: boolean;
  onToggle: () => void;
}

export default function MicButton({ active, disabled = false, onToggle }: MicButtonProps) {
  const pt = useRef({ x: 0, y: 0, moved: false });
  const down = (event: ReactPointerEvent<HTMLButtonElement>): void => {
    pt.current = { x: event.clientX, y: event.clientY, moved: false };
  };
  const move = (event: ReactPointerEvent<HTMLButtonElement>): void => {
    const p = pt.current;
    if (!p.moved && Math.hypot(event.clientX - p.x, event.clientY - p.y) > 10) p.moved = true;
  };
  const up = (): void => { if (!pt.current.moved) onToggle(); };
  return (
    <button
      type="button"
      className={`input-mic${active ? ' on' : ''}`}
      aria-label={active ? t('mic.stop') : t('mic.start')}
      aria-pressed={active}
      disabled={disabled}
      onPointerDown={down}
      onPointerMove={move}
      onPointerUp={up}
    >
      <MicIcon />
    </button>
  );
}
