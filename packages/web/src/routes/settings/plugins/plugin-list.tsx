import type { UseQueryResult } from "@tanstack/react-query"
import { PluginRow } from "./plugin-row"
import type { PluginInventoryRow } from "./inventory"

/** The loading, failed, empty and populated states of the inventory, in the
 *  order the Cron page settles them. */

function ListSkeleton() {
  return (
    <div
      data-testid="plugins-skeleton"
      className="rounded-[var(--radius-xl)] bg-[var(--bg-secondary)] p-[5px] shadow-[var(--shadow-card)]"
      aria-hidden
    >
      {["44%", "31%", "56%"].map((width, index) => (
        <div key={width} className="flex min-h-[56px] items-center gap-3 px-3 py-2.5">
          <span className="flex flex-1 flex-col gap-2">
            <span
              className="h-3 rounded-[6px] bg-[var(--fill-tertiary)] motion-safe:animate-[skeletonPulse_1.6s_var(--ease-smooth)_infinite]"
              style={{ width, animationDelay: `${index * 200}ms` }}
            />
            <span
              className="h-2.5 w-[38%] rounded-[6px] bg-[var(--fill-tertiary)] motion-safe:animate-[skeletonPulse_1.6s_var(--ease-smooth)_infinite]"
              style={{ animationDelay: `${index * 200}ms` }}
            />
          </span>
          <span
            className="h-6 w-11 flex-none rounded-[12px] bg-[var(--fill-tertiary)] motion-safe:animate-[skeletonPulse_1.6s_var(--ease-smooth)_infinite]"
            style={{ animationDelay: `${index * 200}ms` }}
          />
        </div>
      ))}
    </div>
  )
}

function EmptyState() {
  return (
    <div className="rounded-[var(--radius-xl)] bg-[var(--bg-secondary)] shadow-[var(--shadow-card)]" data-testid="plugins-empty">
      <div className="px-6 py-12 text-center">
        <h3 className="text-[length:var(--text-title3)] font-bold tracking-[var(--tracking-tight)] text-[var(--text-primary)]">
          No plugins installed
        </h3>
        <p className="mx-auto mt-2 max-w-[340px] text-[length:var(--text-subheadline)] leading-relaxed text-[var(--text-tertiary)]">
          Drop a plugin folder into <code className="font-[family-name:var(--font-code)]">~/.jinn/plugins/</code> and
          rescan. Only the ones you enable here ever run.
        </p>
      </div>
    </div>
  )
}

function LoadFailed({ error, onRetry }: { error: unknown; onRetry: () => void }) {
  return (
    <div
      className="rounded-[var(--radius-lg)] p-4 text-[length:var(--text-subheadline)] text-[var(--system-red)]"
      style={{ background: "color-mix(in srgb, var(--system-red) 8%, transparent)" }}
    >
      {error instanceof Error ? error.message : "Failed to load plugins"}
      <button type="button" onClick={onRetry} className="ml-3 font-medium underline">
        Retry
      </button>
    </div>
  )
}

export function PluginList({
  inventory,
  onToggle,
  onReveal,
}: {
  inventory: UseQueryResult<PluginInventoryRow[]>
  onToggle: (id: string, enabled: boolean) => void
  onReveal: (id: string) => void
}) {
  if (inventory.isLoading) return <ListSkeleton />
  if (inventory.isError) return <LoadFailed error={inventory.error} onRetry={() => void inventory.refetch()} />

  const plugins = inventory.data ?? []
  if (plugins.length === 0) return <EmptyState />

  return (
    <div className="rounded-[var(--radius-xl)] bg-[var(--bg-secondary)] p-[5px] shadow-[var(--shadow-card)]">
      {plugins.map((plugin) => (
        <PluginRow
          key={plugin.id}
          plugin={plugin}
          onToggle={(enabled) => onToggle(plugin.id, enabled)}
          onReveal={() => onReveal(plugin.id)}
        />
      ))}
    </div>
  )
}
