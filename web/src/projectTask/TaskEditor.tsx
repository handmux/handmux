import { useRef, useState } from 'react';
import { useBackButton } from '../hooks/useBackButton.js';
import { t } from '../i18n';
import type { Task, TaskDraftInput, TaskPriority } from './contracts.js';

const PRIORITIES: readonly TaskPriority[] = ['none', 'high', 'medium', 'low'];

function inputFromDescription(description: string): TaskDraftInput {
  const objective = description.trim();
  const title = objective.split(/\r?\n/).map((line) => line.trim()).find(Boolean)?.slice(0, 240) ?? '';
  return {
    title,
    objective,
    acceptanceCriteria: [],
    scope: null,
    constraints: null,
    references: [],
    priority: 'none',
  };
}

function initial(task: Task | null): TaskDraftInput {
  return {
    title: task?.title ?? '',
    objective: task?.objective ?? '',
    acceptanceCriteria: task?.acceptanceCriteria ?? [],
    scope: task?.scope ?? null,
    constraints: task?.constraints ?? null,
    references: task?.references ?? [],
    priority: task?.priority ?? 'none',
  };
}

export default function TaskEditor({ task, createMode = 'task', keyboardInset = 0,
  error, conflict = false, busy, onClose, onSave, onRefresh }: {
  task: Task | null;
  createMode?: 'task' | 'draft';
  keyboardInset?: number;
  error?: string | null;
  conflict?: boolean;
  busy?: boolean;
  onClose: () => void;
  onSave: (input: TaskDraftInput, asTask: boolean) => void | Promise<void>;
  onRefresh?: () => void | Promise<void>;
}) {
  const [value, setValue] = useState(() => initial(task));
  const restoringHistory = useRef(false);
  const set = <K extends keyof TaskDraftInput>(key: K, next: TaskDraftInput[K]): void => (
    setValue((current) => ({ ...current, [key]: next }))
  );
  const referencesText = value.references.map((reference) => reference.value).join('\n');
  const submit = (asTask: boolean): void => {
    void onSave(task ? value : inputFromDescription(value.objective), asTask);
  };
  const existingReady = task?.status === 'ready';
  const creating = task === null;
  const creatingTask = creating && createMode === 'task';
  const readyInputValid = Boolean(value.title.trim() && value.objective.trim());
  // App lifts its whole column by -keyboardInset. Giving this fixed page the same top inset cancels that
  // movement at the screen top, while its existing bottom: 0 shrinks the page to the space above the keyboard.
  const pageTop = Number.isFinite(keyboardInset) ? Math.max(0, keyboardInset) : 0;
  const dirty = JSON.stringify(value) !== JSON.stringify(initial(task));
  const confirmClose = (): boolean => !dirty || window.confirm(t('project.task.discardConfirm'));
  const closeFromButton = (): void => { if (!busy && confirmClose()) onClose(); };
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
    if (confirmClose()) onClose();
    else {
      restoringHistory.current = true;
      window.history.forward();
    }
  });

  return (
    <div className="project-page" role="dialog" aria-modal="true"
      style={pageTop > 0 ? { top: `${pageTop}px` } : undefined}
      aria-label={task ? task.title : t(creatingTask ? 'project.newTask' : 'project.newDraft')}>
      <header className="project-page-head">
        <button type="button" disabled={busy} onClick={closeFromButton} aria-label={t('common.back')}>‹</button>
        <h1>{task ? task.title : t(creatingTask ? 'project.newTask' : 'project.newDraft')}</h1>
        <span />
      </header>
      <main className={`project-form${creating ? ' project-quick-task' : ''}`}
        aria-busy={busy || undefined}>
        {error && <div className="project-error" role="alert"><span>{error}</span>
          {conflict && onRefresh && <button type="button" disabled={busy}
            onClick={() => void onRefresh()}>{t('project.task.loadLatest')}</button>}
        </div>}
        {creating ? <>
          <label>
            <span>{t('project.task.request')}</span>
            <textarea autoFocus rows={9} value={value.objective} disabled={busy}
              placeholder={t('project.task.requestPlaceholder')}
              onChange={(event) => set('objective', event.target.value)} />
          </label>
          <p className="project-quick-task-hint">{t('project.task.requestHint')}</p>
        </> : <>
          <label>
            <span>{t('project.task.title')}</span>
            <input value={value.title} maxLength={240} disabled={busy}
              onChange={(event) => set('title', event.target.value)} />
          </label>
          <label>
            <span>{t('project.task.objective')}</span>
            <textarea rows={4} value={value.objective} disabled={busy}
              onChange={(event) => set('objective', event.target.value)} />
          </label>
          <label>
            <span>{t('project.task.acceptance')}</span>
            <textarea rows={5} value={value.acceptanceCriteria.join('\n')} disabled={busy}
              onChange={(event) => set('acceptanceCriteria', event.target.value.split('\n'))} />
          </label>
          <label>
            <span>{t('project.task.scope')}</span>
            <textarea rows={3} value={value.scope ?? ''} disabled={busy}
              onChange={(event) => set('scope', event.target.value || null)} />
          </label>
          <label>
            <span>{t('project.task.constraints')}</span>
            <textarea rows={3} value={value.constraints ?? ''} disabled={busy}
              onChange={(event) => set('constraints', event.target.value || null)} />
          </label>
          <label>
            <span>{t('project.task.references')}</span>
            <textarea rows={3} value={referencesText} disabled={busy}
              onChange={(event) => set('references', event.target.value
              .split('\n').map((line) => line.trim()).filter(Boolean).map((line) => ({
                kind: /^https?:\/\//i.test(line) ? 'url' as const : 'path' as const,
                value: line,
                label: null,
              })))} />
          </label>
          <fieldset className="project-priority" disabled={busy}>
            <legend>{t('project.task.priority')}</legend>
            <div>
              {PRIORITIES.map((priority) => (
                <button key={priority} type="button" className="fontbtn"
                  aria-pressed={value.priority === priority} onClick={() => set('priority', priority)}>
                  {t(`project.task.priority.${priority}`)}
                </button>
              ))}
            </div>
          </fieldset>
        </>}
      </main>
      <footer className="project-form-actions">
        {!creating && !existingReady && (
          <button type="button" disabled={busy || !value.title.trim()} onClick={() => submit(false)}>
            {t('project.task.saveDraft')}
          </button>
        )}
        <button type="button" className="primary"
          disabled={busy || !(creating ? value.objective.trim() : readyInputValid)}
          onClick={() => submit(creating ? createMode === 'task' : true)}>
          {creating ? t(creatingTask ? 'project.task.create' : 'project.task.saveDraft')
            : existingReady ? t('project.task.save') : t('project.task.saveTask')}
        </button>
      </footer>
    </div>
  );
}
