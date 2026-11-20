import { useTranslate } from '../../i18n/index.js'
import { useWorkspace, setActiveWorkspace, openLocalWorkspace } from '../../services/workspace/store.js'
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
 */
export const WorkspacePicker = () => {
  const t = useTranslate()
  const entries = useWorkspace((state) => state.entries)
  const activeId = useWorkspace((state) => state.activeId)
  const loading = useWorkspace((state) => state.loading)
  const desktop = useDesktop()
  const desktopWorkspaces = desktop.status === 'connected' ? (desktop.info?.workspaces ?? []) : []
  const currentDesktop = desktopWorkspaces.find((item) => item.current)

  // 本机工作区被选中时优先展示：两个平面各自有一个「当前」
  const value = currentDesktop ? `${DESKTOP_PREFIX}${currentDesktop.path}` : activeId

  return (
    <PillPicker
      icon={currentDesktop ? <IconDesktop /> : <IconFolder />}
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
          setActiveWorkspace(next)
          return
        }
        void switchDesktopWorkspace(next.slice(DESKTOP_PREFIX.length)).then((ok) => {
          if (!ok) {
            showToast({ key: 'agentConnectFailed', type: 'error' })
          }
        })
      }}
      footer={
        <button
          type="button"
          className={styles.option}
          onClick={() => {
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
