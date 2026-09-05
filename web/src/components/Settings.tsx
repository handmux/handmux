import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import type { ChangeEvent, ReactNode, RefObject } from 'react';
import { notifyEnabled, enableNotifications, disableNotifications, pushSupported, getScriptPushKey } from '../push.js';
import { PushScriptContent } from './PushScriptSheet.jsx';
import {
  getDocHighlight, getVoiceFillerFilter, setDocHighlight, setVoiceFillerFilter,
  VOICE_FILLER_FILTER_LEVELS,
} from '../storage.js';
import { t, getLangCode, setLang, AVAILABLE } from '../i18n';
import { SNAPSHOT_INTERVALS } from '../terminalTransport.js';
import { useBackButton } from '../hooks/useBackButton.js';
import { CheckIcon } from './icons.jsx';
import type { TerminalHandle } from './Terminal.js';
import type { SnapshotInterval, TerminalTransport } from '../terminalTransport.js';
import type { VoiceFillerFilterLevel } from '../storage.js';
import type { AgentIntegrationsController } from '../hooks/useAgentIntegrations.js';
import type {
  AgentIntegrationName,
  AgentIntegrationSnapshot,
} from '../agentIntegrationApi.js';

type DetailPage = 'language' | 'font' | 'keyboard' | 'transport' | 'tone' | 'feedback' | 'script';
type SettingsPage = 'root' | DetailPage;
type ChatTone = 'dusk' | 'ink' | 'light';
type KeyboardMode = 'auto' | 'mobile' | 'desktop';
const KEYBOARD_MODES: readonly KeyboardMode[] = ['auto', 'mobile', 'desktop'];
const TERMINAL_TRANSPORTS: readonly TerminalTransport[] = ['live', 'snapshot'];
const CHAT_TONES: readonly ChatTone[] = ['dusk', 'ink', 'light'];

interface UpdateRelease {
  version: string;
  zh?: string;
  en?: string;
}

interface UpdateInfo {
  current?: string | null;
  latest?: string | null;
  updateAvailable?: boolean;
  whatsNew?: UpdateRelease[];
}

interface WorkspaceProtection {
  status?: string;
  errorCode?: string | null;
}

type SettingsTerminalHandle = Pick<
  TerminalHandle,
  'getFontSize' | 'setFontSize' | 'autoFont' | 'setDocHighlight'
>;

export interface SettingsProps {
  open: boolean;
  onClose: () => void;
  termRef: RefObject<SettingsTerminalHandle | null>;
  onOpenChangelog?: () => void;
  changelogUnread?: boolean;
  onReloadApp?: () => void;
  chatTone?: ChatTone;
  onChatTone?: (tone: ChatTone) => void;
  conversationAgents?: readonly { id: string; label: string; enabled: boolean; experimental: boolean }[];
  onConversationAgentEnabled?: (agentId: string, enabled: boolean) => void;
  keyboardMode?: KeyboardMode;
  onKeyboardMode?: (mode: KeyboardMode) => void;
  terminalTransport?: TerminalTransport;
  onTerminalTransport?: (mode: TerminalTransport) => void;
  snapshotInterval?: SnapshotInterval;
  onSnapshotInterval?: (interval: SnapshotInterval) => void;
  agentIntegrations?: AgentIntegrationsController | null;
  notifUnread?: boolean;
  onOpenInbox?: () => void;
  updateInfo?: UpdateInfo | null;
  workspaceProtection?: WorkspaceProtection | null;
  voiceEnabled?: boolean;
  voiceProvider?: string | null;
  voiceMode?: 'streaming' | 'sentence' | null;
  voiceFillerFilterSupported?: boolean;
}

const DETAIL_TITLE: Record<DetailPage, string> = {
  language: 'settings.language',
  font: 'settings.font_size',
  keyboard: 'settings.keyboard_mode',
  transport: 'settings.terminal_transport',
  tone: 'settings.chat_tone',
  feedback: 'settings.feedback',
  script: 'settings.script_push',
};

