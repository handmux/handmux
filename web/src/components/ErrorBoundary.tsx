// Crash containment. Without a boundary, ANY throw from a render or an effect unmounts the whole React
// tree — the user sees a blank dark page with nothing tappable and no way back except restarting the
// app (reported from a real device). The boundary keeps the failure local, SHOWS the error so it can be
// reported, and offers a way out.
//
// Two scopes:
//   • page  — wraps the whole app (main.tsx). Last resort: the recovery rebuilds the app.
//   • panel — wraps the document preview inside the file sheet, so a bad document cannot take the
//             terminal and the rest of the session down with it.
import { Component } from 'react';
import type { ErrorInfo, ReactNode } from 'react';
import { t } from '../i18n';

interface Props {
  children: ReactNode;
  /** 'page' fills the viewport; 'panel' sits inside the file sheet and adds a close action. */
  scope?: 'page' | 'panel';
  /** Called before the boundary clears its error — e.g. to leave the broken tab. */
  onReset?: () => void;
}

interface State {
  error: Error | null;
}

export default class ErrorBoundary extends Component<Props, State> {
  state: State = { error: null };

  static getDerivedStateFromError(error: Error): State {
    return { error };
  }

  componentDidCatch(error: Error, info: ErrorInfo): void {
    // Keep the component stack in the console for the next debugging round; the card shows the message.
    console.error('[handmux] render error', error, info?.componentStack);
  }

  private reset = (): void => {
    this.props.onReset?.();
    this.setState({ error: null });
  };

  render(): ReactNode {
    const { error } = this.state;
    if (!error) return this.props.children;
    const scope = this.props.scope ?? 'page';
    return (
      <div className={`crash-card is-${scope}`} role="alert">
        <div className="crash-title">{t('crash.title')}</div>
        <div className="crash-detail">{`${error.name || 'Error'}: ${error.message || ''}`.trim()}</div>
        <div className="crash-hint">{t('crash.hint')}</div>
        <div className="crash-actions">
          <button className="crash-btn" onClick={this.reset}>{t('crash.retry')}</button>
          {scope === 'page' ? (
            <button className="crash-btn is-primary" onClick={() => window.location.reload()}>
              {t('crash.reload')}
            </button>
          ) : (
            <button className="crash-btn is-primary" onClick={this.reset}>{t('crash.close')}</button>
          )}
        </div>
      </div>
    );
  }
}
