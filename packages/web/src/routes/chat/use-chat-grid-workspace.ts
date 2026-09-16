import { useCallback } from 'react'
import { useChatGridState } from './use-chat-grid-state'
import { useChatWorkingSet } from './use-chat-working-set'
import { useGridPickerPane } from './use-grid-picker-pane'

export function useChatGridWorkspace(
  committedId: string | null,
  sessions: Array<{ id?: unknown }> | undefined,
  systemPrimedId: string | null = null,
) {
  const workingSet = useChatWorkingSet(committedId, sessions)
  const gridPicker = useGridPickerPane()
  const gridState = useChatGridState({
    committedId,
    workingSet: workingSet.state,
    sessions,
    pickerOpen: Boolean(gridPicker.paneKey),
    systemPrimedId,
  })
  // On a phone the picker pane is the ENTIRE grid (deriveChatGridIds), and the
  // only control that closes it lives in a multi-pane title bar the mobile grid
  // never renders — so every navigation away from it has to release it, or the
  // screen simply does not change. Desktop keeps it open: there it is one pane
  // beside the others rather than the whole surface.
  const closePicker = gridPicker.close
  const { mobile } = gridState.viewport
  const releaseMobilePicker = useCallback(() => {
    if (mobile) closePicker()
  }, [closePicker, mobile])
  return { workingSet, gridPicker, gridState, releaseMobilePicker }
}
