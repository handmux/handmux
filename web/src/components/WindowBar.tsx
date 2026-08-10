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
import LensSwitch from './LensSwitch.jsx';
import { useBackButton } from '../hooks/useBackButton.js';
import { OverlayPortal } from '../overlays/OverlayHost.js';
import type { PaneLayoutCell, PaneLayoutSource } from '../paneLayout.js';
import type { WorkspaceLens } from './LensSwitch.jsx';

export interface WorkspaceWindow {
  id: string;
  name?: string | null;
  active?: boolean;
  panes: number;
}

export interface WorkspacePane extends PaneLayoutSource {
  agent?: string | null;
}

type AgentMap = Readonly<Record<string, string | null | undefined>>;

export interface WindowBarProps {
  windows: readonly WorkspaceWindow[];
  windowAgents?: AgentMap;
  paneAgents?: AgentMap;
  currentAgent?: string | null;
  currentWindowId: string;
  panes: readonly WorkspacePane[];
  currentPaneId: string;
  onSelectWindow: (window: WorkspaceWindow) => void;
  onSelectPane: (paneId: string) => void;
  onNewWindow: () => void;
  onManageWindow: (window: WorkspaceWindow) => void;
  onManagePane?: (paneId: string) => void;
  onBeforePaneMapOpen?: (windowId: string) => void | Promise<void>;
  paneSheetOpen?: boolean;
  openMapFor?: string | null;
  onMapOpened?: () => void;
  onPaneMapOpenChange?: (open: boolean) => void;
  trackWindowId?: string | null;
  lens?: WorkspaceLens;
  onLensChange?: (lens: WorkspaceLens) => void;
  chatLensEnabled?: boolean;
}

const CIRCLED = '①②③④⑤⑥⑦⑧⑨';
const seq = (index: number): string => (index < CIRCLED.length ? CIRCLED[index] : String(index + 1));
const paneLabel = (pane: WorkspacePane | undefined, index: number): string => `${seq(index)} ${pane?.command || pane?.id || ''}`;

// `agent` is the agent id running in this window; when set, its logo prefixes the tab name.
interface WindowTabProps {
  window: WorkspaceWindow;
  active: boolean;
  agent?: string | null;
  onSelect: (window: WorkspaceWindow) => void;
  onManage: (window: WorkspaceWindow) => void;
}

function WindowTab({ window: win, active, agent, onSelect, onManage }: WindowTabProps) {
  const lp = useLongPress<HTMLButtonElement>(() => onManage(win), { onClick: () => onSelect(win) });
  return (
    <button data-win={win.id} className={`win-tab ${active ? 'active' : ''}`} {...lp}>
      <span className="win-title">
        {agent && <AgentMark agent={agent} />}
        <span>{win.name || win.id}</span>
      </span>
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
const DIMENSIONS_MIN_W = 90; // below this, cols×rows would compete with seq / Agent in the top row

// One map tile. Tap = switch (onChoose); long-press = manage this pane (onManage). Its own component
// so useLongPress is a valid per-tile hook. `releasing` drives the blue-handoff on the outgoing tile.
interface PaneMapCellProps {
  cell: PaneLayoutCell;
  cur: boolean;
  releasing: boolean;
  picking: boolean;
  agent?: string | null;
  onChoose: (paneId: string) => void;
  onManage?: (paneId: string) => void;
}

function PaneMapCell({ cell, cur, releasing, picking, agent, onChoose, onManage }: PaneMapCellProps) {
  const fit = cellFit(cell); // '' | 'flat' | 'narrow' | 'tiny'
  const cmd = cell.command || cell.id;
  const hasDimensions = Number.isFinite(cell.cols) && Number.isFinite(cell.rows);
  const dimensions = hasDimensions ? `${cell.cols}×${cell.rows}` : '';
  const showDimensions = fit === '' && cell.width >= DIMENSIONS_MIN_W && dimensions;
  const lp = useLongPress<HTMLButtonElement>(() => onManage?.(cell.id), { onClick: () => onChoose(cell.id) });
  return (
    <button
      type="button"
      role="option"
      aria-selected={cur}
      aria-label={dimensions ? `${cmd}, ${dimensions}` : cmd}
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
              {showDimensions && <span className="pmc-dims" aria-hidden="true">{dimensions}</span>}
            </span>
            <span className="pmc-cmd">{cmd}</span>
          </>
        )}
      </span>
    </button>
  );
}

