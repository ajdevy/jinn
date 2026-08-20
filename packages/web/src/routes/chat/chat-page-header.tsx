import type { ReactNode } from 'react'
import { Check } from 'lucide-react'
import { ChatHeaderPills } from '@/components/chat/chat-tabs'
import { ChatGridAddMenu } from './chat-grid-add-menu'

export function ChatPageHeader({
  hideOnMobile,
  title,
  backTo,
  onBack,
  onNew,
  grid,
  moreMenu,
  copiedField,
}: {
  hideOnMobile: boolean
  title: string
  backTo?: { label: string; onClick: () => void }
  onBack: () => void
  onNew: () => void
  grid?: { sessions: Array<{ id?: unknown; title?: string; employee?: string }>; memberIds: string[]; onAdd: (id: string) => void }
  moreMenu: ReactNode
  copiedField: string | null
}) {
  const addGridPane = grid ? <ChatGridAddMenu {...grid} /> : undefined
  return (
    <>
      <ChatHeaderPills {...{ hideOnMobile, title, backTo, onBack, onNew, addGridPane, moreMenu }} />
      {copiedField && (
        <div className="absolute right-4 top-[58px] z-10 flex items-center gap-1 rounded-full bg-[var(--material-thick)] px-2.5 py-1 text-caption1 font-medium text-[var(--accent)] shadow-[var(--shadow-overlay)]">
          <Check className="size-3" /> Copied!
        </div>
      )}
    </>
  )
}
