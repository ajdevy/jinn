import { useState, type FormEvent } from "react"
import { LoaderCircle } from "lucide-react"
import { pairAndInstallNativeGateway, pairNativeGatewayProfile } from "@/lib/native-gateway-bootstrap"
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog"

function PairingFields({
  origin,
  code,
  onOrigin,
  onCode,
}: {
  origin: string
  code: string
  onOrigin: (value: string) => void
  onCode: (value: string) => void
}) {
  return <>
    <label className="mt-6 block text-footnote font-medium text-foreground" htmlFor="native-gateway-origin">Gateway origin</label>
    <input
      id="native-gateway-origin"
      className="mt-2 h-10 w-full rounded-lg border border-border bg-background px-3 text-subheadline text-foreground"
      inputMode="url"
      value={origin}
      onChange={(event) => onOrigin(event.target.value)}
      placeholder="http://127.0.0.1:7779"
      required
    />
    <label className="mt-4 block text-footnote font-medium text-foreground" htmlFor="native-pair-code">Pair code</label>
    <input
      id="native-pair-code"
      className="mt-2 h-10 w-full rounded-lg border border-border bg-background px-3 font-mono text-subheadline uppercase text-foreground"
      value={code}
      onChange={(event) => onCode(event.target.value)}
      autoComplete="one-time-code"
      placeholder="ABCD-EFGH-JKLM"
      required
    />
  </>
}

export function NativePairingDialog({ open, onOpenChange }: { open: boolean; onOpenChange: (open: boolean) => void }) {
  const [origin, setOrigin] = useState("http://127.0.0.1:7779")
  const [code, setCode] = useState("")
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string>()

  async function submit(event: FormEvent) {
    event.preventDefault()
    setBusy(true)
    setError(undefined)
    try {
      await pairNativeGatewayProfile(origin.trim(), code.trim())
      onOpenChange(false)
      setCode("")
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "Pairing failed")
    } finally {
      setBusy(false)
    }
  }

  return (
    <Dialog open={open} onOpenChange={(next) => { if (!busy) onOpenChange(next) }}>
      <DialogContent className="w-[min(420px,calc(100vw-24px))] gap-0 rounded-[var(--radius-xl)] border-0 bg-[var(--material-regular)] p-2 shadow-[var(--shadow-overlay)]">
        <form onSubmit={(event) => void submit(event)}>
          <div className="p-5">
            <DialogHeader className="gap-2 text-left">
              <DialogTitle>Add gateway</DialogTitle>
              <DialogDescription>Pair another Jinn gateway. It stays inactive until you choose it.</DialogDescription>
            </DialogHeader>
            <PairingFields origin={origin} code={code} onOrigin={setOrigin} onCode={setCode} />
            {error && <p className="mt-3 text-footnote text-destructive" role="alert">{error}</p>}
          </div>
          <DialogFooter className="rounded-[var(--radius-lg)] bg-[var(--fill-quaternary)] p-3 sm:items-center">
            <button type="button" disabled={busy} onClick={() => onOpenChange(false)} className="min-h-10 rounded-[var(--radius-md)] px-4 text-subheadline text-[var(--text-secondary)]">Cancel</button>
            <button type="submit" disabled={busy || !origin.trim() || !code.trim()} className="inline-flex min-h-10 min-w-[132px] items-center justify-center gap-2 rounded-[var(--radius-md)] bg-[var(--accent)] px-4 text-subheadline font-semibold text-white disabled:opacity-45">
              {busy && <LoaderCircle size={16} className="animate-spin" aria-hidden />}
              {busy ? "Pairing…" : "Pair gateway"}
            </button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  )
}

export function NativePairingScreen({ onPaired }: { onPaired: (origin: string) => void }) {
  const [origin, setOrigin] = useState("http://127.0.0.1:7779")
  const [code, setCode] = useState("")
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string>()

  async function submit(event: FormEvent) {
    event.preventDefault()
    setBusy(true)
    setError(undefined)
    try {
      onPaired(await pairAndInstallNativeGateway(origin.trim(), code.trim()))
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "Pairing failed")
    } finally {
      setBusy(false)
    }
  }

  return (
    <main className="flex min-h-dvh items-center justify-center bg-background p-6">
      <form className="w-full max-w-md rounded-2xl border border-border bg-card p-6 shadow-sm" onSubmit={(event) => void submit(event)}>
        <div className="text-title-2 font-semibold text-foreground">Connect Jinn</div>
        <p className="mt-2 text-subheadline text-muted-foreground">
          Add the gateway running on this Mac. HTTP is accepted only for loopback; other gateways require HTTPS.
        </p>
        <PairingFields origin={origin} code={code} onOrigin={setOrigin} onCode={setCode} />
        {error && <p className="mt-3 text-footnote text-destructive" role="alert">{error}</p>}
        <button
          type="submit"
          disabled={busy || !origin.trim() || !code.trim()}
          className="mt-6 h-10 w-full rounded-lg bg-[var(--accent)] px-4 text-subheadline font-medium text-white disabled:opacity-50"
        >
          {busy ? "Pairing…" : "Pair gateway"}
        </button>
      </form>
    </main>
  )
}
