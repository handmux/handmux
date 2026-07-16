// web/src/components/PreviewSheet.jsx
import { useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { ChevronDownIcon, MonitorIcon, RefreshIcon, SmartphoneIcon } from './icons.jsx';
import { previewUrl } from '../api.js';
import { fmtRemainMin, useRemaining } from '../previewCountdown.js';
import { t } from '../i18n';

// Desktop viewport width emulated in "PC" mode: the page renders at this width inside the iframe.
const PC_WIDTH = 1280;
const PC_MAX_ZOOM = 6; // multiplier over fit-to-width

// Bottom-sheet preview of a registered site — same portal-on-<body> + slide-up shell as FileManager,
// so the keyboard-inset transform on .app can't drag it off-screen, and it's ALWAYS mounted: 收起
// (minimize) just slides it down, leaving the iframe alive. Top-bar actions are minimal — 手机/电脑
// view toggle + 刷新 + 收起; the TTL is a minutes-only chip that, when tapped, opens a 续期/停止 popover.
//
// PC view emulates a 1280-wide desktop page and scales the WHOLE page with the + / − buttons (100% =
// fit-to-width). The iframe stays fully interactive: it scrolls its own content, takes input, and the
// + / − buttons resize the whole page — so one mode covers slide + zoom + type.
export default function PreviewSheet({ open, tabs, activeName, name, kind = 'static', domain = null, port, dir, expiresAt, initialPath = '/', onSwitchTab, onCloseTab, onRenew, onStop, onMinimize }) {
  // Normalize to a tab list. App passes `tabs` (+ `activeName`); the single-preview props are a fallback
  // (used by tests / any caller that hasn't adopted tabs). All tabs' iframes stay mounted in parallel;
  // only the active one is shown, so switching keeps each preview's live state (HMR, scroll, form input).
  const tabList = (tabs && tabs.length)
    ? tabs
    : (name ? [{ name, kind, port, dir, expiresAt, path: initialPath }] : []);
  const active = tabList.find((tb) => tb.name === activeName) || tabList[0] || null;
  const [popOpen, setPopOpen] = useState(false); // the time chip's 续期/停止 popover
  const [device, setDevice] = useState('mobile'); // 'mobile' (device width) | 'pc' (emulate desktop)
  const [zoom, setZoom] = useState(1);            // PC zoom multiplier over fit-to-width (1 = 适应宽度)
  const [bodySize, setBodySize] = useState({ w: 0, h: 0 }); // measured so PC mode can scale-to-fit
  const frameRef = useRef(null);
  const bodyRef = useRef(null);

  useEffect(() => { if (!open) setPopOpen(false); }, [open]); // never reopen mid-popover
  useEffect(() => { if (device === 'mobile') setZoom(1); }, [device]); // leaving PC resets zoom
  // Measure the body for PC scale-to-fit; ResizeObserver may be absent (jsdom) → guard, measure once.
  useEffect(() => {
    const el = bodyRef.current;
    if (!open || !el) return undefined;
    const measure = () => setBodySize({ w: el.clientWidth, h: el.clientHeight });
    measure();
    if (typeof ResizeObserver === 'undefined') return undefined;
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    return () => ro.disconnect();
  }, [open]);

  const remainMs = useRemaining(active?.expiresAt, open);
  // What to show after the name: a dynamic preview's port, a static preview's source dir.
  const detail = active?.kind === 'dynamic' ? (active.port != null ? `:${active.port}` : '') : (active?.dir || '');
  // Short tab label: a dynamic preview's :port, a static preview's dir basename (or 静态预览).
  const tabLabel = (tb) => (tb.kind === 'dynamic' ? (tb.port != null ? `:${tb.port}` : tb.name) : (tb.dir ? tb.dir.split('/').filter(Boolean).pop() : t('preview.static')));

  const pc = device === 'pc' && bodySize.w > 0;
  const scaleFit = bodySize.w > 0 ? bodySize.w / PC_WIDTH : 1; // zoom 1 = whole desktop width fits
  const frameH = bodySize.h > 0 ? bodySize.h / scaleFit : 0;   // page viewport height (constant across zoom)
  const effScale = scaleFit * zoom;
  // The .preview-scaler box takes the SCALED size so the body (overflow:auto) gets real scroll area.
  const scalerStyle = pc ? { width: `${PC_WIDTH * effScale}px`, height: `${frameH * effScale}px` } : undefined;
  const frameStyle = pc
    ? { width: `${PC_WIDTH}px`, height: `${frameH}px`, transform: `scale(${effScale})`, transformOrigin: '0 0' }
    : undefined;
  const zoomBy = (d) => setZoom((z) => Math.min(PC_MAX_ZOOM, Math.max(1, +(z + d).toFixed(2))));

  // Reload the previewed page: contentWindow.location works for same-origin (static) previews; a
  // dynamic preview is a cross-origin subdomain so the reload throws → caught, fall back to re-assigning src.
  const refresh = () => {
    const f = frameRef.current;
    if (!f) return;
    try { f.contentWindow.location.reload(); } catch { f.src = f.src; } // eslint-disable-line no-self-assign
  };

  return createPortal(
    <div className={`file-sheet ${open ? 'open' : ''}`} aria-hidden={!open}>
      <div className="file-tabs preview-head">
        <span className="preview-status">
          <MonitorIcon />
          <span className="preview-state">{active?.kind === 'dynamic' ? t('preview.dynamic') : t('preview.static')}</span>
          {active?.name && (
            <span className="preview-name" title={`${active.name}${detail ? '  ' + detail : ''}`}>
              {active.name}{detail && <span className="preview-detail">{detail}</span>}
            </span>
          )}
        </span>
        <button className="preview-remain" title={t('preview.remainTitle')} aria-haspopup="dialog" aria-expanded={popOpen}
          onClick={() => setPopOpen((o) => !o)}>{fmtRemainMin(remainMs)}</button>
        <button className="preview-iconbtn" onClick={() => setDevice((d) => (d === 'mobile' ? 'pc' : 'mobile'))}
          aria-label={device === 'mobile' ? t('preview.toPcView') : t('preview.toMobileView')}
          title={device === 'mobile' ? t('preview.pcView') : t('preview.mobileView')} aria-pressed={device === 'pc'}>
          {device === 'mobile' ? <MonitorIcon /> : <SmartphoneIcon />}
        </button>
        <button className="preview-iconbtn" onClick={refresh} aria-label={t('preview.refresh')} title={t('preview.refresh')}><RefreshIcon /></button>
        <button className="file-min" aria-label={t('preview.minimize')} title={t('preview.minimize')} onClick={onMinimize}><ChevronDownIcon /></button>
        {popOpen && (
          <>
            <div className="preview-pop-backdrop" onClick={() => setPopOpen(false)} />
            <div className="preview-pop" role="dialog" aria-label={t('preview.ttlDialog')}>
              <button className="preview-pop-item" onClick={() => { setPopOpen(false); onRenew?.(); }}>{t('preview.renew')}</button>
              <button className="preview-pop-item preview-pop-danger" onClick={() => { setPopOpen(false); onStop?.(); }}>{t('preview.stop')}</button>
            </div>
          </>
        )}
      </div>
      {tabList.length > 1 && (
        <div className="preview-tabs" role="tablist" aria-label={t('preview.tabs')}>
          {tabList.map((tb) => {
            const isActive = active && tb.name === active.name;
            return (
              <span key={tb.name} className={`preview-tab ${isActive ? 'active' : ''}`}>
                <button className="preview-tab-btn" role="tab" aria-selected={isActive} title={tb.name}
                  onClick={() => onSwitchTab?.(tb.name)}>{tabLabel(tb)}</button>
                <button className="preview-tab-close" aria-label={t('preview.stop')} title={t('preview.stop')}
                  onClick={() => onCloseTab?.(tb.name)}>×</button>
              </span>
            );
          })}
        </div>
      )}
      <div className={`file-body preview-body ${pc ? 'pc' : ''}`} ref={bodyRef}>
        {/* Every tab's iframe stays mounted (inactive ones display:none, still live); only the active one
            shows, and only it gets the PC scaler + frameRef (for refresh). */}
        {tabList.map((tb) => {
          const isActive = active && tb.name === active.name;
          const setRef = (el) => { if (isActive) frameRef.current = el; };
          const src = previewUrl({ name: tb.name, kind: tb.kind }, domain, tb.path || '/');
          return (
            <div key={tb.name} className="preview-pane" style={isActive ? undefined : { display: 'none' }}>
              {isActive && pc ? (
                <div className="preview-scaler" style={scalerStyle}>
                  <iframe ref={setRef} className="preview-frame" title={t('preview.iframeTitle')} style={frameStyle} src={src} />
                </div>
              ) : (
                <iframe ref={setRef} className="preview-frame" title={t('preview.iframeTitle')} src={src} />
              )}
            </div>
          );
        })}
      </div>
      {pc && (
        <div className="preview-zoom">
          <button className="preview-zoom-btn" onClick={() => zoomBy(-0.5)} disabled={zoom <= 1} aria-label={t('preview.zoomOut')}>−</button>
          <span className="preview-zoom-val" aria-hidden="true">{Math.round(zoom * 100)}%</span>
          <button className="preview-zoom-btn" onClick={() => zoomBy(0.5)} disabled={zoom >= PC_MAX_ZOOM} aria-label={t('preview.zoomIn')}>+</button>
        </div>
      )}
    </div>,
    document.body,
  );
}
