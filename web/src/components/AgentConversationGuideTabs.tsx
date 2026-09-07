import { useEffect, useId, useMemo, useState } from 'react';
import type { ReactNode } from 'react';
import { copyText } from '../clipboard.js';
import { t } from '../i18n';
import { BotIcon } from './icons.jsx';

const START_COMMANDS: Readonly<Record<string, string>> = {
  codex: 'handmux codex',
  claude: 'claude',
  pi: 'handmux pi',
};

export default function AgentConversationGuideTabs({
  activeAgentId,
  agents,
  children,
  onTerminal,
}: {
  activeAgentId: string;
  agents: readonly { id: string; label: string; enabled: boolean }[];
  children: ReactNode;
  onTerminal: () => void;
}) {
  const choices = useMemo(() => agents.filter((agent) => agent.enabled
    && (agent.id === activeAgentId || START_COMMANDS[agent.id])), [activeAgentId, agents]);
  const [selected, setSelected] = useState(activeAgentId);
  const [copied, setCopied] = useState(false);
  const tabsId = useId();
  useEffect(() => { setSelected(activeAgentId); setCopied(false); }, [activeAgentId]);
  const selectedAgent = choices.find((agent) => agent.id === selected)
    ?? choices.find((agent) => agent.id === activeAgentId) ?? null;
  const selectedId = selectedAgent?.id ?? activeAgentId;
  const command = START_COMMANDS[selectedId];

  return <div className="conversation-guide-shell">
    {choices.length > 1 && <div className="conversation-guide-tabs" role="tablist"
      aria-label={t('chat.guide.agentTabs')}>
      {choices.map((agent, index) => <button type="button" role="tab" key={agent.id}
        id={`${tabsId}-tab-${index}`} aria-controls={`${tabsId}-panel`}
        aria-selected={selectedId === agent.id}
        tabIndex={selectedId === agent.id ? 0 : -1}
        onKeyDown={(event) => {
          if (event.key !== 'ArrowLeft' && event.key !== 'ArrowRight') return;
          event.preventDefault();
          const offset = event.key === 'ArrowRight' ? 1 : -1;
          const next = (index + offset + choices.length) % choices.length;
          setSelected(choices[next]!.id);
          document.getElementById(`${tabsId}-tab-${next}`)?.focus();
        }}
        onClick={() => { setSelected(agent.id); setCopied(false); }}>
        {agent.label}
      </button>)}
    </div>}
    <div className="conversation-guide-panel" role="tabpanel" id={`${tabsId}-panel`}
      aria-labelledby={choices.length > 1
        ? `${tabsId}-tab-${Math.max(0, choices.findIndex((agent) => agent.id === selectedId))}`
        : undefined}>
    {selectedId === activeAgentId ? children : command ? (
      <div className="codex-managed-guide" aria-live="polite">
        <div className="codex-managed-guide-icon" aria-hidden="true"><BotIcon /></div>
        <h2>{t('chat.guide.startAgent', { agent: selectedAgent?.label ?? selectedId })}</h2>
        <p>{t('chat.guide.startAgentHint')}</p>
        <div className="codex-managed-guide-recovery">
          <code>{command}</code>
          <button type="button" onClick={() => {
            void copyText(command).then(setCopied);
          }}>{copied ? t('chat.status.copied') : t('chat.guide.copyCommand')}</button>
        </div>
        <button type="button" className="codex-managed-guide-secondary" onClick={onTerminal}>
          {t('chat.session.openTerminal')}
        </button>
      </div>
    ) : children}
    </div>
  </div>;
}
