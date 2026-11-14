import { create } from 'zustand'
import { initWorkspace } from '../../services/workspace/store.js'

type WorkspacePanelState = { open: boolean }

export const useWorkspacePanel = create<WorkspacePanelState>(() => ({ open: false }))

export const openWorkspacePanel = () => {
  initWorkspace()
  useWorkspacePanel.setState({ open: true })
}

export const closeWorkspacePanel = () => useWorkspacePanel.setState({ open: false })
