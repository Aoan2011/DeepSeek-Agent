/**
 * 液态玻璃：边缘折射 + 背景模糊 + 一层极薄的高光。
 *
 * 原理：用 canvas 生成一张位移贴图（中心平坦、靠近边缘强烈弯曲），
 * 交给 SVG feDisplacementMap 作为 backdrop-filter 的滤镜，浏览器对真实背景做像素级位移，
 * 所以折射的永远是实时内容，不会糊、不会错位。
 *
 * 观感与第一版完全一致（同样的 SDF、同样的位移幅度、同样的滤镜链），
 * 改的只是开销：
 * 1. 贴图按栅格尺寸分桶共享：位移场在归一化坐标里计算，同一张图可以给任意尺寸的元素用，
 *    只有栅格分辨率变了才重算 canvas 与 dataURL（输入框跟着文字长高时不再每敲一个字重算）。
 * 2. 栅格长边封顶 192px，位移幅度按元素真实尺寸换算，放大后与逐像素计算等价。
 * 3. 有预算：同屏折射元素超过 10 个、或总面积超过 1.4 屏时，新元素降级为普通毛玻璃。
 *
 * backdrop-filter: url(#id) 目前只有 Chromium 支持，其他浏览器退化为普通毛玻璃。
 */

export type GlassTier = 'refract' | 'blur'

export type GlassParams = {
  /** 折射率：位移幅度倍率，越大边缘弯得越狠 */
  ref: number
  /** 折射圈厚度：SDF 阈值的缩放，越大边缘折射带越宽 */
  edge: number
  /** 形状圆角：roundedRectSDF 的内缩半径 */
  rad: number
  /** 玻璃白度，写入 CSS 变量 --lg-tint */
  tint: number
  /** 背景模糊半径 */
  blur: number
  /** 降级为毛玻璃时的模糊半径 */
  frostBlur: number
}

export const GLASS_PARAMS: GlassParams = {
  ref: 0.45,
  edge: 0.6,
  rad: 0.6,
  tint: 0.11,
  blur: 1,
  frostBlur: 18,
}

/** 贴图长边上限 */
const MAX_RASTER = 192
/** 同屏最多几个元素做真折射 */
const MAX_REFRACT = 10
/** 折射元素总面积上限（相对视口面积） */
const MAX_AREA_RATIO = 1.4
/** 缓存多少张不同栅格的贴图 */
const MAX_MAPS = 16
/** 缓存多少条滤镜链（每个元素的尺寸各一条，但共用贴图） */
const MAX_FILTERS = 64
/** 低于该尺寸不生成（隐藏或尚未布局） */
const MIN_SIZE = 8

const SVG_NS = 'http://www.w3.org/2000/svg'
const XLINK_NS = 'http://www.w3.org/1999/xlink'

type MapEntry = { href: string; ampX: number; ampY: number }

const maps = new Map<string, MapEntry>()
const filters = new Map<string, SVGFilterElement>()
let root: SVGSVGElement | null = null
let refractCount = 0
let refractArea = 0

const isFirefox = () => typeof navigator !== 'undefined' && /firefox/i.test(navigator.userAgent)

/** 能不能用 SVG 滤镜做折射；不能时由样式层退回毛玻璃 */
export const canRefract = (): boolean => {
  if (typeof document === 'undefined' || typeof CSS === 'undefined' || isFirefox()) {
    return false
  }
  return (
    CSS.supports('backdrop-filter', 'url(#liquid-glass-probe)') ||
    CSS.supports('-webkit-backdrop-filter', 'url(#liquid-glass-probe)')
  )
}

/** 弱机不折腾折射：核数少或内存小，只做毛玻璃 */
const isLowPower = (): boolean => {
  if (typeof navigator === 'undefined') {
    return false
  }
  const cores = navigator.hardwareConcurrency ?? 8
  const memory = (navigator as Navigator & { deviceMemory?: number }).deviceMemory ?? 8
  return cores <= 4 || memory <= 4
}

const smoothStep = (a: number, b: number, t: number) => {
  const x = Math.max(0, Math.min(1, (t - a) / (b - a)))
  return x * x * (3 - 2 * x)
}

const roundedRectSDF = (x: number, y: number, width: number, height: number, radius: number) => {
  const qx = Math.abs(x) - width + radius
  const qy = Math.abs(y) - height + radius
  return Math.min(Math.max(qx, qy), 0) + Math.hypot(Math.max(qx, 0), Math.max(qy, 0)) - radius
}

const ensureRoot = (): SVGSVGElement => {
  if (root && root.isConnected) {
    return root
  }
  const svg = document.createElementNS(SVG_NS, 'svg')
  svg.setAttribute('aria-hidden', 'true')
  svg.setAttribute('width', '0')
  svg.setAttribute('height', '0')
  svg.style.cssText = 'position:fixed;top:0;left:0;width:0;height:0;pointer-events:none'
  const defs = document.createElementNS(SVG_NS, 'defs')
  svg.append(defs)
  document.body.append(svg)
  root = svg
  return svg
}

