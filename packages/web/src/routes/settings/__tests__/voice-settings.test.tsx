import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import type React from 'react'
import { MemoryRouter } from 'react-router-dom'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import SettingsPage from '../page'

/**
 * The Voice section, and the Talk Orb row it cross-references.
 *
 * The account key is the thing under test as much as the controls are: the page
 * is served a sentinel rather than the key, and a save has to hand that sentinel
 * back untouched so the gateway keeps what it has.
 */

const apiMocks = vi.hoisted(() => ({
  getConfig: vi.fn(),
  updateConfig: vi.fn(),
  getOrg: vi.fn(),
  sttStatus: vi.fn(),
  sttUpdateConfig: vi.fn(),
  sttDownload: vi.fn(),
}))

const fetchTalkCapability = vi.hoisted(() => vi.fn())

const settingsMock = vi.hoisted(() => ({
  talkOrb: true,
  talkMicrophone: 'far_field' as 'far_field' | 'near_field',
  talkOrbVariant: 'mist',
}))
const setTalkMicrophone = vi.hoisted(() => vi.fn())
const setTalkOrbVariant = vi.hoisted(() => vi.fn())

vi.mock('@/lib/api', () => ({ api: apiMocks }))
vi.mock('@/components/talk/orb-canvas', () => ({
  OrbCanvas: ({ variant }: { variant: string }) => <canvas data-test-orb-variant={variant} />,
}))
vi.mock('@/lib/talk-capability', () => ({ fetchTalkCapability }))
vi.mock('@/components/page-layout', () => ({ PageLayout: ({ children }: { children: React.ReactNode }) => <>{children}</> }))
vi.mock('@/context/breadcrumb-context', () => ({ useBreadcrumbs: vi.fn() }))
vi.mock('@/routes/providers', () => ({ useTheme: () => ({ theme: 'dark', setTheme: vi.fn() }) }))
vi.mock('@/routes/settings-provider', () => ({
  useSettings: () => ({
    settings: settingsMock,
    setAccentColor: vi.fn(),
    setCompanyName: vi.fn(),
    setPortalName: vi.fn(),
    setPortalSubtitle: vi.fn(),
    setOperatorName: vi.fn(),
    setPortalEmoji: vi.fn(),
    setLanguage: vi.fn(),
    setTalkOrb: vi.fn(),
    setTalkMicrophone,
    setTalkOrbVariant,
    resetAll: vi.fn(),
  }),
}))
vi.mock('@/hooks/use-model-registry', () => ({ useModelRegistry: () => ({ data: undefined }) }))
vi.mock('@/hooks/use-onboarding', () => ({ useOnboarding: () => ({ data: undefined }) }))
vi.mock('@/components/ui/emoji-picker', () => ({ EmojiPicker: () => null }))
vi.mock('@/components/auth/remote-access-panel', () => ({ RemoteAccessPanel: () => null }))
vi.mock('@/routes/auth-provider', () => ({
  useAuth: () => ({ authState: {}, devices: [], createPairingCode: vi.fn(), logout: vi.fn(), unpairDevice: vi.fn() }),
}))

const STORED_KEY_SENTINEL = '***'
const NOT_SET_UP = /Voice is not set up yet/

function renderSettings() {
  render(
    <MemoryRouter>
      <SettingsPage />
    </MemoryRouter>,
  )
}

function save() {
  fireEvent.click(screen.getByRole('button', { name: 'Save Config' }))
}

beforeEach(() => {
  settingsMock.talkOrb = true
  settingsMock.talkMicrophone = 'far_field'
  setTalkMicrophone.mockReset()
  setTalkOrbVariant.mockReset()
  apiMocks.getConfig.mockResolvedValue({ realtime: { provider: 'openai', apiKey: STORED_KEY_SENTINEL } })
  apiMocks.updateConfig.mockResolvedValue({})
  apiMocks.getOrg.mockResolvedValue({ employees: [] })
  apiMocks.sttStatus.mockResolvedValue({ available: false, model: null, downloading: false, progress: 0, languages: ['en'] })
  apiMocks.sttUpdateConfig.mockResolvedValue({})
  apiMocks.sttDownload.mockResolvedValue({})
  fetchTalkCapability.mockResolvedValue({ configured: true, provider: 'openai', providers: ['openai'] })
})

