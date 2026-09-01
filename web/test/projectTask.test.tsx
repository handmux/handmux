import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import type { ReactNode } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ApiError } from '../src/apiErrors.js';

const api = vi.hoisted(() => ({
  archiveTask: vi.fn(),
  archiveProject: vi.fn(),
  cancelTask: vi.fn(),
  createProject: vi.fn(),
  createTask: vi.fn(),
  getProject: vi.fn(),
  getProjectTaskStatus: vi.fn(),
  getTask: vi.fn(),
  listProjects: vi.fn(),
  listTasks: vi.fn(),
  promoteTask: vi.fn(),
  renameProject: vi.fn(),
  updateTask: vi.fn(),
}));

vi.mock('../src/projectTask/api.js', () => api);
vi.mock('../src/components/DirPicker.jsx', () => ({
  default: ({ open, hint, busy, onPick, onClose }: {
    open: boolean;
    hint?: ReactNode;
    busy?: boolean;
    onPick: (directory: string) => void | Promise<void>;
    onClose: () => void;
  }) => open ? <div role="dialog" aria-label="测试目录选择器">
    {hint && <div data-testid="dir-picker-hint">{hint}</div>}
    <button type="button" disabled={busy} onClick={() => void onPick('/new-project')}>选择测试目录</button>
    <button type="button" disabled={busy} onClick={onClose}>关闭目录选择器</button>
  </div> : null,
}));
vi.mock('../src/api.js', () => ({
  fetchDir: vi.fn(async () => ({
    path: '/repo', home: '/', parent: '/', entries: [{ name: 'AGENTS.md', type: 'doc' }],
  })),
  gitStatus: vi.fn(async () => ({ changes: [] })),
}));

import ProjectRoot from '../src/projectTask/ProjectRoot.js';
import type { Project, Task, TaskDraftInput } from '../src/projectTask/contracts.js';

const project: Project = {
  id: 'project-1', name: 'HandMux', rootPath: '/repo', repositoryRoot: '/repo',
  defaultAgent: null, executionMode: 'project-root', version: 1, archivedAt: null,
  createdAt: '2026-08-16T00:00:00.000Z', updatedAt: '2026-08-16T00:00:00.000Z',
};

let tasks: Task[];

function taskFrom(input: TaskDraftInput, status: 'draft' | 'ready'): Task {
  return {
    id: 'task-1', projectId: project.id, ...input, status, briefVersion: 1, version: 1,
    archivedAt: null, createdAt: '2026-08-16T00:00:00.000Z', updatedAt: '2026-08-16T00:00:00.000Z',
  };
}

function root(inset = 0): JSX.Element {
  return <ProjectRoot drawerOpen={false} inbox={<button type="button">收件箱</button>}
    inset={inset}
    onOpenDrawer={() => {}} onCloseDrawer={() => {}} onSwitchSession={() => {}}
    onOpenUsage={() => {}} onOpenSettings={() => {}} />;
}

