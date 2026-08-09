import { useEffect, useRef, useState } from 'react';
import type { CSSProperties, PointerEvent as ReactPointerEvent } from 'react';

const KEY_DIRECTION: Record<string, number> = {
  ArrowLeft: -1,
  ArrowDown: -1,
  ArrowRight: 1,
  ArrowUp: 1,
};

// A compact, discrete slider for short ordered choices. It uses pointer events instead of a native range:
// native range controls take focus on iOS and can dismiss an already-open keyboard. This slider owns its
// drag while deliberately cancelling that focus-changing default action.
export interface DiscreteSliderOption {
  value: string;
  label?: string;
  description?: string;
}

interface DiscreteSliderProps {
  options: DiscreteSliderOption[];
  value?: string | null;
  disabled?: boolean;
  ariaLabel: string;
  onCommit?: (value: string) => void;
}

type SliderStyle = CSSProperties & {
  '--slider-count': number;
  '--slider-progress': string;
};

export default function DiscreteSlider({
  options, value, disabled = false, ariaLabel, onCommit,
}: DiscreteSliderProps) {
  const [draftIndex, setDraftIndex] = useState<number | null>(null);
  const draggingRef = useRef(false);
  const indexRef = useRef(0);
  const values = options.map((option) => option.value);
  const optionKey = values.join('\0');
  const selectedIndex = Math.max(0, value == null ? -1 : values.indexOf(value));
  const shownIndex = draftIndex == null ? selectedIndex : draftIndex;
  indexRef.current = shownIndex;

  useEffect(() => { setDraftIndex(null); }, [value, optionKey]);

  if (options.length === 0) return null;

  const sliderStyle: SliderStyle = {
    '--slider-count': options.length,
    '--slider-progress': options.length > 1
      ? `${(shownIndex / (options.length - 1)) * 100}%` : '0%',
  };

  const preview = (index: number): void => {
    const bounded = Math.min(options.length - 1, Math.max(0, index));
    indexRef.current = bounded;
    setDraftIndex(bounded);
  };
  const commit = (index: number): void => {
    const next = options[index]?.value;
    if (next != null && next !== value) onCommit?.(next);
  };
  const indexAt = (element: HTMLDivElement, clientX: number): number => {
    if (options.length <= 1) return 0;
    const rect = element.getBoundingClientRect();
    const edge = rect.width / (options.length * 2);
    const usableWidth = Math.max(1, rect.width - edge * 2);
    const ratio = Math.min(1, Math.max(0, (clientX - rect.left - edge) / usableWidth));
    return Math.round(ratio * (options.length - 1));
  };
  const previewPointer = (event: ReactPointerEvent<HTMLDivElement>, shouldCommit = false): void => {
    const index = indexAt(event.currentTarget, event.clientX);
    preview(index);
    if (shouldCommit) commit(index);
  };

  return (
    <div className={`discrete-slider${disabled ? ' disabled' : ''}`}
      role="slider" tabIndex={disabled ? -1 : 0}
      aria-disabled={disabled || undefined}
      aria-label={ariaLabel}
      aria-valuemin={0} aria-valuemax={options.length - 1}
      aria-valuenow={shownIndex}
      aria-valuetext={options[shownIndex]?.label || options[shownIndex]?.value || ''}
      style={sliderStyle}
      onPointerDown={(event) => {
        if (disabled) return;
        if (event.cancelable) event.preventDefault();
        draggingRef.current = true;
        event.currentTarget.setPointerCapture?.(event.pointerId);
        previewPointer(event);
      }}
      onPointerMove={(event) => {
        if (draggingRef.current) previewPointer(event);
      }}
      onPointerUp={(event) => {
        if (!draggingRef.current) return;
        draggingRef.current = false;
        previewPointer(event, true);
      }}
      onPointerCancel={() => {
        draggingRef.current = false;
        setDraftIndex(null);
      }}
      onKeyDown={(event) => {
        if (disabled) return;
        let next;
        if (KEY_DIRECTION[event.key]) next = indexRef.current + KEY_DIRECTION[event.key];
        else if (event.key === 'Home') next = 0;
        else if (event.key === 'End') next = options.length - 1;
        else return;
        event.preventDefault();
        preview(next);
      }}
      onKeyUp={(event) => {
        if (KEY_DIRECTION[event.key] || event.key === 'Home' || event.key === 'End') commit(indexRef.current);
      }}>
      <span className="discrete-slider-track" aria-hidden="true"><i /></span>
      <span className="discrete-slider-steps" aria-hidden="true">
        {options.map((option, index) => (
          <span className={index === shownIndex ? 'selected' : ''}
            key={option.value} title={option.description || ''}>
            <i />
            <small>{option.label || option.value}</small>
          </span>
        ))}
      </span>
    </div>
  );
}
