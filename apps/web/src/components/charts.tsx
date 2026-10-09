// Small charts that follow the dataviz rules: thin marks with rounded data-ends, one axis, a
// recessive grid, text in ink tokens (never the series colour). Baseline = series 1 (blue),
// candidate = series 2 (orange). The larger charts are hand-drawn in viz.tsx and run/.
import { pct } from '../lib/format'

/** The one way a rate (0..1) reads on a chart axis: "50%". */
export const pctTick = (v: number) => `${Math.round(v * 100)}%`

/** A rate with its 95% interval as a thin track (0-100%, with 50% marked) - overlap is visible at a glance. */
export function IntervalBar({ value, low, high, axis: showAxis = false }: { value: number | null; low: number | null; high: number | null; axis?: boolean }) {
  if (value === null) return <span className="text-xs text-ink-3">not reported</span>
  return (
    <div className="w-32">
      <div className="relative h-2 rounded-full bg-surface-2" title={`${pct(value)} (95% interval ${pct(low)} to ${pct(high)})`}>
        <div className="absolute inset-y-[-2px] left-1/2 w-px bg-line-strong" aria-hidden />
        {low !== null && high !== null && (
          <div className="absolute inset-y-0 rounded-full bg-accent/30" style={{ left: `${low * 100}%`, width: `${Math.max(1, (high - low) * 100)}%` }} />
        )}
        <div className="absolute -top-0.5 h-3 w-0.5 rounded bg-accent" style={{ left: `calc(${value * 100}% - 1px)` }} />
      </div>
      {showAxis && <div className="mt-0.5 flex justify-between font-mono text-label leading-none text-ink-3"><span>{pctTick(0)}</span><span>{pctTick(0.5)}</span><span>{pctTick(1)}</span></div>}
    </div>
  )
}
