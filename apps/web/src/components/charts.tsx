// Charts follow the dataviz rules: thin marks with rounded data-ends, one axis, a legend
// for two series plus a table view nearby, recessive grid, hover tooltips, text in ink
// tokens (never the series colour). Baseline = series 1 (blue), candidate = series 2 (orange).
import { Bar, BarChart, CartesianGrid, Cell, Legend, ResponsiveContainer, Tooltip, XAxis, YAxis } from 'recharts'
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
    <div className="rounded-md border border-line bg-surface px-3 py-2 text-xs shadow-sm">
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

/** Baseline vs candidate pass rate per group (category, difficulty...). */
export function PairedBars({ data, height = 260 }: {
  data: { group: string; baseline: number | null; candidate: number | null; n?: number }[]
  height?: number
}) {
  return (
    <ResponsiveContainer width="100%" height={height}>
      <BarChart data={data} margin={{ top: 8, right: 8, bottom: 0, left: -12 }} barGap={2} barCategoryGap="22%">
        <CartesianGrid vertical={false} stroke="var(--line)" />
        <XAxis dataKey="group" {...axis} interval={0} />
        <YAxis {...axis} axisLine={false} domain={[0, 1]} tickFormatter={(v: number) => `${Math.round(v * 100)}%`} />
        <Tooltip cursor={{ fill: 'var(--surface-2)' }} content={<TooltipBox format={(v) => pct(v)} />} />
        <Legend iconType="square" iconSize={10} wrapperStyle={{ fontSize: 12, color: 'var(--ink-2)' }} />
        <Bar dataKey="baseline" name="Baseline" fill="var(--series-1)" radius={[4, 4, 0, 0]} maxBarSize={28} />
        <Bar dataKey="candidate" name="Candidate" fill="var(--series-2)" radius={[4, 4, 0, 0]} maxBarSize={28} />
      </BarChart>
    </ResponsiveContainer>
  )
}

/** One series, horizontal: counts per failure type. Clicking a bar filters. */
export function CountBars({ data, onSelect, selected, height }: {
  data: { key: string; label: string; value: number }[]
  onSelect?: (key: string) => void
  selected?: string | null
  height?: number
}) {
  const h = height ?? Math.max(120, data.length * 30 + 24)
  return (
    <ResponsiveContainer width="100%" height={h}>
      <BarChart data={data} layout="vertical" margin={{ top: 0, right: 32, bottom: 0, left: 8 }} barCategoryGap={6}>
        <XAxis type="number" hide allowDecimals={false} />
        <YAxis type="category" dataKey="label" width={170} {...axis} axisLine={false} />
        <Tooltip cursor={{ fill: 'var(--surface-2)' }} content={<TooltipBox format={(v) => `${v ?? 0} trials`} />} />
        <Bar
          dataKey="value"
          name="Failed trials"
          radius={[0, 4, 4, 0]}
          maxBarSize={18}
          label={{ position: 'right', fill: 'var(--ink-2)', fontSize: 11 }}
          onClick={(d) => {
            const key = (d as { payload?: { key?: string } }).payload?.key
            if (key) onSelect?.(key)
          }}
          style={{ cursor: onSelect ? 'pointer' : 'default' }}
        >
          {data.map((d) => (
            <Cell key={d.key} fill="var(--series-1)" fillOpacity={selected && selected !== d.key ? 0.35 : 1} />
          ))}
        </Bar>
      </BarChart>
    </ResponsiveContainer>
  )
}

/** A rate with its 95% interval drawn as a thin track: makes overlap visible at a glance. */
export function IntervalBar({ value, low, high }: { value: number | null; low: number | null; high: number | null }) {
  if (value === null) return <span className="text-ink-3">n/a</span>
  return (
    <div className="relative h-2 w-28 rounded-full bg-surface-2" title={`${pct(value)} (95% CI ${pct(low)} to ${pct(high)})`}>
      {low !== null && high !== null && (
        <div className="absolute inset-y-0 rounded-full bg-series-1/30" style={{ left: `${low * 100}%`, width: `${Math.max(1, (high - low) * 100)}%` }} />
      )}
      <div className="absolute -top-0.5 h-3 w-0.5 rounded bg-series-1" style={{ left: `calc(${value * 100}% - 1px)` }} />
    </div>
  )
}
