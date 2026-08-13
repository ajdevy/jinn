import { useState, type ReactNode } from "react"
import { api } from "@/lib/api"
import { cn } from "@/lib/utils"
import type { AnswerHandler, SituationPayload } from "../situation-payload"

type VoiceSetupPayload = Extract<SituationPayload, { kind: "voice-setup" }>

/** Answering with this is what tells the surface to try opening a session again. */
export const VOICE_SETUP_SAVED = "saved"
export const VOICE_SETUP_NOT_NOW = "not-now"

/** The sheet's own control well: a soft fill and an accent focus ring, no border
 *  at rest — the same recipe the settings rows use, sized for a touch target. */
const FIELD_CLASS = cn(
  "w-full min-h-[38px] rounded-[var(--radius-lg)] border-none bg-[var(--fill-tertiary)]",
  "px-[var(--space-3)] py-[var(--space-2)] text-[length:var(--text-subheadline)]",
  "text-[var(--text-primary)] outline-none placeholder:text-[var(--text-tertiary)]",
  "transition-[box-shadow] duration-150 focus:shadow-[0_0_0_3px_var(--accent-fill)]",
)

const QUIET_BUTTON_CLASS = cn(
  "inline-flex min-h-[38px] cursor-pointer items-center rounded-full border-none",
  "bg-[var(--fill-tertiary)] px-[var(--space-4)] text-[length:var(--text-subheadline)]",
  "text-[var(--text-secondary)] transition-colors hover:bg-[var(--fill-secondary)]",
  "hover:text-[var(--text-primary)] disabled:cursor-default disabled:opacity-60",
)

const SAVE_BUTTON_CLASS = cn(
  "inline-flex min-h-[38px] cursor-pointer items-center rounded-full border-none",
  "bg-[var(--accent-fill)] px-[var(--space-4)] text-[length:var(--text-subheadline)]",
  "font-[var(--weight-semibold)] text-[var(--accent)] shadow-[var(--inset-shine)]",
  "transition-transform hover:scale-[0.98] disabled:cursor-default",
  "disabled:opacity-60 disabled:hover:scale-100",
)

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

/** A labelled control in the sheet's own vertical rhythm. */
function Field({ label, children }: { label: string; children: ReactNode }) {
  return (
    <label className="flex flex-col gap-[var(--space-1)]">
      <span className="text-[length:var(--text-footnote)] text-[var(--text-secondary)]">{label}</span>
      {children}
    </label>
  )
}

function ProviderField({
  providers,
  value,
  onChange,
}: {
  providers: string[]
  value: string
  onChange: (provider: string) => void
}) {
  return (
    <Field label="Provider">
      <select
        aria-label="Voice provider"
        value={value}
        onChange={(event) => onChange(event.target.value)}
        className={cn(FIELD_CLASS, "cursor-pointer")}
      >
        {providers.map((name) => (
          <option key={name} value={name}>
            {name}
          </option>
        ))}
      </select>
    </Field>
  )
}

function KeyField({ value, onChange }: { value: string; onChange: (key: string) => void }) {
  return (
    <Field label="API key">
      <input
        type="password"
        aria-label="Voice API key"
        autoComplete="off"
        value={value}
        onChange={(event) => onChange(event.target.value)}
        placeholder="sk-… or ${OPENAI_API_KEY}"
        className={FIELD_CLASS}
      />
      <span className="text-[length:var(--text-caption1)] text-[var(--text-tertiary)]">
        Paste the key, or name an environment variable to read it from and keep
        it out of the config file.
      </span>
    </Field>
  )
}

/** Put it down, or save it. Saving stays disabled until there is a key, so no
 *  press of it can clear one the gateway already has. */
function Actions({ saving, ready, onNotNow }: { saving: boolean; ready: boolean; onNotNow: () => void }) {
  return (
    <div className="flex flex-wrap justify-end gap-[var(--space-2)]">
      <button type="button" disabled={saving} onClick={onNotNow} className={QUIET_BUTTON_CLASS}>
        Not now
      </button>
      <button type="submit" disabled={saving || !ready} className={SAVE_BUTTON_CLASS}>
        {saving ? "Saving…" : "Save and start"}
      </button>
    </div>
  )
}

/**
 * First-run voice setup, in the sheet rather than in config.yaml.
 *
 * The gateway refuses to open a session it cannot pay for, and the refusal used
 * to arrive as the provider factory's own exception. This is what the operator
 * sees instead: the providers this gateway implements, somewhere to put the key,
 * and a save that writes the `realtime` block through the same managed-config
 * route the settings page uses. The key is sent and never read back — nothing
 * here ever renders a stored one.
 */
export function VoiceSetupSituation({
  payload,
  onAnswer,
}: {
  payload: VoiceSetupPayload
  onAnswer: AnswerHandler
}) {
  const [provider, setProvider] = useState(payload.providers[0] ?? "")
  const [apiKey, setApiKey] = useState("")
  const [saving, setSaving] = useState(false)
  const [failure, setFailure] = useState<string | null>(null)

  async function save() {
    setSaving(true)
    setFailure(null)
    try {
      await api.updateConfig({ realtime: { provider, apiKey: apiKey.trim() } })
      // Answering unmounts this card, so `saving` is deliberately left set.
      onAnswer(VOICE_SETUP_SAVED)
    } catch (error) {
      setFailure(message(error))
      setSaving(false)
    }
  }

  return (
    <form
      data-situation-renderer="voice-setup"
      className="flex flex-col gap-[var(--space-3)]"
      onSubmit={(event) => {
        event.preventDefault()
        void save()
      }}
    >
      <ProviderField providers={payload.providers} value={provider} onChange={setProvider} />
      <KeyField value={apiKey} onChange={setApiKey} />

      {failure && (
        <p role="alert" className="text-[length:var(--text-footnote)] text-[var(--system-red)]">
          {failure}
        </p>
      )}

      <Actions saving={saving} ready={Boolean(provider && apiKey.trim())} onNotNow={() => onAnswer(VOICE_SETUP_NOT_NOW)} />
    </form>
  )
}

export function voiceSetupSpeech(payload: VoiceSetupPayload): string {
  return `Voice needs a provider and a key. Available here: ${payload.providers.join(", ")}.`
}
