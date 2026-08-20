import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import type React from 'react'
import { MemoryRouter } from 'react-router-dom'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import SettingsPage from '../../page'

/* The Engines section as the operator drives it: chains are edited into the
 * page's config state and land on the wire through the page's own Save Config
 * button, so every assertion here is about what `api.updateConfig` receives. */

const apiMocks = vi.hoisted(() => ({
  getConfig: vi.fn(),
  updateConfig: vi.fn(),
  getOrg: vi.fn(),
  sttStatus: vi.fn(),
  sttUpdateConfig: vi.fn(),
  sttDownload: vi.fn(),
}))
const fetchTalkCapability = vi.hoisted(() => vi.fn())
const registry = vi.hoisted(() => ({ current: undefined as unknown }))

vi.mock('@/lib/api', () => ({ api: apiMocks }))
vi.mock('@/lib/talk-capability', () => ({ fetchTalkCapability }))
vi.mock('@/components/page-layout', () => ({ PageLayout: ({ children }: { children: React.ReactNode }) => <>{children}</> }))
vi.mock('@/context/breadcrumb-context', () => ({ useBreadcrumbs: vi.fn() }))
vi.mock('@/routes/providers', () => ({ useTheme: () => ({ theme: 'dark', setTheme: vi.fn() }) }))
vi.mock('@/routes/settings-provider', () => ({
  useSettings: () => ({
    settings: {},
    setAccentColor: vi.fn(),
    setCompanyName: vi.fn(),
    setPortalName: vi.fn(),
    setPortalSubtitle: vi.fn(),
    setOperatorName: vi.fn(),
    setPortalEmoji: vi.fn(),
    setLanguage: vi.fn(),
    resetAll: vi.fn(),
  }),
}))
vi.mock('@/hooks/use-model-registry', () => ({ useModelRegistry: () => ({ data: registry.current }) }))
vi.mock('@/hooks/use-onboarding', () => ({ useOnboarding: () => ({ data: undefined }) }))
vi.mock('@/components/ui/emoji-picker', () => ({ EmojiPicker: () => null }))
vi.mock('@/components/auth/remote-access-panel', () => ({ RemoteAccessPanel: () => null }))
vi.mock('@/routes/auth-provider', () => ({
  useAuth: () => ({ authState: {}, devices: [], createPairingCode: vi.fn(), logout: vi.fn(), unpairDevice: vi.fn() }),
}))

const EXHAUSTED_UNTIL = '2026-08-19T17:30:00.000Z'

function engine(name: string, available: boolean, defaultModel: string, health?: unknown) {
  return { name, available, defaultModel, effortMechanism: 'none', models: [], ...(health ? { health } : {}) }
}

async function renderSettings() {
  render(<MemoryRouter><SettingsPage /></MemoryRouter>)
  await screen.findByRole('button', { name: 'Save Config' })
}

/** The chain rows on one card, in the order they are rendered. */
function chainRows(engineName: string): string[] {
  const card = document.querySelector(`[data-engine-card="${engineName}"]`)!
  return Array.from(card.querySelectorAll('[data-chain-row]')).map((row) => row.getAttribute('data-chain-row')!)
}

async function save() {
  fireEvent.click(screen.getByRole('button', { name: 'Save Config' }))
  await waitFor(() => expect(apiMocks.updateConfig).toHaveBeenCalled())
  return apiMocks.updateConfig.mock.calls[0][0] as Record<string, any>
}

beforeEach(() => {
  vi.clearAllMocks()
  registry.current = {
    default: 'claude',
    engines: {
      claude: engine('claude', true, 'opus', { state: 'exhausted', until: EXHAUSTED_UNTIL }),
      codex: engine('codex', true, 'gpt-5.6-sol'),
      grok: engine('grok', false, 'grok-build', { state: 'degraded' }),
    },
  }
  apiMocks.getConfig.mockResolvedValue({ engines: { claude: { fallback: ['codex'] } } })
  apiMocks.updateConfig.mockResolvedValue({})
  apiMocks.getOrg.mockResolvedValue({ employees: [] })
  apiMocks.sttStatus.mockResolvedValue({ available: false, model: null, downloading: false, progress: 0, languages: ['en'] })
  apiMocks.sttUpdateConfig.mockResolvedValue({})
  apiMocks.sttDownload.mockResolvedValue({})
  fetchTalkCapability.mockResolvedValue({ configured: true, provider: 'openai', providers: ['openai'] })
})

