import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import LensBoot from './LensBoot.jsx';
import HistoryActivityIndicator from './HistoryActivityIndicator.js';
import { completedEntryAnchor, positionCompletedEntry } from '../completedEntryAnchor.js';
import { t } from '../i18n';
import { useBackButton } from '../hooks/useBackButton.js';
import {
  conversationMessageIdentity as messageIdentity,
  type ConversationTimelineMessage,
} from '../conversationTimelineTypes.js';
import type { MouseEvent as ReactMouseEvent } from 'react';
import type { AgentConversationController } from '../hooks/useAgentConversation.js';
import type { ConversationActivity } from '../agentConversationControlsApi.js';
import { projectConversationMessages } from '../conversationPresentation.js';
import {
  CompactionDetail,
  ConversationEntry,
  MessageTime,
  TypingDots,
  TypingIndicator,
  outputLinkFromAnchor,
  timeStampedIndices,
  type ConversationOutputLink,
} from './ConversationEntry.js';
import {
  resolveConversationCopyBlock,
  ToolChip,
  ToolSheet,
} from './ConversationTool.js';
import {
  ConversationGoalCard,
  ConversationGoalSheet,
  ConversationPlanSheet,
  ConversationPlanSummary,
  conversationPlanSteps,
  type ConversationGoal,
  type ConversationPlan,
} from './ConversationMilestones.js';
import {
  ConversationCopyCallout,
  useConversationLongPressCopy,
} from '../hooks/useConversationLongPressCopy.js';

const BOTTOM_REJOIN_PX = 2;
const BOTTOM_JUMP_THRESHOLD_PX = 80;
const HISTORY_TOP_TRIGGER_PX = 1;
const HISTORY_SPINNER_DELAY_MS = 180;
type TranscriptMessage = ConversationTimelineMessage;

function withinBottomJumpThreshold(element: HTMLElement): boolean {
  const distance = Math.max(0, element.scrollHeight - element.scrollTop - element.clientHeight);
  return distance <= BOTTOM_JUMP_THRESHOLD_PX;
}

interface PageAnchor {
  firstKey: string;
  element: HTMLElement | null;
  offset: number;
  scrollTop: number;
  scrollHeight: number;
}

function visiblePageAnchor(element: HTMLElement): { element: HTMLElement | null; offset: number } {
  const viewportTop = element.getBoundingClientRect().top;
  const children = (Array.from(element.children) as HTMLElement[])
    .filter((child) => !child.classList.contains('chat-history-slot'));
  const visible = children.find((child) => child.getBoundingClientRect().bottom > viewportTop + 1)
    || children[0] || null;
  return {
    element: visible,
    offset: visible ? visible.getBoundingClientRect().top - viewportTop : 0,
  };
}

export function AgentConversationErrorView({
  message,
  resetKey,
}: {
  message: string;
  resetKey: string | null;
}) {
  const viewRef = useRef<HTMLDivElement>(null);
  const copy = useConversationLongPressCopy({
    viewRef,
    resolveBlock: resolveConversationCopyBlock,
    resetKey,
  });
  const endPress = (): void => copy.cancel();
  return (
    <div className="chat-view" ref={viewRef}
      onPointerDown={copy.onPointerDown} onPointerMove={copy.onPointerMove}
      onPointerUp={endPress} onPointerCancel={endPress} onPointerLeave={endPress}
      onClickCapture={copy.onClickCapture}>
      <div className="chat-scroll" onScroll={() => {
        copy.cancel();
        if (copy.active) copy.dismiss();
      }}>
        <div className="chat-turn-error" role="status">{message}</div>
      </div>
      {copy.calloutStyle && (
        <ConversationCopyCallout style={copy.calloutStyle} onCopy={() => void copy.copy()} />
      )}
    </div>
  );
}

