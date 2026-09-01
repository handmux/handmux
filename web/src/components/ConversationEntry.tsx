import { Fragment, useMemo, useState } from 'react';
import { marked } from 'marked';
import DOMPurify from 'dompurify';
import { findOutputLinks } from '../docDecorations.js';
import { t } from '../i18n';
import { getLangCode } from '../i18n';
import type { ConversationTimelineMessage } from '../conversationTimelineTypes.js';
import type { AgentConversationController } from '../hooks/useAgentConversation.js';
import type { ConversationContentBlock } from '../agentConversationTypes.js';
import type { ReactNode } from 'react';
import CompactionDetail, { CompactionBanner } from './CompactionDetail.js';

type TranscriptMessage = ConversationTimelineMessage;

export interface ConversationOutputLink {
  kind: 'url' | 'doc';
  path?: string;
  protocol?: 'http' | 'https';
  port?: number;
  urlPath?: string;
  raw?: string;
}

export function outputLinkFromAnchor(anchor: HTMLAnchorElement): ConversationOutputLink | null {
  const explicitKind = anchor.dataset.handmuxOutputLink;
  const raw = anchor.dataset.handmuxOutputValue || anchor.getAttribute('href') || '';
  const links = findOutputLinks(raw);
  const match = explicitKind ? links.find((link) => link.kind === explicitKind) : links[0];
  if (!match) return null;
  if (match.kind === 'url') {
    return {
      kind: 'url', protocol: match.protocol, port: match.port,
      urlPath: match.urlPath, raw: match.raw,
    };
  }
  const path = match.path || raw.slice(match.start, match.end);
  if (explicitKind) return { kind: 'doc', path };
  try { return { kind: 'doc', path: decodeURIComponent(path) }; }
  catch { return { kind: 'doc', path }; }
}

export function linkedAssistantHtml(text: string): string {
  const root = document.createElement('div');
  root.innerHTML = DOMPurify.sanitize(marked.parse(text || '') as string);
  for (const anchor of root.querySelectorAll('a')) {
    if (!outputLinkFromAnchor(anchor)) anchor.replaceWith(...Array.from(anchor.childNodes));
  }
  const walker = document.createTreeWalker(root, 4);
  const nodes: Text[] = [];
  while (walker.nextNode()) nodes.push(walker.currentNode as Text);
  for (const node of nodes) {
    if (node.parentElement?.closest('a')) continue;
    const links = findOutputLinks(node.data);
    if (!links.length) continue;
    const fragment = document.createDocumentFragment();
    let offset = 0;
    for (const link of links) {
      fragment.append(node.data.slice(offset, link.start));
      const anchor = document.createElement('a');
      const value = link.kind === 'url' ? link.raw : link.path;
      anchor.href = value;
      anchor.dataset.handmuxOutputLink = link.kind;
      anchor.dataset.handmuxOutputValue = value;
      anchor.textContent = node.data.slice(link.start, link.end);
      fragment.append(anchor);
      offset = link.end;
    }
    fragment.append(node.data.slice(offset));
    node.replaceWith(fragment);
  }
  return root.innerHTML;
}

export function AssistantMarkdown({
  text,
  streaming = false,
}: { text: string; streaming?: boolean }) {
  const html = useMemo(() => linkedAssistantHtml(text), [text]);
  return (
    <div className="chat-bubble chat-them chat-md"
      data-conversation-stream={streaming ? 'active' : undefined}
      dangerouslySetInnerHTML={{ __html: html }} />
  );
}

export function TypingDots() {
  return (
    <span className="chat-typing-dots">
      <span className="chat-typing-dot" />
      <span className="chat-typing-dot" />
      <span className="chat-typing-dot" />
    </span>
  );
}

export function TypingIndicator({ className = 'chat-typing' }: { className?: string }) {
  return (
    <div className={className} aria-hidden="true">
      <TypingDots />
    </div>
  );
}

export function timeStampedIndices(
  messages: TranscriptMessage[],
  turnInProgress = false,
  activeTurnId: string | null = null,
): Set<number> {
  const set = new Set<number>();
  let lastAiText = -1;
  const addAiTime = (index: number, trailing: boolean): void => {
    if (turnInProgress && (
      activeTurnId ? messages[index]?.turnId === activeTurnId : trailing
    )) return;
    set.add(index);
  };
  messages.forEach((message, index) => {
    if (message.type === 'text' && message.role === 'user') {
      set.add(index);
      if (lastAiText >= 0) { addAiTime(lastAiText, false); lastAiText = -1; }
    } else if (message.type === 'text') {
      lastAiText = index;
    }
  });
  if (lastAiText >= 0) addAiTime(lastAiText, true);
  return set;
}

