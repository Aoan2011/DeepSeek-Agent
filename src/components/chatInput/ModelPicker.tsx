import clsx from 'clsx'
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
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
import { setModel, useSettings } from '../../services/settings.js'
import { showToast } from '../base/toastState.js'
import { useTranslate } from '../../i18n/index.js'
import styles from './ModelPicker.module.css'

const mergeModels = (remote: ModelOption[]): ModelOption[] => {
  const seen = new Set(remote.map((item) => item.id))
  return [...remote, ...BUILTIN_MODELS.filter((item) => !seen.has(item.id))]
}

/**
 * 模型选择：优先展示远端 /models 拉取的列表，失败时退回缓存与内置列表。
 * 选择结果写入设置，下一次请求直接使用该 id。
 */
export const ModelPicker = () => {
  const t = useTranslate()
  const model = useSettings((state) => state.model)
  const mockAgent = useSettings((state) => state.mockAgent)
  const [open, setOpen] = useState(false)
  const [models, setModels] = useState<ModelOption[]>(() => mergeModels(readCachedModels() ?? []))
  const [loading, setLoading] = useState(false)
  const [, setSource] = useState<'cache' | 'remote' | 'builtin'>(
    readCachedModels() ? 'cache' : 'builtin'
  )
  const fetched = useRef(false)

  const { anchorRef, floatingRef, position } = useAnchoredPosition<
    HTMLButtonElement,
    HTMLDivElement
  >(open, {
    side: 'top',
    align: 'start',
    offset: 8,
    maxHeight: 320,
    minSpace: 200,
    measureKey: models.length,
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
        setSource('remote')
      } catch {
        setSource(readCachedModels() ? 'cache' : 'builtin')
        if (!silent) {
          showToast(t('modelFetchFailed'))
        }
      } finally {
        setLoading(false)
      }
    },
    [t]
  )

  // 首次打开时自动拉取一次；演示模式没有真实 Key，直接使用内置列表
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
    // 缓存里的远端列表同样按远端展示，刷新失败才回落到内置文案
    const count = models.filter((item) => item.source === 'remote').length
    return count > 0 ? t('modelRemoteOk', { count }) : t('modelBuiltinFallback')
  }, [loading, models, t])

  return (
    <>
      <button
        ref={anchorRef}
        type="button"
        className={clsx(styles.trigger, open && styles.open)}
        aria-label={t('modelSelect')}
        aria-haspopup="listbox"
        aria-expanded={open}
        onClick={() => setOpen((value) => !value)}
      >
        <span className={styles.caption}>{t('modelSelect')}</span>
        <span className={styles.name}>{modelLabel(model)}</span>
        <span className={styles.arrow}>
          <IconChevronDownOutline14 />
        </span>
      </button>
      {open
        ? createPortal(
            <div
              ref={floatingRef}
              className={styles.panel}
              style={position ?? undefined}
              role="listbox"
              aria-label={t('modelSelect')}
            >
              <div className={styles.head}>
                <span className={styles.title}>{t('modelSelect')}</span>
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
              <div className={styles.list}>
                {models.map((item) => (
                  <button
                    key={item.id}
                    type="button"
                    role="option"
                    aria-selected={item.id === model}
                    className={clsx(styles.option, item.id === model && styles.active)}
                    onClick={() => {
                      setModel(item.id)
                      setOpen(false)
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
              <div className={styles.foot}>{sourceText}</div>
            </div>,
            document.body
          )
        : null}
    </>
  )
}
