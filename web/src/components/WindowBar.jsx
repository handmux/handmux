// One-row nav strip below the topbar: the current session's windows scroll horizontally. A window
// with a single pane is just a plain tab; the ACTIVE window with >1 panes expands inline into a
// combined "name │ ① cmd ▾" control whose tap opens a themed pane menu (reusing the .dd-menu styles
// from Dropdown). So the old always-on right-side pane <select> is gone — no pane picker clutters a
// single-pane window. Tap a tab to switch; long-press a tab to manage it (rename / delete) — that
// long-press still works on the expanded pane tab (its tap opens the menu instead of switching, since
// the window is already active). Selecting a window picks its remembered pane.
import { useRef, useLayoutEffect, useState, useEffect } from 'react';
import { useLongPress } from '../hooks/useLongPress.js';
import { AgentMark } from './icons.jsx';
import { paneRects, hasGeometry } from '../paneLayout.js';
import { t } from '../i18n';

const CIRCLED = '①②③④⑤⑥⑦⑧⑨';
const seq = (i) => (i < CIRCLED.length ? CIRCLED[i] : String(i + 1));
const paneLabel = (p, i) => `${seq(i)} ${p.command || p.id}`;

// `agent` is the agent id running in this window; when set, its logo prefixes the tab name.
function WindowTab({ window: win, active, agent, onSelect, onManage }) {
  const lp = useLongPress(() => onManage(win), { onClick: () => onSelect(win) });
  return (
    <button data-win={win.id} className={`win-tab ${active ? 'active' : ''}`} {...lp}>
      {agent && <AgentMark agent={agent} />}
      {win.name || win.id}
      {win.panes > 1 && <span className="win-panes">{win.panes}</span>}
    </button>
  );
}

