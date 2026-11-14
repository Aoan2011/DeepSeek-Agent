import clsx from 'clsx'
import { useEffect } from 'react'
import { useTranslate } from '../../i18n/index.js'
import { resolveApproval, useApprovals } from '../../services/agent/approval.js'
import { sourceLabel } from '../../services/agent/types.js'
import { Button } from '../base/Button.js'
import { IconWarningOutline16 } from '../base/icons.js'
import { toolIcon } from './ToolIcons.js'
import styles from './ApprovalDialog.module.css'

/** 长文本（如文件内容）只展示摘要，避免确认框被一整篇文章撑满 */
const shorten = (value: unknown): unknown => {
  if (typeof value === 'string') {
    return value.length > 150 ? `${value.slice(0, 150)}… （共 ${value.length} 字符）` : value
  }
  if (Array.isArray(value)) {
    return value.slice(0, 20).map(shorten)
  }
  if (typeof value === 'object' && value !== null) {
    return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, shorten(item)]))
  }
  return value
}

const formatInput = (input: unknown) => {
  try {
    return JSON.stringify(shorten(input), null, 2)
  } catch {
    return String(input)
  }
}

/** 危险操作的确认面板：阻塞等待用户决定，未决定前工具不会执行 */
export const ApprovalDialog = () => {
  const t = useTranslate()
  const queue = useApprovals((state) => state.queue)
  const request = queue[0]

  useEffect(() => {
    if (!request) {
      return
    }
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        resolveApproval(request.id, 'deny')
      }
      if (event.key === 'Enter' && !event.metaKey && !event.ctrlKey) {
        resolveApproval(request.id, 'allow_once')
      }
    }
    document.addEventListener('keydown', onKeyDown)
    return () => document.removeEventListener('keydown', onKeyDown)
  }, [request])

  if (!request) {
    return null
  }

  const riskText =
    request.risk === 'exec'
      ? t('agentApprovalRiskExec')
      : request.risk === 'write'
        ? t('agentApprovalRiskWrite')
        : t('agentApprovalRiskNetwork')

  return (
    <div className={styles.overlay} role="presentation">
      <div className={styles.card} role="alertdialog" aria-modal="true" aria-label={t('agentApprovalTitle')}>
        <div className={styles.glow} aria-hidden />
        <div className={styles.head}>
          <span className={styles.icon}>{toolIcon(request.toolName, request.source)}</span>
          <div className={styles.titles}>
            <span className={styles.title}>
              {t('agentApprovalTitle')}
              {queue.length > 1 ? (
                <span className={styles.count}>
                  {queue.length - 1} {t('agentApprovalPending')}
                </span>
              ) : null}
            </span>
            <span className={styles.subtitle}>
              {request.label}
              <span className={styles.source}>{sourceLabel(request.source)}</span>
            </span>
          </div>
          <span className={clsx(styles.risk, styles[request.risk])}>
            <IconWarningOutline16 />
            {riskText}
          </span>
        </div>

        <div className={styles.body}>
          <p className={styles.desc}>{request.description}</p>
          <div className={styles.args}>
            <span className={styles.argsTitle}>{t('agentToolArgs')}</span>
            <pre className={styles.code}>{formatInput(request.input)}</pre>
          </div>
          <p className={styles.notice}>{t('agentApprovalNotice')}</p>
        </div>

        <div className={styles.footer}>
          <Button variant="outlined" size="m" onClick={() => resolveApproval(request.id, 'deny')}>
            {t('agentApprovalDeny')}
          </Button>
          <div className={styles.spacer} />
          <Button
            variant="outlined"
            size="m"
            onClick={() => resolveApproval(request.id, 'allow_session')}
          >
            {t('agentApprovalAllowSession')}
          </Button>
          <Button
            variant="primary"
            size="m"
            onClick={() => resolveApproval(request.id, 'allow_once')}
          >
            {t('agentApprovalAllow')}
          </Button>
        </div>
      </div>
    </div>
  )
}
