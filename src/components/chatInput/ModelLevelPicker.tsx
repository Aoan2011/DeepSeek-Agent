import clsx from 'clsx'
import { useCallback, useEffect, useMemo, useRef, useState, type CSSProperties } from 'react'
import { createPortal } from 'react-dom'
import { useAnchoredPosition, useDismiss } from '../base/anchored.js'
import {
  IconCheckedOutline14,
  IconChevronDownOutline14,
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

const mergeModels = (remote: ModelOption[]): ModelOption[] => {
  const seen = new Set(remote.map((item) => item.id))
  return [...remote, ...BUILTIN_MODELS.filter((item) => !seen.has(item.id))]
}

/**
 * 模型与推理等级：参考视频里的合并入口。
 *
 * 收起时只显示「模型名 · 当前等级」；展开后上半部分是模型列表，
 * 下半部分是一条紫蓝渐变滑杆，0 档关闭思考，4 档最高。
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
  const fetched = useRef(false)
  // 面板是液态玻璃：和输入框同一套材质
  const glassRef = useGlassAttach({ tier: 'liquid', tint: 0.16 })

  const { anchorRef, floatingRef, position } = useAnchoredPosition<
    HTMLButtonElement,
    HTMLDivElement
  >(open, {
    side: 'top',
    align: 'start',
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
        aria-label={t('modelSelect')}
        aria-haspopup="dialog"
        aria-expanded={open}
        onClick={() => setOpen((value) => !value)}
      >
        <span className={styles.model}>{modelLabel(model)}</span>
        {effort > 0 ? (
          <>
            <span className={styles.separator}>·</span>
            <span className={styles.level}>{t(LEVEL_KEYS[effort])}</span>
          </>
        ) : null}
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
              data-max={maxed || undefined}
              role="dialog"
              aria-label={t('modelSelect')}
            >
              <div className={styles.section}>
                <div className={styles.row}>
                  <span className={styles.rowLabel}>{t('modelSelect')}</span>
                  <button
                    type="button"
                    className={styles.rowValue}
                    onClick={() => setModelOpen((value) => !value)}
                  >
                    {modelLabel(model)}
                    <span className={styles.rowArrow} data-open={modelOpen || undefined}>
                      <IconChevronDownOutline14 />
                    </span>
                  </button>
                </div>
                {modelOpen ? (
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
                ) : null}
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

              <div className={styles.divider} />

              <div className={styles.section}>
                <div className={styles.row}>
                  <span className={styles.rowLabel}>{t('modelLevelReasoning')}</span>
                  <span className={styles.levelValue}>{t(LEVEL_KEYS[effort])}</span>
                </div>
                <div className={styles.sliderWrap} style={style}>
                  <div className={styles.track}>
                    <span className={styles.fill} />
                    <span className={styles.glow} />
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
                    onChange={(event) => setReasoningEffort(Number(event.target.value))}
                  />
                </div>
                <div className={styles.hint} data-warn={maxed || undefined}>
                  {maxed ? t('thinkingMaxWarning') : t('thinkingPanelHint')}
                </div>
              </div>
            </div>,
            document.body
          )
        : null}
    </>
  )
}
