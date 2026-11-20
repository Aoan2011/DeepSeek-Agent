import type { CSSProperties } from 'react'
import { useTranslate, type TranslationKey } from '../../i18n/index.js'
import { setAnimSpeed, toggleAnim, useSettings, type AnimSettings } from '../../services/settings.js'
import { ToggleCell } from './SettingCell.js'
import styles from './Settings.module.css'

/** 动画速度：缩放所有过渡与关键帧时长 */
export const AnimSpeedSetting = () => {
  const t = useTranslate()
  const speed = useSettings((state) => state.animSpeed)
  const fill = `${((speed - 0.5) / 1.5) * 100}%`
  return (
    <div className={styles.cell}>
      <label className={styles.slider}>
        <span className={styles.sliderHead}>
          <span>{t('settingsAnimSpeed')}</span>
          <b>{speed.toFixed(1)}×</b>
        </span>
        <input
          type="range"
          min={0.5}
          max={2}
          step={0.1}
          value={speed}
          aria-label={t('settingsAnimSpeed')}
          style={{ '--fill': fill } as CSSProperties}
          onChange={(event) => setAnimSpeed(Number(event.target.value))}
        />
      </label>
      <div className={styles.description}>{t('settingsAnimSpeedHint')}</div>
    </div>
  )
}

const TOGGLES: { key: keyof AnimSettings; label: TranslationKey }[] = [
  { key: 'aurora', label: 'settingsAnimAurora' },
  { key: 'shimmer', label: 'settingsAnimShimmer' },
  { key: 'transitions', label: 'settingsAnimTransitions' },
  { key: 'pulse', label: 'settingsAnimPulse' },
]

/** 逐项开关：低配机器上只留必要的反馈 */
export const AnimTogglesSetting = () => {
  const t = useTranslate()
  const anim = useSettings((state) => state.anim)
  return (
    <>
      {TOGGLES.map((item) => (
        <ToggleCell
          key={item.key}
          label={t(item.label)}
          checked={anim[item.key]}
          onChange={() => toggleAnim(item.key)}
        />
      ))}
    </>
  )
}
