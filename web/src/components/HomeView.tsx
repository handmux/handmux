// web/src/components/HomeView.jsx
import { useState, useEffect, useRef } from 'react';
import { getRecentDocs, removeRecentDoc } from '../storage.js';
import { t } from '../i18n';

interface RecentDoc {
  path: string;
  name: string;
}

export interface HomeViewProps {
  onOpenDoc: (path: string) => void | Promise<void>;
  refreshKey?: number;
}

const readRecentDocs = (): RecentDoc[] => {
  const value: unknown = getRecentDocs();
  if (!Array.isArray(value)) return [];
  return value.flatMap((entry): RecentDoc[] => {
    if (entry === null || typeof entry !== 'object' || Array.isArray(entry)) return [];
    const record = entry as Record<string, unknown>;
    return typeof record.path === 'string' && typeof record.name === 'string'
      ? [{ path: record.path, name: record.name }]
      : [];
  });
};

// The 最近 segment of the file viewer: ONLY recently-opened docs. The directory browser lives in the
// sibling 新增 segment (FileBrowser). Recent taps bubble an absolute path up via onOpenDoc.
export default function HomeView({ onOpenDoc, refreshKey = 0 }: HomeViewProps) {
  const [recents, setRecents] = useState<RecentDoc[]>(readRecentDocs);
  const dropRecent = (path: string): void => { removeRecentDoc(path); setRecents(readRecentDocs()); };
  // Re-read the (localStorage-backed) recents whenever the sheet reopens (refreshKey bump) — it stays
  // mounted while minimized, so a doc opened in the meantime wouldn't otherwise show up on reopen. Skip
  // the mount run: the useState initializer already read the current list.
  const firstRef = useRef(true);
  useEffect(() => {
    if (firstRef.current) { firstRef.current = false; return; }
    setRecents(readRecentDocs());
  }, [refreshKey]);

  if (recents.length === 0) {
    return (
      <div className="home-view">
        <div className="home-empty">{t('home.empty')}<span>{t('home.emptyHint')}</span></div>
      </div>
    );
  }
  return (
    <div className="home-view">
      {recents.map((d) => (
        <div key={d.path} className="home-recent-row">
          <button className="home-recent" onClick={() => onOpenDoc(d.path)} title={d.path}>
            <span className="home-name">{d.name}</span>
            <span className="home-path">{d.path}</span>
          </button>
          <button className="home-x" aria-label={t('home.remove')} onClick={() => dropRecent(d.path)}>✕</button>
        </div>
      ))}
    </div>
  );
}