function SettingsHeader({ title, onBack }: { title: string; onBack: () => void }) {
  return (
    <header className="settings-page-head">
      <button type="button" className="settings-page-back" onClick={onBack} aria-label={t('common.back')}>‹</button>
      <h1>{title}</h1>
      <span className="settings-page-head-spacer" aria-hidden="true" />
    </header>
  );
}

function SettingsGroup({ title, children, footer }: {
  title: string;
  children: ReactNode;
  footer?: ReactNode;
}) {
  return (
    <section className="settings-page-group">
      <h2>{title}</h2>
      <div className="settings-page-list">{children}</div>
      {footer && <div className="settings-page-footer">{footer}</div>}
    </section>
  );
}

function SettingsNavRow({ label, value, onClick, dot = false, disabled = false }: {
  label: string;
  value?: string;
  onClick: () => void;
  dot?: boolean;
  disabled?: boolean;
}) {
  return (
    <button type="button" className="settings-page-row" onClick={onClick} disabled={disabled}>
      <span className="settings-page-row-label">{label}</span>
      <span className="settings-page-row-trailing">
        {value && <span className="settings-page-row-value">{value}</span>}
        {dot && <span className="settings-page-dot" aria-hidden="true" />}
        <span className="settings-page-chevron" aria-hidden="true">›</span>
      </span>
    </button>
  );
}

function SettingsValueRow({ label, value, dot = false }: {
  label: string;
  value: string;
  dot?: boolean;
}) {
  return (
    <div className="settings-page-row settings-page-value-row">
      <span className="settings-page-row-label">{label}</span>
      <span className="settings-page-row-trailing">
        <span className="settings-page-row-value">{value}</span>
        {dot && <span className="settings-page-dot" aria-hidden="true" />}
      </span>
    </div>
  );
}

function AgentIntegrationRow({ label, status, action, busy = false, disabled = false, onAction }: {
  label: string;
  status: string;
  action?: string;
  busy?: boolean;
  disabled?: boolean;
  onAction?: () => void;
}) {
  return (
    <div className="settings-page-row settings-agent-integration-row">
      <span className="settings-page-row-label">{label}</span>
      <span className="settings-page-row-trailing">
        <span className="settings-page-row-value">{status}</span>
        {action && <button type="button" className="settings-agent-integration-action"
          disabled={disabled} onClick={onAction}>
          {busy ? t('settings.agent_integration_processing') : action}
        </button>}
      </span>
    </div>
  );
}

function SettingsLinkRow({ label, href }: { label: string; href: string }) {
  return (
    <a className="settings-page-row" href={href} target="_blank" rel="noreferrer">
      <span className="settings-page-row-label">{label}</span>
      <span className="settings-page-row-trailing">
        <span className="settings-page-external" aria-hidden="true">↗</span>
      </span>
    </a>
  );
}

function SettingsSwitchRow({ label, checked, onChange, disabled = false, busy = false }: {
  label: ReactNode;
  checked: boolean;
  onChange: (event: ChangeEvent<HTMLInputElement>) => void;
  disabled?: boolean;
  busy?: boolean;
}) {
  return (
    <label className={`settings-page-row settings-page-switch${disabled ? ' disabled' : ''}`}>
      <span className="settings-page-row-label">{label}</span>
      <span className="settings-page-row-trailing">
        {busy && <span className="spinner" role="status" aria-label={t('settings.processing')} />}
        <span className="cmd-switch">
          <input type="checkbox" checked={checked} disabled={disabled} onChange={onChange} />
          <span className="cmd-switch-track" aria-hidden="true" />
          <span className="cmd-switch-knob" aria-hidden="true" />
        </span>
      </span>
    </label>
  );
}

