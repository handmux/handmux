// web/src/components/ChatView.jsx
// The 对话 lens: a read-projection of the pane's Claude session as IM bubbles + two-type gate cards
// (permission / AskUserQuestion). NO input of its own — text is typed in the existing BottomDock composer
// (which stays mounted below in chat lens). Gate buttons write via the SAME send-keys the terminal uses.
import { useEffect, useRef, useState } from 'react';
import { marked } from 'marked';
import DOMPurify from 'dompurify';
import { useTranscript } from '../hooks/useTranscript.js';
import { pendingGate } from '../chatGate.js';
import { sendKeys } from '../api.js';

// One-line summary for a collapsed tool chip. Cover the high-frequency tools; generic fallback otherwise.
function toolSummary(tool) {
  const n = tool.name || '工具';
  const inp = tool.input || {};
  if (n === 'Bash') return `▶ 运行命令: ${inp.command || ''}`.trim();
  if (n === 'Edit' || n === 'Write') return `✎ ${n === 'Write' ? '写入' : '编辑'} ${inp.file_path || ''}`.trim();
  if (n === 'Read') return `📄 读取 ${inp.file_path || ''}`.trim();
  return `🔧 ${n}`;
}

function ToolChip({ tool }) {
  const [open, setOpen] = useState(false);
  const headClass = 'chat-tool-head' + (open ? ' chat-tool-head-open' : '');
  return (
    <div className={'chat-tool' + (tool.isError ? ' chat-tool-err' : '')}>
      <button type="button" className={headClass} onClick={() => setOpen((v) => !v)} aria-expanded={open}>
        {toolSummary(tool)}
      </button>
      {open && tool.result != null && <pre className="chat-tool-body">{tool.result}</pre>}
    </div>
  );
}

function Bubble({ m }) {
  if (m.type === 'tool') return <ToolChip tool={m.tool} />;
  if (m.type === 'thinking') return <div className="chat-thinking">{m.text}</div>;
  // Assistant text gets markdown (tables/code/etc render properly); user text stays plain — it's what the
  // user typed, not content to be re-interpreted. Same marked→DOMPurify pipeline as DocView.jsx.
  if (m.role !== 'user') {
    const html = DOMPurify.sanitize(marked.parse(m.text || ''));
    return <div className="chat-bubble chat-them chat-md" dangerouslySetInnerHTML={{ __html: html }} />;
  }
  return <div className="chat-bubble chat-me">{m.text}</div>;
}

const NEAR_BOTTOM_PX = 40;
const NEAR_TOP_PX = 80;