interface PaneTabProps {
  window: WorkspaceWindow;
  panes: readonly WorkspacePane[];
  paneAgents?: AgentMap;
  currentPaneId: string;
  agent?: string | null;
  onManage: (window: WorkspaceWindow) => void;
  onManagePane?: (paneId: string) => void;
  onSelectPane: (paneId: string) => void;
  onBeforePaneMapOpen?: (windowId: string) => void | Promise<void>;
  paneSheetOpen?: boolean;
  openMapFor?: string | null;
  onMapOpened?: () => void;
  onPaneMapOpenChange?: (open: boolean) => void;
}

function PaneTab({
  window: win,
  panes,
  paneAgents = {},
  currentPaneId,
  agent,
  onManage,
  onManagePane,
  onSelectPane,
  onBeforePaneMapOpen,
  paneSheetOpen = false,
  openMapFor = null,
  onMapOpened,
  onPaneMapOpenChange,
}: PaneTabProps) {
  const [open, setOpen] = useState(false);
  useBackButton(open, () => setOpen(false));
  const openRef = useRef(open);
  const onPaneMapOpenChangeRef = useRef(onPaneMapOpenChange);
  openRef.current = open;
  onPaneMapOpenChangeRef.current = onPaneMapOpenChange;
  useEffect(() => {
    onPaneMapOpenChange?.(open);
  }, [open, onPaneMapOpenChange]);
  useEffect(() => () => {
    if (openRef.current) onPaneMapOpenChangeRef.current?.(false);
  }, []);
  // Id of the tile mid-selection (drives the .is-picking flash) until the switch commits.
  const [picking, setPicking] = useState<string | null>(null);
  const pickTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => () => { if (pickTimer.current !== null) clearTimeout(pickTimer.current); }, []);
  // Tap a tile: give a nudge of haptic (Android; iOS Safari has no web haptic → silently ignored),
  // flash the tile selected, then commit the switch. Under reduced-motion, skip the flash and switch now.
  const choose = (id: string): void => {
    try { navigator.vibrate?.(10); } catch { /* unsupported */ }
    // If the pane-manage sheet is already open, tapping another tile re-points that sheet at the tapped
    // pane too — its title and its split/close target follow your selection, not just the viewed pane.
    if (paneSheetOpen) onManagePane?.(id);
    const reduce = typeof window !== 'undefined' && window.matchMedia
      && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    if (reduce) { onSelectPane(id); return; } // map stays open — outside tap closes it
    setPicking(id);
    if (pickTimer.current !== null) clearTimeout(pickTimer.current);
    pickTimer.current = setTimeout(() => {
      setPicking(null);
      onSelectPane(id); // no setOpen(false): dwell in the map to split/close next
    }, PICK_MS);
  };
  // The popup is position:fixed (anchored by measured rect), not absolute: its anchor sits inside the
  // horizontally-scrolling .windowbar-scroll, whose overflow would otherwise CLIP a normal dropdown.
  // The geometry-backed map is also portalled to <body>, because iOS WebKit can still clip a fixed
  // descendant of an overflow scroller. Recompute its viewport coordinates on scroll/resize.
  const [pos, setPos] = useState<{ top: number; left: number } | null>(null);
  const rootRef = useRef<HTMLDivElement | null>(null);
  const popupRef = useRef<HTMLDivElement | null>(null);
  // The pixel-accurate mosaic (null → no geometry → flat-list fallback). Its own size can grow a little
  // past the base box when a tiny pane is padded to a minimum, so the viewport clamp below uses the
  // real dims, not the base constants.
  const layout = hasGeometry(panes) ? paneLayout(panes) : null;
  const mapW = layout ? layout.w : MAP_W;
  const mapH = layout ? layout.h : MAP_H;
  // Anchor under the tab, then CLAMP inside the viewport so a tab near the right/bottom edge can't
  // push the fixed-position popover off-screen: pin its right edge in when it would overflow right,
  // and flip it above the tab when it would overflow the bottom. MARGIN keeps it off the very edge.
  const place = (): void => {
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
  // Pane metadata may refresh after the map is already visible. Re-anchor only when its outer
  // dimensions change so a freshly discovered layout cannot push the popup off-screen.
  useLayoutEffect(() => {
    if (open) place();
    // `place` intentionally reads the current render's map dimensions and anchor ref.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, mapW, mapH]);
  const lp = useLongPress<HTMLButtonElement>(() => onManage(win), {
    onClick: () => {
      if (open) { setOpen(false); return; }
      const show = () => { place(); setOpen(true); };
      // Cached panes are already enough to draw a useful map. Open now and refresh in the background;
      // a slow request must neither delay this tap nor reopen a map the user has since closed.
      show();
      if (onBeforePaneMapOpen) {
        try { void Promise.resolve(onBeforePaneMapOpen(win.id)).catch(() => {}); } catch { /* optional refresh */ }
      }
    },
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
    const onDocDown = (event: PointerEvent): void => {
      if (paneSheetOpen) return;
      if (!(event.target instanceof Node)
        || (!rootRef.current?.contains(event.target) && !popupRef.current?.contains(event.target))) setOpen(false);
    };
    const reflow = (): void => place();
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
        <span className="win-title">
          {agent && <AgentMark agent={agent} />}
          <span className="wt-name">{win.name || win.id}</span>
        </span>
        <span className="wt-sep" aria-hidden="true">│</span>
        <span className="wt-pane">{paneLabel(cur, idx)}</span>
        <span className={`wt-caret${open ? ' open' : ''}`} aria-hidden="true">▾</span>
      </button>
      {open && pos && (
        layout ? (
          <OverlayPortal>
            <div ref={popupRef} className="pane-map" role="listbox" style={{ top: pos.top, left: pos.left, width: mapW, height: mapH }}>
              {layout.cells.map((c) => {
                const isCur = c.id === currentPaneId;
                return (
                  <PaneMapCell
                    key={c.id}
                    cell={c}
                    cur={isCur}
                    releasing={isCur && !!picking && picking !== currentPaneId}
                    picking={picking === c.id}
                    agent={paneAgents[c.id] ?? null}
                    onChoose={choose}
                    {...(onManagePane ? { onManage: onManagePane } : {})}
                  />
                );
              })}
            </div>
          </OverlayPortal>
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
                  {paneAgents[p.id] && <AgentMark agent={paneAgents[p.id] ?? null} />}
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
  onManagePane, onBeforePaneMapOpen, paneSheetOpen = false, openMapFor = null, onMapOpened, onPaneMapOpenChange, trackWindowId,
  lens = 'terminal', onLensChange = () => {}, chatLensEnabled = false,
}: WindowBarProps) {
  const scrollRef = useRef<HTMLDivElement | null>(null);
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
                agent={currentAgent ?? null}
                onManage={onManageWindow}
                {...(onManagePane ? { onManagePane } : {})}
                onSelectPane={onSelectPane}
                {...(onBeforePaneMapOpen ? { onBeforePaneMapOpen } : {})}
                paneSheetOpen={paneSheetOpen}
                openMapFor={openMapFor}
                {...(onMapOpened ? { onMapOpened } : {})}
                {...(onPaneMapOpenChange ? { onPaneMapOpenChange } : {})}
              />
            );
          }
          return (
            <WindowTab
              key={w.id}
              window={w}
              active={active}
              agent={windowAgents[w.id] ?? null}
              onSelect={onSelectWindow}
              onManage={onManageWindow}
            />
          );
        })}
        <button className="win-tab win-new" onClick={onNewWindow} aria-label={t('windowbar.newWindow')} title={t('windowbar.newWindow')}>＋</button>
      </div>
      {/* The 对话 lens is experimental (Settings opt-in): no switch until it's enabled. */}
      {chatLensEnabled && <LensSwitch value={lens} onChange={onLensChange} />}
    </div>
  );
}
