import { t } from '../i18n';
import { useBackButton } from '../hooks/useBackButton.js';
import { OverlayPortal } from '../overlays/OverlayHost.js';
import { ListChecksIcon, XIcon } from './icons.jsx';

export function codexPlanSteps(plan) {
  if (Array.isArray(plan?.steps)) return plan.steps;
  if (Array.isArray(plan?.plan)) return plan.plan;
  return [];
}

function planMeta(plan) {
  const steps = codexPlanSteps(plan);
  const completed = steps.filter((item) => item.status === 'completed').length;
  const current = steps.find((item) => item.status === 'inProgress')
    || steps.find((item) => item.status === 'pending') || null;
  return { steps, completed, current };
}

export function CodexPlanBar({ plan, waiting = false, onOpen }) {
  const { steps, current } = planMeta(plan);
  if (!steps.length) return null;
  const position = current ? steps.indexOf(current) + 1 : steps.length;
  const showActivity = current?.status === 'inProgress';
  const detail = waiting && current
    ? t('chat.plan.waiting', { step: current.step })
    : current ? t('chat.plan.working', { step: current.step })
      : t('chat.plan.finalizing');
  const title = t('chat.plan.currentTitle');
  return (
    <button type="button" className="cc-plan-bar"
      aria-label={`${title} ${position}/${steps.length} ${detail}`} onClick={onOpen}>
      <span className="codex-plan-icon" aria-hidden="true"><ListChecksIcon /></span>
      <span className="cc-plan-copy">
        <span className="cc-plan-top"><strong>{title}</strong><span>{position}/{steps.length}</span></span>
        <span className="cc-plan-current">
          {showActivity && <span className={`codex-plan-spinner${waiting ? ' is-static' : ''}`}
            aria-hidden="true" />}
          {detail}
        </span>
      </span>
      <span className="codex-plan-chevron" aria-hidden="true">›</span>
    </button>
  );
}

export function CodexPlanSummary({ plan, onOpen }) {
  const { steps, completed } = planMeta(plan);
  if (!steps.length) return null;
  const done = completed === steps.length;
  const title = t('chat.plan.historyTitle');
  return (
    <button type="button" className="chat-plan-summary"
      aria-label={`${title} ${completed}/${steps.length} ${t(done ? 'chat.plan.complete' : 'chat.plan.incomplete')}`}
      onClick={onOpen}>
      <span className="codex-plan-icon" aria-hidden="true"><ListChecksIcon /></span>
      <span>{title}</span>
      <strong>{completed}/{steps.length}</strong>
      <span className={done ? 'is-complete' : ''}>{t(done ? 'chat.plan.complete' : 'chat.plan.incomplete')}</span>
      <span className="codex-plan-chevron" aria-hidden="true">›</span>
    </button>
  );
}

function PlanSheetContent({ title, plan, onClose, animateInProgress = false }) {
  const { steps, completed } = planMeta(plan);
  return (
    <>
      <div className="codex-plan-backdrop" onClick={onClose} />
      <section className="codex-plan-sheet"
        role="dialog" aria-modal="true" aria-label={title}>
        <div className="tool-sheet-grip" />
        <header className="codex-plan-sheet-head">
          <span className="codex-plan-icon" aria-hidden="true"><ListChecksIcon /></span>
          <strong>{title}</strong>
          <span>{completed}/{steps.length}</span>
        </header>
        <button type="button" className="cmd-close codex-plan-sheet-x"
          aria-label={t('common.close')} onClick={onClose}><XIcon /></button>
        {plan?.explanation && <p className="codex-plan-explanation">{plan.explanation}</p>}
        <ol className="codex-plan-list">
          {steps.map((item, index) => (
            <li className={`is-${item.status}`} key={`${item.step}:${index}`}>
              <span className="codex-plan-status" aria-hidden="true">
                {item.status === 'completed' ? <span>✓</span>
                  : item.status === 'inProgress'
                    ? <span className={`codex-plan-spinner${animateInProgress ? '' : ' is-static'}`} />
                    : index + 1}
              </span>
              <span>{item.step}</span>
              <small>{t(`chat.plan.status.${item.status}`)}</small>
            </li>
          ))}
        </ol>
      </section>
    </>
  );
}

export function CodexPlanSheet({
  open, title, plan, onClose, portal = false, chatTone = 'dusk', keyboardInset = 0,
  animateInProgress = false,
}) {
  useBackButton(open, onClose);
  if (!open || !codexPlanSteps(plan).length) return null;
  const content = <PlanSheetContent title={title} plan={plan} onClose={onClose}
    animateInProgress={animateInProgress} />;
  if (!portal) return content;
  return <OverlayPortal chatTone={chatTone} keyboardInset={keyboardInset}>{content}</OverlayPortal>;
}
