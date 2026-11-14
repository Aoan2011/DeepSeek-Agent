import { runSubagent } from '../subagent.js'
import { defineTool, fail, num, objectSchema, ok, str } from '../toolKit.js'
import type { RegisteredTool } from '../types.js'

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
]