const paramsKey = (p: GlassParams) => `${p.ref}:${p.edge}:${p.rad}`

/**
 * 生成一张分桶贴图。位移场只与归一化坐标有关，
 * 所以同一张图可以喂给任意尺寸的元素，幅度由调用方按尺寸换算。
 */
const buildMap = (regionW: number, regionH: number, params: GlassParams): MapEntry => {
  // 栅格按 8px 取整，尺寸微调不会重算
  const ratio = Math.min(1, MAX_RASTER / Math.max(regionW, regionH))
  const rw = Math.max(2, Math.ceil((regionW * ratio) / 8) * 8)
  const rh = Math.max(2, Math.ceil((regionH * ratio) / 8) * 8)
  const key = `${paramsKey(params)}@${rw}x${rh}`
  const cached = maps.get(key)
  if (cached) {
    return cached
  }

  const canvas = document.createElement('canvas')
  canvas.width = rw
  canvas.height = rh
  const context = canvas.getContext('2d')
  if (!context) {
    return { href: '', ampX: 0, ampY: 0 }
  }

  const data = new Uint8ClampedArray(rw * rh * 4)
  const rawX = new Float32Array(rw * rh)
  const rawY = new Float32Array(rw * rh)
  let ampX = 0
  let ampY = 0
  let index = 0

  for (let y = 0; y < rh; y++) {
    const iy = (y + 0.5) / rh - 0.5
    for (let x = 0; x < rw; x++) {
      const ix = (x + 0.5) / rw - 0.5
      const distance = roundedRectSDF(ix, iy, 0.3, 0.2, params.rad)
      const displacement = smoothStep(0.8, 0, distance - 0.15 / params.edge)
      const scaled = smoothStep(0, 1, displacement)
      // 归一化位移：乘上元素真实尺寸即为像素位移
      const dx = ix * scaled
      const dy = iy * scaled
      rawX[index] = dx
      rawY[index] = dy
      ampX = Math.max(ampX, Math.abs(dx))
      ampY = Math.max(ampY, Math.abs(dy))
      index += 1
    }
  }

  // 编码时用统一的归一化幅度，解码端按元素尺寸还原
  const norm = Math.max(ampX, ampY) || 1
  for (let i = 0, p = 0; i < data.length; i += 4, p += 1) {
    data[i] = (rawX[p] / norm + 0.5) * 255
    data[i + 1] = (rawY[p] / norm + 0.5) * 255
    data[i + 2] = 0
    data[i + 3] = 255
  }
  context.putImageData(new ImageData(data, rw, rh), 0, 0)

  const entry: MapEntry = { href: canvas.toDataURL('image/png'), ampX, ampY }
  maps.set(key, entry)
  if (maps.size > MAX_MAPS) {
    const oldest = maps.keys().next().value
    if (oldest !== undefined && oldest !== key) {
      maps.delete(oldest)
    }
  }
  return entry
}

/** 元素尺寸下的实际位移幅度：与逐像素算完取最大值再折半等价 */
const scaleFor = (entry: MapEntry, regionW: number, regionH: number, params: GlassParams) => {
  const maxScale = Math.max(entry.ampX * regionW, entry.ampY * regionH) * 0.5
  return maxScale * params.ref
}

const ensureFilter = (
  regionW: number,
  regionH: number,
  entry: MapEntry,
  params: GlassParams
): string | null => {
  const key = `${paramsKey(params)}@${regionW}x${regionH}`
  const cached = filters.get(key)
  if (cached) {
    return cached.id
  }
  if (!entry.href) {
    return null
  }
  const svg = ensureRoot()
  const defs = svg.querySelector('defs')
  if (!defs) {
    return null
  }
  const id = `lg-${key.replace(/[.:]/g, '-')}`

  const filter = document.createElementNS(SVG_NS, 'filter')
  filter.setAttribute('id', id)
  filter.setAttribute('filterUnits', 'userSpaceOnUse')
  filter.setAttribute('colorInterpolationFilters', 'sRGB')
  filter.setAttribute('x', '0')
  filter.setAttribute('y', '0')
  filter.setAttribute('width', String(regionW))
  filter.setAttribute('height', String(regionH))

  const feImage = document.createElementNS(SVG_NS, 'feImage')
  feImage.setAttribute('result', 'liquid-glass-map')
  feImage.setAttribute('preserveAspectRatio', 'none')
  feImage.setAttribute('width', String(regionW))
  feImage.setAttribute('height', String(regionH))
  feImage.setAttributeNS(XLINK_NS, 'href', entry.href)

  const feDisplacement = document.createElementNS(SVG_NS, 'feDisplacementMap')
  feDisplacement.setAttribute('in', 'SourceGraphic')
  feDisplacement.setAttribute('in2', 'liquid-glass-map')
  feDisplacement.setAttribute('xChannelSelector', 'R')
  feDisplacement.setAttribute('yChannelSelector', 'G')
  feDisplacement.setAttribute('scale', String(scaleFor(entry, regionW, regionH, params)))

  filter.append(feImage, feDisplacement)
  defs.append(filter)
  filters.set(key, filter)
  if (filters.size > MAX_FILTERS) {
    const oldestKey = filters.keys().next().value
    if (oldestKey !== undefined && oldestKey !== key) {
      filters.get(oldestKey)?.remove()
      filters.delete(oldestKey)
    }
  }
  return id
}

