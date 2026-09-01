import type { CSSProperties } from 'react';

export default function HistoryActivityIndicator({ label }: { label: string }) {
  return (
    <span className="chat-history-spinner" role="status" aria-label={label}>
      {Array.from({ length: 12 }, (_, index) => (
        <i key={index} aria-hidden="true"
          style={{ '--history-spinner-spoke': index } as CSSProperties} />
      ))}
    </span>
  );
}
