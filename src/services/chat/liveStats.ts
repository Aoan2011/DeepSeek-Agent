import { create } from 'zustand'
import type { MessageUsage } from '../api/types.js'

/**
 * 底部状态条的实时数据源。
 * 服务端只在一轮结束时给出准确用量，所以流式过程中用字符权重估算输出 token，
 * 收到 message_delta 后用服务端数值替换本轮估算，避免数字倒退。
 */
export type LiveRun = {
  sessionId: string
  model: string
  active: boolean
  startedAt: number
  firstTokenAt: number | null
  endedAt: number | null
  /** 正文与思考的字符数，用于估算速度 */
  textChars: number
  thinkingChars: number
  /** 已完成轮次的服务端输出 token 累计 */
  serverOutput: number
  /** 当前轮尚未结算的估算输出 token */
  roundEstimate: number
  inputTokens: number
  cacheRead: number
  cacheCreation: number
  /** 已完成的请求轮次（工具循环会累加） */
  rounds: number
}

type LiveState = { run: LiveRun | null }

export const useLiveStats = create<LiveState>(() => ({ run: null }))

const patchRun = (fn: (run: LiveRun) => LiveRun) => {
  useLiveStats.setState((state) => (state.run ? { run: fn(state.run) } : state))
}

/** 中文按 1 token、其余按 0.3 token 估算，足够速度条使用 */
const tokenWeight = (text: string): number => {
  let weight = 0
  for (const char of text) {
    const code = char.codePointAt(0) ?? 0
    weight += code >= 0x2e80 && code <= 0x9fff ? 1 : 0.3
  }
  return weight
}

export const beginLiveRun = (sessionId: string, model: string) => {
  useLiveStats.setState({
    run: {
      sessionId,
      model,
      active: true,
      startedAt: Date.now(),
      firstTokenAt: null,
      endedAt: null,
      textChars: 0,
      thinkingChars: 0,
      serverOutput: 0,
      roundEstimate: 0,
      inputTokens: 0,
      cacheRead: 0,
      cacheCreation: 0,
      rounds: 0,
    },
  })
}

export const noteDelta = (kind: 'text' | 'thinking', text: string) => {
  const weight = tokenWeight(text)
  patchRun((run) => ({
    ...run,
    firstTokenAt: run.firstTokenAt ?? Date.now(),
    textChars: kind === 'text' ? run.textChars + text.length : run.textChars,
    thinkingChars: kind === 'thinking' ? run.thinkingChars + text.length : run.thinkingChars,
    roundEstimate: run.roundEstimate + weight,
  }))
}

/**
 * phase=start：一轮请求开始，累计输入与缓存用量，重置本轮估算；
 * phase=delta：一轮结束，采用服务端输出 token。
 */
export const noteUsage = (usage: MessageUsage | undefined, phase: 'start' | 'delta') => {
  if (!usage) {
    return
  }
  patchRun((run) =>
    phase === 'start'
      ? {
          ...run,
          inputTokens: run.inputTokens + (usage.input_tokens ?? 0),
          cacheRead: run.cacheRead + (usage.cache_read_input_tokens ?? 0),
          cacheCreation: run.cacheCreation + (usage.cache_creation_input_tokens ?? 0),
          roundEstimate: 0,
        }
      : {
          ...run,
          serverOutput: run.serverOutput + (usage.output_tokens ?? 0),
          roundEstimate: 0,
          rounds: run.rounds + 1,
        }
  )
}

export const finishLiveRun = (sessionId?: string) => {
  patchRun((run) =>
    run.active && (sessionId === undefined || run.sessionId === sessionId)
      ? { ...run, active: false, endedAt: Date.now() }
      : run
  )
}

/** 展示用派生值；调用方负责每秒触发一次重渲染 */
export const readLiveMetrics = (run: LiveRun) => {
  const now = run.endedAt ?? Date.now()
  const elapsed = Math.max(0, now - run.startedAt)
  const firstTokenMs =
    run.firstTokenAt === null ? null : Math.max(0, run.firstTokenAt - run.startedAt)
  const outputTokens = run.serverOutput + Math.round(run.roundEstimate)
  const totalInput = run.inputTokens + run.cacheRead + run.cacheCreation
  const cacheRate = totalInput > 0 ? run.cacheRead / totalInput : null
  const seconds = elapsed / 1000
  // 速度从首字之后算，避免把等待首字的时间摊进吞吐
  const streamSeconds =
    run.firstTokenAt === null ? 0 : Math.max(0.2, (now - run.firstTokenAt) / 1000)
  const tps = streamSeconds > 0 ? outputTokens / streamSeconds : 0
  return {
    elapsed,
    firstTokenMs,
    outputTokens,
    inputTokens: totalInput,
    cacheRate,
    tps,
    seconds,
  }
}

/** 每 1 秒刷新一次；只在生成中订阅，结束后停表 */
export const subscribeLiveTick = (active: boolean, tick: () => void) => {
  if (!active) {
    return () => undefined
  }
  const timer = setInterval(tick, 1000)
  return () => clearInterval(timer)
}