/** 尺寸取整：小元素 2px、大元素 6px，肉眼不可见，但能挡住拖拽缩放时的抖动重建 */
const quantize = (value: number) => {
  const step = value < 120 ? 2 : 6
  return Math.max(step, Math.ceil(value / step) * step)
}

export type GlassHandle = {
  /** 重新测量（尺寸变化后调用） */
  refresh: () => void
  destroy: () => void
}

export type AttachOptions = Partial<GlassParams> & {
  /** 强制层级；不传则按预算自动决定 */
  tier?: GlassTier
}

/**
 * 给元素装上液态玻璃。元素自己的底色由样式层用 --lg-tint 书写，这里只管滤镜。
 */
export const createLiquidGlass = (el: HTMLElement, options: AttachOptions = {}): GlassHandle => {
  const params: GlassParams = { ...GLASS_PARAMS, ...options }
  let regionW = 0
  let regionH = 0
  let tier: GlassTier = options.tier ?? 'refract'
  let frame = 0
  let destroyed = false

  const applyBlur = () => {
    el.dataset.glass = 'blur'
    el.style.setProperty('--lg-tint', String(params.tint))
    const value = `blur(${params.frostBlur}px) saturate(1.4)`
    el.style.setProperty('backdrop-filter', value)
    el.style.setProperty('-webkit-backdrop-filter', value)
  }

  const apply = () => {
    if (destroyed) {
      return
    }
    if (tier === 'blur' || !canRefract() || isLowPower()) {
      applyBlur()
      return
    }
    if (regionW < MIN_SIZE || regionH < MIN_SIZE) {
      return
    }
    const entry = buildMap(regionW, regionH, params)
    const id = ensureFilter(regionW, regionH, entry, params)
    if (!id) {
      applyBlur()
      return
    }
    el.dataset.glass = 'refract'
    el.style.setProperty('--lg-tint', String(params.tint))
    // 滤镜链与原版一致：折射 → 轻微模糊 → 一点对比与饱和度
    const value = `url(#${id}) blur(${params.blur}px) contrast(1.2) brightness(1.05) saturate(1.1)`
    el.style.setProperty('backdrop-filter', value)
    el.style.setProperty('-webkit-backdrop-filter', value)
  }

  const measure = () => {
    if (destroyed) {
      return
    }
    const w = el.offsetWidth
    const h = el.offsetHeight
    if (w < MIN_SIZE || h < MIN_SIZE) {
      return
    }
    const nextW = quantize(w)
    const nextH = quantize(h)
    if (nextW === regionW && nextH === regionH) {
      return
    }
    regionW = nextW
    regionH = nextH
    apply()
  }

  // 预算：同屏折射面积与个数都设上限，超了就这一个元素降级，不影响别人
  const affordRefract = () => {
    if (typeof window === 'undefined') {
      return false
    }
    const area = el.offsetWidth * el.offsetHeight
    const viewport = window.innerWidth * window.innerHeight
    return refractCount + 1 <= MAX_REFRACT && refractArea + area <= viewport * MAX_AREA_RATIO
  }

  if (options.tier === undefined && !affordRefract()) {
    tier = 'blur'
  }

  if (tier === 'refract') {
    refractCount += 1
    refractArea += el.offsetWidth * el.offsetHeight
  }

  measure()

  const observer = new ResizeObserver(() => {
    if (frame) {
      return
    }
    frame = requestAnimationFrame(() => {
      frame = 0
      measure()
    })
  })
  observer.observe(el)

  return {
    refresh: () => {
      measure()
    },
    destroy: () => {
      destroyed = true
      observer.disconnect()
      if (frame) {
        cancelAnimationFrame(frame)
      }
      if (tier === 'refract') {
        refractCount = Math.max(0, refractCount - 1)
        refractArea = Math.max(0, refractArea - el.offsetWidth * el.offsetHeight)
      }
      el.removeAttribute('data-glass')
      el.style.removeProperty('backdrop-filter')
      el.style.removeProperty('-webkit-backdrop-filter')
      el.style.removeProperty('--lg-tint')
    },
  }
}
