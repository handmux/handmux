import { CHANGELOG } from '../changelog.js';
import { t, getLangCode } from '../i18n';

// Full-screen "What's new" page — a read-only list of every release (newest first). Opened from Settings;
// App marks the latest entry seen on open (clearing the unread dot). The separate pre-upgrade notice in
// Settings is intentionally compact; this page remains the complete historical record.
export default function Changelog({ open, onClose }: { open: boolean; onClose: () => void }) {
  if (!open) return null;
  return (
    <div className="settings-page changelog-page" role="dialog" aria-label={t('changelog.title')} aria-modal="true">
      <header className="settings-page-head">
        <button type="button" className="settings-page-back" onClick={onClose} aria-label={t('common.back')}>‹</button>
        <h1>{t('changelog.title')}</h1>
        <span className="settings-page-head-spacer" aria-hidden="true" />
      </header>
      <div className="settings-page-body">
        <main className="settings-page-content detail changelog-page-content">
          <div className="changelog-list settings-page-list">
            {CHANGELOG.map((rel) => {
              // items is { zh, en }; fall back across locales so a partly-translated entry still shows.
              const items = rel.items[getLangCode()] || rel.items.en || rel.items.zh || [];
              // Header: "v0.9.1 · 2026-07-06" for public releases; the localized label ("早期内测") for
              // the merged internal builds, which carry no version.
              const label = rel.version ? `v${rel.version}` : (rel.label?.[getLangCode()] || rel.label?.en);
              return (
                <div key={rel.version || rel.date} className="rel">
                  <div className="rel-date">
                    {label && <span className="rel-ver">{label}</span>}
                    <span className="rel-day">{rel.date}</span>
                  </div>
                  <ul className="rel-items">
                    {items.map((it, i) => <li key={i}>{it}</li>)}
                  </ul>
                </div>
              );
            })}
          </div>
        </main>
      </div>
    </div>
  );
}
