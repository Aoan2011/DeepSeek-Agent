import { runSubagent } from '../subagent.js'
import {
  addGoal,
  completeGoal,
  dropGoal,
  removeGoal,
  reopenGoal,
  updateGoal,
  useGoals,
} from '../../goals.js'
import { defineTool, fail, num, objectSchema, ok, str } from '../toolKit.js'
import type { RegisteredTool } from '../types.js'

/**
 * 目标管理：目标会一直出现在系统提示里，直到被标记完成。
 * 写的是本机目标清单，风险很低，不额外要求确认，避免打断连续推进。
 */
const manageGoalsTool = defineTool(
  {
    name: 'manage_goals',
    label: '管理目标',
    description: [
      '维护跨轮次的目标清单。目标会出现在每一轮的系统提示里，用来对齐「最终要达成什么」。',
      'action=list 查看；create 新建；update 改标题/细节；complete 标记达成并写结论；drop 放弃；reopen 重新激活；remove 删除。',
      '用法建议：接到多步任务先 create 一条目标并写清验收标准，推进过程中用 update 补充进展，交付后用 complete 写结论。',
    ].join(''),
    inputSchema: objectSchema(
      {
        action: {
          type: 'string',
          enum: ['list', 'create', 'update', 'complete', 'drop', 'reopen', 'remove'],
          description: '要执行的动作',
        },
        id: { type: 'string', description: '目标 id，除 create/list 外都需要' },
        title: { type: 'string', description: '目标标题（create/update）' },
        detail: { type: 'string', description: '验收标准、约束、拆解步骤（create/update）' },
        result: { type: 'string', description: '达成结论或产出说明（complete/update）' },
      },
      ['action']
    ),
    risk: 'write',
    requiresApproval: false,
    icon: 'target',
  },
  async (input) => {
    const action = str(input, 'action')
    const id = str(input, 'id').trim()
    const title = str(input, 'title').trim()
    const detail = input.detail === undefined ? undefined : str(input, 'detail')
    const result = input.result === undefined ? undefined : str(input, 'result')

    if (action === 'list') {
      const list = useGoals.getState().list
      if (list.length === 0) {
        return ok('还没有目标。可以用 action=create 建一条。')
      }
      const mark = (status: string) =>
        status === 'active' ? '[ ]' : status === 'done' ? '[x]' : '[-]'
      return ok(
        list
          .map(
            (goal) =>
              `${mark(goal.status)} ${goal.title}（id: ${goal.id}）${goal.result ? `｜结论：${goal.result}` : ''}`
          )
          .join('\n')
      )
    }

    if (action === 'create') {
      if (!title) {
        return fail('create 需要 title')
      }
      const goal = addGoal(title, detail ?? '')
      return ok(`已创建目标「${goal.title}」（id: ${goal.id}），会持续出现在系统提示里。`, {
        meta: { goalId: goal.id },
      })
    }

    if (!id) {
      return fail(`${action} 需要 id，可以先用 action=list 查`)
    }
    const exists = useGoals.getState().list.some((goal) => goal.id === id)
    if (!exists) {
      return fail(`没有这个目标：${id}`)
    }

    switch (action) {
      case 'update':
        updateGoal(id, { ...(title ? { title } : {}), ...(detail !== undefined ? { detail } : {}), ...(result !== undefined ? { result } : {}) })
        return ok('目标已更新。')
      case 'complete':
        completeGoal(id, result)
        return ok(
          `目标已标记达成${result ? `，结论：${result}` : ''}。如果还有下一步，可以再 create 一条新目标。`
        )
      case 'drop':
        dropGoal(id)
        return ok('目标已标记为放弃。')
      case 'reopen':
        reopenGoal(id)
        return ok('目标已重新激活。')
      case 'remove':
        removeGoal(id)
        return ok('目标已删除。')
      default:
        return fail(`不支持的动作：${action}`)
    }
  },
  'browser'
)

export const agentTools: RegisteredTool[] = [
  defineTool(
    {
      name: 'spawn_subagent',
      label: '派生子 Agent',
      description: [
        '把一个相对独立、可并行或需要多步查证的任务交给子 Agent 处理。',
        '子 Agent 有独立上下文和独立工具循环，只把最终结论返回给你，中间过程不占用当前对话。',
        '默认只授予只读工具（时间、天气、网页抓取、扩展读取、MCP 只读工具），不会执行写文件或命令。',
        '适合：分别调研几个对象再对比、先查证再汇总、把长链路检索拆出去。',
        '不适合：一步就能完成的事、需要用户确认的写操作、需要保留中间截图的任务。',
      ].join(''),
      inputSchema: objectSchema(
        {
          task: {
            type: 'string',
            description: '交给子 Agent 的具体任务，写清楚目标、范围与期望输出',
          },
          tools: {
            type: 'array',
            items: { type: 'string' },
            description: '限定子 Agent 可用的工具名；省略时自动挑选只读工具',
          },
          max_rounds: {
            type: 'number',
            description: '最多推理轮次，1-6，默认 3',
          },
        },
        ['task']
      ),
      risk: 'safe',
      icon: 'spark',
    },
    async (input, context) => {
      const task = str(input, 'task').trim()
      if (!task) {
        return fail('task 不能为空')
      }
      const names = Array.isArray(input.tools)
        ? input.tools.filter((item): item is string => typeof item === 'string')
        : undefined
      const maxRounds = Math.min(6, Math.max(1, num(input, 'max_rounds') ?? 3))
      const run = await runSubagent({
        task,
        tools: names,
        maxRounds,
        sessionId: context.sessionId,
        signal: context.signal,
        onProgress: context.progress,
      })
      if (!run.text.trim()) {
        return fail('子 Agent 没有返回内容，可以让它重试或改用主对话工具')
      }
      const summary = run.used.length > 0 ? `调用 ${run.used.join('、')}` : '未调用工具'
      return ok(`子 Agent 完成（${run.rounds} 轮，${summary}）：\n\n${run.text}`)
    }
  ),
  manageGoalsTool,
]
