import { useState, useEffect, useCallback } from 'react';
import { getPreviews, createPreview, deletePreview } from '../api.js';
import { previewName } from '../previewName.js';
import { setPreviewDir } from '../storage.js';

// The in-app preview subsystem: the registry state (previews/domain/dynamic flag), the visible-sheet flag,
// the current window's previews as switchable TABS, and every start/stop/renew/switch/open handler.
// `current` is App's { session, window, … } (for the per-window preview name); `settingsOpen` +
// `setSettingsOpen` let the open/start handlers coordinate with the Settings sheet's history entry (see
// the back-popstate sequencing in startDynamicPreview).
//
// Tabs: a window can have several live previews at once — its window-default (static dir or a dynamic
// port started from Settings, named `<window>`) plus any number of loopback-URL previews tapped from the
// terminal (named `<window>-<port>`). They're all registered in parallel server-side; the sheet shows one
// at a time and a tab strip switches between them (their iframes stay mounted, so switching keeps state).
// `activeTabName` picks which; `pathByName` remembers each tab's deep-link path (URL previews land on the
// tapped path, others on '/').
export function usePreviews(current, { settingsOpen, setSettingsOpen }) {
  const [previews, setPreviews] = useState([]);
  const [previewDomain, setPreviewDomain] = useState(null);
  const [dynamicEnabled, setDynamicEnabled] = useState(false);
  const [previewSheetOpen, setPreviewSheetOpen] = useState(false); // in-app preview sheet visible
  const [activeTabName, setActiveTabName] = useState(null);        // which tab the sheet shows
  const [pathByName, setPathByName] = useState({});               // name → deep-link path for that preview

  const refreshPreviews = useCallback(async () => {
    try {
      const r = await getPreviews();
      setPreviews(r.previews || []);
      setPreviewDomain(r.domain ?? null);
      setDynamicEnabled(!!r.dynamicEnabled);
    } catch { /* ignore */ }
  }, []);
  useEffect(() => { refreshPreviews(); }, [refreshPreviews]);

  // The preview name for the open session-window, and its window-default entry (if any, not expired).
  const curPreviewName = current
    ? previewName({ session: current.session?.name, windowName: current.window?.name, windowId: current.window?.id })
    : null;
  const activePreview = previews.find((p) => p.name === curPreviewName && p.expiresAt > Date.now()) || null;
  const activeExpiresAt = activePreview?.expiresAt ?? null;

  // Every live preview belonging to THIS window → the tab strip. The window default (`<window>`) sorts
  // first, then URL previews (`<window>-<port>`) by port. Each tab carries its remembered deep-link path.
  const isWindowPreview = (name) => !!curPreviewName && (name === curPreviewName || name.startsWith(`${curPreviewName}-`));
  const now = Date.now();
  const tabs = previews
    .filter((p) => p && p.expiresAt > now && isWindowPreview(p.name))
    .map((p) => ({ name: p.name, kind: p.kind, port: p.port, dir: p.dir, expiresAt: p.expiresAt, path: pathByName[p.name] || '/' }))
    .sort((a, b) => (a.name === curPreviewName ? -1 : b.name === curPreviewName ? 1 : (a.port || 0) - (b.port || 0)));

  // Effective active tab: the picked one if it's still live, else the first tab. shownPreview drives the
  // topbar icon and the sheet header; shownPath its initial iframe path.
  const activeName = tabs.find((tb) => tb.name === activeTabName)?.name ?? tabs[0]?.name ?? null;
  const shownPreview = tabs.find((tb) => tb.name === activeName) ?? null;
  const shownPath = shownPreview?.path || '/';

  // Tabs are window-scoped; on window change, forget the active pick so it can't linger over another window.
  useEffect(() => { setActiveTabName(null); }, [curPreviewName]);

  // Reset the sheet's open flag once this window has no previews, so a later fresh preview doesn't pop the
  // sheet open on its own (the flag would otherwise stay true from a previous session).
  const hasTabs = tabs.length > 0;
  useEffect(() => { if (!hasTabs) setPreviewSheetOpen(false); }, [hasTabs]);

  // Auto-clear the topbar icon when the window-default preview's TTL elapses (refetch drops the expired entry).
  useEffect(() => {
    if (activeExpiresAt == null) return undefined;
    const id = setTimeout(refreshPreviews, Math.max(0, activeExpiresAt - Date.now()) + 500);
    return () => clearTimeout(id);
  }, [activeExpiresAt, refreshPreviews]);

  // Open the preview sheet. If Settings is open (launching/opening from there), close Settings FIRST
  // and open the sheet on the NEXT frame — never in the same commit. Both overlays balance the Back
  // button via useBackButton (each pushes one history entry); swapping them in one commit makes the
  // closing Settings' cleanup `history.back()` pop the sheet's just-pushed entry, whose fresh popstate
  // listener then fires → the sheet flashes open and immediately closes back to the main page.
  const openPreviewSheet = useCallback(() => {
    setActiveTabName(curPreviewName); // opening the window default → focus its tab
    if (settingsOpen) {
      setSettingsOpen(false);
      requestAnimationFrame(() => setPreviewSheetOpen(true));
    } else {
      setPreviewSheetOpen(true);
    }
  }, [settingsOpen, setSettingsOpen, curPreviewName]);

  const startPreview = useCallback(async (dir) => {
    if (!curPreviewName) return;
    try {
      await createPreview(curPreviewName, { dir });
      setPreviewDir(current?.window?.id, dir); // remember → next open seeds here
      setPathByName((m) => ({ ...m, [curPreviewName]: '/' }));
      await refreshPreviews();
      openPreviewSheet();
    } catch { /* ignore */ }
  }, [curPreviewName, current?.window?.id, refreshPreviews, openPreviewSheet]);

  // Throws on failure (e.g. the port isn't listening) so Settings can show why instead of silently closing.
  const startDynamicPreview = useCallback(async (port) => {
    if (!curPreviewName) return;
    await createPreview(curPreviewName, { port }); // throws on failure → Settings keeps its inline error, stays open
    setPathByName((m) => ({ ...m, [curPreviewName]: '/' }));
    setActiveTabName(curPreviewName);
    await refreshPreviews();
    // Auto-open the sheet — but NOT in the same frame we close Settings. Settings' useBackButton pops its
    // history entry on close (history.back() → an async popstate); if the sheet opened immediately its
    // freshly-mounted popstate listener would catch THAT back and close itself — the preview flashed open
    // then shut (the exact dynamic-preview symptom). The static path dodges this only by luck: its caller
    // closes Settings seconds earlier (before the network), so the back-popstate has long dissipated by the
    // time the sheet opens. Here we make the gap explicit — open the sheet only AFTER Settings' back-popstate,
    // so the sheet's listener mounts on a clean history stack. Fallback timer covers the (rare) case where
    // Settings wasn't back-tracked and no popstate fires.
    let opened = false;
    const openSheet = () => {
      if (opened) return;
      opened = true;
      window.removeEventListener('popstate', onPop);
      clearTimeout(fallback);
      setPreviewSheetOpen(true);
    };
    const onPop = () => openSheet();
    window.addEventListener('popstate', onPop);
    const fallback = setTimeout(openSheet, 300);
    setSettingsOpen(false); // → Settings' useBackButton cleanup → history.back() → popstate → openSheet()
  }, [curPreviewName, refreshPreviews, setSettingsOpen]);

  // Open a tapped loopback URL through a dynamic-preview reverse-proxy: register `<window>-<port>` (so
  // several ports coexist as tabs), remember its deep-link path, focus its tab. Throws on failure (e.g.
  // the port isn't listening) so the caller can surface why — mirrors startDynamicPreview.
  const startUrlPreview = useCallback(async ({ port, path }) => {
    if (!curPreviewName) return;
    const name = `${curPreviewName}-${port}`;
    await createPreview(name, { port }); // throws on failure
    setPathByName((m) => ({ ...m, [name]: path || '/' }));
    setActiveTabName(name);
    await refreshPreviews();
    setPreviewSheetOpen(true);
  }, [curPreviewName, refreshPreviews]);

  const switchTab = useCallback((name) => setActiveTabName(name), []);

  // Close (stop) a tab: delete its registration + reap now. If it was active, the next render's activeName
  // falls back to the first remaining tab; if it was the last, the hasTabs effect closes the sheet.
  const closeTab = useCallback(async (name) => {
    if (!name) return;
    try {
      await deletePreview(name);
      setPathByName((m) => { const n = { ...m }; delete n[name]; return n; });
      if (activeTabName === name) setActiveTabName(null);
      await refreshPreviews();
    } catch { /* ignore */ }
  }, [activeTabName, refreshPreviews]);

  // The sheet's 停止 / 续期 popover acts on the ACTIVE tab.
  const stopPreview = useCallback(() => closeTab(activeName), [closeTab, activeName]);
  const renewPreview = useCallback(async () => {
    const target = tabs.find((tb) => tb.name === activeName);
    if (!target) return;
    const opts = target.kind === 'dynamic' ? { port: target.port } : { dir: target.dir };
    try { await createPreview(target.name, opts); await refreshPreviews(); } catch { /* ignore */ }
  }, [tabs, activeName, refreshPreviews]);

  // Keep-alive: while the sheet is OPEN, renew EVERY tab ~1 min before the soonest one expires so no
  // actively-viewed preview dies mid-use (all their iframes are live in parallel). Renewing bumps the
  // expiries → soonestExpiry changes → this effect reschedules, a self-perpetuating heartbeat. Tied to
  // previewSheetOpen (not merely having previews): a minimized/closed sheet stops renewing, so forgotten
  // proxies still expire and get reaped.
  const tabNamesKey = tabs.map((tb) => tb.name).join('|');
  const soonestExpiry = tabs.length ? Math.min(...tabs.map((tb) => tb.expiresAt)) : null;
  useEffect(() => {
    if (!previewSheetOpen || soonestExpiry == null || !tabNamesKey) return undefined;
    const names = tabNamesKey.split('|');
    const delay = Math.max(0, soonestExpiry - Date.now() - 60_000);
    const id = setTimeout(async () => {
      try {
        // Re-derive each name's registration args from the freshest registry, not the (possibly stale) closure.
        await Promise.all(names.map((name) => {
          const p = previews.find((e) => e && e.name === name);
          if (!p) return null;
          return createPreview(name, p.kind === 'dynamic' ? { port: p.port } : { dir: p.dir });
        }));
        await refreshPreviews();
      } catch { /* ignore */ }
    }, delay);
    return () => clearTimeout(id);
  }, [previewSheetOpen, soonestExpiry, tabNamesKey, previews, refreshPreviews]);

  return {
    previews, previewDomain, dynamicEnabled,
    previewSheetOpen, setPreviewSheetOpen,
    activePreview, curPreviewName,
    tabs, activeName, shownPreview, shownPath,
    refreshPreviews, openPreviewSheet,
    startPreview, startDynamicPreview, startUrlPreview,
    switchTab, closeTab, stopPreview, renewPreview,
  };
}
