import { create } from 'zustand'
import { createArtifact } from '../artifacts.js'
import { registerTools, unregisterTools } from '../registry.js'
import type { RegisteredTool, ToolDefinition } from '../types.js'
import { DesktopClient, type DesktopInfo } from './client.js'
import type { McpCallResult, McpToolInfo } from '../mcp/types.js'
import type { ToolImage } from '../types.js'

const URL_KEY = 'chat-agent:desktop-url'
const TOKEN_KEY = 'chat-agent:desktop-token'
const AUTO_KEY = 'chat-agent:desktop-auto'

export type DesktopStatus = 'disconnected' | 'connecting' | 'connected' | 'error'

type DesktopStore = {
  status: DesktopStatus
  error?: string
  info?: DesktopInfo
  url: string
  token: string
  autoConnect: boolean
  toolCount: number
}

const read = (key: string, fallback: string) => {
  try {
    return localStorage.getItem(key) ?? fallback
  } catch {
    return fallback
  }
}

export const useDesktop = create<DesktopStore>(() => ({
  status: 'disconnected',
  url: read(URL_KEY, 'ws://127.0.0.1:8765'),
  token: read(TOKEN_KEY, ''),
  autoConnect: read(AUTO_KEY, 'false') === 'true',
  toolCount: 0,
}))

let client: DesktopClient | null = null

const DESKTOP_TOOLS: Record<string, { risk: ToolDefinition['risk']; approval?: boolean; icon: string }> = {
  desk_fs_read: { risk: 'safe', icon: 'file' },
  desk_fs_list: { risk: 'safe', icon: 'folder' },
  desk_fs_stat: { risk: 'safe', icon: 'info' },
  desk_fs_write: { risk: 'write', approval: true, icon: 'file' },
  desk_fs_delete: { risk: 'write', approval: true, icon: 'trash' },
  desk_fs_move: { risk: 'write', approval: true, icon: 'move' },
  desk_shell_exec: { risk: 'exec', approval: true, icon: 'terminal' },
  desk_python_exec: { risk: 'exec', approval: true, icon: 'code' },
  desk_system_info: { risk: 'safe', icon: 'chip' },
  desk_screen_capture: { risk: 'safe', icon: 'desktop' },
  desk_mouse: { risk: 'exec', approval: true, icon: 'desktop' },
  desk_keyboard: { risk: 'exec', approval: true, icon: 'terminal' },
  desk_window: { risk: 'write', approval: true, icon: 'desktop' },
  // 移植过来的扩展工具：只读的默认免确认，会写盘或读隐私的仍然要确认
  desk_hash: { risk: 'safe', icon: 'code' },
  desk_grep: { risk: 'safe', icon: 'search' },
  desk_archive: { risk: 'write', approval: true, icon: 'folder' },
  desk_json_query: { risk: 'safe', icon: 'code' },
  desk_net_probe: { risk: 'network', icon: 'globe' },
  desk_process_list: { risk: 'safe', icon: 'chip' },
  desk_text_stats: { risk: 'safe', icon: 'file' },
  desk_clipboard: { risk: 'write', approval: true, icon: 'clipboard' },
  desk_git: { risk: 'safe', icon: 'move' },
}

const toArtifacts = async (
  tools: string,
  result: McpCallResult,
  sessionId: string
): Promise<{
  text: string
  artifacts: Awaited<ReturnType<typeof createArtifact>>[]
  /** 截图等图片同时回传给模型，否则模型只看到一句「已截图」 */
  images: ToolImage[]
}> => {
  const texts: string[] = []
  const artifacts: Awaited<ReturnType<typeof createArtifact>>[] = []
  const images: ToolImage[] = []
  for (const [index, item] of result.content.entries()) {
    if (item.type === 'text') {
      texts.push(item.text)
      continue
    }
    if (item.type === 'image') {
      const artifact = await createArtifact({
        name: `desktop-screen-${Date.now() % 100000}-${index + 1}.png`,
        dataUrl: `data:${item.mimeType};base64,${item.data}`,
        mime: item.mimeType,
        source: 'desktop',
        tool: tools,
        sessionId,
      })
      artifacts.push(artifact)
      images.push({ mediaType: item.mimeType, data: item.data, name: artifact.name })
      texts.push(`（截图已保存为 ${artifact.name}）`)
    }
  }
  return { text: texts.join('\n\n') || '（无输出）', artifacts, images }
}

