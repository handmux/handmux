// Lens switch — a ONE-TAP toggle between 终端 / 对话 (not a dropdown or a segmented pair). Tapping flips
// the view. The visible label names the TARGET mode, matching the aria-label/title action, while the swap
// glyph (two opposed arrows) reinforces that it changes views. Rendered by App ONLY for agent panes.
export type WorkspaceLens = 'terminal' | 'chat';

const LABEL: Record<WorkspaceLens, string> = { terminal: '终端', chat: '对话' };

// Two stacked horizontal arrows pointing opposite ways — the standard iOS swap icon. currentColor so it
// inherits the button's text colour in either theme.
function SwapIcon() {
  return (
    <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor"
      strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M4 8h13M13 4l4 4-4 4" />
      <path d="M20 16H7M11 20l-4-4 4-4" />
    </svg>
  );
}

export interface LensSwitchProps {
  value: WorkspaceLens;
  onChange: (lens: WorkspaceLens) => void;
}

export default function LensSwitch({ value, onChange }: LensSwitchProps) {
  const next = value === 'chat' ? 'terminal' : 'chat';
  return (
    <button
      type="button"
      className="lens-toggle"
      onClick={() => onChange(next)}
      aria-label={`切换到${LABEL[next]}视图`}
      title={`切换到${LABEL[next]}视图`}
    >
      <SwapIcon />
      <span className="lens-toggle-label">{LABEL[next]}</span>
    </button>
  );
}
