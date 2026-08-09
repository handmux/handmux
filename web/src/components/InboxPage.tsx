import { t } from '../i18n';
import { ChevronDownIcon } from './icons.jsx';
import { sanitizeNotificationUrl } from '../urlPolicy.js';
import { OverlayPortal } from '../overlays/OverlayHost.js';

// Relative time, compact (jsdom-safe, no Intl.RelativeTimeFormat): "刚刚" / "5分钟前" / a date.
export type DeliveryStatus = 'pending' | 'success' | 'failed';

export interface PushDelivery {
  status: DeliveryStatus;
  reason?: string | null;
}

export interface PushInboxItem {
  id: string;
  title: string;
  body: string;
  ts: number;
  url?: string | null;
  delivery?: PushDelivery | null;
}

interface InboxPageProps {
  open: boolean;
  detailId?: string | null;
  items: PushInboxItem[];
  readIds?: string[];
  onOpenDetail: (id: string) => void;
  onCloseDetail: () => void;
  onClose: () => void;
  onDelete: (id: string) => Promise<boolean> | boolean;
  deletingId?: string | null;
  error?: string;
  onRetry: () => void;
  onMarkAllRead: () => void;
  unreadCount?: number;
}

function ago(ts: number): string {
  const d = Math.max(0, Date.now() - ts);
  const m = Math.floor(d / 60000);
  if (m < 1) return t('pushInbox.justNow');
  if (m < 60) return t('pushInbox.minutesAgo').replace('{n}', m);
  const h = Math.floor(m / 60);
  if (h < 24) return t('pushInbox.hoursAgo').replace('{n}', h);
  return new Date(ts).toLocaleDateString();
}

const DELIVERY_REASON_KEY: Record<string, string> = {
  expired: 'pushInbox.deliveryReasonExpired',
  rate_limited: 'pushInbox.deliveryReasonRateLimited',
  service_unavailable: 'pushInbox.deliveryReasonUnavailable',
  rejected: 'pushInbox.deliveryReasonRejected',
  network_error: 'pushInbox.deliveryReasonNetwork',
  not_configured: 'pushInbox.deliveryReasonNotConfigured',
};

function deliveryLabel(delivery: PushDelivery | null | undefined, withReason = false): string {
  if (delivery?.status === 'pending') return t('pushInbox.deliveryPending');
  if (delivery?.status === 'success') return t('pushInbox.deliverySuccess');
  if (delivery?.status === 'failed') {
    if (!withReason) return t('pushInbox.deliveryFailed');
    const reasonKey = typeof delivery.reason === 'string'
      ? DELIVERY_REASON_KEY[delivery.reason] : undefined;
    const reason = t(reasonKey || 'pushInbox.deliveryReasonUnknown');
    return `${t('pushInbox.deliveryFailed')} · ${reason}`;
  }
  return '';
}

// Full-screen manual-push inbox. Uses the app's shared full-screen sheet shell (.file-sheet slide-up +
// portal-on-<body> + .file-tabs header), exactly like GitPanel/FileManager/PreviewSheet — NOT a bespoke
// overlay. List and detail are ONE sheet: opening a message swaps the header (‹ back + title) and body
// (matches App's single back-guard: detail→list→close). App owns state/read/delete; this is presentational.
// Classes stay push-inbox-* (not inbox-*) — .inbox-* belongs to the unrelated pane-status Inbox.
export default function InboxPage({ open, detailId, items, readIds = [], onOpenDetail, onCloseDetail, onClose,
  onDelete, deletingId = null, error = '', onRetry, onMarkAllRead, unreadCount = 0 }: InboxPageProps) {
  const readSet = new Set(readIds);
  const inDetail = detailId != null;
  const detail = inDetail ? items.find((x) => x.id === detailId) : null;
  const detailUrl = sanitizeNotificationUrl(detail?.url);
  const detailDelivery = deliveryLabel(detail?.delivery, true);
  const hasUnread = items.some((n) => !readSet.has(n.id));

  return (
    <OverlayPortal>
      <div className={`file-sheet push-inbox-sheet ${open ? 'open' : ''}`} aria-hidden={!open}
      role="dialog" aria-label={t('pushInbox.title')}>
      <div className="file-tabs push-inbox-head">
        {inDetail ? (
          <div className="push-inbox-drill-head">
            <button className="push-inbox-back" aria-label={t('pushInbox.back')} title={t('pushInbox.back')} onClick={onCloseDetail}>‹</button>
            <span className="push-inbox-head-title">{t('pushInbox.detailTitle')}</span>
          </div>
        ) : (
          <span className="push-inbox-head-title push-inbox-list-title">
            {t('pushInbox.title')}
            {unreadCount > 0 && <span className="push-inbox-unread-count">{t('pushInbox.unreadCount').replace('{n}', unreadCount)}</span>}
          </span>
        )}
        {!inDetail && hasUnread && (
          <button className="push-inbox-markall" onClick={onMarkAllRead}>{t('pushInbox.markAllRead')}</button>
        )}
        <button className="file-min" aria-label={t('common.close')} title={t('common.close')} onClick={onClose}><ChevronDownIcon /></button>
      </div>

      <div className="push-inbox-body">
        {error && (
          <div className="push-inbox-error" role="alert">
            <span>{error}</span>
            <button type="button" onClick={onRetry}>{t('pushInbox.retry')}</button>
          </div>
        )}
        {inDetail ? (
          detail ? (
            <div className="push-inbox-detail">
              <div className="push-inbox-detail-title">{detail.title}</div>
              <div className="push-inbox-detail-time">{ago(detail.ts)}</div>
              {detailDelivery && <div className={`push-inbox-delivery detail ${detail.delivery?.status || ''}`}>{detailDelivery}</div>}
              <div className="push-inbox-detail-text">{detail.body}</div>
              {detailUrl && <a className="fontbtn push-inbox-openurl" href={detailUrl}>{t('pushInbox.openUrl')}</a>}
              <button className="fontbtn push-inbox-detail-del" disabled={deletingId != null}
                onClick={async () => { if (await onDelete(detail.id)) onCloseDetail(); }}>
                {t('pushInbox.delete')}
              </button>
            </div>
          ) : (
            <p className="push-inbox-empty">{t('pushInbox.expired')}</p>
          )
        ) : items.length === 0 && !error ? (
          <p className="push-inbox-empty">{t('pushInbox.empty')}</p>
        ) : items.length > 0 ? (
          <ul className="push-inbox-list">
            {items.map((n) => (
              <li key={n.id} className={`push-inbox-row${readSet.has(n.id) ? '' : ' push-inbox-unread'}`}>
                <button className="push-inbox-main" onClick={() => onOpenDetail(n.id)}>
                  <div className="push-inbox-row-top">
                    <span className="push-inbox-row-title">{n.title}</span>
                    {deliveryLabel(n.delivery) && (
                      <span className={`push-inbox-delivery ${n.delivery?.status || ''}`}>{deliveryLabel(n.delivery)}</span>
                    )}
                    <span className="push-inbox-row-time">{ago(n.ts)}</span>
                  </div>
                  <div className="push-inbox-row-body">{n.body}</div>
                </button>
                <button className="push-inbox-del" disabled={deletingId != null}
                  onClick={() => void onDelete(n.id)} aria-label={t('pushInbox.delete')}>✕</button>
              </li>
            ))}
          </ul>
        ) : null}
      </div>
    </div>
    </OverlayPortal>
  );
}
