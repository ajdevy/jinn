export type ProactiveCueOutcome = "completed" | "interrupted"
export type ProactiveCueSettled = (outcome: ProactiveCueOutcome) => void

interface PendingCue {
  receiptId: string
  summary: string
  settled: ProactiveCueSettled
}

/** Keeps provider speech and durable proactive receipts in the same lifecycle. */
export class DriverProactiveCues {
  private readonly seen = new Set<string>()
  private readonly pending: PendingCue[] = []
  private active: PendingCue | null = null
  private stopped = false

  constructor(
    private readonly send: (event: Record<string, unknown>) => void,
    private readonly onThinking: () => void,
  ) {}

  accept(summary: string, receiptId: string, settled: ProactiveCueSettled, busy: boolean): boolean {
    if (this.stopped) return false
    if (this.seen.has(receiptId)) return true
    this.seen.add(receiptId)
    this.pending.push({ summary, receiptId, settled })
    return busy ? true : this.flush()
  }

  flush(): boolean {
    if (this.stopped || this.active) return !this.stopped
    const next = this.pending.shift()
    if (!next) return true
    this.active = next
    this.onThinking()
    try {
      this.send({
        type: "response.create",
        response: { instructions: `Briefly tell the operator: ${next.summary}` },
      })
      return true
    } catch {
      this.active = null
      this.seen.delete(next.receiptId)
      return false
    }
  }

  settle(outcome: ProactiveCueOutcome): void {
    const active = this.active
    if (!active) return
    this.active = null
    active.settled(outcome)
  }

  stop(): void {
    this.stopped = true
    this.settle("interrupted")
    for (const cue of this.pending) this.seen.delete(cue.receiptId)
    this.pending.length = 0
  }
}
