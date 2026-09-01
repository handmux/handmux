import { t } from '../i18n';
import { useBackButton } from '../hooks/useBackButton.js';
import { ListChecksIcon, TargetIcon, XIcon } from './icons.jsx';
import type {
  ConversationGoal,
  ConversationPlan,
  ConversationPlanStep,
} from '../conversationTimelineTypes.js';
export type {
  ConversationGoal,
  ConversationPlan,
  ConversationPlanStep,
} from '../conversationTimelineTypes.js';

export function conversationPlanSteps(plan: ConversationPlan | null | undefined): ConversationPlanStep[] {
  if (Array.isArray(plan?.steps)) return plan.steps;
  return Array.isArray(plan?.plan) ? plan.plan : [];
}

function planMeta(plan: ConversationPlan | null | undefined) {
  const steps = conversationPlanSteps(plan);
  const completed = steps.filter((item) => item.status === 'completed').length;
  return { steps, completed };
}

export function ConversationPlanSummary({
  plan,
  onOpen,
}: {
  plan: ConversationPlan;
  onOpen: () => void;
}) {
  const { steps, completed } = planMeta(plan);
  if (!steps.length) return null;
  const done = completed === steps.length;
  const title = t('chat.plan.historyTitle');
  return (
    <button type="button" className="chat-plan-summary"
      aria-label={`${title} ${completed}/${steps.length} ${t(done ? 'chat.plan.complete' : 'chat.plan.incomplete')}`}
      onClick={onOpen}>
      <span className="conversation-plan-icon" aria-hidden="true"><ListChecksIcon /></span>
      <span>{title}</span>
      <strong>{completed}/{steps.length}</strong>
      <span className={done ? 'is-complete' : ''}>{t(done ? 'chat.plan.complete' : 'chat.plan.incomplete')}</span>
      <span className="conversation-plan-chevron" aria-hidden="true">›</span>
    </button>
  );
}

export function ConversationPlanSheet({
  plan,
  onClose,
}: {
  plan: ConversationPlan | null;
  onClose: () => void;
}) {
  const open = plan != null && conversationPlanSteps(plan).length > 0;
  useBackButton(open, onClose);
  if (!open || !plan) return null;
  const { steps, completed } = planMeta(plan);
  const title = t('chat.plan.historyTitle');
  return (
    <>
      <div className="conversation-plan-backdrop" onClick={onClose} />
      <section className="conversation-plan-sheet" role="dialog" aria-modal="true" aria-label={title}>
        <div className="tool-sheet-grip" />
        <header className="conversation-plan-sheet-head">
          <span className="conversation-plan-icon" aria-hidden="true"><ListChecksIcon /></span>
          <strong>{title}</strong>
          <span>{completed}/{steps.length}</span>
        </header>
        <button type="button" className="cmd-close conversation-plan-sheet-x"
          aria-label={t('common.close')} onClick={onClose}><XIcon /></button>
        {plan.explanation && <p className="conversation-plan-explanation">{plan.explanation}</p>}
        <ol className="conversation-plan-list">
          {steps.map((item, index) => (
            <li className={`is-${item.status}`} key={`${item.step}:${index}`}>
              <span className="conversation-plan-status" aria-hidden="true">
                {item.status === 'completed' ? <span>✓</span>
                  : item.status === 'inProgress'
                    ? <span className="conversation-plan-spinner is-static" /> : index + 1}
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

function goalStatusLabel(status: string | undefined): string {
  if (status === 'active') return t('chat.goal.statusActive');
  if (status === 'paused') return t('chat.goal.statusPaused');
  if (status === 'blocked') return t('chat.goal.statusBlocked');
  if (status === 'complete') return t('chat.goal.statusComplete');
  if (status === 'usageLimited') return t('chat.goal.statusUsageLimited');
  if (status === 'budgetLimited') return t('chat.goal.statusBudgetLimited');
  return status || '';
}

function goalEventLabel(goal: ConversationGoal, event?: string | null): string {
  if (event === 'set') return t('chat.goal.eventSet');
  if (event === 'restarted') return t('chat.goal.eventRestarted');
  if (goal.status === 'complete' || event === 'complete') return t('chat.goal.eventComplete');
  if (goal.status === 'blocked' || event === 'blocked') return t('chat.goal.eventBlocked');
  if (goal.status === 'usageLimited' || event === 'usageLimited') return t('chat.goal.eventUsageLimited');
  if (goal.status === 'budgetLimited' || event === 'budgetLimited') return t('chat.goal.eventBudgetLimited');
  return goalStatusLabel(goal.status) || t('chat.goal.title');
}

export function ConversationGoalCard({
  goal,
  event,
  onOpen,
}: {
  goal: ConversationGoal;
  event?: string | null;
  onOpen: (goal: ConversationGoal) => void;
}) {
  if (!goal.objective) return null;
  const label = goalEventLabel(goal, event);
  const userInitiated = event === 'set' || event === 'restarted';
  return (
    <button type="button"
      className={`chat-goal-card is-${event || goal.status || 'set'}${userInitiated ? ' is-user' : ''}`}
      aria-label={`${label} ${goal.objective}`} onClick={() => onOpen(goal)}>
      <span className="conversation-goal-icon" aria-hidden="true"><TargetIcon /></span>
      <span className="chat-goal-copy"><strong>{label}</strong><span>{goal.objective}</span></span>
      <span className="conversation-goal-chevron" aria-hidden="true">›</span>
    </button>
  );
}

export function ConversationGoalSheet({
  goal,
  onClose,
}: {
  goal: ConversationGoal | null;
  onClose: () => void;
}) {
  useBackButton(goal != null, onClose);
  if (!goal) return null;
  const tokens = Number(goal.tokensUsed);
  const budget = goal.tokenBudget == null ? Number.NaN : Number(goal.tokenBudget);
  const elapsed = Number(goal.timeUsedSeconds);
  return (
    <>
      <div className="conversation-goal-backdrop" onClick={onClose} />
      <section className="conversation-goal-menu" role="dialog" aria-modal="true"
        aria-label={t('chat.goal.title')}>
        <div className="tool-sheet-grip" />
        <header className="conversation-goal-head">
          <span className="conversation-goal-icon" aria-hidden="true"><TargetIcon /></span>
          <strong>{t('chat.goal.title')}</strong>
          {goal.status && <span className={`conversation-goal-status ${goal.status}`}>
            {goalStatusLabel(goal.status)}
          </span>}
        </header>
        <button type="button" className="cmd-close conversation-goal-sheet-x"
          aria-label={t('common.close')} onClick={onClose}><XIcon /></button>
        <div className="conversation-goal-body">
          <p className="conversation-goal-objective">{goal.objective}</p>
          {(Number.isFinite(tokens) || Number.isFinite(elapsed)) && (
            <div className="conversation-goal-meta">
              {Number.isFinite(tokens) && <span>{t('chat.goal.tokens', {
                value: Number.isFinite(budget)
                  ? `${tokens.toLocaleString()} / ${budget.toLocaleString()}` : tokens.toLocaleString(),
              })}</span>}
              {Number.isFinite(elapsed) && elapsed > 0 && <span>{t('chat.goal.elapsed', {
                value: Math.round(elapsed).toLocaleString(),
              })}</span>}
            </div>
          )}
        </div>
      </section>
    </>
  );
}
