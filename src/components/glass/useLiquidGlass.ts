import { useEffect, useRef } from 'react'
import { createLiquidGlass, type GlassParams } from './liquidGlass.js'

/**
 * 把液态玻璃挂到一个元素上：挂载时生成折射贴图，尺寸变化由 ResizeObserver 重建。
 * 只改变背景的渲染方式，不影响元素本身的布局与事件。
 *
 * params 用来按场景微调：承载文字的输入框需要更毛一点，纯装饰的侧栏可以更透。
 */
export const useLiquidGlass = <T extends HTMLElement>(params?: Partial<GlassParams>) => {
  const ref = useRef<T>(null)
  // 参数只取一次快照，避免每次渲染重建贴图
  const paramsRef = useRef(params)

  useEffect(() => {
    const el = ref.current
    if (!el) {
      return
    }
    const handle = createLiquidGlass(el, paramsRef.current)
    return () => handle.destroy()
  }, [])

  return ref
}
