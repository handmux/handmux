import { useEffect, useState } from 'react';
import { sendText, sendKeys, UnauthorizedError } from '../api.js';
import type { PendingPrompt } from '../hooks/usePendingPrompt.js';

interface PromptGateProps {
  pane: string;
  prompt: PendingPrompt;
  onAuthFail?: () => void;
  onAct?: () => void;
}

// The 对话-lens action gate: renders a pending AskUserQuestion / permission menu (scraped from the pane via
// usePendingPrompt) as a native single-select list + 确认/取消 — instead of blindly showing 允许/拒绝.
// The gate is DOCKED over the composer (position:fixed bottom — while a menu owns the pane's input, the
// composer behind is useless anyway), so the question is always in view with no scrolling. `prompt.leadIn`
// shows the assistant's last line(s) before the question — scraped server-side because the turn isn't
// flushed to the jsonl until AFTER the answer, so the transcript can't show it while the gate is up.
//
// Driving is by DIGIT hotkey (verified live): sending an option's number selects it — for a single question
// it selects AND submits; for a multi-question it selects AND auto-advances to the next tab; on the review
// screen digit 1 = "Submit answers". So 确认 sends String(sel), and the poll (usePendingPrompt) picks up
// whatever screen comes next (next question → review → gate gone). 取消 sends Escape.
export default function PromptGate({ pane, prompt, onAuthFail, onAct }: PromptGateProps) {
  const first = prompt.cursor ?? prompt.options[0]?.n ?? null;
  const [sel, setSel] = useState<number | null>(first);
  const [cancelSig, setCancelSig] = useState<string | null>(null);
  // Reset the local selection whenever the underlying screen changes (a new question / the review screen),
  // keyed by a signature of the prompt so a stale pick never carries across steps. Cancellation stores that
  // same signature: a new screen is synchronously unarmed, without waiting for this effect to run.
  const sig = `${prompt.title}|${prompt.options.map((o) => `${o.n}:${o.label}`).join(',')}`;
  const cancelArmed = cancelSig === sig;
  useEffect(() => { setSel(prompt.cursor ?? prompt.options[0]?.n ?? null); }, [sig]); // eslint-disable-line react-hooks/exhaustive-deps
  // A stray touch on the left button must not interrupt the agent. The first tap only arms cancellation;
  // if the user does not deliberately tap it again soon, return to the safe idle state automatically.
  useEffect(() => {
    if (!cancelArmed) return undefined;
    const timer = setTimeout(() => setCancelSig(null), 2000);
    return () => clearTimeout(timer);
  }, [cancelArmed]);

  const send = async (fn: () => void | Promise<unknown>): Promise<void> => {
    try { await fn(); onAct?.(); }
    catch (e) { if (e instanceof UnauthorizedError) onAuthFail?.(); }
  };
  const pick = (n: number): Promise<void> => send(() => sendText(pane, String(n), false));
  const cancel = (): Promise<void> => send(() => sendKeys(pane, ['Escape']));
  const requestCancel = (action: () => void | Promise<unknown> = cancel): void => {
    if (!cancelArmed) { setCancelSig(sig); return; }
    setCancelSig(null);
    void action();
  };
  const confirm = (): void => {
    if (sel === null) return;
    setCancelSig(null);
    void pick(sel);
  };
  const cancelLabel = cancelArmed ? '再点一次取消' : '取消';

  // The multi-question review screen: options are Submit answers / Cancel — show it as a plain confirm.
  if (prompt.submit) {
    const submitN = (prompt.options.find((o) => /submit/i.test(o.label)) || prompt.options[0]).n;
    const cancelOpt = prompt.options.find((o) => /cancel/i.test(o.label));
    return (
      <div className="chat-gate">
        <div className="chat-gate-prompt">复核并提交你的回答?</div>
        <div className="chat-gate-actions">
          <button type="button" className="chat-gate-btn" onClick={() => requestCancel(() => (cancelOpt ? pick(cancelOpt.n) : cancel()))}>{cancelLabel}</button>
          <button type="button" className="chat-gate-btn primary" onClick={() => { setCancelSig(null); pick(submitN); }}>提交</button>
        </div>
      </div>
    );
  }

  return (
    <div className="chat-gate">
      {prompt.leadIn && <div className="chat-gate-leadin">{prompt.leadIn}</div>}
      {prompt.multi && <div className="chat-gate-step">第 {prompt.step}/{prompt.total} 题</div>}
      <div className="chat-gate-prompt">{prompt.title}</div>
      <div className="chat-gate-options" role="radiogroup">
        {prompt.options.map((o) => (
          <button key={o.n} type="button" role="radio" aria-checked={sel === o.n}
            className={`chat-gate-opt${sel === o.n ? ' on' : ''}`} onClick={() => { setCancelSig(null); setSel(o.n); }}>
            <span className="chat-gate-opt-label">{o.label}</span>
            {o.description && <span className="chat-gate-opt-desc">{o.description}</span>}
          </button>
        ))}
      </div>
      <div className="chat-gate-actions">
        <button type="button" className="chat-gate-btn" onClick={() => requestCancel()}>{cancelLabel}</button>
        <button type="button" className="chat-gate-btn primary" disabled={sel == null}
          onClick={confirm}>确认</button>
      </div>
    </div>
  );
}
