import clsx from 'clsx'
import { useCallback, useEffect, useMemo, useRef, useState, type CSSProperties } from 'react'
import { createPortal } from 'react-dom'
import { useAnchoredPosition, useDismiss } from '../base/anchored.js'
import {
  IconCheckedOutline14,
  IconChevronDownOutline14,
  IconChevronRightOutline14,
  IconRefreshOutline16,
} from '../base/icons.js'
import {
  BUILTIN_MODELS,
  fetchRemoteModels,
  modelLabel,
  readCachedModels,
  type ModelOption,
} from '../../services/api/models.js'
import {
  EFFORT_LEVELS,
  setModel,
  setReasoningEffort,
  useSettings,
} from '../../services/settings.js'
import { showToast } from '../base/toastState.js'
import { useTranslate } from '../../i18n/index.js'
import { useGlassAttach } from '../glass/useLiquidGlass.js'
import styles from './ModelLevelPicker.module.css'

const LEVEL_KEYS = [
  'thinkingLevel0',
  'thinkingLevel1',
  'thinkingLevel2',
  'thinkingLevel3',
  'thinkingLevel4',
] as const

/** 滑杆上每个档位的位置（0 档在最左，4 档在最右） */
const STEPS = Array.from({ length: EFFORT_LEVELS + 1 }, (_, index) => index)

/** 滑块半径：轨道左右各留出这一段，圆点才能完整落在轨道内 */
const THUMB_RADIUS = 13

const mergeModels = (remote: ModelOption[]): ModelOption[] => {
  const seen = new Set(remote.map((item) => item.id))
  return [...remote, ...BUILTIN_MODELS.filter((item) => !seen.has(item.id))]
}

/**
 * 模型与推理等级：参考视频里的合并入口。
 *
 * 收起时是输入框底部的一行「模型名 + 当前等级」；展开后上方是模型行，
 * 下方是一张内嵌卡片：标题行 + 一条厚胶囊滑杆，档位越高颜色越偏紫。
 */