export default function ChatView({ pane, kind }) {
  const { messages, hasMoreOlder, loadOlder, loadingOlder } = useTranscript(pane, true);
  const gate = pendingGate(messages, kind);
  const isPlanGate = kind === 'permission' && !gate; // permission 但被 pendingGate 排除（如 ExitPlanMode）

  const scrollRef = useRef(null);
  const stickBottomRef = useRef(true); // was the user near the bottom just before this render's messages changed?
  const prevScrollHeightRef = useRef(null); // captured just before a loadOlder() prepend, to preserve scroll position
  const pendingPrependRef = useRef(false); // true only while a loadOlder() round-trip is in flight, so a
  // recent-window poll landing mid-flight doesn't consume the stale prevScrollHeight and jump the view.
  const lastMaxKRef = useRef(null); // largest message.k seen as of the previous messages-effect run
  const [atBottom, setAtBottom] = useState(true);

  const onScroll = () => {
    const el = scrollRef.current;
    if (!el) return;
    const near = el.scrollHeight - el.scrollTop - el.clientHeight < NEAR_BOTTOM_PX;
    stickBottomRef.current = near;
    setAtBottom(near);
    if (el.scrollTop < NEAR_TOP_PX && hasMoreOlder && !loadingOlder) {
      prevScrollHeightRef.current = el.scrollHeight;
      pendingPrependRef.current = true;
      loadOlder();
    }
  };

  const jumpToBottom = () => {
    const el = scrollRef.current;
    if (!el) return;
    el.scrollTop = el.scrollHeight;
    stickBottomRef.current = true;
    setAtBottom(true);
  };

  // Default view is pinned to the bottom (newest), like a normal chat. Priority on each messages change:
  //   1. a loadOlder() prepend just landed (pendingPrependRef set) → restore the visual position (scroll
  //      delta) so the view doesn't jump — this must win over everything else, it's mid-flight state.
  //   2. the newest message is a NEWLY-ARRIVED user message (bigger k than last seen, role==='user') — the
  //      user just sent it via the composer below (ChatView can't see the send itself) → force bottom
  //      regardless of where the view was scrolled.
  //   3. otherwise, if the view was already near the bottom → keep it stuck there.
  //   4. otherwise leave the scroll position alone.
  useEffect(() => {
    const el = scrollRef.current;
    const newest = messages.length ? messages[messages.length - 1] : null;
    const newestK = newest ? (newest.k ?? newest.i) : null;
    const isNewTrailingUser = newest && newest.role === 'user'
      && lastMaxKRef.current != null && newestK != null && newestK > lastMaxKRef.current;

    if (!el) return;
    if (pendingPrependRef.current) {
      // Do NOT advance lastMaxKRef here: this run is preempted by the in-flight prepend restore, so it
      // never evaluates isNewTrailingUser for real. Leaving lastMaxKRef stale means the very next
      // (non-prepend) run still sees a trailing new user message as new and force-scrolls to bottom —
      // otherwise a message sent while scrolled up (mid-prepend) would be silently marked "already seen"
      // and permanently strand the user off-screen after their own send.
      el.scrollTop += el.scrollHeight - prevScrollHeightRef.current;
      prevScrollHeightRef.current = null;
      pendingPrependRef.current = false;
      return;
    }
    if (newestK != null) lastMaxKRef.current = lastMaxKRef.current == null ? newestK : Math.max(lastMaxKRef.current, newestK);
    if (isNewTrailingUser) {
      el.scrollTop = el.scrollHeight;
      stickBottomRef.current = true;
      setAtBottom(true);
      return;
    }
    if (stickBottomRef.current) el.scrollTop = el.scrollHeight;
  }, [messages]);

  // First mount / pane switch: land at the bottom immediately (no animation to fight).
  useEffect(() => {
    const el = scrollRef.current;
    if (el) el.scrollTop = el.scrollHeight;
    stickBottomRef.current = true;
    setAtBottom(true);
    lastMaxKRef.current = null;
  }, [pane]);

  return (
    <div className="chat-view">
      <div className="chat-scroll" ref={scrollRef} onScroll={onScroll}>
        {messages.length === 0 && <div className="chat-empty">还没有对话内容</div>}
        {messages.map((m, idx) => <Bubble key={(m.k ?? m.i) + ':' + idx} m={m} />)}
      </div>

      {!atBottom && (
        <button type="button" className="chat-jump-bottom" aria-label="回到最新" onClick={jumpToBottom}>
          ↓
        </button>
      )}

      {gate && (
        <div className="chat-gate">
          <div className="chat-gate-prompt">{gate.prompt}</div>
          <div className="chat-gate-actions">
            {gate.options.map((o, i) => (
              <button key={i} type="button" className="chat-gate-btn" onClick={() => sendKeys(pane, o.keys)}>{o.label}</button>
            ))}
          </div>
        </div>
      )}
      {isPlanGate && <div className="chat-gate chat-gate-hint">这一步需要在终端里处理，点右上「终端」切换。</div>}
    </div>
  );
}
// 输入不在此处：chat 镜头下底部照常是 BottomDock composer（Task 7 保证其常驻），门卡片悬在气泡流末尾、composer 之上。
