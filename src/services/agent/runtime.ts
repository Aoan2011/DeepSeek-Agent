import type { ClientToolDefinition } from '../api/types.js'
import type { AssistantMessage, ReplyBlock, ToolCallPart } from '../chat/types.js'
import { requestApproval } from './approval.js'
import { getTool, listTools, runTool } from './registry.js'
import type { ApprovalDecision, ToolDefinition, ToolResult } from './types.js'
import { needsApproval, sourceLabel } from './types.js'

/** 单次工具结果进入上下文的最大长度，避免长输出挤掉对话 */
const MAX_RESULT_CHARS = 24_000
/** 超过该长度时先截断再回传，原文仍保留在工具卡片的完整结果里 */
const clipResult = (text: string) =>
  text.length <= MAX_RESULT_CHARS
    ? text
    : `${text.slice(0, MAX_RESULT_CHARS)}\n\n…（结果过长已截断，共 ${text.length} 字符）`

/** 工具默认超时：本机执行可能较慢；个别工具（如等待用户回答）可以覆盖为无限 */
const timeoutFor = (definition: ToolDefinition) =>
  definition.timeoutMs ??
  (definition.source === 'desktop' ? 300_000 : definition.source === 'mcp' ? 180_000 : 90_000)

/**
 * 生成给模型的工具声明。MCP 返回的 schema 可能缺少 type，
 * 统一补成 object，避免服务端校验失败。
 */
export const buildToolDeclarations = (): ClientToolDefinition[] =>
  listTools()
    .filter((definition) => definition.name.length <= 64)
    .map((definition) => {
      const schema = definition.inputSchema as Record<string, unknown>
      return {
        name: definition.name,
        description: `${definition.description}\n\n[来源：${sourceLabel(definition.source)}${definition.serverName ? ` / ${definition.serverName}` : ''}]`,
        input_schema: {
          ...schema,
          type: 'object',
          properties:
            typeof schema.properties === 'object' && schema.properties !== null
              ? schema.properties
              : {},
        } as ClientToolDefinition['input_schema'],
      }
    })

export const describeToolInput = (input: unknown): string => {
  if (input === null || input === undefined) {
    return ''
  }
  if (typeof input !== 'object') {
    return String(input)
  }
  const record = input as Record<string, unknown>
  const priority = [
    'question',
    'path',
    'command',
    'url',
    'query',
    'selector',
    'name',
    'location',
    'code',
    'text',
  ]
  for (const key of priority) {
    const value = record[key]
    if (typeof value === 'string' && value.trim()) {
      return value.length > 80 ? `${value.slice(0, 80)}…` : value
    }
  }
  const first = Object.values(record).find((value) => typeof value === 'string')
  return typeof first === 'string' ? first.slice(0, 80) : ''
}

const updateCall = (
  reply: AssistantMessage,
  id: string,
  update: (block: ToolCallPart) => ToolCallPart
): AssistantMessage => {
  let changed = false
  const blocks = reply.blocks.map((block) => {
    if (block.type === 'tool_use' && block.id === id) {
      changed = true
      return update(block)
    }
    return block
  })
  return changed ? { ...reply, blocks } : reply
}

const appendResult = (reply: AssistantMessage, result: ReplyBlock): AssistantMessage => ({
  ...reply,
  blocks: [...reply.blocks, result],
})

/** 用 AbortSignal 与超时竞争，任一触发都让工具尽快结束 */
const withTimeout = async <T>(
  task: (signal: AbortSignal) => Promise<T>,
  parent: AbortSignal,
  timeout: number
): Promise<T> => {
  const controller = new AbortController()
  const onAbort = () => controller.abort()
  parent.addEventListener('abort', onAbort, { once: true })
  // Infinity 表示不设超时：等待用户回答这类工具只由用户或停止按钮结束
  const timer = Number.isFinite(timeout) ? setTimeout(() => controller.abort(), timeout) : undefined
  try {
    return await task(controller.signal)
  } finally {
    if (timer !== undefined) {
      clearTimeout(timer)
    }
    parent.removeEventListener('abort', onAbort)
  }
}

export type RunToolsOptions = {
  sessionId: string
  signal: AbortSignal
  /** 每次状态变化写回消息，界面据此刷新 */
  update: (reply: AssistantMessage) => void
  /** 通知动画层：工具开始/结束 */
  onEvent?: (event: 'start' | 'finish', call: ToolCallPart) => void
}

/**
 * 顺序执行本轮所有待执行的工具调用。
 * 顺序执行保证写文件、执行命令的副作用可预测，审批弹窗也不会同时叠多层。
 */