export const ModelLevelPicker = () => {
  const t = useTranslate()
  const model = useSettings((state) => state.model)
  const effort = useSettings((state) => state.reasoningEffort)
  const mockAgent = useSettings((state) => state.mockAgent)
  const [open, setOpen] = useState(false)
  const [modelOpen, setModelOpen] = useState(false)
  const [models, setModels] = useState<ModelOption[]>(() => mergeModels(readCachedModels() ?? []))
  const [loading, setLoading] = useState(false)
  // 满档提示只出现一会儿，然后淡回正常标题（和视频一致）
  const [hint, setHint] = useState(false)
  const fetched = useRef(false)
  // 面板只要一层磨砂：跟着输入框透出背景，但不做折射贴图
  const glassRef = useGlassAttach({ tier: 'frost', tint: 0.12 })

  const { anchorRef, floatingRef, position } = useAnchoredPosition<
    HTMLButtonElement,
    HTMLDivElement
  >(open, {
    side: 'top',
    align: 'end',
    offset: 10,
    maxHeight: 420,
    minSpace: 220,
    measureKey: `${models.length}-${modelOpen}`,
  })
  useDismiss(open, [anchorRef, floatingRef], () => setOpen(false), { captureEscape: true })

  const refresh = useCallback(
    async (silent = false) => {
      const apiKey = useSettings.getState().apiKey ?? ''
      if (!apiKey) {
        if (!silent) {
          showToast(t('modelFetchFailed'))
        }
        return
      }
      setLoading(true)
      try {
        const remote = await fetchRemoteModels(apiKey)
        setModels(mergeModels(remote))
      } catch {
        if (!silent) {
          showToast(t('modelFetchFailed'))
        }
      } finally {
        setLoading(false)
      }
    },
    [t]
  )

  useEffect(() => {
    if (!open || fetched.current || mockAgent) {
      return
    }
    fetched.current = true
    if (!readCachedModels()) {
      void refresh(true)
    }
  }, [open, mockAgent, refresh])

  // 收起后回到主页面，下次打开仍是「模型 + 推理等级」
  useEffect(() => {
    if (!open) {
      setModelOpen(false)
    }
  }, [open])

  useEffect(() => {
    if (effort < EFFORT_LEVELS) {
      setHint(false)
      return
    }
    setHint(true)
    const timer = window.setTimeout(() => setHint(false), 1600)
    return () => window.clearTimeout(timer)
  }, [effort])

  const sourceText = useMemo(() => {
    if (loading) {
      return t('modelRefreshing')
    }
    const count = models.filter((item) => item.source === 'remote').length
    return count > 0 ? t('modelRemoteOk', { count }) : t('modelBuiltinFallback')
  }, [loading, models, t])

  const maxed = effort >= EFFORT_LEVELS
  const style = { '--p': effort / EFFORT_LEVELS } as CSSProperties

  // 回调 ref 必须稳定，否则滑杆每次 onChange 都会重挂液态玻璃贴图
  const setFloating = useCallback(
    (node: HTMLDivElement | null) => {
      glassRef(node)
      floatingRef.current = node
    },
    [glassRef, floatingRef]
  )

  return (
    <>
      <button
        ref={anchorRef}
        type="button"
        className={clsx(styles.trigger, open && styles.open)}
        data-level={effort || undefined}
        aria-label={t('modelSelect')}
        aria-haspopup="dialog"
        aria-expanded={open}
        onClick={() => setOpen((value) => !value)}
      >
        <span className={styles.model}>{modelLabel(model)}</span>
        {effort > 0 ? <span className={styles.level}>{t(LEVEL_KEYS[effort])}</span> : null}
        <span className={styles.arrow}>
          <IconChevronDownOutline14 />
        </span>
      </button>
      {open
        ? createPortal(
            <div
              ref={setFloating}
              className={styles.panel}
              style={position ?? undefined}
              data-level={effort || undefined}
              role="dialog"
              aria-label={t('modelSelect')}
            >
              {modelOpen ? (
                <div className={styles.sub}>
                  <div className={styles.subHead}>
                    <button
                      type="button"
                      className={styles.back}
                      aria-label={t('modelBack')}
                      onClick={() => setModelOpen(false)}
                    >
                      <IconChevronRightOutline14 />
                    </button>
                    <span className={styles.rowLabel}>{t('modelSelect')}</span>
                  </div>
                  <div className={styles.models} role="listbox" aria-label={t('modelSelect')}>
                    {models.map((item) => (
                      <button
                        key={item.id}
                        type="button"
                        role="option"
                        aria-selected={item.id === model}
                        className={clsx(styles.option, item.id === model && styles.optionActive)}
                        onClick={() => {
                          setModel(item.id)
                          setModelOpen(false)
                        }}
                      >
                        <span className={styles.optionMain}>
                          <span className={styles.optionName}>{item.label}</span>
                          <span className={styles.optionId}>{item.id}</span>
                        </span>
                        {item.id === model ? <IconCheckedOutline14 /> : null}
                      </button>
                    ))}
                  </div>
                  <div className={styles.modelFoot}>
                    <span className={styles.source}>{sourceText}</span>
                    <button
                      type="button"
                      className={clsx(styles.refresh, loading && styles.spinning)}
                      disabled={loading}
                      onClick={() => void refresh()}
                    >
                      <IconRefreshOutline16 />
                      {loading ? t('modelRefreshing') : t('modelRemoteFetch')}
                    </button>
                  </div>
                </div>
              ) : (
                <>
                  <div className={styles.modelRow}>
                    <span className={styles.rowLabel}>{t('modelSelect')}</span>
                    <button
                      type="button"
                      className={styles.modelValue}
                      aria-haspopup="listbox"
                      onClick={() => setModelOpen(true)}
                    >
                      <span className={styles.modelName}>{modelLabel(model)}</span>
                      <span className={styles.chevron}>
                        <IconChevronRightOutline14 />
                      </span>
                    </button>
                  </div>

                  <div
                    className={styles.card}
                    data-glow={effort > 0 || undefined}
                    data-max={maxed || undefined}
                  >
                    <div className={styles.cardHead} data-hint={hint || undefined}>
                      <div className={styles.headNormal}>
                        <span className={styles.rowLabel}>{t('modelLevelReasoning')}</span>
                        <span className={styles.levelRight}>
                          <span className={styles.levelValue}>{t(LEVEL_KEYS[effort])}</span>
                          <span className={styles.chevron} aria-hidden>
                            <IconChevronRightOutline14 />
                          </span>
                        </span>
                      </div>
                      <span className={styles.headHint} aria-live="polite">
                        {t('thinkingMaxWarning')}
                      </span>
                    </div>

                    <div className={styles.slider} style={style}>
                      <div className={styles.track}>
                        <span className={styles.fill} />
                        <span className={styles.stars} aria-hidden>
                          <span className={styles.starTile} />
                          <span className={styles.starTileAlt} />
                        </span>
                        {STEPS.map((step) =>
                          step > effort ? (
                            <span
                              key={step}
                              className={styles.dot}
                              style={{
                                left: `calc(${THUMB_RADIUS}px + (100% - ${
                                  THUMB_RADIUS * 2
                                }px) * ${step / EFFORT_LEVELS})`,
                              }}
                            />
                          ) : null
                        )}
                        <span className={styles.thumb} />
                      </div>
                      <input
                        className={styles.range}
                        type="range"
                        min={0}
                        max={EFFORT_LEVELS}
                        step={1}
                        value={effort}
                        aria-label={t('modelLevelReasoning')}
                        aria-valuetext={t(LEVEL_KEYS[effort])}
                        onChange={(event) => setReasoningEffort(Number(event.target.value))}
                      />
                    </div>
                  </div>
                </>
              )}
            </div>,
            document.body
          )
        : null}
    </>
  )
}
