import { t } from '../i18n';
import { useBackButton } from '../hooks/useBackButton.js';
import { OverlayPortal } from '../overlays/OverlayHost.js';
import { XIcon } from './icons.jsx';

export interface CompactionDetailValue {
  summary?: string;
  truncated?: boolean;
}

export function CompactionBanner({ onOpen }: { onOpen: () => void }) {
  return (
    <button type="button" className="chat-compact-divider" onClick={onOpen}
      aria-label={`${t('chat.compacted')} · ${t('chat.compaction.viewDetails')}`}>
      <span>{t('chat.compacted')}</span>
      <small>{t('chat.compaction.viewDetails')}</small>
    </button>
  );
}

export default function CompactionDetail({
  value,
  onClose,
}: {
  value: CompactionDetailValue;
  onClose: () => void;
}) {
  useBackButton(true, onClose);
  return (
    <OverlayPortal className="compaction-detail-layer">
      <div className="compaction-detail-backdrop" onClick={onClose} />
      <section className="compaction-detail-sheet" role="dialog" aria-modal="true"
        aria-label={t('chat.compaction.title')}>
        <div className="tool-sheet-grip" />
        <header className="compaction-detail-head">
          <strong>{t('chat.compaction.title')}</strong>
          <span>{t('chat.compaction.complete')}</span>
        </header>
        <button type="button" className="cmd-close compaction-detail-x"
          aria-label={t('common.close')} onClick={onClose}><XIcon /></button>
        <div className="compaction-detail-body">
          <h3>{t('chat.compaction.summary')}</h3>
          {value.summary ? <pre>{value.summary}</pre> : (
            <p className="compaction-detail-empty">{t('chat.compaction.unavailable')}</p>
          )}
          {value.truncated && (
            <p className="compaction-detail-note">{t('chat.compaction.truncated')}</p>
          )}
        </div>
      </section>
    </OverlayPortal>
  );
}
