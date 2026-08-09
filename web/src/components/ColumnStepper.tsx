import { t } from '../i18n';

// Compact iOS-style stepper used inside the window/pane management sheets. The caller owns the
// target and the optimistic value so this control can never accidentally resize "whatever is current".
interface ColumnStepperProps {
  label: string;
  cols: number;
  onAdjust: (step: number, cols: number) => void;
  onRestore: () => void;
  restoreLabel: string;
  restoreDisabled?: boolean;
}

export default function ColumnStepper({
  label, cols, onAdjust, onRestore, restoreLabel, restoreDisabled = false,
}: ColumnStepperProps) {
  const steps = [-10, -1, 1, 10];
  return (
    <div className="sheet-size-control">
      <div className="sheet-size-head">
        <span className="settings-label">{label}</span>
        <span className="sheet-size-value">{t('resize.columns', { n: cols })}</span>
      </div>
      <div className="sheet-size-buttons">
        {steps.map((step) => (
          <button
            key={step}
            type="button"
            className={`fontbtn col-step${Math.abs(step) === 1 ? ' col-fine' : ''}`}
            aria-label={`${label} ${step > 0 ? '+' : '−'}${Math.abs(step)}`}
            onClick={() => onAdjust(step, cols)}
          >
            {step > 0 ? '+' : '−'}{Math.abs(step)}
          </button>
        ))}
        <button type="button" className="fontbtn sheet-size-restore" disabled={restoreDisabled}
          aria-label={restoreLabel} title={restoreLabel} onClick={onRestore}>
          ↺ {t('resize.restore')}
        </button>
      </div>
    </div>
  );
}