// Active window with >1 pane: the tab carries the current pane inline and taps open the pane menu.
// Long-press = manage the window. The menu reuses Dropdown's .dd-menu / .dd-option visuals; the
// current pane is pre-selected (✓), so opening it is just "confirm or switch".
function PaneTab({ window: win, panes, paneAgents = {}, currentPaneId, agent, onManage, onSelectPane }) {
  const [open, setOpen] = useState(false);
  // The menu is position:fixed (anchored by measured rect), not absolute: its anchor sits inside the
  // horizontally-scrolling .windowbar-scroll, whose overflow would otherwise CLIP a normal dropdown
  // and make it invisible (you'd see only the caret flip). Fixed escapes that clip; we keep it pinned
  // under the tab by recomputing on scroll/resize.
  const [pos, setPos] = useState(null);
  const rootRef = useRef(null);
  const place = () => {
    const r = rootRef.current?.getBoundingClientRect();
    if (r) setPos({ top: r.bottom + 6, left: r.left });
  };
  const lp = useLongPress(() => onManage(win), {
    onClick: () => { if (!open) place(); setOpen((o) => !o); },
  });

  // Close on an outside tap (capture phase, beats other handlers); reposition while open — same as Dropdown.
  useEffect(() => {
    if (!open) return undefined;
    const onDocDown = (e) => { if (!rootRef.current?.contains(e.target)) setOpen(false); };
    const reflow = () => place();
    document.addEventListener('pointerdown', onDocDown, true);
    window.addEventListener('scroll', reflow, true);
    window.addEventListener('resize', reflow);
    return () => {
      document.removeEventListener('pointerdown', onDocDown, true);
      window.removeEventListener('scroll', reflow, true);
      window.removeEventListener('resize', reflow);
    };
  }, [open]);

  const idx = Math.max(0, panes.findIndex((p) => p.id === currentPaneId));
  const cur = panes[idx];

  return (
    <div className="wt-dd active" data-win={win.id} ref={rootRef}>
      <button
        className="win-tab active wt-trigger"
        aria-haspopup="listbox"
        aria-expanded={open}
        {...lp}
      >
        {agent && <AgentMark agent={agent} />}
        <span className="wt-name">{win.name || win.id}</span>
        <span className="wt-sep" aria-hidden="true">│</span>
        <span className="wt-pane">{paneLabel(cur, idx)}</span>
        <span className={`wt-caret${open ? ' open' : ''}`} aria-hidden="true">▾</span>
      </button>
      {open && pos && (
        hasGeometry(panes) ? (
          <div className="pane-map wt-menu" role="listbox" style={{ top: pos.top, left: pos.left }}>
            {paneRects(panes).map((c) => (
              <button
                type="button"
                key={c.id}
                role="option"
                aria-selected={c.id === currentPaneId}
                className={`pane-map-cell${c.id === currentPaneId ? ' is-current' : ''}`}
                style={{ left: `${c.left}%`, top: `${c.top}%`, width: `${c.width}%`, height: `${c.height}%` }}
                onClick={() => { onSelectPane(c.id); setOpen(false); }}
              >
                <span className="pmc-seq" aria-hidden="true">{seq(c.seq)}</span>
                {paneAgents[c.id] && <AgentMark agent={paneAgents[c.id]} />}
                <span className="pmc-cmd">{c.command || c.id}</span>
              </button>
            ))}
          </div>
        ) : (
          <div className="dd-menu wt-menu" role="listbox" style={{ top: pos.top, left: pos.left }}>
            {panes.map((p, i) => (
              <button
                type="button"
                key={p.id}
                role="option"
                aria-selected={p.id === currentPaneId}
                className={`dd-option${p.id === currentPaneId ? ' is-selected' : ''}`}
                onClick={() => { onSelectPane(p.id); setOpen(false); }}
              >
                <span className="dd-option-label">
                  <span className="dd-pane-seq" aria-hidden="true">{seq(i)}</span>
                  {paneAgents[p.id] && <AgentMark agent={paneAgents[p.id]} />}
                  <span className="dd-pane-cmd">{p.command || p.id}</span>
                </span>
                {p.id === currentPaneId && <span className="dd-check" aria-hidden="true">✓</span>}
              </button>
            ))}
          </div>
        )
      )}
    </div>
  );
}

export default function WindowBar({
  windows, windowAgents = {}, paneAgents = {}, currentAgent, currentWindowId, panes, currentPaneId, onSelectWindow, onSelectPane, onNewWindow, onManageWindow,
  trackWindowId,
}) {
  const scrollRef = useRef(null);
  // While a window is being managed (its long-press menu open), keep its tab in view as the order
  // shifts underneath — a reorder can push it out of the scroll strip, and then you can't see it
  // move. No-op when nothing is tracked, so normal manual scrolling isn't hijacked.
  useLayoutEffect(() => {
    if (!trackWindowId) return;
    scrollRef.current?.querySelector(`[data-win="${trackWindowId}"]`)
      ?.scrollIntoView({ block: 'nearest', inline: 'nearest' });
  }, [windows, trackWindowId]);

  return (
    <div className="windowbar">
      <div className="windowbar-scroll" ref={scrollRef}>
        {windows.map((w) => {
          const active = w.id === currentWindowId;
          if (active && panes.length > 1) {
            return (
              <PaneTab
                key={w.id}
                window={w}
                panes={panes}
                paneAgents={paneAgents}
                currentPaneId={currentPaneId}
                agent={currentAgent}
                onManage={onManageWindow}
                onSelectPane={onSelectPane}
              />
            );
          }
          return (
            <WindowTab
              key={w.id}
              window={w}
              active={active}
              agent={windowAgents[w.id]}
              onSelect={onSelectWindow}
              onManage={onManageWindow}
            />
          );
        })}
        <button className="win-tab win-new" onClick={onNewWindow} aria-label={t('windowbar.newWindow')} title={t('windowbar.newWindow')}>＋</button>
      </div>
    </div>
  );
}
