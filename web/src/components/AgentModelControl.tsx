import { useEffect, useState } from 'react';
import { t } from '../i18n';
import { useBackButton } from '../hooks/useBackButton.js';
import type { AgentSessionControlController } from '../hooks/useAgentSessionControl.js';
import type { AgentModelControlPatch, AgentModelOption } from '../agentSessionControlApi.js';
import { BoltIcon, ChevronDownIcon, GaugeIcon, RefreshIcon } from './icons.jsx';
import DiscreteSlider from './DiscreteSlider.jsx';

function isFastTier(tier: { id: string } | null | undefined): boolean {
  const id = tier?.id.toLowerCase();
  return id === 'fast' || id === 'priority';
}

export default function AgentModelControl({
  control,
  busy,
  openRequest = 0,
}: {
  control: AgentSessionControlController;
  busy: boolean;
  openRequest?: number;
}) {
  const [open, setOpen] = useState(false);
  useBackButton(open, () => setOpen(false));
  const snapshot = control.modelControl;
  const selectedModel = snapshot?.models.find((model) => model.id === snapshot.selected.model);
  const tiers = selectedModel?.serviceTiers ?? [];
  const selectedTier = tiers.find((tier) => tier.id === snapshot?.selected.serviceTier) ?? null;
  useEffect(() => {
    if (control.status === 'unavailable') setOpen(false);
  }, [control.status]);
  useEffect(() => { if (openRequest > 0) setOpen(true); }, [openRequest]);
  if (control.status === 'unavailable') return null;

  const save = (patch: AgentModelControlPatch): void => {
    if (!snapshot?.canUpdate) return;
    void control.update(patch).catch(() => {});
  };
  const pickModel = (model: AgentModelOption): void => {
    const efforts = model.efforts.map((effort) => effort.id);
    const tiers = model.serviceTiers?.map((item) => item.id) ?? [];
    const patch: AgentModelControlPatch = { model: model.id };
    if (!snapshot || !snapshot.selected.effort || !efforts.includes(snapshot.selected.effort)) {
      const effort = model.defaultEffort ?? efforts[0];
      if (effort) patch.effort = effort;
    }
    if (snapshot && Object.hasOwn(snapshot.selected, 'serviceTier') && snapshot.selected.serviceTier
      && !tiers.includes(snapshot.selected.serviceTier)) patch.serviceTier = null;
    save(patch);
  };

  return (
    <>
      <button type="button" className="cc-ctx cc-config-trigger"
        aria-label={t('chat.config.open')} onClick={() => setOpen(true)}>
        <span className="cc-ctx-model">{selectedModel?.label || t('chat.config.model')}</span>
        <span className="cc-ctx-pct">{snapshot?.selected.effort || t('chat.config.effort')}</span>
        {selectedTier && <span
          className={`cc-tier-indicator ${isFastTier(selectedTier) ? 'fast' : 'standard'}`}
          aria-hidden="true">
          {isFastTier(selectedTier) ? <BoltIcon /> : <GaugeIcon />}
        </span>}
        <ChevronDownIcon />
      </button>
      {open && (
        <>
          <div className="agent-model-backdrop" data-conversation-overlay
            onClick={() => setOpen(false)} />
          <section className="agent-model-menu" data-conversation-overlay role="dialog" aria-modal="true"
            aria-label={t('chat.config.title')}>
            <header className="agent-model-head">
              <strong>{t('chat.config.title')}</strong>
              <button type="button" className={control.status === 'loading' ? 'is-refreshing' : ''}
                aria-label={t('chat.config.refresh')} disabled={control.saving}
                onClick={() => { void control.refresh(); }}><RefreshIcon /></button>
            </header>
            <div className="agent-model-body">
              <div className="agent-model-section">
                <div className="agent-model-label">{t('chat.config.model')}</div>
                {(control.status === 'idle' || control.status === 'loading')
                  && <div className="agent-model-state">{t('chat.config.loading')}</div>}
                {control.status === 'ready' && snapshot?.models.length === 0 && !control.error
                  && <div className="agent-model-state">{t('chat.config.empty')}</div>}
                <div className="agent-model-list">
                  {snapshot?.models.map((model) => (
                    <button type="button" key={model.id}
                      className={model.id === snapshot?.selected.model ? 'selected' : ''}
                      disabled={control.saving || !snapshot.canUpdate}
                      aria-pressed={model.id === snapshot?.selected.model}
                      onClick={() => pickModel(model)}>
                      <span><strong>{model.label}</strong>
                        {model.description && <small>{model.description}</small>}</span>
                    </button>
                  ))}
                </div>
              </div>
              {control.error && <div className="agent-model-error" role="status">
                {t('chat.config.unavailable')}
              </div>}
            </div>
            {snapshot && <footer className="agent-model-footer">
              <div className="agent-model-section">
                <div className="agent-model-label">{t('chat.config.effort')}</div>
                <div className="agent-model-effort-list">
                  <DiscreteSlider
                    options={(selectedModel?.efforts ?? []).map((effort) => ({
                      value: effort.id,
                      label: effort.label ?? effort.id,
                      ...(effort.description === undefined ? {} : { description: effort.description }),
                    }))}
                    value={snapshot.selected.effort}
                    disabled={control.saving || !snapshot.canUpdate}
                    ariaLabel={t('chat.config.effort')}
                    onCommit={(effort: string) => save({ effort })}
                  />
                  {selectedModel?.efforts.length === 0
                    && <div className="agent-model-state">{t('chat.config.chooseModel')}</div>}
                </div>
              </div>
              {tiers.length === 1 && (
                <label className="agent-model-tier-row">
                  <span>
                    <strong className={`agent-model-tier-title ${
                      isFastTier(tiers[0]) ? 'fast' : 'standard'
                    }`}>
                      {tiers[0]!.label || tiers[0]!.id}
                      {isFastTier(tiers[0]) ? <BoltIcon /> : <GaugeIcon />}
                    </strong>
                    {tiers[0]!.description && <small>{tiers[0]!.description}</small>}
                  </span>
                  <span className="cmd-switch">
                    <input type="checkbox" checked={snapshot.selected.serviceTier === tiers[0]!.id}
                      disabled={control.saving || !snapshot.canUpdate}
                      onChange={(event) => save({
                        serviceTier: event.target.checked ? tiers[0]!.id : null,
                      })} />
                    <span className="cmd-switch-track" aria-hidden="true" />
                    <span className="cmd-switch-knob" aria-hidden="true" />
                  </span>
                </label>
              )}
              {tiers.length > 1 && <div className="agent-model-section agent-model-tier-section">
                <div className="agent-model-label">{t('chat.config.serviceTier')}</div>
                <div className="agent-model-tier-list" role="radiogroup"
                  aria-label={t('chat.config.serviceTier')}>
                  {[{ id: null, label: t('chat.config.serviceTierDefault') }, ...tiers].map((option) => (
                    <button type="button" role="radio" key={option.id ?? 'default'}
                      aria-checked={snapshot.selected.serviceTier === option.id}
                      className={snapshot.selected.serviceTier === option.id ? 'selected' : ''}
                      disabled={control.saving || !snapshot.canUpdate}
                      onClick={() => save({ serviceTier: option.id })}>
                      {option.label || option.id}
                    </button>
                  ))}
                </div>
              </div>}
              {busy && <div className="agent-model-next-turn">{t('chat.config.nextTurn')}</div>}
            </footer>}
          </section>
        </>
      )}
    </>
  );
}
