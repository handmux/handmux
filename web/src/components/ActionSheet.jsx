import { useEffect, useState } from 'react';
import { t } from '../i18n';

// A small action menu over the settings-card chrome. Each action is
// { key, label, icon?, danger?, confirm?, confirmLabel?, onClick }. `icon` (an inline <svg> node)
// renders left of the label for pane/split actions, matching the app's line-icon set. A `confirm` action needs two taps:
// the first arms it (its label switches to confirmLabel), a second fires onClick. Tapping a
// different action or 取消 disarms. (Two-tap confirm mirrors BindSession — no separate dialog.)
export default function ActionSheet({ open, title, actions = [], onClose }) {
  const [armed, setArmed] = useState(null); // key of the confirm action currently armed
  useEffect(() => { if (!open) setArmed(null); }, [open]);
  if (!open) return null;

  const pick = (a) => {
    if (a.disabled) return;
    if (a.confirm && armed !== a.key) { setArmed(a.key); return; }
    setArmed(null);
    a.onClick?.();
  };

  // An action renders as a full-width button; an ARRAY of actions renders as one row of equal-width
  // buttons (used for the ◀/▶ reorder pair so they share a line instead of stacking).
  const renderAction = (a) => (
    <button
      key={a.key}
      className={`sheet-action ${a.danger ? 'danger' : ''} ${armed === a.key ? 'armed' : ''}`}
      disabled={a.disabled}
      onClick={() => pick(a)}
    >
      {a.icon && armed !== a.key && <span className="sheet-action-icon" aria-hidden="true">{a.icon}</span>}
      {a.confirm && armed === a.key ? (a.confirmLabel || t('actionsheet.confirmAgain')) : a.label}
    </button>
  );

  return (
    <>
      <div className="settings-backdrop" onClick={onClose} />
      <div className="settings-card" role="dialog" aria-label={title} aria-modal="true">
        <div className="settings-head">
          <span className="settings-title">{title}</span>
          <button className="settings-close" onClick={onClose} aria-label={t('common.close')}>✕</button>
        </div>
        <div className="settings-section sheet-actions">
          {actions.map((a, i) => (Array.isArray(a)
            ? <div key={`row-${i}`} className="sheet-row">{a.map(renderAction)}</div>
            : renderAction(a)))}
          <button className="fontbtn sheet-cancel" onClick={onClose}>{t('common.cancel')}</button>
        </div>
      </div>
    </>
  );
}
