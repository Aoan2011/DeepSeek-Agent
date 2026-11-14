import { create } from 'zustand'
import { demoWorkspace } from './demo.js'
import { diffWorkspace } from './diff.js'
import {
  pickDirectory,
  readLocalWorkspace,
  writeLocalFile,
  type LocalWorkspace,
} from './local.js'
import type { WorkspaceSnapshot, WorkspaceSource } from './types.js'

export type BranchData = {
  head: Record<string, string>
  worktree: Record<string, string>
}

type DemoState = {
  branch: string
  branchData: Record<string, BranchData>
}

const STORAGE_KEY = 'deepseek-agent:workspace'
const STORAGE_VERSION = 1

const seed = (): DemoState => {
  const workspace = demoWorkspace()
  return { branch: workspace.branch, branchData: workspace.branchData }
}

const loadDemo = (): DemoState => {
  const fallback = seed()
  try {
    const raw = localStorage.getItem(STORAGE_KEY)
    if (!raw) {
      return fallback
    }
    const saved = JSON.parse(raw) as { version?: number; branch?: string; branchData?: unknown }
    if (saved.version !== STORAGE_VERSION || typeof saved.branch !== 'string') {
      return fallback
    }
    const data = saved.branchData as Record<string, BranchData> | undefined
    if (!data || typeof data !== 'object') {
      return fallback
    }
    const branchData: Record<string, BranchData> = {}
    for (const [name, value] of Object.entries(data)) {
      if (
        value &&
        typeof value.head === 'object' &&
        typeof value.worktree === 'object' &&
        value.head !== null &&
        value.worktree !== null
      ) {
        branchData[name] = { head: value.head, worktree: value.worktree }
      }
    }
    if (!branchData[saved.branch]) {
      return fallback
    }
    // 代码里新增的演示分支要合并进来，避免旧缓存挡住
    for (const [name, value] of Object.entries(fallback.branchData)) {
      branchData[name] ??= value
    }
    return { branch: saved.branch, branchData }
  } catch {
    return fallback
  }
}

let demo = loadDemo()

const persistDemo = () => {
  try {
    localStorage.setItem(
      STORAGE_KEY,
      JSON.stringify({ version: STORAGE_VERSION, branch: demo.branch, branchData: demo.branchData })
    )
  } catch {
    // 存储配额不足时只影响下次恢复
  }
}

const clone = (value: Record<string, string>) => ({ ...value })

type WorkspaceStore = {
  ready: boolean
  loading: boolean
  error: string | null
  source: WorkspaceSource
  name: string
  root: string
  branch: string
  branches: string[]
  files: Record<string, string>
  base: Record<string, string>
  handle?: FileSystemDirectoryHandle
  /** 本地目录文件过多被截断 */
  truncated: boolean
}

const initial = demoWorkspace()

export const useWorkspace = create<WorkspaceStore>(() => ({
  ready: false,
  loading: false,
  error: null,
  source: 'demo',
  name: initial.name,
  root: initial.root,
  branch: initial.branch,
  branches: initial.branches,
  files: { ...initial.files },
  base: { ...initial.head },
  handle: undefined,
  truncated: false,
}))

const demoBranchData = () => demo.branchData[demo.branch]

/** 首次挂载时载入演示仓库 */
export const initWorkspace = () => {
  if (useWorkspace.getState().ready) {
    return
  }
  const data = demoBranchData()
  useWorkspace.setState({
    ready: true,
    source: 'demo',
    name: 'deepseek-agent',
    root: 'demo/deepseek-agent',
    branch: demo.branch,
    branches: Object.keys(demo.branchData),
    files: clone(data.worktree),
    base: clone(data.head),
    handle: undefined,
    error: null,
    truncated: false,
  })
}

/** 切换分支（仅演示仓库）：换成该分支的基线与工作树 */
export const setBranch = (name: string) => {
  const state = useWorkspace.getState()
  if (state.source !== 'demo' || !demo.branchData[name] || name === state.branch) {
    return false
  }
  demo = { ...demo, branch: name }
  persistDemo()
  const data = demo.branchData[name]
  useWorkspace.setState({
    branch: name,
    branches: Object.keys(demo.branchData),
    files: clone(data.worktree),
    base: clone(data.head),
    error: null,
  })
  return true
}

const VALID_BRANCH = /^[a-zA-Z0-9._/-]+$/

/** 新建分支：以当前工作树为基线，工作树保持不变，因此新分支 diff 为空 */
export const createBranch = (name: string): { ok: boolean; error?: string } => {
  const state = useWorkspace.getState()
  if (state.source !== 'demo') {
    return { ok: false, error: 'local' }
  }
  const branch = name.trim()
  if (!branch || !VALID_BRANCH.test(branch) || branch.startsWith('-')) {
    return { ok: false, error: 'invalid' }
  }
  if (demo.branchData[branch]) {
    return { ok: false, error: 'exists' }
  }
  demo.branchData[branch] = {
    head: clone(state.files),
    worktree: clone(state.files),
  }
  demo = { ...demo, branch }
  persistDemo()
  useWorkspace.setState({
    branch,
    branches: Object.keys(demo.branchData),
    base: clone(state.files),
    files: clone(state.files),
    error: null,
  })
  return { ok: true }
}