const registerDesktopTools = (tools: McpToolInfo[], active: DesktopClient) => {
  const registered: RegisteredTool[] = tools.map((tool) => {
    const exposed = tool.name.startsWith('desk_') ? tool.name : `desk_${tool.name}`
    const meta = DESKTOP_TOOLS[exposed]
    const readOnly = tool.annotations?.readOnlyHint === true
    const definition: ToolDefinition = {
      name: exposed,
      // 优先用 MCP 注解里的标题，其次退回去掉前缀的工具名
      label: tool.annotations?.title || tool.name.replace(/^desk_/, ''),
      // 桥接工具的描述带 "[服务器名] " 前缀，分组已经标出来源，这里去掉避免重复
      description: tool.server ? tool.description.replace(/^\[[^\]]+\]\s*/, '') : tool.description,
      inputSchema: {
        type: 'object',
        ...(tool.inputSchema as Record<string, unknown>),
      },
      source: exposed.startsWith('desk_mcp_') ? 'mcp' : 'desktop',
      serverId: tool.server ? `desktop:${tool.server}` : 'desktop',
      // 桥接的 stdio 服务器单独成组，避免与本机工具同名混淆
      serverName: tool.server ? `本机 · ${tool.server}` : '本机桌面端',
      risk: meta?.risk ?? (readOnly ? 'safe' : 'write'),
      requiresApproval: meta?.approval ?? !readOnly,
      icon: meta?.icon ?? 'desktop',
    }
    return {
      definition,
      execute: async (input, context) => {
        if (context.signal.aborted) {
          return { content: '已停止', isError: true }
        }
        context.progress('正在本机执行…')
        try {
          const result = await active.callTool(tool.name, input)
          const { text, artifacts, images } = await toArtifacts(
            tool.name,
            result,
            context.sessionId
          )
          return {
            content: text,
            isError: result.isError,
            artifacts,
            ...(images.length ? { images } : {}),
          }
        } catch (error) {
          return {
            content: `桌面端执行失败：${error instanceof Error ? error.message : String(error)}`,
            isError: true,
          }
        }
      },
    }
  })
  registerTools(registered)
}

/**
 * 切换本机工作区：直接调用桥接的 desk_workspace 工具。
 * 这是用户在选择器里的主动操作，不需要再走一遍审批。
 */
export const switchDesktopWorkspace = async (path: string): Promise<boolean> => {
  if (!client) {
    return false
  }
  const result = await client.callTool('desk_workspace', { action: 'use', path })
  if (result.isError) {
    return false
  }
  const info = useDesktop.getState().info
  if (info?.workspaces) {
    useDesktop.setState({
      info: {
        ...info,
        sandbox: path,
        workspaces: info.workspaces.map((item) => ({ ...item, current: item.path === path })),
      },
    })
  }
  return true
}

export const connectDesktop = async (url?: string, token?: string): Promise<void> => {
  const target = url ?? useDesktop.getState().url
  const secret = token ?? useDesktop.getState().token
  disconnectDesktop()
  useDesktop.setState({ status: 'connecting', error: undefined, url: target, token: secret })
  const next = new DesktopClient(target, secret)
  client = next
  try {
    await next.connect()
    const tools = await next.listTools()
    registerDesktopTools(tools, next)
    useDesktop.setState({
      status: 'connected',
      info: next.serverInfo ?? undefined,
      toolCount: tools.length,
      error: undefined,
    })
    try {
      localStorage.setItem(URL_KEY, target)
      localStorage.setItem(TOKEN_KEY, secret)
    } catch {
      // 忽略存储失败
    }
  } catch (error) {
    next.close()
    client = null
    useDesktop.setState({
      status: 'error',
      error: error instanceof Error ? error.message : String(error),
      toolCount: 0,
    })
  }
}

export const disconnectDesktop = () => {
  client?.close()
  client = null
  unregisterTools((definition) => definition.serverId === 'desktop')
  useDesktop.setState({ status: 'disconnected', info: undefined, toolCount: 0, error: undefined })
}

export const setDesktopAutoConnect = (autoConnect: boolean) => {
  useDesktop.setState({ autoConnect })
  try {
    localStorage.setItem(AUTO_KEY, String(autoConnect))
  } catch {
    // 忽略存储失败
  }
}

/** 页面加载时：从 URL 读取一次性令牌，或按上次设置自动连接 */
export const initDesktop = () => {
  const params = new URLSearchParams(location.search)
  const url = params.get('desktop') ?? undefined
  const token = params.get('token') ?? undefined
  if (url) {
    void connectDesktop(url, token ?? '')
    return
  }
  if (useDesktop.getState().autoConnect && useDesktop.getState().token) {
    void connectDesktop()
  }
}

export const isDesktopReady = () => useDesktop.getState().status === 'connected'
