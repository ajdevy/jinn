import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { Session } from '@/components/chat/session-signals'
import { installVirtualLayout, type VirtualLayout } from '@/test/virtual-layout'
import { SessionPicker } from '../session-picker'

const pickerData = vi.hoisted(() => ({
  sessions: [] as Session[],
  pins: new Set<string>(),
}))

vi.mock('@/hooks/use-sessions', () => ({
  useSessions: () => ({ data: pickerData.sessions, isLoading: false }),
  useSessionSearch: (query: string) => ({
    data: query.trim()
      ? pickerData.sessions.filter((session) => session.title?.toLowerCase().includes(query.trim().toLowerCase()))
      : undefined,
    isLoading: false,
  }),
}))

vi.mock('@/hooks/use-pins', () => ({
  usePins: () => ({ data: pickerData.pins }),
}))

function session(index: number): Session {
  return {
    id: `session-${index}`,
    title: `Planning chat ${index}`,
    employee: index % 2 ? 'designer' : 'engineer',
    lastActivity: new Date(Date.UTC(2026, 7, 21, 12, 0, 0) - index * 1000).toISOString(),
  }
}

function renderPicker(onPick = vi.fn()) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  return {
    onPick,
    ...render(
      <QueryClientProvider client={client}>
        <div style={{ height: 420 }}><SessionPicker onPick={onPick} /></div>
      </QueryClientProvider>,
    ),
  }
}

let layout: VirtualLayout | null = null

describe('SessionPicker', () => {
  beforeEach(() => {
    pickerData.sessions = []
    pickerData.pins = new Set()
    layout = installVirtualLayout(44, 360, {
      scroller: '[data-testid="session-picker-scroll"]',
      row: '[data-session-picker-row]',
      rowId: 'data-session-picker-row',
    })
  })

  afterEach(() => {
    layout?.release()
    layout = null
  })

  it('keeps a 500-session result set virtualized to a bounded DOM window', async () => {
    pickerData.sessions = Array.from({ length: 500 }, (_, index) => session(index))
    renderPicker()

    await waitFor(() => expect(screen.getAllByTestId('session-picker-row').length).toBeGreaterThan(0))
    expect(screen.getAllByTestId('session-picker-row').length).toBeLessThan(30)
    expect(document.querySelectorAll('[role="option"]').length).toBeLessThan(30)

    const firstWindow = layout!.mountedRowIds()
    layout!.scrollTo(10_000)
    await waitFor(() => expect(layout!.mountedRowIds()).not.toEqual(firstWindow))
    expect(layout!.mountedRowIds().length).toBeLessThan(30)
    expect(layout!.mountedRowIds()).not.toContain('session-0')
  })

  it('renders pinned matches before the recent group without duplicating them', async () => {
    pickerData.sessions = [session(0), session(1), session(2)]
    pickerData.pins = new Set(['session-1'])
    renderPicker()

    await screen.findByText('Pinned')
    const labels = Array.from(document.querySelectorAll('[data-session-picker-group]')).map((node) => node.textContent)
    expect(labels).toEqual(['Pinned', 'Recent'])
    expect(screen.getAllByText('Planning chat 1')).toHaveLength(1)
  })

  it('narrows to server search matches', async () => {
    pickerData.sessions = [session(1), session(12), session(30)]
    renderPicker()

    fireEvent.change(screen.getByRole('combobox', { name: 'Search chats' }), { target: { value: 'chat 12' } })

    await screen.findByText('Planning chat 12')
    expect(screen.queryByText('Planning chat 1')).toBeNull()
    expect(screen.queryByText('Planning chat 30')).toBeNull()
  })

  it('clears the floating header at mobile and desktop heights', async () => {
    pickerData.sessions = [session(0)]
    renderPicker()

    const searchRegion = screen.getByTestId('session-picker-search')
    expect(searchRegion.className).toContain('pt-[calc(var(--safe-top)+var(--space-12)+var(--space-2))]')
    expect(searchRegion.className).toContain('lg:pt-[calc(var(--space-12)+var(--space-10))]')

    const group = await screen.findByText('Recent')
    const subtitle = screen.getByText('engineer')
    expect(group.className).toContain('text-[length:var(--text-caption1)]')
    expect(subtitle.className).toContain('text-[length:var(--text-caption1)]')
  })

  it('picks the active search result with Arrow keys and Enter', async () => {
    pickerData.sessions = [session(1), session(12)]
    const { onPick } = renderPicker()
    const search = screen.getByRole('combobox', { name: 'Search chats' })
    fireEvent.change(search, { target: { value: 'Planning' } })

    await screen.findByText('Planning chat 1')
    fireEvent.keyDown(search, { key: 'ArrowDown' })
    fireEvent.keyDown(search, { key: 'Enter' })

    expect(onPick).toHaveBeenCalledWith('session-12')
  })

  it('scrolls keyboard selection through the virtual window and announces the active option', async () => {
    pickerData.sessions = Array.from({ length: 500 }, (_, index) => session(index))
    renderPicker()
    const input = await screen.findByRole('combobox', { name: 'Search chats' })
    const listbox = screen.getByRole('listbox', { name: 'Chats' })
    expect(input.getAttribute('aria-controls')).toBe(listbox.id)
    await waitFor(() => expect(layout!.mountedRowIds()).toContain('session-0'))

    for (let index = 0; index < 20; index += 1) fireEvent.keyDown(input, { key: 'ArrowDown' })

    await waitFor(() => {
      const activeId = input.getAttribute('aria-activedescendant')
      expect(activeId).toBeTruthy()
      expect(document.getElementById(activeId!)).toBeTruthy()
    })
    expect(layout!.mountedRowIds()).toContain('session-20')
  })

  it('distinguishes an empty history from an empty search', async () => {
    const view = renderPicker()
    expect(await screen.findByText('No chats yet')).toBeTruthy()
    view.unmount()

    pickerData.sessions = [session(1)]
    renderPicker()
    fireEvent.change(screen.getByRole('combobox', { name: 'Search chats' }), { target: { value: 'nothing here' } })
    expect(await screen.findByText('No chats match')).toBeTruthy()
  })
})
