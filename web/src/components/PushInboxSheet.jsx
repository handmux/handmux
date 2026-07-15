import { useEffect, useState } from 'react';
import { t } from '../i18n';
import { getNotifications, deleteNotification } from '../push.js';

// Relative time, compact (jsdom-safe, no Intl.RelativeTimeFormat dependency): "刚刚" / "5分钟前" / a date.
function ago(ts) {
  const d = Math.max(0, Date.now() - ts);
  const m = Math.floor(d / 60000);
  if (m < 1) return t('pushInbox.justNow');
  if (m < 60) return t('pushInbox.minutesAgo').replace('{n}', m);
  const h = Math.floor(m / 60);
  if (h < 24) return t('pushInbox.hoursAgo').replace('{n}', h);
  return new Date(ts).toLocaleDateString();
}

// Manual-push inbox. Opening does NOT mark read — only the footer button does (calls onAllRead with the
// newest ts). Delete is an inline ✕ per row (mirrors the recent-history row ✕), never a swipe gesture.
export default function PushInboxSheet({ open, onClose, onAllRead }) {
  const [items, setItems] = useState(null); // null = loading, [] = empty

  useEffect(() => {
    if (!open) return;
    let alive = true;
    getNotifications().then((list) => { if (alive) setItems(list); });
    return () => { alive = false; };
  }, [open]);

  if (!open) return null;

  const del = async (id) => {
    setItems((cur) => (cur || []).filter((n) => n.id !== id)); // optimistic
    await deleteNotification(id);
  };
  const markRead = () => {
    const maxTs = items && items.length ? items[0].ts : null; // list is newest-first
    onAllRead?.(maxTs);
  };

  return (
    <>
      <div className="settings-backdrop push-script-backdrop" onClick={onClose} />
      <div className="settings-card push-script-sheet" role="dialog" aria-label={t('pushInbox.title')} aria-modal="true">
        <div className="settings-head">
          <span className="settings-title">{t('pushInbox.title')}</span>
          <button className="settings-close" onClick={onClose} aria-label={t('common.close')}>✕</button>
        </div>

        {items == null ? null
          : items.length === 0 ? (
            <p className="push-script-intro push-inbox-empty">{t('pushInbox.empty')}</p>
          ) : (
            <>
              <ul className="push-inbox-list">
                {items.map((n) => (
                  <li key={n.id} className="push-inbox-row">
                    <div className="push-inbox-main">
                      <div className="push-inbox-row-title">{n.title}</div>
                      <div className="push-inbox-row-body">{n.body}</div>
                      <div className="push-inbox-row-time">{ago(n.ts)}</div>
                    </div>
                    <button className="push-inbox-del" onClick={() => del(n.id)} aria-label={t('pushInbox.delete')}>✕</button>
                  </li>
                ))}
              </ul>
              <button className="fontbtn push-inbox-markread" onClick={markRead}>{t('pushInbox.markRead')}</button>
            </>
          )}
      </div>
    </>
  );
}
