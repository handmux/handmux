import { useRef, useState } from 'react';
import type { CSSProperties, ReactNode } from 'react';
import FileBrowser from './FileBrowser.jsx';
import { fetchPaneCwd } from '../api.js';
import { t } from '../i18n';

export interface DirPickerProps {
  open: boolean;
  seedCwd?: string | null;
  hint?: ReactNode;
  pane?: string | null;
  allowMkdir?: boolean;
  onPick: (dir: string) => void | Promise<void>;
  onClose: () => void;
  inset?: number;
}

const noop = (): void => {};

function cwdOf(value: unknown): string | null {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return null;
  const cwd = (value as Record<string, unknown>).cwd;
  return typeof cwd === 'string' && cwd ? cwd : null;
}

// Directory-only picker overlay. FileBrowser owns path validation and the $HOME fallback.
export default function DirPicker({
  open,
  seedCwd = null,
  hint = null,
  pane = null,
  allowMkdir = false,
  onPick,
  onClose,
  inset = 0,
}: DirPickerProps) {
  const [path, setPath] = useState<string | null>(seedCwd);
  // Adjust during render on the open edge so FileBrowser mounts on the new seed without a one-frame HOME flash.
  const wasOpen = useRef(false);
  if (open && !wasOpen.current) {
    wasOpen.current = true;
    if (path !== seedCwd) setPath(seedCwd);
  } else if (!open && wasOpen.current) {
    wasOpen.current = false;
  }

  const jumpToCwd = pane ? async (): Promise<void> => {
    try {
      const cwd = cwdOf(await fetchPaneCwd(pane));
      if (cwd) setPath(cwd);
    } catch { /* ignore */ }
  } : null;
  if (!open) return null;
  const style: CSSProperties & { '--kb-inset': string } = {
    transform: `translate(-50%, calc(-50% + ${inset / 2}px))`,
    '--kb-inset': `${inset}px`,
  };
  return (
    <>
      <div className="settings-backdrop dirpick-backdrop" onClick={onClose} />
      <div className="settings-card dirpick-card" style={style}
        role="dialog" aria-label={t('dirpicker.title')} aria-modal="true">
        <div className="settings-head">
          <span className="settings-title">{t('dirpicker.title')}</span>
          <button className="settings-close" onClick={onClose} aria-label={t('common.close')}>✕</button>
        </div>
        {hint && <div className="dirpick-hint">{hint}</div>}
        <FileBrowser
          path={path} onNavigate={setPath} onOpenDoc={noop}
          onJumpToCwd={jumpToCwd}
          pickMode allowMkdir={allowMkdir} onPick={onPick} overlayActive={open}
        />
      </div>
    </>
  );
}
