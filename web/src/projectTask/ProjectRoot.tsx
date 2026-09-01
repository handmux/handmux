import { useCallback, useEffect, useRef, useState } from 'react';
import type { ReactNode } from 'react';
import { ApiError } from '../apiErrors.js';
import DirPicker from '../components/DirPicker.jsx';
import { t } from '../i18n';
import { getLastProject, setLastProject } from '../storage.js';
import {
  archiveProject,
  archiveTask,
  cancelTask,
  createProject,
  createTask,
  getProject,
  getProjectTaskStatus,
  getTask,
  listProjects,
  listTasks,
  promoteTask,
  renameProject,
  updateTask,
} from './api.js';
import type { Project, Task, TaskDraftInput } from './contracts.js';
import ProjectHome from './ProjectHome.js';
import type { ProjectBucket } from './ProjectHome.js';
import ProjectManagement from './ProjectManagement.js';
import TaskDetail from './TaskDetail.js';
import TaskEditor from './TaskEditor.js';

function message(error: unknown): string {
  if (error instanceof ApiError) return error.serverError || error.message;
  return error instanceof Error && error.message ? error.message : t('project.storeUnavailable');
}

function folderName(path: string): string {
  return path.replace(/\/+$/, '').split('/').pop() || path;
}

function isVersionConflict(error: unknown): boolean {
  return error instanceof ApiError && error.code === 'VERSION_CONFLICT';
}

function isProjectNotFound(error: unknown): boolean {
  return error instanceof ApiError && error.code === 'PROJECT_NOT_FOUND';
}

function taskBelongsToBucket(task: Task, bucket: ProjectBucket): boolean {
  return !task.archivedAt && (bucket === 'tasks' ? task.status === 'ready' : task.status === 'draft');
}

