import { useState } from 'react';
import { t } from '../i18n';
import Dropdown from './Dropdown.jsx';

// Startup command to auto-run after a window/session is created (typed + Enter in the new shell).
// '' = plain shell (no command). Add presets here as new vibe-coding launchers come up.
const PRESETS = [
  { value: '', label: t('startup.preset_shell') },
  { value: 'claude', label: t('startup.preset_claude') },
  { value: 'claude --continue', label: t('startup.preset_claude_continue') },
  { value: 'handmux codex', label: t('startup.preset_codex') },
];
const CUSTOM = '__custom__';
const OPTIONS = [...PRESETS, { value: CUSTOM, label: t('startup.custom') }];

// Pick a startup command via the themed Dropdown, with a free-text "自定义" fallback. Reports the
// final command string out via onChange ('' = none). `value` seeds the initial selection (e.g. the
// last-used command), read once at mount — the parent owns the value, this just edits it.
export default function StartupCmdPicker({ value = '', onChange }) {
  const isPreset = PRESETS.some((p) => p.value === value);
  const [mode, setMode] = useState(isPreset ? value : CUSTOM);
  const [custom, setCustom] = useState(isPreset ? '' : value);

  const onPick = (m) => { setMode(m); onChange?.(m === CUSTOM ? custom : m); };
  const onCustomInput = (e) => { const c = e.target.value; setCustom(c); onChange?.(c); };

  return (
    <>
      <div className="settings-label">{t('startup.label')}</div>
      <Dropdown value={mode} options={OPTIONS} onChange={onPick} ariaLabel={t('startup.aria')} />
      {mode === CUSTOM && (
        <input
          className="bind-input startup-custom"
          value={custom}
          placeholder={t('startup.custom_placeholder')}
          onChange={onCustomInput}
          autoCapitalize="off"
          autoCorrect="off"
          spellCheck={false}
        />
      )}
    </>
  );
}
