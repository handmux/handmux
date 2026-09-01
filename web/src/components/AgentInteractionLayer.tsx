import { useEffect, useState } from 'react';
import { t } from '../i18n';
import type { AgentInteractionController } from '../hooks/useAgentInteraction.js';
import type { AgentInteractionValue, PendingAgentInteraction } from '../agentInteractionTypes.js';

function responseValue(
  interaction: PendingAgentInteraction,
  selected: string[],
  text: string,
  answers: Record<string, string>,
): AgentInteractionValue | null {
  if (interaction.type === 'approval') {
    return selected[0] ? { type: 'approval', optionId: selected[0] } : null;
  }
  if (interaction.type === 'select' || interaction.type === 'multi_select') {
    return selected.length ? { type: 'selection', optionIds: selected } : null;
  }
  if (interaction.type === 'text' || interaction.type === 'editor') {
    return text.trim() ? { type: 'text', text } : null;
  }
  if (interaction.type === 'form' && interaction.fields?.length
    && interaction.fields.every((field) => {
      const answer = answers[field.id];
      return typeof answer === 'string'
        && (field.type === 'secret' ? answer.length > 0 : !!answer.trim());
    })) {
    return {
      type: 'form',
      answers: Object.fromEntries(interaction.fields.map((field) => [
        field.id, answers[field.id]!,
      ])),
    };
  }
  return null;
}

function interactionPrompt(interaction: PendingAgentInteraction): string {
  if (interaction.intent === 'command_approval') {
    return t('agentConversation.interactionCommandApproval');
  }
  if (interaction.intent === 'file_approval') {
    return t('agentConversation.interactionFileApproval');
  }
  if (interaction.intent === 'permission_approval') {
    return t('agentConversation.interactionPermissionApproval');
  }
  if (interaction.intent === 'input_request') {
    return t('agentConversation.interactionInputRequest');
  }
  return interaction.prompt;
}

function detailLabel(detail: NonNullable<PendingAgentInteraction['details']>[number]): string | null {
  if (detail.kind === 'reason') return t('agentConversation.interactionReason');
  if (detail.kind === 'command') return t('agentConversation.interactionCommand');
  if (detail.kind === 'working_directory') return t('agentConversation.interactionWorkingDirectory');
  if (detail.kind === 'context') return t('agentConversation.interactionContext');
  return null;
}

function InteractionDetails({ interaction }: { interaction: PendingAgentInteraction }) {
  if (!interaction.details?.length) return null;
  return <div className="agent-interaction-details">{interaction.details.map((detail, index) => {
    const label = detailLabel(detail);
    return (
      <div className={`agent-interaction-detail is-${detail.type}`} key={`${detail.type}:${index}`}>
        {label && <div className="agent-interaction-detail-label">{label}</div>}
        {detail.type === 'code'
          ? <pre className="agent-interaction-code">{detail.text}</pre>
          : <div className={detail.type === 'path'
            ? 'agent-interaction-path' : 'agent-interaction-text'}>{detail.text}</div>}
      </div>
    );
  })}</div>;
}