beforeEach(() => {
  localStorage.clear();
  localStorage.setItem('tw_lang', 'zh');
  tasks = [];
  api.getProjectTaskStatus.mockResolvedValue({ status: 'ready', schemaVersion: 1 });
  api.listProjects.mockImplementation(async (archived = false) => archived ? [] : [project]);
  api.getProject.mockResolvedValue(project);
  api.listTasks.mockImplementation(async (_projectId: string, bucket: string) => tasks.filter((task) => (
    bucket === 'tasks' ? task.status === 'ready' : bucket === 'drafts' ? task.status === 'draft' : false
  )));
  api.createTask.mockImplementation(async (_projectId: string, input: TaskDraftInput, status: 'draft' | 'ready') => {
    const created = taskFrom(input, status);
    tasks = [created];
    return created;
  });
  api.updateTask.mockImplementation(async (_id: string, input: TaskDraftInput) => {
    const updated = { ...tasks[0], ...input, briefVersion: 2, version: 2 } as Task;
    tasks = [updated];
    return updated;
  });
  api.promoteTask.mockImplementation(async (id: string) => {
    const promoted = { ...tasks[0], id, status: 'ready' as const, version: 3 } as Task;
    tasks = [promoted];
    return promoted;
  });
  api.getTask.mockImplementation(async () => tasks[0]);
});

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe('Project Task root', () => {
  it('keeps the task input top visible above the software keyboard', async () => {
    render(root(312));
    fireEvent.click(await screen.findByRole('button', { name: '新建任务' }));

    const dialog = screen.getByRole('dialog', { name: '新建任务' });
    expect(dialog.style.top).toBe('312px');
    expect(screen.getByLabelText('想完成什么？')).toBeTruthy();
  });

  it('keeps Project management visible above the software keyboard', async () => {
    render(root(312));
    fireEvent.click(await screen.findByRole('button', { name: /项目管理/ }));

    expect(await screen.findByText('已取消（0）')).toBeTruthy();
    const page = document.querySelector<HTMLElement>('.project-page');
    expect(page?.style.top).toBe('312px');
    expect(screen.getByDisplayValue('HandMux')).toBeTruthy();
  });

  it('creates a ready task from one natural-language request', async () => {
    render(root());
    expect(await screen.findByRole('heading', { name: 'HandMux' })).toBeTruthy();

    fireEvent.click(screen.getByRole('button', { name: '新建任务' }));
    expect(screen.queryByLabelText('标题')).toBeNull();
    expect(screen.queryByLabelText('验收标准（每行一条）')).toBeNull();
    fireEvent.change(screen.getByLabelText('想完成什么？'), {
      target: { value: '  \n修复对话页加载失败\n并补上回归测试' },
    });
    fireEvent.click(screen.getByRole('button', { name: '创建任务' }));

    await waitFor(() => expect(api.createTask).toHaveBeenCalledWith(project.id, {
      title: '修复对话页加载失败',
      objective: '修复对话页加载失败\n并补上回归测试',
      acceptanceCriteria: [],
      scope: null,
      constraints: null,
      references: [],
      priority: 'none',
    }, 'ready'));
    expect(await screen.findByRole('heading', { name: '修复对话页加载失败' })).toBeTruthy();
  });

  it('keeps one Task from an incomplete draft through edit and promotion', async () => {
    render(root());
    expect(await screen.findByRole('heading', { name: 'HandMux' })).toBeTruthy();

    fireEvent.click(screen.getByRole('tab', { name: '草稿' }));
    fireEvent.click(screen.getByRole('button', { name: '记录草稿' }));
    fireEvent.change(screen.getByLabelText('想完成什么？'), { target: { value: '登录失败提示' } });
    fireEvent.click(screen.getByRole('button', { name: '保存草稿' }));

    await waitFor(() => expect(api.createTask).toHaveBeenCalledWith(project.id,
      expect.objectContaining({ title: '登录失败提示' }), 'draft'));
    expect(await screen.findByRole('button', { name: /登录失败提示/ })).toBeTruthy();

    fireEvent.click(screen.getByRole('button', { name: /登录失败提示/ }));
    fireEvent.click(screen.getByRole('button', { name: '编辑要求' }));
    fireEvent.change(screen.getByLabelText('目标'), { target: { value: '解释真实失败原因' } });
    fireEvent.change(screen.getByLabelText('验收标准（每行一条）'), {
      target: { value: '无效令牌给出下一步\n重试成功' },
    });
    fireEvent.click(screen.getByRole('button', { name: '保存为任务' }));

    await waitFor(() => expect(api.promoteTask).toHaveBeenCalledWith('task-1', 2));
    expect(api.updateTask).toHaveBeenCalledWith('task-1', expect.objectContaining({
      objective: '解释真实失败原因', acceptanceCriteria: ['无效令牌给出下一步', '重试成功'],
    }), 1);
    expect(screen.getAllByText('解释真实失败原因')).toHaveLength(2);
    expect(tasks[0]).toMatchObject({ id: 'task-1', status: 'ready' });
  });

  it('does not partially update a draft before its empty objective blocks promotion', async () => {
    tasks = [taskFrom({
      title: '待补充草稿', objective: '', acceptanceCriteria: [], scope: null,
      constraints: null, references: [], priority: 'none',
    }, 'draft')];
    render(root());
    fireEvent.click(await screen.findByRole('tab', { name: '草稿' }));
    fireEvent.click(await screen.findByRole('button', { name: /待补充草稿/ }));
    fireEvent.click(screen.getByRole('button', { name: '编辑要求' }));

    expect(screen.getByRole('button', { name: '保存草稿' })).toHaveProperty('disabled', false);
    expect(screen.getByRole('button', { name: '保存为任务' })).toHaveProperty('disabled', true);
    fireEvent.click(screen.getByRole('button', { name: '保存为任务' }));
    expect(api.updateTask).not.toHaveBeenCalled();

    fireEvent.change(screen.getByLabelText('目标'), { target: { value: '补齐目标' } });
    expect(screen.getByRole('button', { name: '保存为任务' })).toHaveProperty('disabled', false);
    fireEvent.change(screen.getByLabelText('标题'), { target: { value: '' } });
    expect(screen.getByRole('button', { name: '保存为任务' })).toHaveProperty('disabled', true);
  });

  it('does not save a ready Task after its objective is cleared', async () => {
    tasks = [taskFrom({
      title: '正式任务', objective: '已有目标', acceptanceCriteria: [], scope: null,
      constraints: null, references: [], priority: 'none',
    }, 'ready')];
    render(root());
    fireEvent.click(await screen.findByRole('button', { name: /正式任务/ }));
    fireEvent.click(screen.getByRole('button', { name: '编辑要求' }));
    fireEvent.change(screen.getByLabelText('目标'), { target: { value: '' } });

    const save = screen.getByRole('button', { name: '保存' });
    expect(save).toHaveProperty('disabled', true);
    fireEvent.click(save);
    expect(api.updateTask).not.toHaveBeenCalled();
  });

  it('keeps Session reachable when the Project store is unavailable', async () => {
    const onSwitchSession = vi.fn();
    api.getProjectTaskStatus.mockResolvedValue({
      status: 'unavailable', schemaVersion: 1,
      error: { code: 'PROJECT_STORE_LOCKED', message: '关闭重复 HandMux 实例后重试' },
    });
    api.listProjects.mockResolvedValue([]);
    render(<ProjectRoot drawerOpen={false} inbox={null} onOpenDrawer={() => {}} onCloseDrawer={() => {}}
      onSwitchSession={onSwitchSession} onOpenUsage={() => {}} onOpenSettings={() => {}} />);

    expect(await screen.findByText('关闭重复 HandMux 实例后重试')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: '会话' }));
    expect(onSwitchSession).toHaveBeenCalledOnce();
  });

  it('keeps Add Project usable from the store-unavailable Drawer', async () => {
    api.getProjectTaskStatus.mockResolvedValue({
      status: 'unavailable', schemaVersion: 1,
      error: { code: 'PROJECT_STORE_LOCKED', message: '关闭重复 HandMux 实例后重试' },
    });
    const { container } = render(<ProjectRoot drawerOpen inbox={null} onOpenDrawer={() => {}}
      onCloseDrawer={() => {}} onSwitchSession={() => {}} onOpenUsage={() => {}} onOpenSettings={() => {}} />);
    expect(await screen.findByText('关闭重复 HandMux 实例后重试')).toBeTruthy();

    fireEvent.click(screen.getByRole('button', { name: /添加项目/ }));
    expect(screen.getByRole('dialog', { name: '测试目录选择器' })).toBeTruthy();
    expect(screen.getByRole('button', { name: '关闭目录选择器' })).toHaveProperty('disabled', false);

    fireEvent.click(screen.getByRole('button', { name: '关闭目录选择器' }));
    expect(screen.queryByRole('dialog', { name: '测试目录选择器' })).toBeNull();
    expect(container.querySelector('.project-drawer')?.hasAttribute('inert')).toBe(false);
  });

  it('offers an explicit retry instead of an empty Task state after a read failure', async () => {
    tasks = [taskFrom({
      title: '恢复后的任务', objective: '重新读取成功', acceptanceCriteria: [], scope: null,
      constraints: null, references: [], priority: 'none',
    }, 'ready')];
    api.listTasks.mockRejectedValueOnce(new Error('任务读取暂时失败'));
    render(root());

    expect((await screen.findByRole('alert')).textContent).toContain('任务读取暂时失败');
    expect(screen.queryByText('还没有正式任务')).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: '重试' }));

    expect(await screen.findByRole('button', { name: /恢复后的任务/ })).toBeTruthy();
    expect(screen.queryByRole('alert')).toBeNull();
  });

  it('keeps typed edits on conflict until the user loads the latest Task', async () => {
    tasks = [taskFrom({
      title: '服务端标题', objective: '目标', acceptanceCriteria: ['标准'], scope: null,
      constraints: null, references: [], priority: 'none',
    }, 'draft')];
    api.updateTask.mockRejectedValueOnce(new ApiError('conflict', 409, 'changed', 'VERSION_CONFLICT'));
    api.getTask.mockResolvedValueOnce({ ...tasks[0], version: 2 });
    render(root());
    fireEvent.click(await screen.findByRole('tab', { name: '草稿' }));
    fireEvent.click(await screen.findByRole('button', { name: /服务端标题/ }));
    fireEvent.click(screen.getByRole('button', { name: '编辑要求' }));
    fireEvent.change(screen.getByLabelText('标题'), { target: { value: '我正在编辑的标题' } });
    fireEvent.click(screen.getByRole('button', { name: '保存为任务' }));

    expect(await screen.findByText(/已在其他页面更新/)).toBeTruthy();
    expect((screen.getByLabelText('标题') as HTMLInputElement).value).toBe('我正在编辑的标题');
    fireEvent.click(screen.getByRole('button', { name: '加载最新版本' }));
    await waitFor(() => expect(api.getTask).toHaveBeenCalledWith('task-1'));
    await waitFor(() => expect((screen.getByLabelText('标题') as HTMLInputElement).value).toBe('服务端标题'));
  });

  it.each([
    ['canceled', { status: 'canceled' as const, archivedAt: null }],
    ['archived', { status: 'ready' as const, archivedAt: '2026-08-16T02:00:00.000Z' }],
  ])('leaves the editor for read-only detail when the latest Task is %s', async (_label, latestState) => {
    tasks = [taskFrom({
      title: '并发更新任务', objective: '目标', acceptanceCriteria: [], scope: null,
      constraints: null, references: [], priority: 'none',
    }, 'ready')];
    api.updateTask.mockRejectedValueOnce(new ApiError('conflict', 409, 'changed', 'VERSION_CONFLICT'));
    api.getTask.mockResolvedValueOnce({ ...tasks[0], ...latestState, version: 2 });
    render(root());
    fireEvent.click(await screen.findByRole('button', { name: /并发更新任务/ }));
    fireEvent.click(screen.getByRole('button', { name: '编辑要求' }));
    fireEvent.change(screen.getByLabelText('标题'), { target: { value: '本地编辑' } });
    fireEvent.click(screen.getByRole('button', { name: '保存' }));

    fireEvent.click(await screen.findByRole('button', { name: '加载最新版本' }));
    await waitFor(() => expect(api.getTask).toHaveBeenCalledWith('task-1'));
    expect(screen.queryByLabelText('标题')).toBeNull();
    expect(screen.getByText('只读')).toBeTruthy();
    expect(screen.queryByRole('button', { name: '编辑要求' })).toBeNull();
  });

  it('exposes Project management as one full-screen page with three tabs', async () => {
    render(root());
    fireEvent.click(await screen.findByRole('button', { name: /项目管理/ }));
    expect(screen.getByRole('heading', { name: '项目管理' })).toBeTruthy();
    for (const label of ['概览', '规范记忆', 'Git']) {
      expect(screen.getByRole('tab', { name: label })).toBeTruthy();
    }
    fireEvent.click(screen.getByRole('tab', { name: '规范记忆' }));
    expect(screen.getByText('Project Memory 尚未启用')).toBeTruthy();
    expect(await screen.findByText('/repo/AGENTS.md')).toBeTruthy();
  });

  it('shows Task action failures in Task detail and blocks duplicate submissions', async () => {
    tasks = [taskFrom({
      title: '待归档任务', objective: '目标', acceptanceCriteria: [], scope: null,
      constraints: null, references: [], priority: 'none',
    }, 'ready')];
    vi.spyOn(window, 'confirm').mockReturnValue(true);
    let rejectArchive: ((reason?: unknown) => void) | undefined;
    api.archiveTask.mockImplementationOnce(() => new Promise<void>((_resolve, reject) => {
      rejectArchive = reject;
    }));
    render(root());
    fireEvent.click(await screen.findByRole('button', { name: /待归档任务/ }));

    const archive = screen.getByRole('button', { name: '归档' });
    fireEvent.click(archive);
    expect(archive).toHaveProperty('disabled', true);
    expect(screen.getByRole('button', { name: '返回' })).toHaveProperty('disabled', true);
    fireEvent.click(archive);
    expect(api.archiveTask).toHaveBeenCalledOnce();
    await act(async () => rejectArchive?.(new ApiError('archive failed', 500, '无法归档，请重试')));
    expect((await screen.findByRole('alert')).textContent).toContain('无法归档，请重试');
  });

  it('loads the latest Task after an action conflict so the next confirmation can succeed', async () => {
    tasks = [taskFrom({
      title: '并发任务', objective: '目标', acceptanceCriteria: [], scope: null,
      constraints: null, references: [], priority: 'none',
    }, 'ready')];
    const latest = { ...tasks[0], objective: '其他页面更新后的目标', version: 2 };
    api.cancelTask.mockRejectedValueOnce(new ApiError('conflict', 409, 'changed', 'VERSION_CONFLICT'))
      .mockResolvedValueOnce({ ...latest, status: 'canceled', version: 3 });
    api.getTask.mockResolvedValueOnce(latest);
    vi.spyOn(window, 'confirm').mockReturnValue(true);
    render(root());
    fireEvent.click(await screen.findByRole('button', { name: /并发任务/ }));

    fireEvent.click(screen.getByRole('button', { name: '取消任务' }));
    expect(await screen.findByText(/已加载最新版本/)).toBeTruthy();
    expect(screen.getAllByText('其他页面更新后的目标')).toHaveLength(2);
    const retry = screen.getByRole('button', { name: '取消任务' });
    fireEvent.click(retry);
    expect(retry).toHaveProperty('disabled', true);

    await waitFor(() => expect(api.cancelTask).toHaveBeenNthCalledWith(2, 'task-1', 2));
    await waitFor(() => expect(screen.queryByRole('dialog', { name: '并发任务' })).toBeNull());
  });

  it('shows a concurrently canceled Task as read-only after loading its latest version', async () => {
    tasks = [taskFrom({
      title: '已被取消的任务', objective: '目标', acceptanceCriteria: [], scope: null,
      constraints: null, references: [], priority: 'none',
    }, 'ready')];
    api.cancelTask.mockRejectedValueOnce(new ApiError('conflict', 409, 'changed', 'VERSION_CONFLICT'));
    api.getTask.mockResolvedValueOnce({ ...tasks[0], status: 'canceled', version: 2 });
    vi.spyOn(window, 'confirm').mockReturnValue(true);
    render(root());
    fireEvent.click(await screen.findByRole('button', { name: /已被取消的任务/ }));

    fireEvent.click(screen.getByRole('button', { name: '取消任务' }));
    expect(await screen.findByText(/请确认当前状态/)).toBeTruthy();
    expect(screen.getByText('只读')).toBeTruthy();
    expect(screen.queryByRole('button', { name: '编辑要求' })).toBeNull();
    expect(screen.queryByRole('button', { name: '取消任务' })).toBeNull();
    expect(screen.getByRole('button', { name: '归档' })).toBeTruthy();
  });

  it('shows Project mutation failures in management and blocks duplicate submissions', async () => {
    let rejectRename: ((reason?: unknown) => void) | undefined;
    api.renameProject.mockImplementationOnce(() => new Promise<Project>((_resolve, reject) => {
      rejectRename = reject;
    }));
    render(root());
    fireEvent.click(await screen.findByRole('button', { name: /项目管理/ }));
    expect(await screen.findByText('已取消（0）')).toBeTruthy();
    fireEvent.change(screen.getByDisplayValue('HandMux'), { target: { value: '新项目名' } });

    const save = screen.getByRole('button', { name: '保存' });
    fireEvent.click(save);
    expect(save).toHaveProperty('disabled', true);
    expect(screen.getByDisplayValue('新项目名')).toHaveProperty('disabled', true);
    expect(screen.getByRole('button', { name: '返回' })).toHaveProperty('disabled', true);
    fireEvent.click(save);
    expect(api.renameProject).toHaveBeenCalledOnce();
    await act(async () => rejectRename?.(new ApiError('rename failed', 500, '无法重命名，请重试')));
    expect((await screen.findByRole('alert')).textContent).toContain('无法重命名，请重试');
  });

  it('loads the latest Project version after a rename conflict without discarding the proposed name', async () => {
    const latest = { ...project, name: '其他页面的名字', version: 2 };
    api.renameProject.mockRejectedValueOnce(new ApiError('conflict', 409, 'changed', 'VERSION_CONFLICT'))
      .mockResolvedValueOnce({ ...latest, name: '我准备的新名字', version: 3 });
    api.getProject.mockResolvedValueOnce(latest);
    render(root());
    fireEvent.click(await screen.findByRole('button', { name: /项目管理/ }));
    fireEvent.change(screen.getByDisplayValue('HandMux'), { target: { value: '我准备的新名字' } });

    fireEvent.click(screen.getByRole('button', { name: '保存' }));
    expect(await screen.findByText(/项目信息已在其他页面更新/)).toBeTruthy();
    expect(screen.getByDisplayValue('我准备的新名字')).toBeTruthy();
    const retry = screen.getByRole('button', { name: '保存' });
    const back = screen.getByRole('button', { name: '返回' });
    fireEvent.click(retry);
    expect(back).toHaveProperty('disabled', true);

    await waitFor(() => expect(api.renameProject)
      .toHaveBeenNthCalledWith(2, project.id, '我准备的新名字', 2));
    await waitFor(() => expect(back).toHaveProperty('disabled', false));
  });

  it('leaves a Task detail that belongs to a Project archived on another client', async () => {
    const replacement = { ...project, id: 'project-2', name: 'Second' };
    tasks = [taskFrom({
      title: '失效项目任务', objective: '目标', acceptanceCriteria: [], scope: null,
      constraints: null, references: [], priority: 'none',
    }, 'ready')];
    let projectGone = false;
    api.listProjects.mockImplementation(async (includeArchived = false) => (
      includeArchived ? (projectGone ? [project] : []) : (projectGone ? [replacement] : [project, replacement])
    ));
    api.listTasks.mockImplementation(async (projectId: string, targetBucket: string) => (
      projectId === project.id && targetBucket === 'tasks' ? tasks : []
    ));
    api.archiveTask.mockImplementationOnce(async () => {
      projectGone = true;
      throw new ApiError('gone', 404, 'Project is archived', 'PROJECT_NOT_FOUND');
    });
    vi.spyOn(window, 'confirm').mockReturnValue(true);
    render(root());
    fireEvent.click(await screen.findByRole('button', { name: /失效项目任务/ }));
    fireEvent.click(screen.getByRole('button', { name: '归档' }));

    expect(await screen.findByRole('heading', { name: 'Second' })).toBeTruthy();
    expect(screen.queryByRole('dialog', { name: '失效项目任务' })).toBeNull();
    expect(screen.queryByRole('button', { name: /失效项目任务/ })).toBeNull();
  });

  it('leaves Project management when another client archived that Project', async () => {
    let projectGone = false;
    api.listProjects.mockImplementation(async (includeArchived = false) => (
      includeArchived ? (projectGone ? [{ ...project, archivedAt: '2026-08-16T01:00:00.000Z' }] : [])
        : (projectGone ? [] : [project])
    ));
    api.renameProject.mockImplementationOnce(async () => {
      projectGone = true;
      throw new ApiError('gone', 404, 'Project is archived', 'PROJECT_NOT_FOUND');
    });
    render(root());
    fireEvent.click(await screen.findByRole('button', { name: /项目管理/ }));
    fireEvent.change(screen.getByDisplayValue('HandMux'), { target: { value: '新名字' } });
    fireEvent.click(screen.getByRole('button', { name: '保存' }));

    expect(await screen.findByText('还没有项目')).toBeTruthy();
    expect(screen.queryByRole('heading', { name: '项目管理' })).toBeNull();
    expect(screen.queryByDisplayValue('新名字')).toBeNull();
  });

  it('keeps the task editor open while its save is in flight', async () => {
    let resolveCreate: ((task: Task) => void) | undefined;
    api.createTask.mockImplementationOnce(async (_projectId: string, input: TaskDraftInput) => (
      await new Promise<Task>((resolve) => { resolveCreate = resolve; })
    ));
    render(root());
    fireEvent.click(await screen.findByRole('button', { name: '新建任务' }));
    fireEvent.change(screen.getByLabelText('想完成什么？'), { target: { value: '稳定保存需求' } });
    fireEvent.click(screen.getByRole('button', { name: '创建任务' }));

    const back = screen.getByRole('button', { name: '返回' });
    expect(back).toHaveProperty('disabled', true);
    expect(screen.getByLabelText('想完成什么？')).toHaveProperty('disabled', true);
    fireEvent.click(back);
    expect(screen.getByLabelText('想完成什么？')).toBeTruthy();

    const saved = taskFrom({
      title: '稳定保存需求', objective: '稳定保存需求', acceptanceCriteria: [], scope: null,
      constraints: null, references: [], priority: 'none',
    }, 'ready');
    await act(async () => resolveCreate?.(saved));
    expect(await screen.findByRole('heading', { name: '稳定保存需求' })).toBeTruthy();
  });

  it('keeps Add Project open while project creation is in flight', async () => {
    let rejectCreate: ((reason?: unknown) => void) | undefined;
    api.createProject.mockImplementationOnce(() => new Promise<Project>((_resolve, reject) => {
      rejectCreate = reject;
    }));
    render(<ProjectRoot drawerOpen inbox={null} onOpenDrawer={() => {}} onCloseDrawer={() => {}}
      onSwitchSession={() => {}} onOpenUsage={() => {}} onOpenSettings={() => {}} />);
    fireEvent.click(await screen.findByRole('button', { name: /添加项目/ }));
    fireEvent.click(screen.getByRole('button', { name: '选择测试目录' }));

    const close = screen.getByRole('button', { name: '关闭目录选择器' });
    expect(close).toHaveProperty('disabled', true);
    fireEvent.click(close);
    expect(screen.getByRole('dialog', { name: '测试目录选择器' })).toBeTruthy();

    await act(async () => rejectCreate?.(new Error('目录正被占用')));
    expect((await screen.findByTestId('dir-picker-hint')).textContent).toContain('目录正被占用');
    expect(close).toHaveProperty('disabled', false);
  });

  it('clears the previous Project tasks before a switched Project load fails', async () => {
    const secondProject = { ...project, id: 'project-2', name: 'Second' };
    const oldTask = taskFrom({
      title: '旧项目任务', objective: '不应残留', acceptanceCriteria: [], scope: null,
      constraints: null, references: [], priority: 'none',
    }, 'ready');
    api.listProjects.mockImplementation(async (archived = false) => archived ? [] : [project, secondProject]);
    api.listTasks.mockImplementation(async (projectId: string, bucket: string) => {
      if (projectId === project.id) return bucket === 'tasks' ? [oldTask] : [];
      throw new Error('第二项目读取失败');
    });
    const view = (drawerOpen: boolean): JSX.Element => <ProjectRoot drawerOpen={drawerOpen} inbox={null}
      onOpenDrawer={() => {}} onCloseDrawer={() => {}} onSwitchSession={() => {}}
      onOpenUsage={() => {}} onOpenSettings={() => {}} />;
    const { rerender } = render(view(false));
    expect(await screen.findByRole('button', { name: /旧项目任务/ })).toBeTruthy();

    rerender(view(true));
    fireEvent.click(screen.getByRole('button', { name: 'Second' }));
    rerender(view(false));
    expect((await screen.findByRole('alert')).textContent).toContain('第二项目读取失败');
    expect(screen.queryByRole('button', { name: /旧项目任务/ })).toBeNull();
  });

  it('keeps current tasks when the active Project is tapped again in the drawer', async () => {
    tasks = [taskFrom({
      title: '当前项目任务', objective: '继续显示', acceptanceCriteria: [], scope: null,
      constraints: null, references: [], priority: 'none',
    }, 'ready')];
    const onCloseDrawer = vi.fn();
    const view = (drawerOpen: boolean): JSX.Element => <ProjectRoot drawerOpen={drawerOpen} inbox={null}
      onOpenDrawer={() => {}} onCloseDrawer={onCloseDrawer} onSwitchSession={() => {}}
      onOpenUsage={() => {}} onOpenSettings={() => {}} />;
    const { rerender } = render(view(false));
    expect(await screen.findByRole('button', { name: /当前项目任务/ })).toBeTruthy();
    const reads = api.listTasks.mock.calls.length;

    rerender(view(true));
    fireEvent.click(screen.getByRole('button', { name: /^HandMux$/ }));
    rerender(view(false));

    expect(onCloseDrawer).toHaveBeenCalledOnce();
    expect(screen.getByRole('button', { name: /当前项目任务/ })).toBeTruthy();
    expect(api.listTasks).toHaveBeenCalledTimes(reads);
  });

  it('does not leave archived Project tasks under the replacement Project when its load fails', async () => {
    const secondProject = { ...project, id: 'project-2', name: 'Second' };
    const oldTask = taskFrom({
      title: '已归档项目任务', objective: '必须清除', acceptanceCriteria: [], scope: null,
      constraints: null, references: [], priority: 'none',
    }, 'ready');
    let archived = false;
    api.listProjects.mockImplementation(async (includeArchived = false) => (
      includeArchived ? [] : archived ? [secondProject] : [project, secondProject]
    ));
    api.listTasks.mockImplementation(async (projectId: string, targetBucket: string) => {
      if (projectId === project.id) return targetBucket === 'tasks' ? [oldTask] : [];
      throw new Error('新项目任务读取失败');
    });
    api.archiveProject.mockImplementation(async () => { archived = true; });
    vi.spyOn(window, 'confirm').mockReturnValue(true);
    render(root());
    expect(await screen.findByRole('button', { name: /已归档项目任务/ })).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: /项目管理/ }));
    fireEvent.click(await screen.findByRole('button', { name: '归档项目' }));

    expect(await screen.findByRole('heading', { name: 'Second' })).toBeTruthy();
    expect((await screen.findByRole('alert')).textContent).toContain('新项目任务读取失败');
    expect(screen.queryByRole('button', { name: /已归档项目任务/ })).toBeNull();
  });

  it('clears tasks immediately when switching between task and draft buckets', async () => {
    const readyTask = taskFrom({
      title: '正式任务', objective: '不要显示在草稿下', acceptanceCriteria: [], scope: null,
      constraints: null, references: [], priority: 'none',
    }, 'ready');
    const draftTask = {
      ...taskFrom({
        title: '草稿需求', objective: '草稿内容', acceptanceCriteria: [], scope: null,
        constraints: null, references: [], priority: 'none',
      }, 'draft'),
      id: 'draft-1',
    };
    let resolveDrafts: ((value: Task[]) => void) | undefined;
    api.listTasks.mockImplementation(async (_projectId: string, targetBucket: string) => {
      if (targetBucket === 'tasks') return [readyTask];
      return await new Promise<Task[]>((resolve) => { resolveDrafts = resolve; });
    });
    render(root());
    expect(await screen.findByRole('button', { name: /正式任务/ })).toBeTruthy();

    fireEvent.click(screen.getByRole('tab', { name: '草稿' }));
    expect(screen.queryByRole('button', { name: /正式任务/ })).toBeNull();
    expect(screen.getByText('加载中…')).toBeTruthy();

    await act(async () => resolveDrafts?.([draftTask]));
    expect(await screen.findByRole('button', { name: /草稿需求/ })).toBeTruthy();
  });

  it('clears a previous mutation error whenever Add Project is opened', async () => {
    api.createProject.mockRejectedValueOnce(new ApiError('create failed', 500, '目录无法添加'));
    render(<ProjectRoot drawerOpen inbox={null} onOpenDrawer={() => {}} onCloseDrawer={() => {}}
      onSwitchSession={() => {}} onOpenUsage={() => {}} onOpenSettings={() => {}} />);
    fireEvent.click(await screen.findByRole('button', { name: /添加项目/ }));
    fireEvent.click(screen.getByRole('button', { name: '选择测试目录' }));
    expect((await screen.findByTestId('dir-picker-hint')).textContent).toContain('目录无法添加');

    fireEvent.click(screen.getByRole('button', { name: '关闭目录选择器' }));
    fireEvent.click(screen.getByRole('button', { name: /添加项目/ }));
    expect(screen.queryByTestId('dir-picker-hint')).toBeNull();
  });

  it('makes hidden Project surfaces inert while keeping the active layer interactive', async () => {
    const { container } = render(root());
    const drawer = container.querySelector('.project-drawer');
    expect(drawer?.hasAttribute('inert')).toBe(true);

    fireEvent.click(await screen.findByRole('button', { name: /项目管理/ }));
    expect(await screen.findByText('已取消（0）')).toBeTruthy();
    const home = container.querySelector('.project-root');
    expect(home?.getAttribute('aria-hidden')).toBe('true');
    expect(home?.hasAttribute('inert')).toBe(true);
    expect(container.querySelector('.project-page')?.hasAttribute('inert')).toBe(false);
  });

  it('does not discard edited requirements without confirmation', async () => {
    const confirm = vi.spyOn(window, 'confirm').mockReturnValue(false);
    render(root());
    fireEvent.click(await screen.findByRole('button', { name: '新建任务' }));
    fireEvent.change(screen.getByLabelText('想完成什么？'), { target: { value: '未保存需求' } });
    fireEvent.click(screen.getByRole('button', { name: '返回' }));
    expect(confirm).toHaveBeenCalledWith('尚未保存的修改会丢失。确定返回吗？');
    expect(screen.getByLabelText('想完成什么？')).toBeTruthy();

    confirm.mockReturnValue(true);
    fireEvent.click(screen.getByRole('button', { name: '返回' }));
    expect(screen.queryByLabelText('想完成什么？')).toBeNull();
  });

  it('re-arms browser Back after the user keeps unsaved requirements', async () => {
    const confirm = vi.spyOn(window, 'confirm').mockReturnValue(false);
    render(root());
    fireEvent.click(await screen.findByRole('button', { name: '新建任务' }));
    fireEvent.change(screen.getByLabelText('想完成什么？'), { target: { value: '不要丢' } });

    act(() => window.history.back());
    await waitFor(() => expect(confirm).toHaveBeenCalledOnce());
    await waitFor(() => expect(window.history.state?.overlayId).toBeTruthy());
    expect(screen.getByLabelText('想完成什么？')).toBeTruthy();

    confirm.mockReturnValue(true);
    act(() => window.history.back());
    await waitFor(() => expect(screen.queryByLabelText('想完成什么？')).toBeNull());
  });

  it('keeps archived Projects reachable as read-only management pages', async () => {
    const archived = { ...project, id: 'project-archived', name: '旧项目', archivedAt: '2026-08-16T01:00:00.000Z' };
    api.listProjects.mockImplementation(async (includeArchived = false) => includeArchived ? [archived] : [project]);
    render(<ProjectRoot drawerOpen={true} inbox={null} onOpenDrawer={() => {}} onCloseDrawer={() => {}}
      onSwitchSession={() => {}} onOpenUsage={() => {}} onOpenSettings={() => {}} />);

    fireEvent.click(await screen.findByText('已归档项目（1）'));
    fireEvent.click(screen.getByRole('button', { name: '旧项目' }));
    expect(screen.getByRole('heading', { name: '项目管理' })).toBeTruthy();
    expect(screen.getByDisplayValue('旧项目')).toHaveProperty('disabled', true);
    expect(screen.queryByRole('button', { name: '归档项目' })).toBeNull();
    expect(await screen.findByText('已取消（0）')).toBeTruthy();
  });
});