export function formatMessageTime(iso?: string): string | null {
  if (!iso) return null;
  const value = new Date(iso);
  if (Number.isNaN(value.getTime())) return null;
  const locale = getLangCode();
  const hm = new Intl.DateTimeFormat(locale, {
    hour: '2-digit', minute: '2-digit', hourCycle: 'h23',
  }).format(value);
  const now = new Date();
  const sameDay = value.getFullYear() === now.getFullYear()
    && value.getMonth() === now.getMonth() && value.getDate() === now.getDate();
  return sameDay ? hm : `${new Intl.DateTimeFormat(locale, {
    month: 'numeric', day: 'numeric',
  }).format(value)} ${hm}`;
}

export function MessageTime({ message }: { message: TranscriptMessage }) {
  const label = formatMessageTime(message.ts);
  return label
    ? <div className={`chat-ts ${message.role === 'user' ? 'ts-me' : 'ts-them'}`}>{label}</div>
    : null;
}

function messageResources(message: TranscriptMessage) {
  const value = message.conversationResources;
  return Array.isArray(value) ? value.filter((block): block is Extract<
    ConversationContentBlock, { type: 'resource' }
  > => !!block && typeof block === 'object' && block.type === 'resource') : [];
}

export function ConversationResources({
  message,
  downloadResource,
}: {
  message: TranscriptMessage;
  downloadResource?: AgentConversationController['downloadResource'];
}) {
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState<string | null>(null);
  const resources = messageResources(message);
  if (!resources.length || !downloadResource) return null;
  return (
    <div className="agent-conversation-resources">
      {resources.map((resource) => (
        <button type="button" key={resource.resourceId}
          disabled={pending === resource.resourceId}
          onClick={() => {
            setError(null);
            setPending(resource.resourceId);
            void downloadResource(resource).catch((cause: unknown) => {
              setError(cause instanceof Error && cause.message
                ? cause.message : t('agentConversation.attachmentFailed'));
            }).finally(() => setPending(null));
          }}>
          {pending === resource.resourceId
            ? t('common.loading') : resource.name || t('agentConversation.attachment')}
        </button>
      ))}
      {error && <small className="agent-conversation-item-error" role="alert">{error}</small>}
    </div>
  );
}

function ConversationItemStatus({ message }: { message: TranscriptMessage }) {
  if (message.conversationStatus === 'error') {
    return <div className="chat-turn-error" role="status">
      {typeof message.conversationStatusMessage === 'string'
        ? message.conversationStatusMessage : t('chat.sendFailed')}
    </div>;
  }
  if (message.conversationStatus === 'truncated') {
    return <div className="chat-turn-notice is-info" role="status">
      {t('agentConversation.truncated')}
    </div>;
  }
  return null;
}

export function ConversationEntry({
  message,
  running,
  renderTool,
  renderGoal,
  onOpenCompaction,
  downloadResource,
}: {
  message: TranscriptMessage;
  running: boolean;
  renderTool: (message: TranscriptMessage, running: boolean) => ReactNode;
  renderGoal?: (message: TranscriptMessage) => ReactNode;
  onOpenCompaction: (message: TranscriptMessage) => void;
  downloadResource?: AgentConversationController['downloadResource'];
}): ReactNode {
  if (message.type === 'tool' && message.tool) return (
    <>
      {renderTool(message, running)}
      <ConversationResources message={message} {...(downloadResource ? { downloadResource } : {})} />
      <ConversationItemStatus message={message} />
    </>
  );
  if (message.type === 'goal') return renderGoal?.(message) ?? null;
  if (message.type === 'interrupt') return <div className="chat-interrupt">{t('chat.interrupted')}</div>;
  if (message.type === 'compact') {
    return <CompactionBanner onOpen={() => onOpenCompaction(message)} />;
  }
  if (message.type === 'slash') {
    return (
      <>
        <div className="chat-slash-cmd">{message.name}{message.args ? ` ${message.args}` : ''}</div>
        {message.result && <div className="chat-slash-result">{message.result}</div>}
      </>
    );
  }
  if (message.type === 'thinking') return null;
  if (message.type === 'notice') {
    return message.noticeLevel === 'error'
      ? <div className="chat-turn-error" role="status">{message.text}</div>
      : <div className={`chat-turn-notice is-${message.noticeLevel === 'warning' ? 'warning' : 'info'}`}
        role="status">{message.text}</div>;
  }
  const content = message.role !== 'user'
    ? <AssistantMarkdown text={message.text || ''} streaming={!!message.streaming} />
    : <div className="chat-bubble chat-me">{message.text}</div>;
  const attachments = (
    <ConversationResources message={message} {...(downloadResource ? { downloadResource } : {})} />
  );
  return (
    <Fragment>
      {content}
      {attachments}
      <ConversationItemStatus message={message} />
    </Fragment>
  );
}

export { CompactionDetail };
