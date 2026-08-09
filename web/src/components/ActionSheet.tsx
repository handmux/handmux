import { useEffect, useState } from 'react';
import type { ReactNode } from 'react';
import { t } from '../i18n';

export interface ActionSheetAction {
  key: string;
  label: ReactNode;
  icon?: ReactNode;
  danger?: boolean;
  confirm?: boolean;
  confirmLabel?: ReactNode;
  disabled?: boolean;
  onClick?: () => void | Promise<void>;
}

export type ActionSheetItem = ActionSheetAction | readonly ActionSheetAction[];

export interface ActionSheetProps {
  open: boolean;
  title: string;
  subtitle?: string;
  actions?: readonly ActionSheetItem[];
  onClose: () => void;
  children?: ReactNode;
}

const isActionRow = (item: ActionSheetItem): item is readonly ActionSheetAction[] => Array.isArray(item);

// A small action menu over the settings-card chrome. Each action is
// { key, label, icon?, danger?, confirm?, confirmLabel?, onClick }. `icon` (an inline <svg> node)
// renders left of the label for pane/split actions, matching the app's line-icon set. A `confirm` action needs two taps:
// the first arms it (its label switches to confirmLabel), a second fires onClick. Tapping a
// different action or 取消 disarms. (Two-tap confirm mirrors BindSession — no separate dialog.)
export default function ActionSheet({
  open,
  title,
  subtitle = '',
  actions = [],
  onClose,
  children = null,
}: ActionSheetProps) {
  const [armed, setArmed] = useState<string | null>(null); // key of the confirm action currently armed
  useEffect(() => { if (!open) setArmed(null); }, [open]);
  if (!open) return null;

  const pick = (action: ActionSheetAction): void => {
    if (action.disabled) return;
    if (action.confirm && armed !== action.key) { setArmed(action.key); return; }
    setArmed(null);
    void action.onClick?.();
  };

  // An action renders as a full-width button; an ARRAY of actions renders as one row of equal-width
  // buttons (used for the ◀/▶ reorder pair so they share a line instead of stacking).
  const renderAction = (action: ActionSheetAction) => (
    <button
      key={action.key}
      className={`sheet-action ${action.danger ? 'danger' : ''} ${armed === action.key ? 'armed' : ''}`}
      disabled={action.disabled}
      onClick={() => pick(action)}
    >
      {action.icon && armed !== action.key && <span className="sheet-action-icon" aria-hidden="true">{action.icon}</span>}
      {action.confirm && armed === action.key ? (action.confirmLabel || t('actionsheet.confirmAgain')) : action.label}
    </button>
  );

  return (
    <>
      <div className="settings-backdrop" onClick={onClose} />
      <div className="settings-card" role="dialog" aria-label={subtitle ? `${title}，${subtitle}` : title} aria-modal="true">
        <div className="settings-head">
          <span className="settings-heading">
            <span className="settings-title">{title}</span>
            {subtitle && <span className="settings-subtitle">{subtitle}</span>}
          </span>
          <button className="settings-close" onClick={onClose} aria-label={t('common.close')}>✕</button>
        </div>
        <div className="settings-section sheet-actions">
          {children}
          {actions.map((action, index) => (isActionRow(action)
            ? <div key={`row-${index}`} className="sheet-row">{action.map(renderAction)}</div>
            : renderAction(action)))}
          <button className="fontbtn sheet-cancel" onClick={onClose}>{t('common.cancel')}</button>
        </div>
      </div>
    </>
  );
}
