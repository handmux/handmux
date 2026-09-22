import { t } from '../i18n';
import type { ReactNode } from 'react';
import type { Project, Task } from './contracts.js';

export type ProjectBucket = 'tasks' | 'drafts';

export default function ProjectHome({ project, bucket, tasks, loading, error, inbox, obscured = false, onMenu, onBucket,
  onCreate, onRetry, onManage, onOpenTask }: {
  project: Project;
  bucket: ProjectBucket;
  tasks: Task[];
  loading: boolean;
  error?: string | null;
  inbox: ReactNode;
  obscured?: boolean;
  onMenu: () => void;
  onBucket: (bucket: ProjectBucket) => void;
  onCreate?: (() => void) | undefined;
  onRetry: () => void;
  onManage?: (() => void) | undefined;
  onOpenTask?: ((task: Task) => void) | undefined;
}) {
  return (
    <div className="project-root" aria-hidden={obscured}
      {...(obscured ? { inert: '' as const } : {})}>
      <header className="project-topbar">
        <button type="button" className="hamburger" onClick={onMenu}>☰</button>
        <span className="topbar-wordmark" aria-hidden="true">hand<span>mux</span></span>
        <span className="project-topbar-spacer" />
        {inbox}
        {onCreate && <button type="button" className="project-add-button" onClick={onCreate} aria-label={bucket === 'tasks'
          ? t('project.newTask') : t('project.newDraft')}>＋</button>}
      </header>
      <div className="project-title-block">
        <h1>{project.name}</h1>
        {onManage && <button type="button" onClick={onManage}>{t('project.manage')} ›</button>}
      </div>
      <div className="project-buckets" role="tablist">
        {(['tasks', 'drafts'] as const).map((value) => (
          <button key={value} type="button" role="tab" aria-selected={bucket === value}
            onClick={() => onBucket(value)}>{t(`project.${value}`)}</button>
        ))}
      </div>
      <main className="project-task-list">
        {error && <div className="project-error project-list-error" role="alert"><span>{error}</span>
          <button type="button" onClick={onRetry}>{t('project.tryAgain')}</button>
        </div>}
        {loading ? <div className="loading">{t('common.loading')}</div> : !error && tasks.length === 0 ? (
          onCreate ? <button type="button" className="project-empty" onClick={onCreate}>
            <strong>{t(bucket === 'tasks' ? 'project.noTasks' : 'project.noDrafts')}</strong>
            <span>{t(bucket === 'tasks' ? 'project.newTask' : 'project.newDraft')}</span>
          </button> : <div className="project-empty">
            <strong>{t(bucket === 'tasks' ? 'project.noTasks' : 'project.noDrafts')}</strong>
          </div>
        ) : tasks.map((task) => {
          const row = <>
            <span className="project-task-row-main"><strong>{task.title}</strong>
              {task.objective && <small>{task.objective}</small>}</span>
            <span className="project-task-row-meta"><time>{new Date(task.updatedAt).toLocaleDateString()}</time>
              {onOpenTask && <b>›</b>}</span>
          </>;
          return onOpenTask ? (
            <button key={task.id} type="button" className="project-task-row" onClick={() => onOpenTask(task)}>{row}</button>
          ) : (
            <div key={task.id} className="project-task-row">{row}</div>
          );
        })}
      </main>
    </div>
  );
}