export const runToolCalls = async (
  initial: AssistantMessage,
  options: RunToolsOptions
): Promise<AssistantMessage> => {
  let reply = initial
  const calls = reply.blocks.filter(
    (block): block is ToolCallPart => block.type === 'tool_use' && block.status === 'pending'
  )
  for (const call of calls) {
    if (options.signal.aborted) {
      break
    }
    const definition = getTool(call.name)?.definition
    const startedAt = Date.now()
    let decision: ApprovalDecision = 'allow_once'

    // 未知工具也要走完流程，把明确错误交给模型
    if (!definition) {
      const result: ToolResult = {
        content: `工具「${call.name}」当前不可用。可能是 MCP 服务器断开或桌面端未连接，请告知用户检查连接状态，不要重复调用。`,
        isError: true,
      }
      reply = updateCall(reply, call.id, (block) => ({
        ...block,
        status: 'error',
        source: 'browser',
        endedAt: Date.now(),
        progress: '工具不可用',
      }))
      reply = appendResult(reply, {
        type: 'tool_result',
        tool_use_id: call.id,
        content: result.content,
        isError: true,
        durationMs: Date.now() - startedAt,
      })
      options.update(reply)
      continue
    }

    reply = updateCall(reply, call.id, (block) => ({
      ...block,
      label: definition.label,
      risk: definition.risk,
      source: definition.source,
      status: needsApproval(definition) ? 'awaiting' : 'running',
    }))
    options.update(reply)

    if (needsApproval(definition)) {
      decision = await requestApproval({
        id: `approve-${call.id}`,
        sessionId: options.sessionId,
        toolName: call.name,
        label: definition.label,
        source: definition.source,
        risk: definition.risk,
        input: call.input,
        description: definition.description,
      })
      if (options.signal.aborted) {
        break
      }
      if (decision === 'deny') {
        const message = '用户拒绝执行该操作。请不要重试，改为说明需要用户手动完成，或换一种方式。'
        reply = updateCall(reply, call.id, (block) => ({
          ...block,
          status: 'denied',
          decision: 'deny',
          endedAt: Date.now(),
        }))
        reply = appendResult(reply, {
          type: 'tool_result',
          tool_use_id: call.id,
          content: message,
          isError: true,
          durationMs: 0,
        })
        options.update(reply)
        continue
      }
      reply = updateCall(reply, call.id, (block) => ({
        ...block,
        status: 'running',
        decision: 'allow',
      }))
      options.update(reply)
    }

    const running = reply.blocks.find(
      (block): block is ToolCallPart => block.type === 'tool_use' && block.id === call.id
    )
    if (running) {
      options.onEvent?.('start', running)
    }

    // 审批等待不计入执行耗时，否则工具卡片会显示成十几秒
    const execStartedAt = Date.now()
    let result: ToolResult
    try {
      result = await withTimeout(
        (signal) =>
          runTool(call.name, toArguments(call.input), {
            sessionId: options.sessionId,
            signal,
            progress: (text) => {
              reply = updateCall(reply, call.id, (block) => ({ ...block, progress: text }))
              options.update(reply)
            },
          }),
        options.signal,
        timeoutFor(definition)
      )
    } catch (error) {
      const aborted = options.signal.aborted
      result = {
        content: aborted
          ? '用户停止了生成，工具调用被中止。'
          : `工具执行超时或被中断：${error instanceof Error ? error.message : String(error)}`,
        isError: true,
      }
    }

    if (options.signal.aborted && !result.isError) {
      result = { content: '用户停止了生成，工具已中止。', isError: true }
    }

    reply = updateCall(reply, call.id, (block) => ({
      ...block,
      status: result.isError ? 'error' : 'done',
      endedAt: Date.now(),
      progress: undefined,
    }))
    reply = appendResult(reply, {
      type: 'tool_result',
      tool_use_id: call.id,
      content: clipResult(result.content),
      isError: result.isError,
      artifacts: result.artifacts,
      durationMs: Date.now() - execStartedAt,
    })
    options.update(reply)
    const finished = reply.blocks.find(
      (block): block is ToolCallPart => block.type === 'tool_use' && block.id === call.id
    )
    if (finished) {
      options.onEvent?.('finish', finished)
    }
  }
  return reply
}

/** 模型可能把参数写成字符串，统一成对象再交给工具 */
const toArguments = (input: unknown): Record<string, unknown> => {
  if (typeof input === 'object' && input !== null && !Array.isArray(input)) {
    return input as Record<string, unknown>
  }
  if (typeof input === 'string' && input.trim()) {
    try {
      const parsed: unknown = JSON.parse(input)
      if (typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed)) {
        return parsed as Record<string, unknown>
      }
    } catch {
      return {}
    }
  }
  return {}
}