function SettingsChoiceGroup<T extends string | number>({ label, options, value, onChange }: {
  label: string;
  options: readonly { value: T; label: string }[];
  value: T;
  onChange: (value: T) => void;
}) {
  return (
    <div className="settings-page-list settings-choice-list" role="group" aria-label={label}>
      {options.map((option) => (
        <button key={option.value} type="button" className="settings-page-row settings-choice-row"
          aria-pressed={value === option.value} onClick={() => onChange(option.value)}>
          <span className="settings-page-row-label">{option.label}</span>
          <span className="settings-choice-check" aria-hidden="true">
            {value === option.value && <CheckIcon />}
          </span>
        </button>
      ))}
    </div>
  );
}

function SettingsLevelSlider({ label, value, onChange }: {
  label: string;
  value: VoiceFillerFilterLevel;
  onChange: (value: VoiceFillerFilterLevel) => void;
}) {
  const current = VOICE_FILLER_FILTER_LEVELS.indexOf(value);
  const labels = VOICE_FILLER_FILTER_LEVELS.map((level) => t(`settings.voice_filter_${level}`));
  return (
    <div className="settings-page-row settings-level-row">
      <div className="settings-level-head">
        <span className="settings-page-row-label">{label}</span>
        <span className="settings-page-row-value">{labels[current]}</span>
      </div>
      <input type="range" min="0" max="2" step="1" value={current}
        aria-label={label} aria-valuetext={labels[current]}
        onChange={(event) => onChange(VOICE_FILLER_FILTER_LEVELS[Number(event.target.value)] ?? 'medium')} />
      <div className="settings-level-labels" aria-hidden="true">
        {labels.map((item) => <span key={item}>{item}</span>)}
      </div>
    </div>
  );
}

function UpdateNotice({ updateInfo }: { updateInfo: UpdateInfo | null | undefined }) {
  if (!updateInfo?.updateAvailable) return null;
  const whatsNew = updateInfo.whatsNew || [];
  return (
    <div className="settings-update">
      <div className="settings-update-title">{t('settings.update_available', { v: updateInfo.latest })}</div>
      {whatsNew.length > 0 && (
        <ul className="settings-update-new">
          {whatsNew.slice(0, 1).map((release) => (
            <li key={release.version}>
              <span className="settings-update-new-ver">v{release.version}</span>
              {(getLangCode().startsWith('zh') ? release.zh : release.en) || release.en}
            </li>
          ))}
        </ul>
      )}
      {whatsNew.length > 1 && (
        <details className="settings-update-more">
          <summary>{t('settings.update_more', { n: whatsNew.length - 1 })}</summary>
          <ul className="settings-update-new">
            {whatsNew.slice(1).map((release) => (
              <li key={release.version}>
                <span className="settings-update-new-ver">v{release.version}</span>
                {(getLangCode().startsWith('zh') ? release.zh : release.en) || release.en}
              </li>
            ))}
          </ul>
        </details>
      )}
      <div className="settings-update-how">{t('settings.update_how')} <code>handmux update</code></div>
    </div>
  );
}

