// Charts follow the dataviz rules: thin marks with rounded data-ends, one axis, a legend for two
// series plus a table view nearby, recessive grid, hover tooltips, text in ink tokens (never the
// series colour). Baseline = series 1 (blue), candidate = series 2 (orange).
import clsx from 'clsx'
import { motion } from 'motion/react'
import { Bar, BarChart, CartesianGrid, Legend, ResponsiveContainer, Tooltip, XAxis, YAxis } from 'recharts'
import { pct } from '../lib/format'

const axis = { stroke: 'var(--line-strong)', tick: { fill: 'var(--ink-3)', fontSize: 11 }, tickLine: false }

function TooltipBox({ active, payload, label, format }: {
  active?: boolean
  payload?: { name: string; value: number | null; color: string; payload: Record<string, unknown> }[]
  label?: string
  format: (v: number | null) => string
}) {
  if (!active || !payload?.length) return null
  const n = payload[0]?.payload?.n
  return (
    <div className="rounded-lg border border-line bg-surface px-3 py-2 text-xs shadow-pop">
      <div className="mb-1 font-medium text-ink">{label}</div>
      {payload.map((p) => (
        <div key={p.name} className="flex items-center gap-2 text-ink-2">
          <span className="size-2 rounded-sm" style={{ background: p.color }} aria-hidden />
          <span>{p.name}</span>
          <span className="num ml-auto pl-3 font-medium text-ink">{format(p.value)}</span>
        </div>
      ))}
      {typeof n === 'number' && <div className="mt-1 text-ink-3">n = {n} cases</div>}
    </div>
  )
}

/** Pass rate per group (category...): baseline vs candidate, or one series with ``single``. */
export function PairedBars({ data, height = 260, single = false }: {
  data: { group: string; baseline: number | null; candidate: number | null; n?: number }[]
  height?: number
  single?: boolean
}) {
  return (
    <ResponsiveContainer width="100%" height={height}>
      <BarChart data={data} margin={{ top: 8, right: 8, bottom: 0, left: -12 }} barGap={2} barCategoryGap="22%">
        <CartesianGrid vertical={false} stroke="var(--line)" />
        <XAxis dataKey="group" {...axis} interval={0} />
        <YAxis {...axis} axisLine={false} domain={[0, 1]} tickFormatter={(v: number) => `${Math.round(v * 100)}%`} />
        <Tooltip cursor={{ fill: 'var(--surface-2)' }} content={<TooltipBox format={(v) => pct(v)} />} />
        {!single && <Legend iconType="square" iconSize={10} wrapperStyle={{ fontSize: 12, color: 'var(--ink-2)' }} />}
        {!single && <Bar dataKey="baseline" name="Baseline" fill="var(--series-1)" radius={[4, 4, 0, 0]} maxBarSize={28} />}
        <Bar dataKey="candidate" name={single ? 'Pass rate' : 'Candidate'} fill={single ? 'var(--accent)' : 'var(--series-2)'} radius={[4, 4, 0, 0]} maxBarSize={single ? 40 : 28} />
      </BarChart>
    </ResponsiveContainer>
  )
}

/** Counts per failure type as clickable bars (each bar is a button: click or Enter filters). */
export function CountBars({ data, onSelect, selected }: {
  data: { key: string; label: string; value: number }[]
  onSelect?: (key: string) => void
  selected?: string | null
}) {
  const max = Math.max(1, ...data.map((d) => d.value))
  return (
    <ul className="space-y-1">
      {data.map((d, i) => (
        <li key={d.key}>
          <button type="button" onClick={() => onSelect?.(d.key)} aria-pressed={selected === d.key}
            className={clsx('grid w-full grid-cols-[minmax(0,150px)_minmax(0,1fr)_36px] items-center gap-2 rounded-md px-1.5 py-1 text-left text-[13px] transition-colors hover:bg-surface-2',
              selected === d.key && 'bg-bad-wash', selected && selected !== d.key && 'opacity-50')}>
            <span className="truncate">{d.label}</span>
            <span className="h-2.5 overflow-hidden rounded-full bg-surface-2">
              <motion.span className="block h-full rounded-full bg-bad/75" initial={{ width: 0 }} animate={{ width: `${(d.value / max) * 100}%` }}
                transition={{ type: 'spring', stiffness: 120, damping: 20, delay: i * 0.03 }} />
            </span>
            <span className="num text-right text-xs text-ink-2">{d.value}</span>
          </button>
        </li>
      ))}
    </ul>
  )
}

/** A rate with its 95% interval as a thin track (0-100%, with 50% marked) - overlap is visible at a glance. */
export function IntervalBar({ value, low, high, axis: showAxis = false }: { value: number | null; low: number | null; high: number | null; axis?: boolean }) {
  if (value === null) return <span className="text-ink-3">n/a</span>
  return (
    <div className="w-32">
      <div className="relative h-2 rounded-full bg-surface-2" title={`${pct(value)} (95% interval ${pct(low)} to ${pct(high)})`}>
        <div className="absolute inset-y-[-2px] left-1/2 w-px bg-line-strong" aria-hidden />
        {low !== null && high !== null && (
          <div className="absolute inset-y-0 rounded-full bg-accent/30" style={{ left: `${low * 100}%`, width: `${Math.max(1, (high - low) * 100)}%` }} />
        )}
        <div className="absolute -top-0.5 h-3 w-0.5 rounded bg-accent" style={{ left: `calc(${value * 100}% - 1px)` }} />
      </div>
      {showAxis && <div className="mt-0.5 flex justify-between text-[9px] leading-none text-ink-3"><span>0</span><span>50%</span><span>100</span></div>}
    </div>
  )
}