export default function ProjectRoot({ drawerOpen, inbox, inset, onOpenDrawer, onCloseDrawer,
  onSwitchSession, onOpenUsage, onOpenSettings }: {
  drawerOpen: boolean;
  inbox: ReactNode;
  inset?: number;
  onOpenDrawer: () => void;
  onCloseDrawer: () => void;
  onSwitchSession: () => void;
  onOpenUsage: () => void;
  onOpenSettings: () => void;
}) {
  const [projects, setProjects] = useState<Project[]>([]);
  const [archivedProjects, setArchivedProjects] = useState<Project[]>([]);
  const [currentId, setCurrentId] = useState<string | null>(getLastProject);
  const [bucket, setBucket] = useState<ProjectBucket>('tasks');
  const [tasks, setTasks] = useState<Task[]>([]);
  const [loading, setLoading] = useState(true);
  const [tasksLoading, setTasksLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [addingProject, setAddingProject] = useState(false);
  const [editor, setEditor] = useState<{ task: Task | null } | null>(null);
  const [selectedTask, setSelectedTask] = useState<Task | null>(null);
  const [managementOpen, setManagementOpen] = useState(false);
  const [archivedManagement, setArchivedManagement] = useState<Project | null>(null);
  const [mutationBusy, setMutationBusy] = useState(false);
  const [mutationError, setMutationError] = useState<string | null>(null);
  const [mutationConflict, setMutationConflict] = useState(false);
  const taskRequest = useRef(0);
  const currentIdRef = useRef(currentId);
  currentIdRef.current = currentId;

  const current = projects.find((project) => project.id === currentId) ?? null;
  const secondaryOpen = Boolean(editor || selectedTask || managementOpen);
  const surfaceObscured = drawerOpen || addingProject || secondaryOpen;
  const drawerInteractive = drawerOpen && !addingProject && !secondaryOpen;

  const reloadProjects = useCallback(async (): Promise<void> => {
    setLoading(true);
    setError(null);
    try {
      const status = await getProjectTaskStatus();
      if (status.status !== 'ready') throw new Error(status.error?.message || t('project.storeUnavailable'));
      const [rows, archivedRows] = await Promise.all([listProjects(), listProjects(true)]);
      setProjects(rows);
      setArchivedProjects(archivedRows);
      const active = currentIdRef.current;
      const next = rows.some((project) => project.id === active) ? active : rows[0]?.id ?? null;
      if (next !== active) {
        taskRequest.current += 1;
        setTasks([]);
        setTasksLoading(next !== null);
        setSelectedTask(null);
        currentIdRef.current = next;
        setCurrentId(next);
      }
      setLastProject(next ?? '');
    } catch (cause) {
      setError(message(cause));
    } finally {
      setLoading(false);
    }
  }, []);

  const recoverMissingProject = useCallback(async (projectId: string | null): Promise<void> => {
    taskRequest.current += 1;
    setEditor(null);
    setSelectedTask(null);
    setManagementOpen(false);
    setArchivedManagement(null);
    setMutationError(null);
    setMutationConflict(false);
    setTasks([]);
    setTasksLoading(false);
    if (projectId) setProjects((rows) => rows.filter((project) => project.id !== projectId));
    currentIdRef.current = null;
    setCurrentId(null);
    setLastProject('');
    await reloadProjects();
  }, [reloadProjects]);

  const reloadTasks = useCallback(async (targetBucket: ProjectBucket = bucket): Promise<void> => {
    if (!currentId) { setTasks([]); return; }
    const request = ++taskRequest.current;
    setTasksLoading(true);
    setError(null);
    try {
      const rows = await listTasks(currentId, targetBucket);
      if (request === taskRequest.current) setTasks(rows);
    } catch (cause) {
      if (request !== taskRequest.current) return;
      if (isProjectNotFound(cause)) await recoverMissingProject(currentId);
      else setError(message(cause));
    } finally {
      if (request === taskRequest.current) setTasksLoading(false);
    }
  }, [bucket, currentId, recoverMissingProject]);

  useEffect(() => { void reloadProjects(); }, [reloadProjects]);
  useEffect(() => { void reloadTasks(); }, [reloadTasks]);

  const selectProject = (id: string): void => {
    if (id === currentIdRef.current) {
      onCloseDrawer();
      return;
    }
    taskRequest.current += 1;
    setTasks([]);
    setTasksLoading(true);
    setError(null);
    setMutationError(null);
    setMutationConflict(false);
    currentIdRef.current = id;
    setCurrentId(id);
    setLastProject(id);
    setSelectedTask(null);
    setManagementOpen(false);
    setArchivedManagement(null);
    onCloseDrawer();
  };

  const selectBucket = (next: ProjectBucket): void => {
    if (next === bucket) return;
    // The tab label changes synchronously. Invalidate the old request and clear its rows in the same
    // interaction so tasks from one bucket never flash under the other bucket while the next read starts.
    taskRequest.current += 1;
    setBucket(next);
    setTasks([]);
    setTasksLoading(true);
    setError(null);
  };

  const openAddProject = (): void => {
    setMutationError(null);
    setMutationConflict(false);
    setAddingProject(true);
  };

  const addProject = async (rootPath: string): Promise<void> => {
    if (mutationBusy) return;
    setMutationBusy(true);
    setMutationError(null);
    try {
      const created = await createProject(folderName(rootPath), rootPath);
      setProjects((rows) => [created, ...rows]);
      selectProject(created.id);
      setAddingProject(false);
    } catch (cause) {
      setMutationError(message(cause));
    } finally {
      setMutationBusy(false);
    }
  };

  const saveTask = async (input: TaskDraftInput, asTask: boolean): Promise<void> => {
    if (!current || mutationBusy) return;
    setMutationBusy(true);
    setMutationError(null);
    setMutationConflict(false);
    try {
      let saved: Task;
      const editing = editor?.task ?? null;
      if (!editing) {
        saved = await createTask(current.id, input, asTask ? 'ready' : 'draft');
      } else {
        saved = await updateTask(editing.id, input, editing.version);
        if (asTask && editing.status === 'draft') saved = await promoteTask(saved.id, saved.version);
      }
      setEditor(null);
      setSelectedTask(saved.status === 'ready' ? saved : null);
      const nextBucket = saved.status === 'ready' ? 'tasks' : 'drafts';
      taskRequest.current += 1;
      setTasks([]);
      setTasksLoading(true);
      setError(null);
      if (nextBucket !== bucket) setBucket(nextBucket);
      else await reloadTasks(nextBucket);
    } catch (cause) {
      if (isProjectNotFound(cause)) {
        await recoverMissingProject(current.id);
        return;
      }
      const conflict = cause instanceof ApiError && cause.code === 'VERSION_CONFLICT';
      setMutationConflict(conflict);
      setMutationError(conflict ? t('project.task.conflict') : message(cause));
    } finally {
      setMutationBusy(false);
    }
  };

  const refreshEditor = async (): Promise<void> => {
    const editing = editor?.task;
    if (!editing || mutationBusy) return;
    setMutationBusy(true);
    try {
      const latest = await getTask(editing.id);
      setSelectedTask(latest);
      setTasks((rows) => taskBelongsToBucket(latest, bucket)
        ? rows.map((row) => row.id === latest.id ? latest : row)
        : rows.filter((row) => row.id !== latest.id));
      // Canceled and archived Tasks are immutable. A conflict refresh must leave the editable surface,
      // otherwise every later save can only repeat TASK_TRANSITION_INVALID / TASK_NOT_FOUND.
      setEditor(latest.archivedAt || latest.status === 'canceled' ? null : { task: latest });
      setMutationError(null);
      setMutationConflict(false);
    } catch (cause) {
      if (isProjectNotFound(cause)) await recoverMissingProject(editing.projectId);
      else setMutationError(message(cause));
    } finally {
      setMutationBusy(false);
    }
  };

  const refreshTaskActionConflict = async (task: Task): Promise<void> => {
    try {
      const latest = await getTask(task.id);
      setSelectedTask(latest);
      setTasks((rows) => taskBelongsToBucket(latest, bucket)
        ? rows.map((row) => row.id === latest.id ? latest : row)
        : rows.filter((row) => row.id !== latest.id));
      setMutationError(t('project.task.actionConflict'));
    } catch (cause) {
      if (isProjectNotFound(cause)) await recoverMissingProject(task.projectId);
      else setMutationError(message(cause));
    }
  };

  const refreshProjectActionConflict = async (project: Project): Promise<void> => {
    try {
      const latest = await getProject(project.id);
      setProjects((rows) => rows.map((row) => row.id === latest.id ? latest : row));
      setMutationError(t('project.management.conflict'));
    } catch (cause) {
      if (isProjectNotFound(cause)) await recoverMissingProject(project.id);
      else setMutationError(message(cause));
    }
  };

  const doCancel = async (task: Task): Promise<void> => {
    if (mutationBusy) return;
    if (!window.confirm(t('project.task.cancelConfirm'))) return;
    setMutationBusy(true);
    setMutationError(null);
    try {
      await cancelTask(task.id, task.version);
      setSelectedTask(null);
      await reloadTasks();
    } catch (cause) {
      if (isProjectNotFound(cause)) await recoverMissingProject(task.projectId);
      else if (isVersionConflict(cause)) await refreshTaskActionConflict(task);
      else setMutationError(message(cause));
    }
    finally { setMutationBusy(false); }
  };

  const doArchive = async (task: Task): Promise<void> => {
    if (mutationBusy) return;
    if (!window.confirm(t('project.task.archiveConfirm'))) return;
    setMutationBusy(true);
    setMutationError(null);
    try {
      await archiveTask(task.id, task.version);
      setSelectedTask(null);
      await reloadTasks();
    } catch (cause) {
      if (isProjectNotFound(cause)) await recoverMissingProject(task.projectId);
      else if (isVersionConflict(cause)) await refreshTaskActionConflict(task);
      else setMutationError(message(cause));
    }
    finally { setMutationBusy(false); }
  };

  const doRename = async (name: string): Promise<void> => {
    if (!current || mutationBusy) return;
    setMutationBusy(true);
    setMutationError(null);
    try {
      const renamed = await renameProject(current.id, name, current.version);
      setProjects((rows) => rows.map((project) => project.id === renamed.id ? renamed : project));
    } catch (cause) {
      if (isProjectNotFound(cause)) await recoverMissingProject(current.id);
      else if (isVersionConflict(cause)) await refreshProjectActionConflict(current);
      else setMutationError(message(cause));
    }
    finally { setMutationBusy(false); }
  };

  const doArchiveProject = async (): Promise<void> => {
    if (mutationBusy) return;
    if (!current || !window.confirm(t('project.management.archiveConfirm'))) return;
    setMutationBusy(true);
    setMutationError(null);
    try {
      await archiveProject(current.id, current.version);
      setManagementOpen(false);
      setSelectedTask(null);
      taskRequest.current += 1;
      setTasks([]);
      setTasksLoading(false);
      setProjects((rows) => rows.filter((project) => project.id !== current.id));
      currentIdRef.current = null;
      setCurrentId(null);
      setLastProject('');
      await reloadProjects();
    } catch (cause) {
      if (isProjectNotFound(cause)) await recoverMissingProject(current.id);
      else if (isVersionConflict(cause)) await refreshProjectActionConflict(current);
      else setMutationError(message(cause));
    }
    finally { setMutationBusy(false); }
  };

  const drawer = (
    <>
      <div className={`drawer project-drawer ${drawerOpen ? 'open' : ''}`} aria-hidden={!drawerInteractive}
        {...(!drawerInteractive ? { inert: '' as const } : {})}>
        <div className="drawer-list">
          <div className="project-root-switch" role="group">
            <button type="button" aria-pressed="true">{t('project.root.projects')}</button>
            <button type="button" aria-pressed="false" onClick={onSwitchSession}>{t('project.root.sessions')}</button>
          </div>
          <div className="drawer-title">{t('project.root.projects').toUpperCase()}</div>
          {projects.map((project) => (
            <button key={project.id} type="button" className={`drawer-row drawer-name${project.id === currentId ? ' active' : ''}`}
              onClick={() => selectProject(project.id)}>{project.name}</button>
          ))}
          <button type="button" className="drawer-bind" onClick={openAddProject}>＋ {t('project.add')}</button>
          {archivedProjects.length > 0 && (
            <details className="project-archived-projects">
              <summary>{t('project.archivedProjects', { n: archivedProjects.length })}</summary>
              {archivedProjects.map((project) => (
                <button key={project.id} type="button" onClick={() => {
                  setMutationError(null);
                  setMutationConflict(false);
                  setArchivedManagement(project);
                  setManagementOpen(true);
                  onCloseDrawer();
                }}>{project.name}</button>
              ))}
            </details>
          )}
        </div>
        <div className="project-drawer-tools">
          <button type="button" onClick={onOpenUsage}>{t('usage.title')}</button>
          <button type="button" onClick={onOpenSettings}>{t('app.settings')}</button>
        </div>
      </div>
      {drawerInteractive && <div className="drawer-backdrop" onClick={onCloseDrawer} />}
    </>
  );

  return (
    <>
      {drawer}
      {error && !current ? (
        <div className="project-root" aria-hidden={surfaceObscured}
          {...(surfaceObscured ? { inert: '' as const } : {})}>
          <header className="project-topbar">
            <button type="button" className="hamburger" onClick={onOpenDrawer}>☰</button>{inbox}
          </header>
          <main className="project-fatal"><strong>{t('project.storeUnavailable')}</strong><p>{error}</p>
            <button type="button" onClick={() => void reloadProjects()}>{t('project.tryAgain')}</button>
            <button type="button" onClick={onSwitchSession}>{t('project.root.sessions')}</button>
          </main>
        </div>
      ) : current ? (
        <ProjectHome project={current} bucket={bucket} tasks={tasks} loading={tasksLoading}
          error={error}
          inbox={inbox} obscured={surfaceObscured}
          onMenu={onOpenDrawer} onBucket={selectBucket}
          onCreate={() => { setMutationError(null); setMutationConflict(false); setEditor({ task: null }); }}
          onRetry={() => void reloadTasks()}
          onManage={() => { setMutationError(null); setMutationConflict(false); setManagementOpen(true); }}
          onOpenTask={(task) => { setMutationError(null); setMutationConflict(false); setSelectedTask(task); }} />
      ) : (
        <div className="project-root" aria-hidden={surfaceObscured}
          {...(surfaceObscured ? { inert: '' as const } : {})}>
          <header className="project-topbar"><button type="button" className="hamburger" onClick={onOpenDrawer}>☰</button>
            <span className="project-topbar-spacer" />{inbox}
            <button type="button" className="project-add-button" onClick={openAddProject}>＋</button></header>
          <main className="project-fatal"><strong>{loading ? t('common.loading') : t('project.empty')}</strong>
            {!loading && <><p>{t('project.emptyHint')}</p><button type="button" onClick={openAddProject}>{t('project.add')}</button></>}</main>
        </div>
      )}
      <DirPicker open={addingProject} seedCwd={current?.rootPath ?? null} pane={null}
        hint={mutationBusy ? t('common.loading') : mutationError} busy={mutationBusy}
        onPick={addProject} onClose={() => setAddingProject(false)} inset={inset ?? 0} />
      {editor && <TaskEditor key={editor.task ? `${editor.task.id}:${editor.task.version}` : 'new'} task={editor.task}
        createMode={bucket === 'tasks' ? 'task' : 'draft'}
        keyboardInset={inset ?? 0}
        busy={mutationBusy} error={mutationError} conflict={mutationConflict} onRefresh={refreshEditor}
        onClose={() => setEditor(null)} onSave={saveTask} />}
      {selectedTask && !editor && <TaskDetail task={selectedTask} onBack={() => setSelectedTask(null)}
        busy={mutationBusy} error={mutationError}
        onEdit={() => { setMutationError(null); setMutationConflict(false); setEditor({ task: selectedTask }); }}
        onCancel={() => void doCancel(selectedTask)} onArchive={() => void doArchive(selectedTask)} />}
      {managementOpen && (archivedManagement ?? current) && <ProjectManagement project={(archivedManagement ?? current)!}
        keyboardInset={inset ?? 0} busy={mutationBusy} error={mutationError} readOnly={Boolean(archivedManagement)}
        onBack={() => { setManagementOpen(false); setArchivedManagement(null); }}
        onRename={doRename} onArchive={doArchiveProject} />}
    </>
  );
}