// Full-screen, browser-local app preferences. Window/pane sizing stays with its concrete management
// target, while web-preview settings remain in that tool's own menu.
export default function Settings({ open, onClose, termRef, onOpenChangelog = () => {}, changelogUnread = false,
  onReloadApp = () => window.location.reload(),
  chatTone = 'ink', onChatTone = () => {},
  conversationAgents = [], onConversationAgentEnabled = () => {},
  keyboardMode = 'auto', onKeyboardMode = () => {},
  terminalTransport = 'live', onTerminalTransport = () => {},
  snapshotInterval = 1000, onSnapshotInterval = () => {},
  agentIntegrations = null,
  notifUnread = false, onOpenInbox,
  updateInfo = null,
  workspaceProtection = null,
  voiceEnabled, voiceProvider = null, voiceMode = null,
  voiceFillerFilterSupported = false }: SettingsProps) {
  const [page, setPage] = useState<SettingsPage>('root');
  const [font, setFont] = useState<{ size: number | null; auto: boolean } | null>(null);
  const [docHl, setDocHl] = useState(getDocHighlight());
  const [voiceFillerFilter, setVoiceFillerFilterState] = useState(getVoiceFillerFilter);
  const [notify, setNotify] = useState(notifyEnabled());
  const [notifyBusy, setNotifyBusy] = useState(false);
  const [notifyMsg, setNotifyMsg] = useState('');
  const [notifyDisableConfirm, setNotifyDisableConfirm] = useState(false);
  const [scriptPushKey, setScriptPushKey] = useState<string | null>(null);
  const bodyRef = useRef<HTMLDivElement>(null);
  const rootScrollRef = useRef(0);

  const notificationsSupported = pushSupported();

  useEffect(() => {
    if (open) {
      setFont(termRef.current?.getFontSize?.() ?? null);
      setNotify(notifyEnabled());
      setVoiceFillerFilterState(getVoiceFillerFilter());
    } else {
      setPage('root');
      setNotifyMsg('');
      setNotifyDisableConfirm(false);
      rootScrollRef.current = 0;
    }
  }, [open, termRef]);

  useBackButton(open && page !== 'root', () => setPage('root'));
  useBackButton(open && notifyDisableConfirm, () => setNotifyDisableConfirm(false));

  useLayoutEffect(() => {
    if (open && page === 'root' && bodyRef.current) bodyRef.current.scrollTop = rootScrollRef.current;
  }, [open, page]);

  if (!open) return null;

  const openPage = (nextPage: DetailPage): void => {
    if (page === 'root') rootScrollRef.current = bodyRef.current?.scrollTop ?? 0;
    setPage(nextPage);
  };
  const backToRoot = (): void => setPage('root');

  const stepFont = (delta: number): void => {
    const current = termRef.current?.getFontSize?.();
    const applied = termRef.current?.setFontSize?.((current?.size ?? 14) + delta);
    if (applied != null) setFont({ size: applied, auto: false });
  };
  const autoFont = (): void => {
    termRef.current?.autoFont?.();
    setFont({ size: null, auto: true });
  };
  const toggleDocHl = (on: boolean): void => {
    setDocHl(on);
    setDocHighlight(on);
    termRef.current?.setDocHighlight?.(on);
  };

  const setNotificationEnabled = async (enabled: boolean): Promise<void> => {
    setNotifyBusy(true);
    setNotifyMsg('');
    try {
      if (enabled) {
        await enableNotifications();
        setNotify(true);
        setNotifyMsg(t('settings.notify_enabled'));
      } else {
        await disableNotifications();
        setNotify(false);
        setNotifyMsg(t('settings.notify_disabled'));
      }
    } catch (error: unknown) {
      setNotifyMsg(error instanceof Error && error.message ? error.message : t('settings.notify_failed'));
    } finally {
      setNotifyBusy(false);
    }
  };

  const changeNotify = (event: ChangeEvent<HTMLInputElement>): void => {
    if (!event.target.checked) {
      setNotifyDisableConfirm(true);
      return;
    }
    void setNotificationEnabled(true);
  };

  const confirmDisableNotify = (): void => {
    setNotifyDisableConfirm(false);
    void setNotificationEnabled(false);
  };

  const openScriptPush = async (): Promise<void> => {
    try {
      const key: unknown = notifyEnabled() ? await getScriptPushKey() : null;
      setScriptPushKey(typeof key === 'string' ? key : null);
    } catch {
      setScriptPushKey(null);
    }
    openPage('script');
  };

  const fontLabel = font?.auto ? t('settings.font_auto') : font?.size ? `${font.size}px` : '—';
  const languageLabel = AVAILABLE.find((language) => language.code === getLangCode())?.label || '—';
  const voiceEnabledLabel = voiceEnabled === undefined ? '—'
    : t(voiceEnabled ? 'settings.voice_on' : 'settings.voice_off');
  const voiceProviderLabel = !voiceEnabled ? t('settings.voice_not_configured')
    : voiceProvider === 'tencent' && voiceMode === 'sentence'
      ? t('settings.voice_profile_tencent_sentence')
      : voiceProvider === 'tencent'
        ? t('settings.voice_profile_tencent_streaming')
        : voiceProvider === 'xfyun'
          ? t('settings.voice_profile_xfyun')
          : voiceProvider || '—';
  const changeVoiceFillerFilter = (level: VoiceFillerFilterLevel): void => {
    setVoiceFillerFilter(level);
    setVoiceFillerFilterState(level);
  };
  const protectionCode = workspaceProtection?.errorCode;
  const protectionReason = protectionCode === 'live-corrupt' || protectionCode === 'live-unavailable'
    ? protectionCode : 'unknown';
  const integrationItems: readonly (AgentIntegrationSnapshot | {
    name: AgentIntegrationName;
    status: null;
  })[] = agentIntegrations?.items.length ? agentIntegrations.items : [
    { name: 'claude', status: null }, { name: 'pi', status: null },
  ];
  const integrationLabel = (name: AgentIntegrationName): string => t(
    name === 'claude' ? 'settings.agent_integration_claude' : 'settings.agent_integration_pi',
  );
  const integrationFooter = agentIntegrations ? (
    <>
      {agentIntegrations.error?.kind === 'load' && <div>
        {t('settings.agent_integration_load_error')}
        <button type="button" className="settings-page-inline-action"
          onClick={() => { void agentIntegrations.refresh(); }}>{t('common.retry')}</button>
      </div>}
      {agentIntegrations.error?.kind === 'action' && <div className="settings-hint-err">
        {t('settings.agent_integration_action_error')} <code>
          handmux agent enable {agentIntegrations.error.name}
        </code>
      </div>}
      {agentIntegrations.items.filter((item) => item.status === 'conflict').map((item) => (
        <div key={`conflict:${item.name}`}>
          {t('settings.agent_integration_conflict_hint', { agent: integrationLabel(item.name) })}{' '}
          <code>handmux agent status {item.name}</code>
        </div>
      ))}
      {agentIntegrations.items.filter((item) => item.status === 'not-installed').map((item) => (
        <div key={`missing:${item.name}`}>{t('settings.agent_integration_not_installed_hint', {
          agent: integrationLabel(item.name),
        })}</div>
      ))}
      {agentIntegrations.items.filter((item) => item.reason === 'initialize-first').map((item) => (
        <div key={`initialize:${item.name}`}>
          {t('settings.agent_integration_initialize_first_hint', {
            agent: integrationLabel(item.name),
          })}
        </div>
      ))}
    </>
  ) : null;

  const rootContent = (
    <>
      {workspaceProtection?.status === 'degraded' && (
        <div className="settings-page-alert" role="status">
          <strong>{t('workspace.protectionTitle')}</strong>
          <span>{t(`workspace.protection.${protectionReason}`)}</span>
        </div>
      )}

      <SettingsGroup title={t('settings.group_general')}>
        <SettingsNavRow label={t('settings.language')} value={languageLabel} onClick={() => openPage('language')} />
        <SettingsNavRow label={t('settings.font_size')} value={fontLabel} onClick={() => openPage('font')} />
        <SettingsNavRow label={t('settings.keyboard_mode')} value={t(`settings.keyboard_mode_${keyboardMode}`)}
          onClick={() => openPage('keyboard')} />
      </SettingsGroup>

      <SettingsGroup title={t('settings.group_voice')}>
        <SettingsValueRow label={t('settings.voice_enabled')} value={voiceEnabledLabel} />
        <SettingsValueRow label={t('settings.voice_provider')} value={voiceProviderLabel} />
        {voiceFillerFilterSupported ? (
          <SettingsLevelSlider label={t('settings.voice_filler_filter')} value={voiceFillerFilter}
            onChange={changeVoiceFillerFilter} />
        ) : (
          <SettingsValueRow label={t('settings.voice_filler_filter')}
            value={t('settings.voice_not_supported')} />
        )}
      </SettingsGroup>

      <SettingsGroup title={t('settings.group_terminal')} footer={t('settings.path_highlight_hint')}>
        <SettingsNavRow label={t('settings.terminal_transport')}
          value={t(`settings.terminal_transport_${terminalTransport}`)} onClick={() => openPage('transport')} />
        <SettingsSwitchRow label={t('settings.path_highlight')} checked={docHl}
          onChange={(event) => toggleDocHl(event.target.checked)} />
      </SettingsGroup>

      <SettingsGroup title={t('settings.group_chat')}>
        {conversationAgents.map((agent) => (
          <SettingsSwitchRow key={agent.id}
            label={<span className="settings-conversation-agent-label">
              <span className="settings-conversation-agent-name">
                {t('settings.conversation_view_agent', { agent: agent.label })}
              </span>
              {agent.experimental && <span className="settings-conversation-experimental">
                {t('settings.experimental')}
              </span>}
            </span>}
            checked={agent.enabled}
            onChange={(event) => onConversationAgentEnabled(agent.id, event.target.checked)} />
        ))}
        <SettingsNavRow label={t('settings.chat_tone')} value={t(`settings.chat_tone_${chatTone}`)}
          onClick={() => openPage('tone')} />
      </SettingsGroup>

      <SettingsGroup title={t('settings.group_agent_integration')} footer={integrationFooter}>
        {integrationItems.map((item) => {
          const action = item.status === 'not-enabled' && item.reason !== 'initialize-first'
            ? t('settings.agent_integration_enable')
            : item.status === 'needs-repair' ? t('settings.agent_integration_repair') : undefined;
          return <AgentIntegrationRow key={item.name} label={integrationLabel(item.name)}
            status={item.status === null ? t('settings.agent_integration_loading')
              : t(`settings.agent_integration_status_${item.status.replace('-', '_')}`)}
            {...(action ? { action } : {})} busy={agentIntegrations?.busy === item.name}
            disabled={Boolean(agentIntegrations?.busy)}
            onAction={() => { if (agentIntegrations) void agentIntegrations.enable(item.name); }} />;
        })}
      </SettingsGroup>

      <SettingsGroup title={t('settings.group_notifications')} footer={notifyMsg || (
        notificationsSupported ? t('settings.push_hint') : t('settings.push_unsupported')
      )}>
        <SettingsSwitchRow label={t('settings.push_notifications')} checked={notify}
          disabled={!notificationsSupported || notifyBusy} busy={notifyBusy} onChange={changeNotify} />
        <SettingsNavRow label={t('settings.script_push')} value={t('settings.script_push_open')}
          disabled={!notificationsSupported} onClick={openScriptPush} />
        <SettingsNavRow label={t('pushInbox.title')} dot={notifUnread} onClick={() => onOpenInbox?.()} />
      </SettingsGroup>

      <SettingsGroup title={t('settings.group_about')}
        footer={updateInfo?.updateAvailable ? <UpdateNotice updateInfo={updateInfo} /> : null}>
        <SettingsValueRow label={t('settings.version')}
          value={updateInfo?.current ? `v${updateInfo.current}` : '—'} dot={!!updateInfo?.updateAvailable} />
        <SettingsNavRow label={t('settings.view_changelog')} dot={changelogUnread} onClick={onOpenChangelog} />
        <SettingsNavRow label={t('settings.feedback')} onClick={() => openPage('feedback')} />
        <button type="button" className="settings-page-row settings-page-text-action" onClick={onReloadApp}>
          <span className="settings-page-row-label">{t('settings.reload_app')}</span>
        </button>
      </SettingsGroup>
    </>
  );

  const detailContent: Record<DetailPage, ReactNode> = {
    language: (
      <SettingsChoiceGroup label={t('settings.language')} value={getLangCode()} onChange={setLang}
        options={AVAILABLE.map((language) => ({ value: language.code, label: language.label }))} />
    ),
    font: (
      <section className="settings-detail-card settings-font-card">
        <div className="settings-font-value">{fontLabel}</div>
        <div className="settings-font-controls" role="group" aria-label={t('settings.font_size')}>
          <button type="button" onClick={() => stepFont(-1)} aria-label={t('settings.font_decrease')}>A−</button>
          <button type="button" onClick={() => stepFont(1)} aria-label={t('settings.font_increase')}>A+</button>
          <button type="button" className={font?.auto ? 'selected' : ''} onClick={autoFont}
            aria-pressed={!!font?.auto}>{t('settings.font_auto')}</button>
        </div>
        <p>{t('settings.font_auto_title')}</p>
      </section>
    ),
    keyboard: (
      <>
        <SettingsChoiceGroup label={t('settings.keyboard_mode')} value={keyboardMode} onChange={onKeyboardMode}
          options={KEYBOARD_MODES.map((mode) => ({
            value: mode, label: t(`settings.keyboard_mode_${mode}`),
          }))} />
        <p className="settings-detail-note">{t('settings.keyboard_mode_hint')}</p>
      </>
    ),
    transport: (
      <>
        <SettingsChoiceGroup label={t('settings.terminal_transport')} value={terminalTransport}
          onChange={onTerminalTransport} options={TERMINAL_TRANSPORTS.map((mode) => ({
            value: mode, label: t(`settings.terminal_transport_${mode}`),
          }))} />
        <p className="settings-detail-note">{t('settings.terminal_transport_hint')}</p>
        {terminalTransport === 'snapshot' && (
          <section className="settings-page-group settings-detail-group">
            <h2>{t('settings.snapshot_interval')}</h2>
            <SettingsChoiceGroup label={t('settings.snapshot_interval')} value={snapshotInterval}
              onChange={onSnapshotInterval} options={SNAPSHOT_INTERVALS.map((intervalMs) => ({
                value: intervalMs,
                label: `${(intervalMs / 1000).toFixed(intervalMs % 1000 ? 1 : 0)}s`,
              }))} />
            <p className="settings-page-footer">{t('settings.snapshot_interval_hint')}</p>
          </section>
        )}
      </>
    ),
    tone: (
      <>
        <SettingsChoiceGroup label={t('settings.chat_tone')} value={chatTone} onChange={onChatTone}
          options={CHAT_TONES.map((tone) => ({
            value: tone, label: t(`settings.chat_tone_${tone}`),
          }))} />
        <p className="settings-detail-note">{t('settings.chat_tone_hint')}</p>
      </>
    ),
    feedback: (
      <>
        <div className="settings-page-list">
          <SettingsLinkRow label={t('settings.feedback_issues')} href="https://github.com/handmux/handmux/issues" />
          {getLangCode().startsWith('zh') && (
            <SettingsLinkRow label={t('settings.feedback_group')} href="https://handmux.com/#community" />
          )}
        </div>
        <p className="settings-detail-note">{t('settings.feedback_hint')}</p>
      </>
    ),
    script: <PushScriptContent pushKey={scriptPushKey} notifyOn={notify} />,
  };

  return (
    <div className="settings-page" role="dialog" aria-label={t('settings.title')} aria-modal="true">
      <SettingsHeader title={page === 'root' ? t('settings.title') : t(DETAIL_TITLE[page])}
        onBack={page === 'root' ? onClose : backToRoot} />
      <div ref={bodyRef} className="settings-page-body">
        <main className={`settings-page-content${page === 'root' ? '' : ' detail'}`}>
          {page === 'root' ? rootContent : detailContent[page]}
        </main>
      </div>
      {notifyDisableConfirm && (
        <div className="settings-confirm-backdrop" onClick={() => setNotifyDisableConfirm(false)}>
          <div className="settings-confirm" role="alertdialog" aria-modal="true"
            aria-labelledby="settings-notify-disable-title" aria-describedby="settings-notify-disable-hint"
            onClick={(event) => event.stopPropagation()}>
            <h2 id="settings-notify-disable-title">{t('settings.notify_disable_title')}</h2>
            <p id="settings-notify-disable-hint">{t('settings.notify_disable_hint')}</p>
            <div className="settings-confirm-actions">
              <button type="button" autoFocus onClick={() => setNotifyDisableConfirm(false)}>{t('common.cancel')}</button>
              <button type="button" className="danger" onClick={confirmDisableNotify}>
                {t('settings.notify_disable_confirm')}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
