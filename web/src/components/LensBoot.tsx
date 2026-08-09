// Shared waiting state for both lenses: a three-dot wave with a short text hint (正在加载).
// pointer-events:none: it never intercepts taps meant for the surface beneath.
export default function LensBoot({ hint }: { hint?: string | null }) {
  return (
    <div className="lens-boot" aria-live="polite">
      <div className="lens-boot-dots" aria-hidden="true">
        <span className="lens-boot-dot" />
        <span className="lens-boot-dot" />
        <span className="lens-boot-dot" />
      </div>
      {hint && <div className="lens-boot-hint">{hint}</div>}
    </div>
  );
}