export default function AgentConversationView({
  conversation,
  working = false,
  activity,
  followLatestRequest = 0,
  completedEntryRequest = 0,
  onCompletedEntryConsumed,
  onDocLinkTap,
}: {
  conversation: AgentConversationController;
  working?: boolean;
  activity?: ConversationActivity;
  followLatestRequest?: number;
  completedEntryRequest?: number;
  onCompletedEntryConsumed?: (request: number) => void;
  onDocLinkTap?: (link: ConversationOutputLink, clientX: number, clientY: number) => void;
}) {
  const scrollRef = useRef<HTMLDivElement>(null);
  const viewRef = useRef<HTMLDivElement>(null);
  const stickBottomRef = useRef(true);
  const readingRef = useRef(false);
  const pointerGestureActiveRef = useRef(false);
  const pointerStartYRef = useRef(0);
  const lastScrollTopRef = useRef(0);
  const lastScrollGestureAtRef = useRef(0);
  const requestInFlightRef = useRef(false);
  const pageAnchorRef = useRef<PageAnchor | null>(null);
  const [settledRequest, setSettledRequest] = useState(0);
  const [pageError, setPageError] = useState<string | null>(null);
  const [showHistorySpinner, setShowHistorySpinner] = useState(false);
  const [showEntrySpinner, setShowEntrySpinner] = useState(false);
  const [atBottom, setAtBottom] = useState(true);
  const [compactionDetail, setCompactionDetail] = useState<TranscriptMessage | null>(null);
  const [sheetKey, setSheetKey] = useState<string | null>(null);
  const [planSheet, setPlanSheet] = useState<ConversationPlan | null>(null);
  const [goalSheet, setGoalSheet] = useState<ConversationGoal | null>(null);
  const conversationRef = useRef(conversation);
  const completedEntryConsumedRef = useRef(0);
  const completedEntryRefreshRef = useRef(new Set<number>());
  const completedEntryRefreshSettledRef = useRef(new Set<number>());
  const completedEntryRefreshFailedRef = useRef(new Set<number>());
  const [, setCompletedEntryRefreshSettled] = useState(0);
  conversationRef.current = conversation;
  const atLatestWindow = conversation.atLatest !== false;
  const sessionId = conversation.descriptor?.session.sessionId ?? null;
  useEffect(() => {
    setCompactionDetail(null);
    setSheetKey(null);
    setPlanSheet(null);
    setGoalSheet(null);
  }, [sessionId]);

  const copy = useConversationLongPressCopy({
    viewRef,
    resolveBlock: resolveConversationCopyBlock,
    resetKey: sessionId,
    onPointerDown: (event) => {
      pointerGestureActiveRef.current = true;
      pointerStartYRef.current = event.clientY;
      if (event.pointerType !== 'mouse') lastScrollGestureAtRef.current = Date.now();
    },
    onPointerMove: (event) => {
      if (event.pointerType === 'mouse') return;
      lastScrollGestureAtRef.current = Date.now();
      if (event.clientY - pointerStartYRef.current > 3) enterReadingMode();
    },
  });

  const messages = useMemo(
    () => projectConversationMessages(conversation.items),
    [conversation.items],
  );
  const historicalPlans = useMemo(() => {
    const latest = new Map<string, TranscriptMessage>();
    const lastAnswerIndex = new Map<string, number>();
    messages.forEach((message, index) => {
      if (message.type === 'plan' && message.turnId && conversationPlanSteps(message).length) {
        latest.set(message.turnId, message);
      }
      if (message.type === 'text' && message.role === 'assistant' && message.turnId) {
        lastAnswerIndex.set(message.turnId, index);
      }
    });
    const byAnswerIndex = new Map<number, TranscriptMessage>();
    for (const [turnId, plan] of latest) {
      const answerIndex = lastAnswerIndex.get(turnId);
      if (answerIndex !== undefined) byAnswerIndex.set(answerIndex, plan);
    }
    return byAnswerIndex;
  }, [messages]);
  const outgoingByKey = useMemo(() => new Map(conversation.items.flatMap((item) => (
    item.outgoing ? [[item.key, item.outgoing] as const] : []
  ))), [conversation.items]);
  // Outgoing user rows stay provisional until their durable handoff is observed. They are delivery state,
  // not proof that the Agent is working; failed/unknown sends must never leave a permanent typing wave.
  const timelineWorking = working || conversation.items.some((value) => (
    value.provisional && !value.outgoing
  ));
  const timestamped = useMemo(
    () => timeStampedIndices(messages, timelineWorking),
    [messages, timelineWorking],
  );
  const rowKey = (message: TranscriptMessage): string => (
    typeof message.conversationAnchorId === 'string' && message.conversationAnchorId
      ? message.conversationAnchorId : messageIdentity(message)
  );
  const sheetMessage = sheetKey == null ? null : messages.find((message) => (
    message.type === 'tool' && messageIdentity(message) === sheetKey
  )) ?? null;
  useEffect(() => {
    if (sheetKey != null && !sheetMessage) setSheetKey(null);
  }, [sheetKey, sheetMessage]);
  useBackButton(sheetKey != null, () => setSheetKey(null));
  const consumeCompletedEntry = useCallback((request: number): void => {
    if (request <= 0 || completedEntryConsumedRef.current === request) return;
    completedEntryConsumedRef.current = request;
    setShowEntrySpinner(false);
    onCompletedEntryConsumed?.(request);
  }, [onCompletedEntryConsumed]);
  const completedEntryPending = completedEntryRequest > 0
    && completedEntryConsumedRef.current !== completedEntryRequest;
  const completedEntryCanonicalReady = conversation.canonicalReady !== false;
  useEffect(() => {
    if (!completedEntryPending || conversation.status !== 'ready' || !completedEntryCanonicalReady
      || completedEntryRefreshRef.current.has(completedEntryRequest)) return;
    completedEntryRefreshRef.current.add(completedEntryRequest);
    const settle = (): void => {
      completedEntryRefreshSettledRef.current.add(completedEntryRequest);
      setCompletedEntryRefreshSettled((value) => value + 1);
    };
    if (!conversation.loadLatest) {
      completedEntryRefreshFailedRef.current.add(completedEntryRequest);
      settle();
      return;
    }
    void conversation.loadLatest({ force: true }).catch(() => {
      completedEntryRefreshFailedRef.current.add(completedEntryRequest);
    }).finally(settle);
  }, [completedEntryCanonicalReady, completedEntryPending, completedEntryRequest,
    conversation.loadLatest, conversation.status]);
  const completedEntryRows = messages.map((message) => ({
    key: rowKey(message),
    durableAssistantText: message.type === 'text' && message.role === 'assistant'
      && message.completed !== false,
  }));
  const completedEntryRefreshed = completedEntryRefreshSettledRef.current.has(completedEntryRequest);
  const completedEntryRefreshFailed = completedEntryRefreshFailedRef.current.has(completedEntryRequest);
  const completedEntryResolution = completedEntryPending && conversation.status === 'ready'
    && completedEntryCanonicalReady && completedEntryRefreshed
    ? completedEntryRefreshFailed || conversation.atLatest === false
      ? { kind: 'fallback' as const }
      : completedEntryAnchor(completedEntryRows)
    : null;
  const locatingCompletedEntry = completedEntryPending && conversation.status === 'ready'
    && completedEntryCanonicalReady && !completedEntryRefreshed;

  const enterReadingMode = (): void => {
    readingRef.current = true;
    stickBottomRef.current = false;
  };
  const scrollToBottom = useCallback((): void => {
    if (completedEntryRequest > 0) consumeCompletedEntry(completedEntryRequest);
    const element = scrollRef.current;
    pageAnchorRef.current = null;
    if (element) {
      element.scrollTop = element.scrollHeight;
      lastScrollTopRef.current = element.scrollTop;
    }
    readingRef.current = false;
    stickBottomRef.current = true;
    setAtBottom(true);
    if (conversationRef.current.atLatest === false) {
      void conversationRef.current.loadLatest?.().catch(() => {});
    }
  }, [completedEntryRequest, consumeCompletedEntry]);
  const requestOlder = useCallback((): void => {
    const element = scrollRef.current;
    const firstKey = conversation.items[0]?.key;
    if (!element || !firstKey || !conversation.hasMore || conversation.loadingOlder
      || requestInFlightRef.current) return;
    const visible = visiblePageAnchor(element);
    pageAnchorRef.current = {
      firstKey,
      element: visible.element,
      offset: visible.offset,
      scrollTop: element.scrollTop,
      scrollHeight: element.scrollHeight,
    };
    requestInFlightRef.current = true;
    setPageError(null);
    void conversation.loadOlder().catch(() => {
      pageAnchorRef.current = null;
      setPageError(t('agentConversation.loadOlderFailed'));
    }).finally(() => {
      requestInFlightRef.current = false;
      setSettledRequest((value) => value + 1);
    });
  }, [conversation]);

  useLayoutEffect(() => {
    const anchor = pageAnchorRef.current;
    const element = scrollRef.current;
    if (!anchor || !element || conversation.items[0]?.key === anchor.firstKey) return;
    if (!conversation.items.some((item) => item.key === anchor.firstKey)) {
      // The page was rebased or the user switched conversations while the request was in flight.
      // This anchor belongs to the abandoned list and must never affect a later matching item id.
      pageAnchorRef.current = null;
      return;
    }
    const viewportTop = element.getBoundingClientRect().top;
    const delta = anchor.element && element.contains(anchor.element)
      ? anchor.element.getBoundingClientRect().top - viewportTop - anchor.offset
      : element.scrollHeight - anchor.scrollHeight;
    element.scrollTop = Math.max(0, anchor.scrollTop + delta);
    lastScrollTopRef.current = element.scrollTop;
    pageAnchorRef.current = null;
  }, [conversation.items]);
  useLayoutEffect(() => {
    if (!completedEntryPending || completedEntryResolution?.kind !== 'target') return;
    const element = scrollRef.current;
    if (!element) return;
    const positionedTop = positionCompletedEntry(element, completedEntryResolution);
    if (positionedTop == null) return;
    pageAnchorRef.current = null;
    readingRef.current = true;
    stickBottomRef.current = false;
    lastScrollTopRef.current = positionedTop;
    setAtBottom(withinBottomJumpThreshold(element));
    consumeCompletedEntry(completedEntryRequest);
  }, [completedEntryPending, completedEntryRequest, completedEntryResolution,
    consumeCompletedEntry, conversation.items]);
  useEffect(() => {
    if (!completedEntryPending || completedEntryResolution?.kind !== 'fallback') return;
    consumeCompletedEntry(completedEntryRequest);
  }, [completedEntryPending, completedEntryRequest, completedEntryResolution, consumeCompletedEntry]);
  useEffect(() => {
    if (!locatingCompletedEntry) {
      setShowEntrySpinner(false);
      return undefined;
    }
    const timer = window.setTimeout(() => setShowEntrySpinner(true), HISTORY_SPINNER_DELAY_MS);
    return () => window.clearTimeout(timer);
  }, [locatingCompletedEntry]);
  useEffect(() => {
    const element = scrollRef.current;
    if (element && !pointerGestureActiveRef.current && stickBottomRef.current && !readingRef.current) {
      element.scrollTop = element.scrollHeight;
      lastScrollTopRef.current = element.scrollTop;
      setAtBottom(true);
    } else if (element && !pointerGestureActiveRef.current) {
      setAtBottom(withinBottomJumpThreshold(element));
    }
  }, [conversation.items, locatingCompletedEntry]);
  useEffect(() => {
    const anchor = pageAnchorRef.current;
    if (!conversation.loadingOlder && !requestInFlightRef.current && anchor
      && conversation.items[0]?.key === anchor.firstKey) pageAnchorRef.current = null;
  }, [conversation.items, conversation.loadingOlder, settledRequest]);
  useEffect(() => {
    if (followLatestRequest > 0) scrollToBottom();
  }, [followLatestRequest, scrollToBottom]);
  useEffect(() => {
    if (!conversation.loadingOlder) {
      setShowHistorySpinner(false);
      return undefined;
    }
    const timer = window.setTimeout(() => setShowHistorySpinner(true), HISTORY_SPINNER_DELAY_MS);
    return () => window.clearTimeout(timer);
  }, [conversation.loadingOlder]);
  useEffect(() => {
    const element = scrollRef.current;
    if (!element) return undefined;
    const fill = (): void => {
      if (pageError || conversation.loadingOlder || requestInFlightRef.current
        || !conversation.hasMore || conversation.items.length === 0) return;
      if (element.clientHeight > 0 && element.scrollHeight <= element.clientHeight) requestOlder();
    };
    fill();
    if (typeof ResizeObserver === 'undefined') return undefined;
    const observer = new ResizeObserver(fill);
    observer.observe(element);
    return () => observer.disconnect();
  }, [conversation.hasMore, conversation.items, conversation.loadingOlder, pageError, requestOlder]);

  const onOutputLinkClick = (event: ReactMouseEvent<HTMLDivElement>): void => {
    const anchor = event.target instanceof Element
      ? event.target.closest<HTMLAnchorElement>('.chat-md a') : null;
    if (!anchor || !event.currentTarget.contains(anchor)) return;
    event.preventDefault();
    event.stopPropagation();
    const link = outputLinkFromAnchor(anchor);
    if (!link || !onDocLinkTap) return;
    onDocLinkTap(link, event.clientX ?? 0, event.clientY ?? 0);
  };

  const lastMessage = messages.at(-1) ?? null;
  const activeAssistant = [...messages].reverse().find((message) => (
    message.type === 'text' && message.role === 'assistant' && message.streaming === true
  ));
  const runningLastTool = lastMessage?.type === 'tool'
    && (lastMessage.streaming === true
      || (timelineWorking && lastMessage.tool?.result == null));
  const liveCompacting = activity === 'compacting';
  const showTyping = !liveCompacting && !runningLastTool && (
    (activeAssistant && !activeAssistant.text)
      || (timelineWorking && !activeAssistant)
  );

  const visibleMessageCount = messages.filter((message) => (
    message.type !== 'thinking' && message.type !== 'plan'
  )).length;
  const canonicalReady = conversation.canonicalReady
    ?? (conversation.status !== 'loading' && conversation.status !== 'reconnecting');
  const loading = !canonicalReady && conversation.status !== 'error';
  const empty = conversation.status === 'ready' && visibleMessageCount === 0
    && !timelineWorking && !liveCompacting;
  const reconnecting = conversation.status === 'reconnecting';
  const unavailable = conversation.status === 'error';
  const connectionNotice = unavailable
    ? t('agentConversation.unavailable') : t('agentConversation.reconnecting');
  const reconnectingEmpty = canonicalReady && reconnecting && visibleMessageCount === 0;
  const reloadRequired = conversation.descriptor?.implementation?.reloadRequired === true;
  const hasTimeline = canonicalReady && (visibleMessageCount > 0 || timelineWorking
    || liveCompacting || conversation.hasMore
    || conversation.loadingOlder || !!pageError || reloadRequired) && !locatingCompletedEntry;
  return (
    <div className="chat-view agent-conversation-view" ref={viewRef} onClick={onOutputLinkClick}
      onPointerDown={copy.onPointerDown} onPointerMove={copy.onPointerMove}
      onPointerUp={() => {
        pointerGestureActiveRef.current = false;
        copy.cancel();
      }}
      onPointerCancel={() => {
        pointerGestureActiveRef.current = false;
        copy.cancel();
      }}
      onPointerLeave={() => {
        pointerGestureActiveRef.current = false;
        copy.cancel();
      }}
      onClickCapture={copy.onClickCapture}>
      {hasTimeline ? <div className="chat-scroll" ref={scrollRef}
        onPointerUp={() => {
          pointerGestureActiveRef.current = false;
          copy.cancel();
          if (stickBottomRef.current && !readingRef.current) scrollToBottom();
          else if (scrollRef.current) setAtBottom(withinBottomJumpThreshold(scrollRef.current));
        }}
        onPointerCancel={() => {
          pointerGestureActiveRef.current = false;
          copy.cancel();
          if (stickBottomRef.current && !readingRef.current) scrollToBottom();
          else if (scrollRef.current) setAtBottom(withinBottomJumpThreshold(scrollRef.current));
        }}
        onPointerLeave={() => {
          pointerGestureActiveRef.current = false;
          copy.cancel();
          if (stickBottomRef.current && !readingRef.current) scrollToBottom();
          else if (scrollRef.current) setAtBottom(withinBottomJumpThreshold(scrollRef.current));
        }}
        onWheel={(event) => {
          lastScrollGestureAtRef.current = Date.now();
          if (event.deltaY < 0) {
            enterReadingMode();
            if ((scrollRef.current?.scrollTop ?? Infinity) <= HISTORY_TOP_TRIGGER_PX) requestOlder();
          }
        }}
        onScroll={() => {
          const element = scrollRef.current;
          if (!element) return;
          copy.cancel();
          if (copy.active) copy.dismiss();
          const previousTop = lastScrollTopRef.current;
          const movingUp = element.scrollTop < previousTop - 1;
          const movingDown = element.scrollTop > previousTop + 1;
          lastScrollTopRef.current = element.scrollTop;
          const anchor = pageAnchorRef.current;
          if (anchor) {
            if (anchor.element && element.contains(anchor.element)) {
              anchor.offset = anchor.element.getBoundingClientRect().top
                - element.getBoundingClientRect().top;
            } else {
              const visible = visiblePageAnchor(element);
              anchor.element = visible.element;
              anchor.offset = visible.offset;
            }
            anchor.scrollTop = element.scrollTop;
            anchor.scrollHeight = element.scrollHeight;
          }
          const bottomDistance = Math.max(
            0, element.scrollHeight - element.scrollTop - element.clientHeight,
          );
          const atTrueBottom = bottomDistance <= BOTTOM_REJOIN_PX;
          if (movingUp) enterReadingMode();
          else if (atTrueBottom && movingDown && Date.now() - lastScrollGestureAtRef.current < 5_000) {
            readingRef.current = false;
            stickBottomRef.current = true;
          }
          setAtBottom(bottomDistance <= BOTTOM_JUMP_THRESHOLD_PX);
          if (movingUp && element.scrollTop <= HISTORY_TOP_TRIGGER_PX) requestOlder();
        }}>
        {reloadRequired && (
          <div className="chat-turn-notice is-warning" role="status">
            {t('agentConversation.reloadRequired')}
          </div>
        )}
        {(conversation.hasMore || conversation.loadingOlder || pageError) && (
          <div className="chat-history-slot">
            {showHistorySpinner && conversation.loadingOlder && (
              <HistoryActivityIndicator label={t('chat.historyPulling')} />
            )}
            {pageError && (
              <button type="button" className="chat-history-retry" onClick={requestOlder}>
                {t('agentConversation.loadOlderFailed')}
              </button>
            )}
          </div>
        )}
        {messages.map((message, index) => {
          if (message.type === 'thinking' || message.type === 'plan') return null;
          const key = rowKey(message);
          const plan = historicalPlans.get(index);
          const outgoing = outgoingByKey.get(key);
          const running = message.type === 'tool' && (
            message.streaming === true
              || (timelineWorking && index === messages.length - 1 && message.tool?.result == null)
          );
          return (
            <div key={key} className="chat-entry-row" data-completed-entry-key={key}>
              <ConversationEntry message={message} running={running}
                renderTool={(toolMessage, toolRunning) => toolMessage.tool && (
                  <ToolChip tool={toolMessage.tool} running={toolRunning}
                    onOpen={() => setSheetKey(messageIdentity(toolMessage))} />
                )}
                renderGoal={(goalMessage) => goalMessage.goal && (
                  <ConversationGoalCard goal={goalMessage.goal} event={goalMessage.event ?? null}
                    onOpen={setGoalSheet} />
                )}
                downloadResource={conversation.downloadResource}
                onOpenCompaction={setCompactionDetail} />
              {timestamped.has(index) && <MessageTime message={message} />}
              {outgoing && (
                <div className={`chat-optimistic-state is-${outgoing.status}`}>
                  <span role="status">{t(outgoing.status === 'sending'
                    ? 'chat.outgoing.sending'
                    : outgoing.status === 'accepted'
                      ? 'chat.outgoing.sent'
                      : outgoing.status === 'unknown'
                        ? 'chat.outgoing.unknown' : 'chat.outgoing.failed')}</span>
                  {(outgoing.status === 'failed' || outgoing.status === 'unknown')
                    && conversation.retryOutgoing && (
                    <button type="button"
                      aria-label={t(outgoing.status === 'unknown'
                        ? 'chat.outgoing.retryUnknown' : 'chat.outgoing.retry')}
                      onClick={() => void conversation.retryOutgoing?.(outgoing.clientRequestId)}>
                      {t(outgoing.status === 'unknown'
                        ? 'chat.outgoing.retryUnknown' : 'chat.outgoing.retry')}
                    </button>
                  )}
                </div>
              )}
              {plan && <ConversationPlanSummary plan={plan} onOpen={() => setPlanSheet(plan)} />}
            </div>
          );
        })}
        {liveCompacting && <div className="chat-compacting" aria-live="polite">
          <span className="chat-compacting-label">{t('chat.compacting.live')}</span>
          <TypingDots />
        </div>}
        {showTyping && <TypingIndicator />}
        {(reconnecting || unavailable) && (
          <div className="agent-conversation-reconnecting" role="status">
            {connectionNotice}
          </div>
        )}
      </div> : (
        <div className="agent-conversation-state">
          {(loading || (locatingCompletedEntry && showEntrySpinner))
            && <LensBoot hint={t('common.loading')} />}
          {empty && <div className="chat-new">{t('agentConversation.empty')}</div>}
          {reconnectingEmpty && (
            <div className="agent-conversation-reconnecting" role="status">
              {t('agentConversation.reconnecting')}
            </div>
          )}
          {unavailable && (
            <div className="agent-conversation-reconnecting" role="status">
              {t('agentConversation.unavailable')}
            </div>
          )}
        </div>
      )}
      {copy.calloutStyle && (
        <ConversationCopyCallout style={copy.calloutStyle} onCopy={() => void copy.copy()} />
      )}
      {(!atBottom || !atLatestWindow) && (
        <button type="button" className="new-output" aria-label={t('chat.scroll.latest')}
          onClick={scrollToBottom}>{t(atLatestWindow
            ? 'chat.scroll.bottom' : 'chat.scroll.reloadLatest')}</button>
      )}
      {compactionDetail && (
        <CompactionDetail value={{
          ...(compactionDetail.summary ? { summary: compactionDetail.summary } : {}),
          ...(compactionDetail.summaryTruncated ? { truncated: true } : {}),
        }} onClose={() => setCompactionDetail(null)} />
      )}
      {sheetMessage?.tool && (
        <ToolSheet tool={sheetMessage.tool} running={sheetMessage.streaming === true
          || (timelineWorking && sheetMessage === messages.at(-1) && sheetMessage.tool.result == null)}
          onClose={() => setSheetKey(null)} />
      )}
      <ConversationPlanSheet plan={planSheet} onClose={() => setPlanSheet(null)} />
      <ConversationGoalSheet goal={goalSheet} onClose={() => setGoalSheet(null)} />
    </div>
  );
}
