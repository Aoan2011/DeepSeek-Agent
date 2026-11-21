/**
 * 液态玻璃：边缘折射 + 背景模糊 + 一层极薄的高光。
 *
 * 原理：用 canvas 生成一张位移贴图（中心平坦、靠近边缘强烈弯曲），
 * 交给 SVG feDisplacementMap 作为 backdrop-filter 的滤镜，浏览器对真实背景做像素级位移，
 * 所以折射的永远是实时内容，不会糊、不会错位。
 *
 * 和第一版的三点区别（都是为了「全站铺开还不卡」）：
 * 1. 贴图按尺寸分桶共享：尺寸取整到 24px 的格子，同格子的元素共用一张贴图和一条滤镜链；
 *    输入框跟着文字长高时不再每敲一个字就重算一遍贴图（这是之前卡顿的主因）。
 * 2. 贴图分辨率有上限（长边 192px），位移量按元素实际尺寸换算，放大后视觉一致。
 * 3. 有预算：同屏折射元素超过 10 个、或总面积超过 1.4 屏时，新元素降级为普通毛玻璃。
 *    渲染层不会因为开个弹窗把整页拖慢。
 *
 * backdrop-filter: url(#id) 目前只有 Chromium 支持，其他浏览器直接走毛玻璃。
 */

export type GlassTier = 'refract' | 'frost'

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
  frostBlur: 16,
}

/** 贴图按这个尺寸取整分桶；折射是低频场，24px 的误差看不出来 */
const STEP = 24
/** 贴图长边上限 */
const MAX_RASTER = 192
/** 同屏最多几个元素做真折射 */
const MAX_REFRACT = 10
/** 折射元素总面积上限（相对视口面积） */
const MAX_AREA_RATIO = 1.4
/** 缓存多少张不同尺寸的贴图 */
const MAX_MAPS = 16
/** 低于该尺寸不生成（隐藏或尚未布局） */
const MIN_SIZE = 8

const SVG_NS = 'http://www.w3.org/2000/svg'
const XLINK_NS = 'http://www.w3.org/1999/xlink'

type MapEntry = { href: string; scale: number; regionW: number; regionH: number }

const maps = new Map<string, MapEntry>()
const filters = new Map<string, SVGFilterElement>()
let root: SVGSVGElement | null = null
let refractCount = 0
let refractArea = 0

const isFirefox = () =>
  typeof navigator !== 'undefined' && /firefox/i.test(navigator.userAgent)

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
  return (
    Math.min(Math.max(qx, qy), 0) + Math.hypot(Math.max(qx, 0), Math.max(qy, 0)) - radius
  )
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

const paramsKey = (p: GlassParams) =>
  `${p.ref}:${p.edge}:${p.rad}`

/** 生成一张分桶贴图；同一个 key 只算一次 */
const buildMap = (regionW: number, regionH: number, params: GlassParams): MapEntry => {
  const key = `${paramsKey(params)}@${regionW}x${regionH}`
  const cached = maps.get(key)
  if (cached) {
    return cached
  }

  // 长边封顶，短边按比例；两个方向分别换算回区域像素，位移幅度与分辨率无关
  const ratio = Math.min(1, MAX_RASTER / Math.max(regionW, regionH))
  const rw = Math.max(2, Math.round(regionW * ratio))
  const rh = Math.max(2, Math.round(regionH * ratio))

  const canvas = document.createElement('canvas')
  canvas.width = rw
  canvas.height = rh
  const context = canvas.getContext('2d', { willReadFrequently: false })
  if (!context) {
    return { href: '', scale: 0, regionW, regionH }
  }

  const data = new Uint8ClampedArray(rw * rh * 4)
  const sx = regionW / rw
  const sy = regionH / rh
  const rawX = new Float32Array(rw * rh)
  const rawY = new Float32Array(rw * rh)
  let maxScale = 0
  let index = 0

  for (let y = 0; y < rh; y++) {
    const py = (y + 0.5) * sy
    const iy = py / regionH - 0.5
    for (let x = 0; x < rw; x++) {
      const px = (x + 0.5) * sx
      const ix = px / regionW - 0.5
      const distance = roundedRectSDF(ix, iy, 0.3, 0.2, params.rad)
      const displacement = smoothStep(0.8, 0, distance - 0.15 / params.edge)
      const scaled = smoothStep(0, 1, displacement)
      const dx = ix * scaled * regionW
      const dy = iy * scaled * regionH
      rawX[index] = dx
      rawY[index] = dy
      maxScale = Math.max(maxScale, Math.abs(dx), Math.abs(dy))
      index += 1
    }
  }

  // 原版手感：幅度折半，位移太强会有塑料片感
  maxScale *= 0.5
  const norm = maxScale || 1
  for (let i = 0, p = 0; i < data.length; i += 4, p += 1) {
    data[i] = (rawX[p] / norm + 0.5) * 255
    data[i + 1] = (rawY[p] / norm + 0.5) * 255
    data[i + 2] = 0
    data[i + 3] = 255
  }
  context.putImageData(new ImageData(data, rw, rh), 0, 0)

  const entry: MapEntry = {
    href: canvas.toDataURL('image/png'),
    scale: maxScale * params.ref,
    regionW,
    regionH,
  }
  maps.set(key, entry)
  // 简单的插入序淘汰：最早的贴图先出局
  if (maps.size > MAX_MAPS) {
    const oldest = maps.keys().next().value
    if (oldest !== undefined && oldest !== key) {
      maps.delete(oldest)
    }
  }
  return entry
}