describe('Engines section', () => {
  it('lists every engine with its installed state, default model and health', async () => {
    await renderSettings()
    const localTime = new Date(EXHAUSTED_UNTIL).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })

    expect(screen.getByText('Installed · opus')).toBeTruthy()
    expect(screen.getByText('Installed · gpt-5.6-sol')).toBeTruthy()
    // Uninstalled engines are listed too, not hidden.
    expect(screen.getByText('Not installed · grok-build')).toBeTruthy()
    expect(screen.getByText(`Out of allowance until ${localTime}`)).toBeTruthy()
    expect(screen.getByText('Degraded')).toBeTruthy()
    expect(screen.getByText('Healthy')).toBeTruthy()
  })

  it('offers neither the card own engine nor one already in its chain, and no free-text entry', async () => {
    await renderSettings()
    const add = screen.getByRole('combobox', { name: 'Add an engine to the Claude chain' })

    expect(add.tagName).toBe('SELECT')
    const offered = within(add).getAllByRole('option').map((option) => (option as HTMLOptionElement).value)
    expect(offered).not.toContain('claude')
    expect(offered).not.toContain('codex')
    expect(offered).toContain('grok')
  })

  it('saves the edited chain as exactly the array on screen', async () => {
    await renderSettings()
    fireEvent.change(screen.getByRole('combobox', { name: 'Add an engine to the Claude chain' }), {
      target: { value: 'grok' },
    })
    expect(chainRows('claude')).toEqual(['codex', 'grok'])

    expect((await save()).engines.claude.fallback).toEqual(['codex', 'grok'])
  })

  it('saves a chain emptied in the UI as [], and says the engine waits', async () => {
    await renderSettings()
    fireEvent.click(screen.getByRole('button', { name: 'Remove Codex from the Claude chain' }))

    expect(screen.getByText('No fallback. Claude waits for its own limit to reset.')).toBeTruthy()
    expect((await save()).engines.claude.fallback).toEqual([])
  })

  it('reorders with the move controls a keyboard can reach', async () => {
    apiMocks.getConfig.mockResolvedValue({ engines: { claude: { fallback: ['codex', 'grok'] } } })
    await renderSettings()

    fireEvent.click(screen.getByRole('button', { name: 'Move Grok earlier in the Claude chain' }))
    expect(chainRows('claude')).toEqual(['grok', 'codex'])
    expect((await save()).engines.claude.fallback).toEqual(['grok', 'codex'])
  })

  it('surfaces a failed save and leaves the edited chain on screen', async () => {
    apiMocks.updateConfig.mockRejectedValue(new Error('engines.claude.fallback[0] "grok" is not a known engine'))
    await renderSettings()
    fireEvent.change(screen.getByRole('combobox', { name: 'Add an engine to the Claude chain' }), {
      target: { value: 'grok' },
    })

    fireEvent.click(screen.getByRole('button', { name: 'Save Config' }))
    expect(await screen.findByText(/Failed to save: engines\.claude\.fallback\[0\]/)).toBeTruthy()
    expect(chainRows('claude')).toEqual(['codex', 'grok'])
  })
})

describe('legacy fallback mapping', () => {
  beforeEach(() => {
    // What GET /api/config serves for a legacy config: the mapped chain in the
    // current spelling, with the deprecated pair still on the document.
    apiMocks.getConfig.mockResolvedValue({
      engines: { claude: { fallback: ['codex'] } },
      sessions: { rateLimitStrategy: 'fallback', fallbackEngine: 'codex' },
    })
  })

  it('shows the mapping read-only, and migrating writes the chain and nulls both legacy keys', async () => {
    await renderSettings()
    expect(screen.getByText('An older setting still routes Claude here. Migrate it into the chain above.')).toBeTruthy()
    // Read-only: nothing edits the legacy pair but the one Migrate control.
    expect(screen.queryByRole('combobox', { name: 'When Claude Hits Usage Limit' })).toBeNull()

    await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Migrate' })) })
    expect(screen.queryByRole('button', { name: 'Migrate' })).toBeNull()

    const sent = await save()
    expect(sent.engines.claude.fallback).toEqual(['codex'])
    // Null, not absent: the gateway keeps every key a PUT omits, so an omitted
    // key would leave the deprecated pair on disk.
    expect(Object.keys(sent.sessions)).toEqual(expect.arrayContaining(['rateLimitStrategy', 'fallbackEngine']))
    expect(sent.sessions.rateLimitStrategy).toBeNull()
    expect(sent.sessions.fallbackEngine).toBeNull()
  })
})
