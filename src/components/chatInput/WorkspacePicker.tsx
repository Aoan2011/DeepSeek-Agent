import { useEffect } from 'react'
import { useTranslate } from '../../i18n/index.js'
import {
  useWorkspace,
  setActiveWorkspace,
  openLocalWorkspace,
} from '../../services/workspace/store.js'
import { setDesktopPlane, setWebPlane, useWorkspacePlane } from '../../services/workspace/plane.js'
import { switchDesktopWorkspace, useDesktop } from '../../services/agent/desktop/store.js'
import { showToast } from '../base/toastState.js'
import { PillPicker } from './PillPicker.js'
import { IconDesktop, IconFolder } from '../agent/ToolIcons.js'
import styles from './PillPicker.module.css'

/** 本机工作区在选择器里的值前缀，与网页工作区的 id 区分开 */
const DESKTOP_PREFIX = 'desktop:'

/**
 * 工作区选择器：一次只用一个工作区，具体用哪个由用户在聊天框处决定。
 * 同时列出网页工作区（演示仓库、本地文件夹）与本机工作区（桌面端的沙箱根）。
 *
 * 选中的「平面」会持久化：连着桌面端时不再强行显示本机目录，
 * 用户选网页工作区就是网页工作区。
 */
export const WorkspacePicker = () => {
  const t = useTranslate()
  const entries = useWorkspace((state) => state.entries)
  const activeId = useWorkspace((state) => state.activeId)
  const loading = useWorkspace((state) => state.loading)
  const plane = useWorkspacePlane()
  const desktop = useDesktop()
  // 隐藏目录是配置目录（更老的桌面端会把它当工作区报上来），不参与选择
  const desktopWorkspaces =
    desktop.status === 'connected'
      ? (desktop.info?.workspaces ?? []).filter((item) => !item.name.startsWith('.'))
      : []
  const connected = desktop.status === 'connected'

  // 桌面端断开后选择器要退回网页工作区，否则会一直显示一个不可用的路径
  useEffect(() => {
    if (plane.kind === 'desktop' && !connected) {
      setWebPlane()
    }
  }, [plane.kind, connected])

  const value = plane.kind === 'desktop' && connected ? `${DESKTOP_PREFIX}${plane.path}` : activeId

  return (
    <PillPicker
      icon={plane.kind === 'desktop' && connected ? <IconDesktop /> : <IconFolder />}
      value={value}
      disabled={loading}
      options={[
        ...entries.map((entry) => ({
          value: entry.id,
          label: entry.name,
          description:
            entry.source === 'demo'
              ? `${t('workspacePickerDemo')} · ${entry.branch}`
              : `${entry.branch} · ${entry.root}`,
        })),
        ...desktopWorkspaces.map((item) => ({
          value: `${DESKTOP_PREFIX}${item.path}`,
          label: item.name,
          description: `${t('agentPanelDesktop')} · ${item.path}`,
          icon: <IconDesktop />,
        })),
      ]}
      onChange={(next) => {
        if (!next.startsWith(DESKTOP_PREFIX)) {
          setWebPlane()
          setActiveWorkspace(next)
          return
        }
        const path = next.slice(DESKTOP_PREFIX.length)
        void switchDesktopWorkspace(path).then((ok) => {
          if (!ok) {
            showToast({ key: 'agentConnectFailed', type: 'error' })
            return
          }
          setDesktopPlane(path)
        })
      }}
      footer={
        <button
          type="button"
          className={styles.option}
          onClick={() => {
            setWebPlane()
            void openLocalWorkspace()
          }}
        >
          <span className={styles.optionIcon}>
            <IconFolder />
          </span>
          <span className={styles.optionBody}>
            <span className={styles.optionLabel}>{t('workspacePickerAdd')}</span>
          </span>
        </button>
      }
    />
  )
}
