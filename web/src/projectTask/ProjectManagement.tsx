import { useEffect, useRef, useState } from 'react';
import { fetchDir, gitStatus } from '../api.js';
import { parseGitStatus } from '../gitContracts.js';
import type { GitChange } from '../gitContracts.js';
import { t } from '../i18n';
import { useBackButton } from '../hooks/useBackButton.js';
import { listTasks } from './api.js';
import type { Project, Task } from './contracts.js';

type Tab = 'overview' | 'context' | 'git';
const GUIDANCE_FILES = new Set(['AGENTS.md', 'CLAUDE.md']);

function directoryFiles(value: unknown): string[] {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return [];
  const entries = (value as Record<string, unknown>).entries;
  if (!Array.isArray(entries)) return [];
  return entries.flatMap((entry) => {
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) return [];
    const row = entry as Record<string, unknown>;
    return typeof row.name === 'string' && row.type !== 'dir' ? [row.name] : [];
  });
}

function pathJoin(directory: string, name: string): string {
  return `${directory.replace(/\/$/, '')}/${name}`;
}

function changeBadge(change: GitChange): string {
  return change.x || change.y || '?';
}

export default function ProjectManagement({ project, keyboardInset = 0, busy, error, readOnly = false,
  onBack, onRename, onArchive }: {
  project: Project;
  keyboardInset?: number;
  busy?: boolean;
  error?: string | null;
  readOnly?: boolean;
  onBack: () => void;
  onRename: (name: string) => void | Promise<void>;
  onArchive: () => void | Promise<void>;
}) {
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
  const [tab, setTab] = useState<Tab>('overview');
  const [name, setName] = useState(project.name);
  const [guidance, setGuidance] = useState<string[] | null>(null);
  const [guidanceError, setGuidanceError] = useState(false);
  const [changes, setChanges] = useState<GitChange[] | null>(null);
  const [gitError, setGitError] = useState(false);
  const [canceled, setCanceled] = useState<Task[] | null>(null);
  const [archived, setArchived] = useState<Task[] | null>(null);
  const [historyError, setHistoryError] = useState(false);

  useEffect(() => {
    let canceledRequest = false;
    void Promise.all([listTasks(project.id, 'canceled'), listTasks(project.id, 'archived')])
      .then(([nextCanceled, nextArchived]) => {
        if (canceledRequest) return;
        setCanceled(nextCanceled);
        setArchived(nextArchived);
      }).catch(() => { if (!canceledRequest) setHistoryError(true); });
    return () => { canceledRequest = true; };
  }, [project.id]);

  useEffect(() => {
    if (tab !== 'context' || guidance !== null || guidanceError) return undefined;
    let canceled = false;
    const directories = [...new Set([project.rootPath, project.repositoryRoot].filter(
      (value): value is string => Boolean(value),
    ))];
    void Promise.all(directories.map(async (directory) => ({
      directory,
      files: directoryFiles(await fetchDir(directory)),
    }))).then((rows) => {
      if (canceled) return;
      setGuidance(rows.flatMap(({ directory, files }) => files
        .filter((file) => GUIDANCE_FILES.has(file)).map((file) => pathJoin(directory, file))));
    }).catch(() => { if (!canceled) setGuidanceError(true); });
    return () => { canceled = true; };
  }, [guidance, guidanceError, project.repositoryRoot, project.rootPath, tab]);

  useEffect(() => {
    if (tab !== 'git' || !project.repositoryRoot || changes !== null || gitError) return undefined;
    let canceled = false;
    void gitStatus(project.repositoryRoot).then((value) => {
      if (!canceled) setChanges(parseGitStatus(value));
    }).catch(() => { if (!canceled) setGitError(true); });
    return () => { canceled = true; };
  }, [changes, gitError, project.repositoryRoot, tab]);

  const guidanceFiles = guidance ?? [];
  const gitChanges = changes ?? [];
  // Match TaskEditor: App lifts its column by -keyboardInset, so the fixed page needs the same top offset.
  const pageTop = Number.isFinite(keyboardInset) ? Math.max(0, keyboardInset) : 0;

  return (
    <div className="project-page" role="dialog" aria-modal="true" aria-label={t('project.manage')}
      style={pageTop > 0 ? { top: `${pageTop}px` } : undefined}>
      <header className="project-page-head">
        <button type="button" disabled={busy} onClick={close} aria-label={t('common.back')}>‹</button>
        <h1>{t('project.manage')}</h1>
        <span />
      </header>
      <div className="project-tabs" role="tablist">
        {(['overview', 'context', 'git'] as const).map((value) => (
          <button key={value} type="button" role="tab" aria-selected={tab === value}
            onClick={() => setTab(value)}>{t(`project.management.${value}`)}</button>
        ))}
      </div>
      <main className="project-management">
        {error && <div className="project-error" role="alert"><span>{error}</span></div>}
        {tab === 'overview' && (
          <>
            <section>
              <label><span>{t('project.task.title')}</span><input value={name} maxLength={120}
                disabled={readOnly || busy}
                onChange={(event) => setName(event.target.value)} /></label>
              {readOnly ? <span className="project-read-only">{t('project.management.readOnly')}</span>
                : <button type="button" className="project-inline-save" disabled={busy || !name.trim() || name.trim() === project.name}
                  onClick={() => void onRename(name.trim())}>{t('project.task.save')}</button>}
            </section>
            <section className="project-kv">
              <div><span>{t('project.management.projectRoot')}</span><code>{project.rootPath}</code></div>
              <div><span>{t('project.management.repositoryRoot')}</span><code>{project.repositoryRoot ?? '—'}</code></div>
              <div><span>{t('project.management.defaultAgent')}</span><strong>{project.defaultAgent ?? t('project.management.notSet')}</strong></div>
              <div><span>{t('project.management.isolation')}</span><strong>{t(`project.management.execution.${project.executionMode}`)}</strong></div>
            </section>
            <section className="project-history">
              <h2>{t('project.management.history')}</h2>
              {historyError ? <span>{t('project.management.historyFailed')}</span> : <>
                <details><summary>{t('project.management.canceled', { n: canceled?.length ?? 0 })}</summary>
                  {canceled === null ? <p>{t('common.loading')}</p> : canceled.length === 0 ? <p>{t('project.management.historyEmpty')}</p>
                    : <ul>{canceled.map((task) => <li key={task.id}>{task.title}</li>)}</ul>}
                </details>
                <details><summary>{t('project.management.archived', { n: archived?.length ?? 0 })}</summary>
                  {archived === null ? <p>{t('common.loading')}</p> : archived.length === 0 ? <p>{t('project.management.historyEmpty')}</p>
                    : <ul>{archived.map((task) => <li key={task.id}>{task.title}</li>)}</ul>}
                </details>
              </>}
            </section>
            {!readOnly && <button type="button" className="project-archive-project" disabled={busy}
              onClick={() => void onArchive()}>{t('project.management.archiveProject')}</button>}
          </>
        )}
        {tab === 'context' && (
          <>
            <section className="project-empty-card">
              <strong>{t('project.management.guidance')}</strong>
              {guidance === null && !guidanceError ? <span>{t('common.loading')}</span>
                : guidanceError ? <span>{t('project.management.guidanceFailed')}</span>
                  : guidanceFiles.length === 0 ? <span>{t('project.management.noGuidance')}</span>
                    : <ul className="project-source-list">{guidanceFiles.map((file) => <li key={file}><code>{file}</code></li>)}</ul>}
            </section>
            <section className="project-empty-card">
              <strong>{t('project.management.memoryOff')}</strong>
              <span>{t('project.management.memoryHint')}</span>
            </section>
          </>
        )}
        {tab === 'git' && (
          <section className="project-empty-card">
            <strong>{project.repositoryRoot ?? t('project.management.notGit')}</strong>
            {!project.repositoryRoot ? <span>{t('project.management.notGitHint')}</span>
              : changes === null && !gitError ? <span>{t('common.loading')}</span>
                : gitError ? <span>{t('project.management.gitFailed')}</span>
                  : gitChanges.length === 0 ? <span>{t('project.management.gitClean')}</span>
                    : <><span>{t('project.management.gitChanges', { n: gitChanges.length })}</span>
                      <ul className="project-change-list">{gitChanges.slice(0, 12).map((change) => (
                        <li key={`${change.x}:${change.y}:${change.path}`}><b>{changeBadge(change)}</b><code>{change.path}</code></li>
                      ))}</ul></>}
          </section>
        )}
      </main>
    </div>
  );
}
