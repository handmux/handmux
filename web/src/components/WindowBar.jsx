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
import { paneLayout, hasGeometry, cellFit, MAP_W, MAP_H, MAP_PAD } from '../paneLayout.js';
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
// A picked tile flashes to the selected state for this long before the switch lands + the map closes,
// so you SEE which pane you chose (an instant close gives no feedback that anything happened).
const PICK_MS = 200;

// One map tile. Tap = switch (onChoose); long-press = manage this pane (onManage). Its own component
// so useLongPress is a valid per-tile hook. `releasing` drives the blue-handoff on the outgoing tile.
function PaneMapCell({ cell, cur, releasing, picking, agent, onChoose, onManage }) {
  const fit = cellFit(cell); // '' | 'flat' | 'narrow' | 'tiny'
  const cmd = cell.command || cell.id;
  const lp = useLongPress(() => onManage(cell.id), { onClick: () => onChoose(cell.id) });
  return (
    <button
      type="button"
      role="option"
      aria-selected={cur}
      aria-label={cmd}
      className={`pane-map-cell${cur ? ' is-current' : ''}${releasing ? ' is-releasing' : ''}${fit ? ` is-${fit}` : ''}${picking ? ' is-picking' : ''}`}
      style={{ left: `${cell.left + MAP_PAD}px`, top: `${cell.top + MAP_PAD}px`, width: `${cell.width}px`, height: `${cell.height}px` }}
      {...lp}
    >
      <span className="pmc-surf">
        {fit === 'narrow' || fit === 'tiny' ? (
          <span className="pmc-seq" aria-hidden="true">{seq(cell.seq)}</span>
        ) : fit === 'flat' ? (
          <>
            <span className="pmc-seq" aria-hidden="true">{seq(cell.seq)}</span>
            <span className="pmc-cmd">{cmd}</span>
          </>
        ) : (
          <>
            <span className="pmc-row">
              <span className="pmc-seq" aria-hidden="true">{seq(cell.seq)}</span>
              {agent && <AgentMark agent={agent} />}
            </span>
            <span className="pmc-cmd">{cmd}</span>
          </>
        )}
      </span>
    </button>
  );
}

