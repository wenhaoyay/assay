// A run picker: a quiet panel with the series dot, the run and its setup; opens a filterable list.
import clsx from 'clsx'
import { ChevronDown } from 'lucide-react'
import { AnimatePresence, motion } from 'motion/react'
import { useEffect, useRef, useState } from 'react'
import { pct } from '../../lib/format'
import type { RunHeader } from '../../lib/types'
import { Input } from '../ui'
import { Stamp } from '../viz'

const judgeName = (r: RunHeader) => (r.judge ? (r.judge.provider === 'heuristic' ? 'heuristic judge' : r.judge.model) : 'no judge')

export function RunPicker({ runs, value, onChange, side }: { runs: RunHeader[]; value: number | null; onChange: (id: number) => void; side: 'baseline' | 'candidate' }) {
  const [open, setOpen] = useState(false)
  const [q, setQ] = useState('')
  const ref = useRef<HTMLDivElement>(null)
  useEffect(() => {
    if (!open) return
    const close = (e: MouseEvent) => { if (!ref.current?.contains(e.target as Node)) setOpen(false) }
    const esc = (e: KeyboardEvent) => { if (e.key === 'Escape') setOpen(false) }
    window.addEventListener('mousedown', close)
    window.addEventListener('keydown', esc)
    return () => { window.removeEventListener('mousedown', close); window.removeEventListener('keydown', esc) }
  }, [open])
  const cur = runs.find((r) => r.id === value)
  const list = runs.filter((r) => !q || `${r.id} ${r.experiment} ${r.target} ${r.variant_label}`.toLowerCase().includes(q.toLowerCase()))
  const dot = side === 'baseline' ? 'bg-series-1' : 'bg-series-2'
  return (
    <div className="relative min-w-0 flex-1" ref={ref}>
      <button type="button" onClick={() => setOpen((v) => !v)} aria-label={side} aria-expanded={open}
        className="flex min-h-[60px] w-full items-center gap-3 rounded-xl border border-line bg-surface px-3.5 py-2.5 text-left shadow-card transition-colors hover:border-line-strong">
        <span className={clsx('size-2.5 shrink-0 rounded-full', dot)} />
        <span className="min-w-0 flex-1">
          <span className="t-label block">{side}{cur && <> · <span className="font-mono">#{cur.id}</span></>}</span>
          {cur ? (
            <span className="mt-0.5 block truncate text-sm text-ink" title={`${cur.experiment} · ${cur.target} v${cur.target_version} · ${cur.n_cases} × ${cur.trials_per_case} · ${judgeName(cur)}`}>
              {cur.variant_label || cur.experiment}
              <span className="text-ink-3"> · {cur.target} v<span className="font-mono">{cur.target_version}</span> · <span className="font-mono">{cur.n_cases}×{cur.trials_per_case}</span> · {judgeName(cur)}</span>
            </span>
          ) : <span className="mt-0.5 block text-sm text-ink-3">Choose a run…</span>}
        </span>
        {side === 'candidate' && cur?.gate_status && <span className="shrink-0 origin-right scale-[0.8]"><Stamp status={cur.gate_status} runId={cur.id} /></span>}
        <ChevronDown className={clsx('size-4 shrink-0 text-ink-3 transition-transform', open && 'rotate-180')} />
      </button>
      <AnimatePresence>
        {open && (
          <motion.div initial={{ opacity: 0, y: -4 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0, y: -4 }} transition={{ duration: 0.12 }}
            className="absolute z-30 mt-1 w-full min-w-[340px] rounded-xl border border-line bg-surface p-1.5 shadow-pop">
            <Input autoFocus placeholder="Filter runs" value={q} onChange={(e) => setQ(e.target.value)} className="mb-1" />
            <ul className="scroll-thin max-h-80 overflow-y-auto">
              {list.map((r) => (
                <li key={r.id}>
                  <button type="button" onClick={() => { onChange(r.id); setOpen(false) }}
                    className={clsx('flex w-full items-baseline gap-2 rounded-lg px-2.5 py-1.5 text-left hover:bg-surface-2', r.id === value && 'bg-accent-wash')}>
                    <span className="w-9 shrink-0 font-mono text-xs text-ink-3">#{r.id}</span>
                    <span className="min-w-0 flex-1">
                      <span className="block truncate text-sm">{r.variant_label || r.experiment}</span>
                      <span className="block truncate text-xs text-ink-3">{r.target} · {r.dataset} · {judgeName(r)}{r.off_topic && <span className="text-warn-ink"> · asked {r.off_topic}'s questions</span>}</span>
                    </span>
                    <span className="num shrink-0 font-mono text-xs text-ink-2">{pct(r.metrics.overall_pass_rate, 0)}</span>
                  </button>
                </li>
              ))}
              {!list.length && <li className="px-2.5 py-2 text-sm text-ink-3">No run matches.</li>}
            </ul>
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  )
}
