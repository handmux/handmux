import { useRef } from 'react';
import { t } from '../i18n';
import { useBackButton } from '../hooks/useBackButton.js';
import type { Task } from './contracts.js';

export default function TaskDetail({ task, busy = false, error, onBack, onEdit, onCancel, onArchive }: {
  task: Task;
  busy?: boolean;
  error?: string | null;
  onBack: () => void;
  onEdit: () => void;
  onCancel: () => void;
  onArchive: () => void;
}) {
  const archived = Boolean(task.archivedAt);
  const readOnly = archived || task.status === 'canceled';
  const restoringHistory = useRef(false);
  const close = (): void => { if (!busy) onBack(); };
  useBackButton(true, () => {
    if (restoringHistory.current) {
      restoringHistory.current = false;
      return;
    }
    if (busy) {
      restoringHistory.current = true;
      window.history.forward();
      return;
    }
    onBack();
  });
  return (
    <div className="project-page" role="dialog" aria-modal="true" aria-label={task.title}>
      <header className="project-page-head">
        <button type="button" disabled={busy} onClick={close} aria-label={t('common.back')}>‹</button>
        <h1>{task.title}</h1>
        {readOnly ? <span className="project-read-only">{t('project.management.readOnly')}</span>
          : <button type="button" className="project-page-text" disabled={busy}
            onClick={onEdit}>{t('project.task.edit')}</button>}
      </header>
      <main className="project-task-detail">
        {error && <div className="project-error" role="alert"><span>{error}</span></div>}
        <section><h2>{t('project.task.objective')}</h2><p>{task.objective || '—'}</p></section>
        {task.acceptanceCriteria.length > 0 && <section><h2>{t('project.task.acceptance')}</h2>
          <ol>{task.acceptanceCriteria.map((item) => <li key={item}>{item}</li>)}</ol>
        </section>}
        {task.scope && <section><h2>{t('project.task.scope')}</h2><p>{task.scope}</p></section>}
        {task.constraints && <section><h2>{t('project.task.constraints')}</h2><p>{task.constraints}</p></section>}
        {task.references.length > 0 && <section><h2>{t('project.task.references')}</h2>
          <ul>{task.references.map((item) => <li key={`${item.kind}:${item.value}`}><code>{item.value}</code></li>)}</ul>
        </section>}
        {!archived && <div className="project-task-actions">
          <button type="button" disabled={busy} onClick={onArchive}>{t('project.task.archive')}</button>
          {task.status !== 'canceled' && <button type="button" className="danger" disabled={busy}
            onClick={onCancel}>{t('project.task.cancel')}</button>}
        </div>}
      </main>
    </div>
  );
}
