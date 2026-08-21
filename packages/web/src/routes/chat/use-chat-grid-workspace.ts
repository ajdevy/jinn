import { useChatGridState } from './use-chat-grid-state'
import { useChatWorkingSet } from './use-chat-working-set'
import { useGridPickerPane } from './use-grid-picker-pane'

export function useChatGridWorkspace(
  committedId: string | null,
  sessions: Array<{ id?: unknown }> | undefined,
) {
  const workingSet = useChatWorkingSet(committedId, sessions)
  const gridPicker = useGridPickerPane()
  const gridState = useChatGridState({
    committedId,
    workingSet: workingSet.state,
    sessions: sessions ?? [],
    pickerOpen: Boolean(gridPicker.paneKey),
  })
  return { workingSet, gridPicker, gridState }
}