function PaneTab({ window: win, panes, paneAgents = {}, currentPaneId, agent, onManage, onManagePane, onSelectPane, paneSheetOpen = false, openMapFor = null, onMapOpened }) {
  const [open, setOpen] = useState(false);
  // Id of the tile mid-selection (drives the .is-picking flash) until the switch commits.
  const [picking, setPicking] = useState(null);
  const pickTimer = useRef(null);
  useEffect(() => () => clearTimeout(pickTimer.current), []);
  // Tap a tile: give a nudge of haptic (Android; iOS Safari has no web haptic → silently ignored),
  // flash the tile selected, then commit the switch. Under reduced-motion, skip the flash and switch now.
  const choose = (id) => {
    try { navigator.vibrate?.(10); } catch { /* unsupported */ }
    // If the pane-manage sheet is already open, tapping another tile re-points that sheet at the tapped
    // pane too — its title and its split/close target follow your selection, not just the viewed pane.
    if (paneSheetOpen) onManagePane?.(id);
    const reduce = typeof window !== 'undefined' && window.matchMedia
      && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    if (reduce) { onSelectPane(id); return; } // map stays open — outside tap closes it
    setPicking(id);
    clearTimeout(pickTimer.current);
    pickTimer.current = setTimeout(() => {
      setPicking(null);
      onSelectPane(id); // no setOpen(false): dwell in the map to split/close next
    }, PICK_MS);
  };
  // The menu is position:fixed (anchored by measured rect), not absolute: its anchor sits inside the
  // horizontally-scrolling .windowbar-scroll, whose overflow would otherwise CLIP a normal dropdown
  // and make it invisible (you'd see only the caret flip). Fixed escapes that clip; we keep it pinned
  // under the tab by recomputing on scroll/resize.
  const [pos, setPos] = useState(null);
  const rootRef = useRef(null);
  // The pixel-accurate mosaic (null → no geometry → flat-list fallback). Its own size can grow a little
  // past the base box when a tiny pane is padded to a minimum, so the viewport clamp below uses the
  // real dims, not the base constants.
  const layout = hasGeometry(panes) ? paneLayout(panes) : null;
  const mapW = layout ? layout.w : MAP_W;
  const mapH = layout ? layout.h : MAP_H;
  // Anchor under the tab, then CLAMP inside the viewport so a tab near the right/bottom edge can't
  // push the fixed-position popover off-screen: pin its right edge in when it would overflow right,
  // and flip it above the tab when it would overflow the bottom. MARGIN keeps it off the very edge.
  const place = () => {
    const r = rootRef.current?.getBoundingClientRect();
    if (!r) return;
    const MARGIN = 8;
    const vw = window.innerWidth;
    const vh = window.innerHeight;
    const left = Math.max(MARGIN, Math.min(r.left, vw - mapW - MARGIN));
    let top = r.bottom + 6;
    if (top + mapH + MARGIN > vh) {
      const above = r.top - 6 - mapH;
      top = above >= MARGIN ? above : Math.max(MARGIN, vh - mapH - MARGIN);
    }
    setPos({ top, left });
  };
  const lp = useLongPress(() => onManage(win), {
    onClick: () => { if (!open) place(); setOpen((o) => !o); },
  });

  // "管理分屏" in the window sheet asks (by our window id) to open the map: anchor + show it, then clear
  // the request so it fires once. Only the active window mounts a PaneTab, so App switches to us first.
  useEffect(() => {
    if (openMapFor && openMapFor === win.id) {
      place();
      setOpen(true);
      onMapOpened?.();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [openMapFor, win.id]);

  // Close on an outside tap (capture phase, beats other handlers); reposition while open — same as Dropdown.
  // EXCEPT while a pane-manage sheet is open (split/close): that sheet renders on <body>, so tapping its
  // actions/backdrop is "outside" this tab and would slam the map shut BEFORE the split/close even runs —
  // and the whole point is to keep the map open so it live-refreshes to the new layout and re-highlights
  // the pane now on screen. So suppress the outside-close entirely while the sheet is up; the sheet owns
  // its own dismissal, and normal outside-close resumes once it closes.
  useEffect(() => {
    if (!open) return undefined;
    const onDocDown = (e) => {
      if (paneSheetOpen) return;
      if (!rootRef.current?.contains(e.target)) setOpen(false);
    };
    const reflow = () => place();
    document.addEventListener('pointerdown', onDocDown, true);
    window.addEventListener('scroll', reflow, true);
    window.addEventListener('resize', reflow);
    return () => {
      document.removeEventListener('pointerdown', onDocDown, true);
      window.removeEventListener('scroll', reflow, true);
      window.removeEventListener('resize', reflow);
    };
  }, [open, paneSheetOpen]);

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
          <div className="pane-map" role="listbox" style={{ top: pos.top, left: pos.left, width: mapW, height: mapH }}>
            {layout.cells.map((c) => {
              const isCur = c.id === currentPaneId;
              return (
                <PaneMapCell
                  key={c.id}
                  cell={c}
                  cur={isCur}
                  releasing={isCur && !!picking && picking !== currentPaneId}
                  picking={picking === c.id}
                  agent={paneAgents[c.id]}
                  onChoose={choose}
                  onManage={onManagePane}
                />
              );
            })}
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
  onManagePane, paneSheetOpen = false, openMapFor = null, onMapOpened, trackWindowId,
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
                onManagePane={onManagePane}
                onSelectPane={onSelectPane}
                paneSheetOpen={paneSheetOpen}
                openMapFor={openMapFor}
                onMapOpened={onMapOpened}
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
