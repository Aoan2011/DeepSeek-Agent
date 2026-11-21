import { useCallback, useEffect, useRef } from 'react'
import { useSettings } from '../../services/settings.js'
import { createLiquidGlass, type GlassHandle, type GlassParams } from './liquidGlass.js'

/**
 * 液态玻璃的挂载层。
 *
 * 折射本身完全沿用 createLiquidGlass（观感与参考实现一致，不做任何贴图缩放或分桶）。
 * 这里只多做两件事：
 * 1. 跟随设置里的玻璃强度——毛玻璃 / 关闭时不去建贴图，直接走退化路径；
 * 2. 给条件渲染的浮层（菜单、Toast、抽屉）提供回调 ref 版本。
 */

/** 非折射档位：与 createLiquidGlass 内部的退化路径保持完全一致的参数 */
export const applyFrost = (el: HTMLElement, tint = 0.11) => {
  el.dataset.glass = 'blur'
  el.style.setProperty('--lg-tint', String(tint))
  el.style.setProperty('backdrop-filter', 'blur(18px) saturate(1.4)')
  el.style.setProperty('-webkit-backdrop-filter', 'blur(18px) saturate(1.4)')
}

const clearGlass = (el: HTMLElement) => {
  el.removeAttribute('data-glass')
  el.style.removeProperty('backdrop-filter')
  el.style.removeProperty('-webkit-backdrop-filter')
  el.style.removeProperty('--lg-tint')
}

export type GlassOptions = Partial<GlassParams> & {
  /** 强制降级为毛玻璃：小控件用它，省掉贴图与滤镜链 */
  tier?: 'refract' | 'blur'
}

type Mode = 'refract' | 'frost' | 'off'

const attach = (el: HTMLElement, mode: Mode, options: GlassOptions = {}): GlassHandle => {
  if (mode === 'off') {
    clearGlass(el)
    return { refresh: () => undefined, destroy: () => clearGlass(el) }
  }
  if (mode === 'frost' || options.tier === 'blur') {
    applyFrost(el, options.tint)
    return { refresh: () => undefined, destroy: () => clearGlass(el) }
  }
  // 观感以 createLiquidGlass 为准：参数只透传，不做任何缩放
  return createLiquidGlass(el, options)
}

/**
 * 把液态玻璃挂到一个元素上：挂载时生成折射贴图，尺寸变化由 ResizeObserver 重建。
 * 只改变背景的渲染方式，不影响元素本身的布局与事件。
 */
export const useLiquidGlass = <T extends HTMLElement>(options?: GlassOptions) => {
  const ref = useRef<T>(null)
  const mode = useSettings((state) => state.glass)
  // 参数只取一次快照，避免每次渲染重建贴图
  const optionsRef = useRef(options)

  useEffect(() => {
    const el = ref.current
    if (!el) {
      return
    }
    const handle = attach(el, mode, optionsRef.current)
    return () => handle.destroy()
  }, [mode])

  return ref
}

type Attachment = { el: HTMLElement; handle: GlassHandle }

/**
 * 回调 ref 版本：给条件渲染的浮层用（菜单、Toast 在关闭时根本不存在，
 * 对象 ref 的 effect 不会重跑）。元素挂上/卸载时自动装配与清理。
 */
export const useGlassAttach = (options?: GlassOptions) => {
  const mode = useSettings((state) => state.glass)
  const current = useRef<Attachment | null>(null)
  const optionsRef = useRef(options)

  const detach = useCallback(() => {
    current.current?.handle.destroy()
    current.current = null
  }, [])

  // 设置变化时重建：off → 拆掉，frost/refract → 按新档位重挂
  useEffect(() => {
    const el = current.current?.el
    detach()
    if (!el) {
      return
    }
    current.current = { el, handle: attach(el, mode, optionsRef.current) }
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
      current.current = { el, handle: attach(el, mode, optionsRef.current) }
    },
    [mode, detach]
  )
}
