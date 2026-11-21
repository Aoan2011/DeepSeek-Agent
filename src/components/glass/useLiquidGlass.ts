import { useCallback, useEffect, useRef } from 'react'
import { useSettings } from '../../services/settings.js'
import { createLiquidGlass, type AttachOptions, type GlassHandle } from './liquidGlass.js'

/**
 * 把液态玻璃挂到一个元素上，用 ref 对象持有。
 *
 * 贴图按尺寸分桶共享、尺寸变化只重建一次，所以挂得越多越要看「层级」选：
 * 大面积承载文字的用 refract（真折射），小控件用 frost（只模糊）。
 * 设置里把玻璃关掉时，元素回到样式层写的纯色底，不再有 backdrop-filter。
 */
export const useLiquidGlass = <T extends HTMLElement>(options?: AttachOptions) => {
  const ref = useRef<T>(null)
  const mode = useSettings((state) => state.glass)
  // 参数只取一次快照：每次渲染都重建贴图会把主线程拖死
  const optionsRef = useRef(options)

  useEffect(() => {
    const el = ref.current
    if (!el) {
      return
    }
    if (mode === 'off') {
      delete el.dataset.glass
      return
    }
    const handle = createLiquidGlass(
      el,
      mode === 'frost' ? { ...optionsRef.current, tier: 'blur' } : optionsRef.current
    )
    return () => handle.destroy()
  }, [mode])

  return ref
}

type Attachment = { el: HTMLElement; handle: GlassHandle }

/**
 * 回调 ref 版本：给条件渲染的浮层用（菜单、Toast、抽屉在关闭时根本不存在，
 * 对象 ref 的 effect 不会重跑）。元素挂上/卸载时自动装配与清理。
 */
export const useGlassAttach = (options?: AttachOptions) => {
  const mode = useSettings((state) => state.glass)
  const current = useRef<Attachment | null>(null)
  const optionsRef = useRef(options)

  const detach = useCallback(() => {
    current.current?.handle.destroy()
    current.current = null
  }, [])

  // 设置变化时重建：off → 拆掉，frost/refract → 按新层级重挂
  useEffect(() => {
    const el = current.current?.el
    detach()
    if (!el || mode === 'off') {
      return
    }
    current.current = {
      el,
      handle: createLiquidGlass(
        el,
        mode === 'frost' ? { ...optionsRef.current, tier: 'blur' } : optionsRef.current
      ),
    }
  }, [mode, detach])

  useEffect(() => detach, [detach])

  return useCallback(
    (el: HTMLElement | null) => {
      if (current.current?.el === el) {
        return
      }
      detach()
      if (!el || mode === 'off') {
        return
      }
      current.current = {
        el,
        handle: createLiquidGlass(
          el,
          mode === 'frost' ? { ...optionsRef.current, tier: 'blur' } : optionsRef.current
        ),
      }
    },
    [mode, detach]
  )
}
