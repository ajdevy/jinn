import React from 'react'
import { buildFileReadRequest } from '@/lib/file-read-request'
import { useOpenFile } from '@/components/chat/file-open-context'

// Bare paths stay deliberately narrow: optional ~/ or / prefix, ≥1
// slash-separated segment, and a short extension. Backticked paths may use the
// viewer's supported roots and broader filename characters; the backticks give
// that form an unambiguous boundary without making ordinary prose linkable.
export const FILE_PATH_CORE = String.raw`(?:~\/|\/)?[A-Za-z0-9_.-]+(?:\/[A-Za-z0-9_.-]+)+\.[A-Za-z0-9]{1,8}`
const FILE_PATH_RE = new RegExp(`^${FILE_PATH_CORE}$`)
const SUPPORTED_VIEWER_ROOT_RE = /^(?:knowledge|docs|files|uploads)\//

function buildChatFileLink(path: string): { trimmed: string; href: string } | null {
  const trimmed = path.trim()
  if (SUPPORTED_VIEWER_ROOT_RE.test(trimmed)) {
    if (!buildFileReadRequest(trimmed).ok) return null
  } else if (!FILE_PATH_RE.test(trimmed)) {
    return null
  }
  return { trimmed, href: `/file?path=${encodeURIComponent(trimmed)}` }
}

export function isFilePath(s: string): boolean {
  return buildChatFileLink(s) !== null
}

// Render a file path as a clean clickable link. Opens the file in an in-app tab
// when a FileOpenContext provider is present (chat page); otherwise / on
// modified clicks it falls back to the real `/file?path=` browser route.
// Monospace + blue underline (no code-box background — that looked like an empty highlight).
function FileLink({ path }: { path: string }) {
  const openFile = useOpenFile()
  const link = buildChatFileLink(path)
  if (!link) return path
  const { trimmed, href } = link
  return (
    <a
      href={href}
      target="_blank"
      rel="noopener noreferrer"
      title={`Open ${trimmed} in viewer`}
      onClick={(e) => {
        // Let modified clicks (cmd/ctrl/shift/middle) fall through to a real browser tab.
        if (e.metaKey || e.ctrlKey || e.shiftKey || e.button !== 0) return
        if (openFile) { e.preventDefault(); openFile(trimmed) }
      }}
      className="text-[var(--system-blue)] underline decoration-[var(--system-blue)]/40 hover:decoration-[var(--system-blue)] underline-offset-2 font-[family-name:var(--font-code)] text-[0.88em]"
    >
      {path}
    </a>
  )
}

export function renderPathLink(p: string, key: React.Key): React.ReactNode {
  return <FileLink key={key} path={p} />
}