describe('the Voice section', () => {
  it('persists a close-mic profile independently of gateway secrets', async () => {
    renderSettings()

    const microphone = await screen.findByRole('combobox', { name: 'Talk microphone' })
    expect((microphone as HTMLSelectElement).value).toBe('far_field')
    fireEvent.change(microphone, { target: { value: 'near_field' } })

    expect(setTalkMicrophone).toHaveBeenCalledWith('near_field')
    expect(apiMocks.updateConfig).not.toHaveBeenCalled()
  })

  it('offers the providers the gateway reports, and nothing invented', async () => {
    renderSettings()

    const provider = await screen.findByRole('combobox', { name: 'Voice provider' })
    const offered = Array.from(provider.querySelectorAll('option')).map((option) => option.textContent)
    expect(offered).toEqual(['Not set', 'openai'])
    expect((provider as HTMLSelectElement).value).toBe('openai')
  })

  it('says a key is stored without putting one on the screen', async () => {
    renderSettings()

    expect(await screen.findByText('Stored')).not.toBeNull()
    expect(screen.queryByLabelText('Voice API key')).toBeNull()
    expect(document.body.textContent).not.toContain(STORED_KEY_SENTINEL)
  })

  it('hands the sentinel back untouched, so saving does not overwrite the key', async () => {
    renderSettings()
    await screen.findByText('Stored')

    save()

    await waitFor(() =>
      expect(apiMocks.updateConfig).toHaveBeenCalledWith(
        expect.objectContaining({ realtime: { provider: 'openai', apiKey: STORED_KEY_SENTINEL } }),
      ),
    )
  })

  // An undefined provider is dropped by JSON.stringify, and a body with no
  // provider in it is how the gateway is told to keep the one it has — so the
  // page would report a save that had put the old provider straight back.
  it('clears the provider when it is set back to Not set', async () => {
    renderSettings()

    const provider = await screen.findByRole('combobox', { name: 'Voice provider' })
    fireEvent.change(provider, { target: { value: '' } })
    save()

    await waitFor(() =>
      expect(apiMocks.updateConfig).toHaveBeenCalledWith(
        expect.objectContaining({ realtime: { provider: null, apiKey: STORED_KEY_SENTINEL } }),
      ),
    )
  })

  it('sends a replacement key, and can be talked out of replacing', async () => {
    renderSettings()
    await screen.findByText('Stored')

    fireEvent.click(screen.getByRole('button', { name: 'Replace' }))
    fireEvent.change(screen.getByLabelText('Voice API key'), { target: { value: '${OPENAI_API_KEY}' } })
    save()

    await waitFor(() =>
      expect(apiMocks.updateConfig).toHaveBeenCalledWith(
        expect.objectContaining({ realtime: { provider: 'openai', apiKey: '${OPENAI_API_KEY}' } }),
      ),
    )

    fireEvent.click(screen.getByRole('button', { name: 'Keep the current key' }))
    save()

    await waitFor(() =>
      expect(apiMocks.updateConfig).toHaveBeenLastCalledWith(
        expect.objectContaining({ realtime: { provider: 'openai', apiKey: STORED_KEY_SENTINEL } }),
      ),
    )
  })
})

describe('the Talk Orb row', () => {
  it('offers the four calm orb styles in Voice settings', async () => {
    renderSettings()

    const styles = await screen.findByRole('radiogroup', { name: 'Talk orb style' })
    expect(Array.from(styles.querySelectorAll('[data-orb-variant-option]')).map((option) =>
      option.getAttribute('data-orb-variant-option'))).toEqual(['mist', 'coin', 'ring', 'pulse'])

    fireEvent.click(screen.getByRole('radio', { name: 'Ring orb' }))
    expect(setTalkOrbVariant).toHaveBeenCalledWith('ring')
  })

  it('says voice is not set up when the orb is on and the gateway cannot open one', async () => {
    fetchTalkCapability.mockResolvedValue({ configured: false, provider: null, providers: ['openai'] })
    renderSettings()

    expect(await screen.findByText(NOT_SET_UP)).not.toBeNull()
  })

  it('says nothing once voice is configured', async () => {
    renderSettings()
    await screen.findByText('Stored')

    expect(screen.queryByText(NOT_SET_UP)).toBeNull()
  })

  it('says nothing when the orb itself is switched off', async () => {
    settingsMock.talkOrb = false
    fetchTalkCapability.mockResolvedValue({ configured: false, provider: null, providers: ['openai'] })
    renderSettings()

    await screen.findByRole('combobox', { name: 'Voice provider' })
    expect(screen.queryByText(NOT_SET_UP)).toBeNull()
  })
})
