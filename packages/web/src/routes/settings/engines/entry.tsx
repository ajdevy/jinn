import { useModelRegistry } from "@/hooks/use-model-registry"
import { Section } from "../shared"
import { EngineCard } from "./engine-card"
import { LegacyFallbackRow } from "./legacy-row"
import {
  chainFor,
  legacyFallbackEngine,
  legacyMigrationMutations,
  type EnginesConfig,
  type SessionsFallbackConfig,
} from "./chain-model"

interface EnginesSectionProps {
  engines: EnginesConfig | undefined
  sessions: SessionsFallbackConfig | undefined
  /** The Settings page's config setter; the page's Save Config button PUTs it. */
  onChange: (path: string[], value: unknown) => void
}

/** Every engine the gateway knows, healthy or not, with the chain its turns fall
 *  through to. Uninstalled engines are listed rather than hidden: an operator
 *  deciding what to fall back to needs to see the one that is not there yet. */
export function EnginesSection({ engines, sessions, onChange }: EnginesSectionProps) {
  const { data: registry } = useModelRegistry()
  const entries = Object.values(registry?.engines ?? {})
  if (entries.length === 0) return null

  const registryEngines = entries.map((entry) => entry.name)
  const legacy = legacyFallbackEngine(sessions)

  return (
    <Section title="Engine Fallbacks">
      <div className="flex flex-col gap-[var(--space-2)]">
        {entries.map((entry) => (
          <EngineCard
            key={entry.name}
            entry={entry}
            chain={chainFor(engines, entry.name)}
            registryEngines={registryEngines}
            onChange={(chain) => onChange(["engines", entry.name, "fallback"], chain)}
          />
        ))}
        {legacy && (
          <LegacyFallbackRow
            engine={legacy}
            onMigrate={() => {
              for (const mutation of legacyMigrationMutations(legacy)) onChange(mutation.path, mutation.value)
            }}
          />
        )}
      </div>
    </Section>
  )
}
