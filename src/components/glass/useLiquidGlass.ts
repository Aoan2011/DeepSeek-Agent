import { useCallback, useEffect, useRef } from 'react'
import { useSettings } from '../../services/settings.js'

/**
 * 玻璃表面的挂载层。
 *
 * 这里只做普通毛玻璃：一层半透明底色 + backdrop-filter 模糊。
 * 之前按元素尺寸生成位移贴图做折射，输入框每长高一行就要重算整张 canvas，
 * 侧栏滚动时也要反复重建，是界面卡顿的主要来源；现在统一走 CSS 滤镜。
 *
 * 两档强度：soft 18px（默认），strong 28px；off 时完全去掉滤镜，只留纯色。
 */

const BLUR: Record<'strong' | 'soft', number> = {
  strong: 28,
  soft: 18,
}

/** 毛玻璃：写入 data-glass 供样式层区分，并设置 tint 与模糊半径 */
export const applyFrost = (el: HTMLElement, tint = 0.11, mode: 'strong' | 'soft' = 'soft') => {
  el.dataset.glass = 'blur'
  el.style.setProperty('--lg-tint', String(tint))
  el.style.setProperty('backdrop-filter', `blur(${BLUR[mode]}px) saturate(1.4)`)
  el.style.setProperty('-webkit-backdrop-filter', `blur(${BLUR[mode]}px) saturate(1.4)`)
}

const clearGlass = (el: HTMLElement) => {
  el.removeAttribute('data-glass')
  el.style.removeProperty('backdrop-filter')
  el.style.removeProperty('-webkit-backdrop-filter')
  el.style.removeProperty('--lg-tint')
}

export type GlassOptions = {
  /** 玻璃白度，交给样式层的 --lg-tint */
  tint?: number
  /** 模糊强度；默认跟随设置 */
  mode?: 'strong' | 'soft'
}

type Attachment = { el: HTMLElement }

const attach = (el: HTMLElement, mode: 'strong' | 'soft' | 'off', options: GlassOptions = {}) => {
  if (mode === 'off') {
    clearGlass(el)
    return
  }
  applyFrost(el, options.tint, options.mode ?? mode)
}

/**
 * 把毛玻璃挂到一个元素上：只改变背景渲染方式，不影响布局与事件。
 */
export const useLiquidGlass = <T extends HTMLElement>(options?: GlassOptions) => {
  const ref = useRef<T>(null)
  const mode = useSettings((state) => state.glass)
  // 参数只取一次快照，避免每次渲染重复写样式
  const optionsRef = useRef(options)

  useEffect(() => {
    const el = ref.current
    if (!el) {
      return
    }
    attach(el, mode, optionsRef.current)
    return () => clearGlass(el)
  }, [mode])

  return ref
}

/**
 * 回调 ref 版本：给条件渲染的浮层用（菜单、Toast 在关闭时根本不存在，
 * 对象 ref 的 effect 不会重跑）。元素挂上/卸载时自动装配与清理。
 */
export const useGlassAttach = (options?: GlassOptions) => {
  const mode = useSettings((state) => state.glass)
  const current = useRef<Attachment | null>(null)
  const optionsRef = useRef(options)

  const detach = useCallback(() => {
    if (current.current) {
      clearGlass(current.current.el)
      current.current = null
    }
  }, [])

  useEffect(() => {
    const el = current.current?.el
    detach()
    if (!el) {
      return
    }
    attach(el, mode, optionsRef.current)
    current.current = { el }
  }, [mode, detach])

  useEffect(() => detach, [detach])

  return useCallback(
    (el: HTMLElement | null) => {
      if (current.current?.el === el) {
        return
      }
      detach()
      if (!el) {
        return
      }
      attach(el, mode, optionsRef.current)
      current.current = { el }
    },
    [mode, detach]
  )
}
