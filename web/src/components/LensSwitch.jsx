import Dropdown from './Dropdown.jsx';

// Lens switch — 终端 / 对话. Uses the shared themed Dropdown (project rule: no native <select>), not a
// segmented button group (that read as two competing buttons rather than one view-mode setting).
// Rendered by App ONLY for agent panes; a non-agent pane shows no switch at all.
const OPTIONS = [
  { value: 'terminal', label: '终端模式' },
  { value: 'chat', label: '对话模式' },
];

export default function LensSwitch({ value, onChange }) {
  return (
    <div className="lens-dd">
      <Dropdown value={value} options={OPTIONS} onChange={onChange} ariaLabel="视图切换" />
    </div>
  );
}