export default function AgentInteractionLayer({
  controller,
  onOpenTerminal,
  waiting = false,
}: {
  controller: AgentInteractionController;
  onOpenTerminal?: () => void;
  waiting?: boolean;
}) {
  const interaction = controller.pending[0] ?? null;
  const [selected, setSelected] = useState<string[]>([]);
  const [text, setText] = useState('');
  const [answers, setAnswers] = useState<Record<string, string>>({});
  const [error, setError] = useState('');
  useEffect(() => {
    setSelected([]);
    setText('');
    setAnswers({});
    setError('');
  }, [interaction?.id]);
  if (!interaction) {
    if (!waiting || (controller.status !== 'reconnecting' && controller.status !== 'error')) return null;
    return (
      <div className="chat-gate agent-interaction-layer chat-terminal-gate"
        role="status" aria-live="polite">
        <div className="chat-gate-prompt">{t('agentConversation.interactionUnavailable')}</div>
        <div className="chat-gate-hint">{t('agentConversation.interactionTerminal')}</div>
        {onOpenTerminal && <div className="chat-gate-actions">
          <button type="button" className="chat-gate-btn primary" onClick={onOpenTerminal}>
            {t('agentConversation.openTerminal')}
          </button>
        </div>}
      </div>
    );
  }
  const value = responseValue(interaction, selected, text, answers);
  const busy = controller.respondingId === interaction.id;
  const controllerError = controller.error === 'response_failed'
    ? t('agentConversation.interactionResponseFailed')
    : controller.error ? t('agentConversation.interactionUnavailable') : '';
  const submit = (): void => {
    if (!value || busy) return;
    setError('');
    void controller.respond(interaction, value).catch(() => {
      setError(t('agentConversation.interactionResponseFailed'));
    });
  };
  return (
    <div className="chat-gate agent-interaction-layer" role="dialog" aria-modal="true">
      <div className="chat-gate-prompt">{interactionPrompt(interaction)}</div>
      <InteractionDetails interaction={interaction} />
      {interaction.options && (
        <div className="chat-gate-options" role={interaction.type === 'multi_select'
          ? 'group' : 'radiogroup'}>
          {interaction.options.map((option) => {
            const active = selected.includes(option.id);
            return (
              <button key={option.id} type="button"
                role={interaction.type === 'multi_select' ? 'checkbox' : 'radio'}
                aria-checked={active} className={`chat-gate-opt${active ? ' on' : ''}`}
                disabled={busy} onClick={() => setSelected((current) => (
                  interaction.type === 'multi_select'
                    ? active ? current.filter((id) => id !== option.id) : [...current, option.id]
                    : [option.id]
                ))}>
                <span className="chat-gate-opt-label">{option.label}</span>
                {option.description
                  && <span className="chat-gate-opt-desc">{option.description}</span>}
              </button>
            );
          })}
        </div>
      )}
      {(interaction.type === 'text' || interaction.type === 'editor') && (
        <textarea className="chat-gate-input" value={text} disabled={busy} autoFocus
          rows={interaction.type === 'editor' ? 4 : 2}
          onChange={(event) => setText(event.target.value)} />
      )}
      {interaction.type === 'form' && interaction.fields && (
        <div className="agent-interaction-form">
          {interaction.fields.map((field) => {
            const answer = answers[field.id] ?? '';
            const optionIds = new Set(field.options?.map((option) => option.id) ?? []);
            const otherValue = optionIds.has(answer) ? '' : answer;
            const update = (next: string): void => setAnswers((current) => ({
              ...current, [field.id]: next,
            }));
            return (
              <section className="agent-interaction-field" key={field.id}>
                {field.label && <div className="chat-gate-step">{field.label}</div>}
                <div className="chat-gate-prompt">{field.prompt}</div>
                {field.options && <div className="chat-gate-options" role="radiogroup">
                  {field.options.map((option) => (
                    <button key={option.id} type="button" role="radio"
                      aria-checked={answer === option.id}
                      className={`chat-gate-opt${answer === option.id ? ' on' : ''}`}
                      disabled={busy} onClick={() => update(option.id)}>
                      <span className="chat-gate-opt-label">{option.label}</span>
                      {option.description
                        && <span className="chat-gate-opt-desc">{option.description}</span>}
                    </button>
                  ))}
                </div>}
                {(field.type !== 'select' || field.allowOther) && (
                  <input className="agent-interaction-input"
                    aria-label={field.prompt}
                    type={field.type === 'secret' ? 'password' : 'text'}
                    autoComplete={field.type === 'secret' ? 'off' : undefined}
                    value={field.type === 'select' ? otherValue : answer}
                    disabled={busy}
                    placeholder={field.type === 'select'
                      ? t('agentConversation.interactionOther')
                      : t('agentConversation.interactionPlaceholder')}
                    onChange={(event) => update(event.target.value)} />
                )}
              </section>
            );
          })}
        </div>
      )}
      {interaction.type === 'local_only' && (
        <div className="chat-gate-hint">{t('agentConversation.interactionTerminal')}</div>
      )}
      {(error || controller.error) && (
        <div className="chat-turn-notice is-warning" role="status">
          {error || controllerError}
        </div>
      )}
      <div className="chat-gate-actions">
        {interaction.type === 'local_only' ? (
          <button type="button" className="chat-gate-btn primary" onClick={onOpenTerminal}>
            {t('agentConversation.openTerminal')}
          </button>
        ) : (
          <button type="button" className="chat-gate-btn primary" disabled={!value || busy}
            onClick={submit}>{busy ? t('common.loading') : t('common.confirm')}</button>
        )}
      </div>
    </div>
  );
}