/** 写入文件：演示仓库写内存并持久化，本地目录写回磁盘 */
export const writeWorkspaceFile = async (path: string, content: string) => {
  const state = useWorkspace.getState()
  if (!state.ready) {
    initWorkspace()
  }
  const current = useWorkspace.getState()
  if (current.source === 'demo') {
    const data = demoBranchData()
    data.worktree[path] = content
    persistDemo()
    useWorkspace.setState({ files: clone(data.worktree) })
    return
  }
  if (!current.handle) {
    throw new Error('workspace not writable')
  }
  await writeLocalFile(current.handle, path, content)
  useWorkspace.setState({ files: { ...current.files, [path]: content } })
}

/** 丢弃单个文件的改动：恢复基线内容 */
export const discardFile = async (path: string) => {
  const state = useWorkspace.getState()
  if (state.source === 'demo') {
    const data = demoBranchData()
    if (path in data.head) {
      data.worktree[path] = data.head[path]
    } else {
      Reflect.deleteProperty(data.worktree, path)
    }
    persistDemo()
    useWorkspace.setState({ files: clone(data.worktree) })
    return
  }
  if (path in state.base) {
    await writeWorkspaceFile(path, state.base[path])
  }
}

/** 丢弃全部改动 */
export const discardAll = async () => {
  const state = useWorkspace.getState()
  for (const item of diffWorkspace(state.base, state.files)) {
    await discardFile(item.path)
  }
}

const applyLocal = (local: LocalWorkspace) => {
  useWorkspace.setState({
    source: 'local',
    loading: false,
    error: null,
    name: '本地目录',
    root: local.git ? `local/${local.git.branch}` : 'local',
    branch: local.git?.branch ?? '工作区',
    branches: local.git?.branches ?? [],
    files: clone(local.files),
    base: clone(local.files),
    truncated: local.truncated,
  })
}

/** 打开本地文件夹；用户取消时静默返回 */
export const openLocalWorkspace = async () => {
  const state = useWorkspace.getState()
  if (state.loading) {
    return
  }
  useWorkspace.setState({ loading: true, error: null })
  try {
    const handle = await pickDirectory()
    const local = await readLocalWorkspace(handle)
    useWorkspace.setState({ handle })
    applyLocal(local)
    if (Object.keys(local.files).length === 0) {
      useWorkspace.setState({ error: 'empty' })
    }
  } catch (error) {
    const aborted = error instanceof DOMException && error.name === 'AbortError'
    useWorkspace.setState({ loading: false, error: aborted ? null : 'open' })
  }
}

/** 重新扫描本地目录：基线保持打开时的快照，便于看出磁盘上的新改动 */
export const refreshLocalWorkspace = async () => {
  const state = useWorkspace.getState()
  if (state.source !== 'local' || !state.handle) {
    return
  }
  useWorkspace.setState({ loading: true })
  try {
    const local = await readLocalWorkspace(state.handle)
    useWorkspace.setState({
      files: clone(local.files),
      branches: local.git?.branches ?? [],
      branch: local.git?.branch ?? state.branch,
      root: local.git ? `local/${local.git.branch}` : 'local',
      loading: false,
      truncated: local.truncated,
      error: null,
    })
  } catch {
    useWorkspace.setState({ loading: false, error: 'open' })
  }
}

/** 回到演示仓库，保留之前的分支与改动 */
export const backToDemo = () => {
  const data = demoBranchData()
  useWorkspace.setState({
    source: 'demo',
    name: 'deepseek-agent',
    root: 'demo/deepseek-agent',
    branch: demo.branch,
    branches: Object.keys(demo.branchData),
    files: clone(data.worktree),
    base: clone(data.head),
    handle: undefined,
    error: null,
    truncated: false,
  })
}

/** 供工具与界面读取的一致快照 */
export const workspaceSnapshot = (): WorkspaceSnapshot | null => {
  const state = useWorkspace.getState()
  if (!state.ready) {
    initWorkspace()
  }
  const next = useWorkspace.getState()
  if (next.source === 'local' && !next.handle) {
    return null
  }
  return {
    source: next.source,
    name: next.name,
    root: next.root,
    branch: next.branch,
    branches: next.branches,
    files: next.files,
    base: next.base,
    writable: next.source === 'demo' || Boolean(next.handle),
    handle: next.handle,
  }
}

/** 测试与演示用：清除保存的演示改动 */
export const resetWorkspace = () => {
  demo = seed()
  persistDemo()
  useWorkspace.setState({
    ready: false,
    source: 'demo',
    handle: undefined,
    error: null,
    truncated: false,
  })
  initWorkspace()
}
