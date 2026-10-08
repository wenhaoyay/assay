// B3 Every question, before and after: two fingerprints in the same order; Replay turns the
// candidate's dots over one by one and pulses the ones that change.
import { RotateCcw } from 'lucide-react'
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { PairedCase } from '../../lib/compare'
import { useMotionOn } from '../../lib/prefs'
import { cellState, Fingerprint, FingerprintLegend, type Cell } from '../instrument'
import { Button, Card } from '../ui'

export function Replay({ cases, baseId, candId }: { cases: PairedCase[]; baseId: number; candId: number }) {
  const motionOn = useMotionOn()
  const shared = useMemo(() => cases.filter((c) => c.a && c.b), [cases])
  const baseCells: Cell[] = useMemo(() => shared.map((c) => ({ id: c.id, title: c.title, ...c.a! })), [shared])
  const candCells: Cell[] = useMemo(() => shared.map((c) => ({ id: c.id, title: c.title, ...c.b! })), [shared])
  const changes = useMemo(() => shared.map((c) => {
    const a = cellState(c.a)
    const b = cellState(c.b)
    return a === b ? 0 : c.d > 0 ? 1 : c.d < 0 ? -1 : 0
  }), [shared])
  // How many of the candidate's dots have turned so far (all of them at rest).
  const [turned, setTurned] = useState(() => (motionOn ? 0 : shared.length))
  const [flipped, setFlipped] = useState<Set<string>>(new Set())
  const timers = useRef<number[]>([])
  const replay = useCallback(() => {
    timers.current.forEach(window.clearTimeout)
    timers.current = []
    if (!motionOn) { setTurned(shared.length); setFlipped(new Set()); return }
    setTurned(0)
    setFlipped(new Set())
    shared.forEach((c, i) => {
      timers.current.push(window.setTimeout(() => {
        setTurned(i + 1)
        if (changes[i] !== 0) setFlipped((s) => new Set(s).add(c.id))
      }, 400 + i * 45))
    })
  }, [motionOn, shared, changes])
  // Play once on first view (the cleanup also cancels the first of StrictMode's two mounts).
  useEffect(() => {
    if (!motionOn || !shared.length) return
    const t = window.setTimeout(replay, 300)
    const pending = timers
    return () => { window.clearTimeout(t); pending.current.forEach(window.clearTimeout) }
  }, [motionOn, replay, shared.length])

  const shown = candCells.map((c, i) => (i < turned ? c : baseCells[i]))
  const better = changes.slice(0, turned).filter((x) => x > 0).length
  const worse = changes.slice(0, turned).filter((x) => x < 0).length
  const row = (dot: string, label: string) => (
    <div className="flex items-center gap-2 text-sm text-ink-2"><span className={`size-2 rounded-full ${dot}`} />{label}</div>
  )
  return (
    <Card title="Every question, before and after"
      help={<>
        <p>One dot per question, #{baseId} above #{candId}, in the same order. Green passed every try, amber some, red none.</p>
        <p>Replay turns #{candId}'s dots over one by one; the ones that change pulse. Hover a dot to light that question everywhere on the page; click it to open the answer.</p>
      </>}
      actions={<>
        <span className="num font-mono text-xs" aria-live="polite" data-testid="replay-count">
          <span className="text-good-ink">{better} better</span><span className="text-ink-3"> · </span><span className="text-bad-ink">{worse} worse</span>
        </span>
        <Button size="sm" onClick={replay} data-testid="replay"><RotateCcw className="size-3.5" />Replay</Button>
      </>}>
      <div className="grid grid-cols-[120px_minmax(0,1fr)] items-center gap-x-4 gap-y-3 max-sm:grid-cols-1">
        {row('bg-series-1', `#${baseId} baseline`)}
        <Fingerprint cells={baseCells} size="lg" hrefFor={(id) => { const t = shared.find((c) => c.id === id)?.aTrial; return t ? `/trials/${t}` : null }} label={`Run #${baseId}, one dot per question`} />
        {row('bg-series-2', `#${candId} candidate`)}
        <Fingerprint cells={shown} size="lg" flipped={flipped} hrefFor={(id) => { const t = shared.find((c) => c.id === id)?.bTrial; return t ? `/trials/${t}` : null }} label={`Run #${candId}, one dot per question`} />
      </div>
      <FingerprintLegend className="mt-3" />
    </Card>
  )
}