const ensureFilter = (regionW: number, regionH: number, params: GlassParams): string | null => {
  const map = buildMap(regionW, regionH, params)
  if (!map.href) {
    return null
  }
  const id = `lg-${paramsKey(params).replace(/[.:]/g, '-')}-${regionW}x${regionH}`
  if (!filters.has(id)) {
    const svg = ensureRoot()
    const defs = svg.querySelector('defs')
    if (!defs) {
      return null
    }
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
    feImage.setAttributeNS(XLINK_NS, 'href', map.href)

    const feDisplacement = document.createElementNS(SVG_NS, 'feDisplacementMap')
    feDisplacement.setAttribute('in', 'SourceGraphic')
    feDisplacement.setAttribute('in2', 'liquid-glass-map')
    feDisplacement.setAttribute('xChannelSelector', 'R')
    feDisplacement.setAttribute('yChannelSelector', 'G')
    feDisplacement.setAttribute('scale', String(map.scale))

    filter.append(feImage, feDisplacement)
    defs.append(filter)
    filters.set(id, filter)
  }
  return id
}

const bucket = (value: number) => Math.max(STEP, Math.ceil(value / STEP) * STEP)

export type GlassHandle = {
  /** 重新测量（尺寸变化后调用） */
  refresh: () => void
  destroy: () => void
}

export type AttachOptions = Partial<GlassParams> & {
  /** 强制层级；不传则按预算自动决定 */
  tier?: GlassTier
  /** 尺寸变化多少像素后才重建，默认 8 */
  tolerance?: number
}

/**
 * 给元素装上液态玻璃。元素自己的底色由样式层用 --lg-tint 书写，这里只管滤镜。
 */
export const createLiquidGlass = (el: HTMLElement, options: AttachOptions = {}): GlassHandle => {
  const params: GlassParams = { ...GLASS_PARAMS, ...options }
  const tolerance = options.tolerance ?? 8
  let regionW = 0
  let regionH = 0
  let tier: GlassTier = options.tier ?? 'refract'
  let frame = 0
  let destroyed = false

  const applyFrost = () => {
    el.dataset.glass = 'frost'
    el.style.setProperty('--lg-tint', String(params.tint))
    const value = `blur(${params.frostBlur}px) saturate(1.25)`
    el.style.setProperty('backdrop-filter', value)
    el.style.setProperty('-webkit-backdrop-filter', value)
  }

  const apply = () => {
    if (destroyed) {
      return
    }
    if (tier === 'frost' || !canRefract() || isLowPower()) {
      applyFrost()
      return
    }
    if (regionW < MIN_SIZE || regionH < MIN_SIZE) {
      return
    }
    const id = ensureFilter(regionW, regionH, params)
    if (!id) {
      applyFrost()
      return
    }
    el.dataset.glass = 'refract'
    el.style.setProperty('--lg-tint', String(params.tint))
    const value = `url(#${id}) blur(${params.blur}px) contrast(1.06) saturate(1.08)`
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
    const nextW = bucket(w)
    const nextH = bucket(h)
    if (Math.abs(nextW - regionW) < tolerance && Math.abs(nextH - regionH) < tolerance) {
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
    if (tier === 'frost') {
      return false
    }
    const area = el.offsetWidth * el.offsetHeight
    const viewport = window.innerWidth * window.innerHeight
    return (
      refractCount + 1 <= MAX_REFRACT && refractArea + area <= viewport * MAX_AREA_RATIO
    )
  }

  if (options.tier === undefined && !affordRefract()) {
    tier = 'frost'
  }

  if (tier === 'refract') {
    const area = el.offsetWidth * el.offsetHeight
    refractCount += 1
    refractArea += area
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
