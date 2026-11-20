import { create } from 'zustand'
import { createId } from '../utils/id.js'

/** 用户保存的常用提示词，插到输入框里再手动补充细节 */
export type CustomPrompt = {
  id: string
  name: string
  content: string
  createdAt: number
}

const STORAGE_KEY = 'chat-agent:custom-prompts'
const MAX_PROMPTS = 40

const load = (): CustomPrompt[] => {
  try {
    const parsed: unknown = JSON.parse(localStorage.getItem(STORAGE_KEY) ?? '[]')
    if (!Array.isArray(parsed)) {
      return []
    }
    return parsed.flatMap((item): CustomPrompt[] => {
      if (!item || typeof item !== 'object') {
        return []
      }
      const record = item as Record<string, unknown>
      if (typeof record.name !== 'string' || typeof record.content !== 'string') {
        return []
      }
      return [
        {
          id: typeof record.id === 'string' ? record.id : createId(),
          name: record.name.slice(0, 40),
          content: record.content.slice(0, 8000),
          createdAt: typeof record.createdAt === 'number' ? record.createdAt : Date.now(),
        },
      ]
    })
  } catch {
    return []
  }
}

export const usePrompts = create<{ list: CustomPrompt[] }>(() => ({ list: load() }))

const persist = (list: CustomPrompt[]) => {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(list))
  } catch {
    // 存储不可用时只在内存里生效
  }
  usePrompts.setState({ list })
}

export const addPrompt = (name: string, content: string) => {
  const prompt: CustomPrompt = {
    id: createId(),
    name: name.trim().slice(0, 40) || '未命名提示词',
    content: content.slice(0, 8000),
    createdAt: Date.now(),
  }
  const list = [prompt, ...usePrompts.getState().list].slice(0, MAX_PROMPTS)
  persist(list)
  return prompt
}

export const updatePrompt = (id: string, name: string, content: string) => {
  persist(
    usePrompts.getState().list.map((item) =>
      item.id === id
        ? { ...item, name: name.trim().slice(0, 40) || item.name, content: content.slice(0, 8000) }
        : item
    )
  )
}

export const removePrompt = (id: string) => {
  persist(usePrompts.getState().list.filter((item) => item.id !== id))
}
