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
  onCreate: () => void;
  onRetry: () => void;
  onManage: () => void;
  onOpenTask: (task: Task) => void;
}) {
  return (
    <div className="project-root" aria-hidden={obscured}
      {...(obscured ? { inert: '' as const } : {})}>
      <header className="project-topbar">
        <button type="button" className="hamburger" onClick={onMenu}>☰</button>
        <span className="project-topbar-spacer" />
        {inbox}
        <button type="button" className="project-add-button" onClick={onCreate} aria-label={bucket === 'tasks'
          ? t('project.newTask') : t('project.newDraft')}>＋</button>
      </header>
      <div className="project-title-block">
        <h1>{project.name}</h1>
        <button type="button" onClick={onManage}>{t('project.manage')} ›</button>
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
          <button type="button" className="project-empty" onClick={onCreate}>
            <strong>{t(bucket === 'tasks' ? 'project.noTasks' : 'project.noDrafts')}</strong>
            <span>{t(bucket === 'tasks' ? 'project.newTask' : 'project.newDraft')}</span>
          </button>
        ) : tasks.map((task) => (
          <button key={task.id} type="button" className="project-task-row" onClick={() => onOpenTask(task)}>
            <span className="project-task-row-main"><strong>{task.title}</strong>
              {task.objective && <small>{task.objective}</small>}</span>
            <span className="project-task-row-meta"><time>{new Date(task.updatedAt).toLocaleDateString()}</time><b>›</b></span>
          </button>
        ))}
      </main>
    </div>
  );
}
