// Hand-drawn SVG visualisations (Recharts covers the plain bar charts). Each one turns numbers
// the screen already shows into a picture; the numbers stay next to it.
import clsx from 'clsx'
import { ArrowDown, ArrowUp, Minus } from 'lucide-react'
import { AnimatePresence, motion } from 'motion/react'
import { useEffect, useState } from 'react'
import { Link } from 'react-router-dom'
import { direction, fmtDelta, fmtValue, reading } from '../lib/compare'
import { FAILURE_LABELS, pct } from '../lib/format'
import { useMotionOn } from '../lib/prefs'
import type { CaseMatrix, ComparisonRow, Stage } from '../lib/types'
import { Term } from './ui'

const spring = { type: 'spring' as const, stiffness: 140, damping: 22 }

// --------------------------------------------------------------------------------------
// Sparkline
// --------------------------------------------------------------------------------------

export function Sparkline({ values, width = 120, height = 32, domain = [0, 1], className, label }: {
  values: (number | null)[]
  width?: number
  height?: number
  domain?: [number, number]
  className?: string
  label?: string
}) {
  const pts = values.map((v, i) => (v === null ? null : {
    x: values.length === 1 ? width / 2 : 4 + (i / (values.length - 1)) * (width - 8),
    y: height - 4 - ((v - domain[0]) / (domain[1] - domain[0] || 1)) * (height - 8),
  }))
  const real = pts.filter((p): p is { x: number; y: number } => p !== null)
  if (!real.length) return <span className="text-xs text-ink-3">no trend yet</span>
  const d = real.map((p, i) => `${i ? 'L' : 'M'}${p.x.toFixed(1)},${p.y.toFixed(1)}`).join(' ')
  const last = real[real.length - 1]
  const up = real.length > 1 && last.y < real[real.length - 2].y
  const down = real.length > 1 && last.y > real[real.length - 2].y
  return (
    <svg width={width} height={height} className={className} role="img" aria-label={label ?? 'trend'}>
      <line x1={0} x2={width} y1={height - 4} y2={height - 4} stroke="var(--line)" />
      <motion.path d={d} fill="none" stroke="var(--accent)" strokeWidth={1.75} strokeLinecap="round" strokeLinejoin="round"
        initial={{ pathLength: 0 }} animate={{ pathLength: 1 }} transition={{ duration: 0.9, ease: 'easeOut' }} />
      {real.slice(0, -1).map((p, i) => <circle key={i} cx={p.x} cy={p.y} r={1.6} fill="var(--accent)" opacity={0.5} />)}
      <motion.circle cx={last.x} cy={last.y} r={3.2} initial={{ scale: 0 }} animate={{ scale: 1 }} transition={{ delay: 0.8, ...spring }}
        fill={up ? 'var(--good)' : down ? 'var(--bad)' : 'var(--accent)'} stroke="var(--surface)" strokeWidth={1.5} />
    </svg>
  )
}

// --------------------------------------------------------------------------------------
// Forest plot: one row per metric, the paired change with its 95% interval around zero
// --------------------------------------------------------------------------------------

function niceMax(v: number): number {
  for (const s of [0.05, 0.1, 0.2, 0.3, 0.5, 0.75, 1]) if (v <= s) return s
  return Math.ceil(v)
}

export function ForestPlot({ rows, isHeuristic, onPick }: { rows: ComparisonRow[]; isHeuristic?: (metric: string) => boolean; onPick?: (r: ComparisonRow) => void }) {
  const ranged = rows.filter((r) => r.delta !== null && r.unit === 'rate')
  const max = niceMax(Math.max(0.05, ...ranged.flatMap((r) => [Math.abs(r.delta ?? 0), Math.abs(r.ci?.ci_low ?? 0), Math.abs(r.ci?.ci_high ?? 0)])))
  const W = 520
  const x = (v: number) => W / 2 + (v / max) * (W / 2 - 14)
  const ticks = [-max, -max / 2, 0, max / 2, max]
  if (!ranged.length) return null
  return (
    <div className="space-y-1" data-tour="forest">
      <div className="grid grid-cols-[minmax(0,200px)_minmax(0,1fr)_120px] items-end gap-3 px-1 text-[11px] text-ink-3 max-md:grid-cols-[minmax(0,1fr)_100px]">
        <span>Metric</span>
        <div className="relative h-4 max-md:hidden" aria-hidden>
          {ticks.map((t) => <span key={t} className="num absolute -translate-x-1/2 text-[10px]" style={{ left: `${(x(t) / W) * 100}%` }}>{t > 0 ? '+' : ''}{(t * 100).toFixed(0)}pp</span>)}
        </div>
        <span className="text-right">Change (95% interval)</span>
      </div>
      {ranged.map((r, i) => {
        const read = reading(r)
        const col = read.tone === 'good' ? 'var(--good)' : read.tone === 'bad' ? 'var(--bad)' : 'var(--ink-3)'
        const lo = r.ci?.ci_low ?? null
        const hi = r.ci?.ci_high ?? null
        const heur = isHeuristic?.(r.metric)
        return (
          <button key={r.metric} type="button" onClick={() => onPick?.(r)}
            className={clsx('grid w-full grid-cols-[minmax(0,200px)_minmax(0,1fr)_120px] items-center gap-3 rounded-md px-1 py-1 text-left hover:bg-surface-2 max-md:grid-cols-[minmax(0,1fr)_100px]', heur && 'hatched')}
            data-testid={`forest-${r.metric}`}>
            <span className="truncate text-[13px]">{r.label}{heur && <span className="ml-1 text-[11px] text-ink-3">(heuristic)</span>}</span>
            <svg viewBox={`0 0 ${W} 22`} className="h-[22px] w-full max-md:hidden" preserveAspectRatio="none" role="img"
              aria-label={`${r.label}: ${fmtDelta(r)}${lo !== null ? `, interval ${(lo * 100).toFixed(1)} to ${((hi ?? 0) * 100).toFixed(1)}` : ''}`}>
              <rect x={x(-max)} y={0} width={x(0) - x(-max)} height={22} fill="var(--bad)" opacity={0.035} />
              <rect x={x(0)} y={0} width={x(max) - x(0)} height={22} fill="var(--good)" opacity={0.035} />
              <line x1={x(0)} x2={x(0)} y1={0} y2={22} stroke="var(--line-strong)" strokeDasharray="2 3" />
              {lo !== null && hi !== null && (
                <motion.line y1={11} y2={11} stroke={col} strokeWidth={2.5} strokeLinecap="round"
                  initial={{ x1: x(0), x2: x(0) }} animate={{ x1: x(lo), x2: x(hi) }} transition={{ ...spring, delay: 0.05 * i }} />
              )}
              <motion.circle cy={11} r={5} fill={col} stroke="var(--surface)" strokeWidth={1.5}
                initial={{ cx: x(0), scale: 0.4 }} animate={{ cx: x(r.delta ?? 0), scale: 1 }} transition={{ ...spring, delay: 0.05 * i }} />
            </svg>
            <span className="text-right">
              <span className={clsx('num text-[13px] font-medium', read.tone === 'good' && 'text-good-ink', read.tone === 'bad' && 'text-bad-ink')}>{fmtDelta(r)}</span>
              <span className="block text-[11px] text-ink-3">
                {read.text === 'within noise' ? <Term k="within_noise">within noise</Term> : read.text === 'likely better' ? <Term k="likely_better">likely better</Term> : read.text === 'likely worse' ? <Term k="likely_worse">likely worse</Term> : read.text}
              </span>
            </span>
          </button>
        )
      })}
      <div className="flex justify-between px-1 pt-1 text-[11px] text-ink-3 max-md:hidden">
        <span className="ml-[calc(200px+0.75rem)] text-bad-ink">← worse</span>
        <span className="mr-[calc(120px+0.75rem)] text-good-ink">better →</span>
      </div>
    </div>
  )
}

/** Latency, tokens, cost: measured once, no interval. Arrow = which way the number moved; colour = better/worse. */
export function DeltaList({ rows }: { rows: ComparisonRow[] }) {
  const pts = rows.filter((r) => r.unit !== 'rate' && r.delta !== null)
  if (!pts.length) return null
  const max = Math.max(0.1, ...pts.map((r) => Math.abs(r.relative ?? 0)))
  return (
    <div className="space-y-1.5">
      {pts.map((r, i) => {
        const d = direction(r)
        const rel = r.relative ?? 0
        const Arrow = r.delta! > 0 ? ArrowUp : r.delta! < 0 ? ArrowDown : Minus
        return (
          <div key={r.metric} className="grid grid-cols-[minmax(0,200px)_minmax(0,1fr)_170px] items-center gap-3 px-1 text-[13px] max-md:grid-cols-[minmax(0,1fr)_150px]" data-testid={`metric-${r.metric}`}>
            <span className="truncate">{r.label}</span>
            <div className="relative h-2 rounded-full bg-surface-2 max-md:hidden">
              <span className="absolute inset-y-[-3px] left-1/2 w-px bg-line-strong" />
              <motion.span className={clsx('absolute inset-y-0 rounded-full', d === 'better' ? 'bg-good' : d === 'worse' ? 'bg-bad' : 'bg-ink-3')}
                initial={{ width: 0, left: '50%' }}
                animate={rel >= 0 ? { left: '50%', width: `${(rel / max) * 50}%` } : { left: `${50 + (rel / max) * 50}%`, width: `${(-rel / max) * 50}%` }}
                transition={{ ...spring, delay: 0.04 * i }} />
            </div>
            <span className="num flex items-center justify-end gap-1.5 text-right">
              <span className="text-xs text-ink-3">{fmtValue(r, r.baseline)} → {fmtValue(r, r.candidate)}</span>
              <span className={clsx('inline-flex items-center font-medium', d === 'better' && 'text-good-ink', d === 'worse' && 'text-bad-ink')}>
                <Arrow className="size-3.5" aria-label={r.delta! > 0 ? 'up' : r.delta! < 0 ? 'down' : 'same'} />{fmtDelta(r).replace(/^[+-]/, '')}
              </span>
            </span>
          </div>
        )
      })}
    </div>
  )
}

// --------------------------------------------------------------------------------------
// Verdict needle: the gauge swings to the measured change; the grey band is "could be noise"
// --------------------------------------------------------------------------------------

export function VerdictNeedle({ delta, low, high, size = 168, label }: { delta: number | null; low?: number | null; high?: number | null; size?: number; label?: string }) {
  const max = niceMax(Math.max(0.1, Math.abs(delta ?? 0), Math.abs(low ?? 0), Math.abs(high ?? 0)))
  const ang = (v: number) => (Math.max(-max, Math.min(max, v)) / max) * 90 // -90..90
  const r = size / 2 - 10
  const cx = size / 2
  const cy = size / 2 + 4
  const pt = (deg: number, rad = r) => [cx + rad * Math.sin((deg * Math.PI) / 180), cy - rad * Math.cos((deg * Math.PI) / 180)]
  const arc = (a: number, b: number, rad = r) => {
    const [x1, y1] = pt(a, rad)
    const [x2, y2] = pt(b, rad)
    return `M${x1},${y1} A${rad},${rad} 0 ${b - a > 180 ? 1 : 0} 1 ${x2},${y2}`
  }
  const target = delta === null ? 0 : ang(delta)
  return (
    <svg width={size} height={size / 2 + 18} viewBox={`0 0 ${size} ${size / 2 + 18}`} role="img" aria-label={label ?? 'verdict gauge'}>
      <path d={arc(-90, 0)} stroke="var(--bad)" strokeOpacity={0.28} strokeWidth={10} fill="none" />
      <path d={arc(0, 90)} stroke="var(--good)" strokeOpacity={0.28} strokeWidth={10} fill="none" />
      {low !== null && low !== undefined && high !== null && high !== undefined && (
        <motion.path d={arc(ang(low), ang(high))} stroke="var(--ink-3)" strokeOpacity={0.55} strokeWidth={10} fill="none"
          initial={{ pathLength: 0 }} animate={{ pathLength: 1 }} transition={{ duration: 0.6, delay: 0.2 }} />
      )}
      {[-90, -45, 0, 45, 90].map((t) => {
        const [x1, y1] = pt(t, r - 9)
        const [x2, y2] = pt(t, r - 15)
        return <line key={t} x1={x1} y1={y1} x2={x2} y2={y2} stroke="var(--line-strong)" strokeWidth={1.5} />
      })}
      <motion.g initial={{ rotate: -90 }} animate={{ rotate: target }} transition={{ type: 'spring', stiffness: 60, damping: 9, mass: 0.9 }}
        style={{ originX: 0.5, originY: 1 }}>
        <line x1={cx} y1={cy} x2={cx} y2={cy - r + 4} stroke="var(--ink)" strokeWidth={2.5} strokeLinecap="round" />
      </motion.g>
      <circle cx={cx} cy={cy} r={5} fill="var(--ink)" />
      <circle cx={cx} cy={cy} r={2} fill="var(--accent)" />
      <text x={cx - r} y={cy + 13} textAnchor="middle" className="fill-ink-3 text-[9px]">worse</text>
      <text x={cx + r} y={cy + 13} textAnchor="middle" className="fill-ink-3 text-[9px]">better</text>
    </svg>
  )
}

// --------------------------------------------------------------------------------------
// Gate stamp: lands once per run, then stays put
// --------------------------------------------------------------------------------------

export function Stamp({ status, runId }: { status: 'PASS' | 'FAIL' | 'INCOMPLETE' | 'NOT_EVALUATED'; runId: number }) {
  const motionOn = useMotionOn()
  const [first] = useState(() => {
    try {
      const k = `gl-stamped-${runId}-${status}`
      const seen = localStorage.getItem(k)
      localStorage.setItem(k, '1')
      return !seen
    } catch {
      return false
    }
  })
  const tone = status === 'PASS' ? 'text-good-ink border-good' : status === 'FAIL' ? 'text-bad-ink border-bad' : 'text-warn-ink border-warn'
  const text = status === 'NOT_EVALUATED' ? 'NOT EVALUATED' : status
  return (
    <motion.div className={clsx('inline-flex -rotate-6 select-none items-center rounded-md border-[3px] px-3 py-1 font-mono text-xl font-bold tracking-widest', tone)}
      style={{ boxShadow: 'inset 0 0 0 2px var(--surface)' }}
      initial={first && motionOn ? { scale: 2.4, opacity: 0, rotate: -18 } : false}
      animate={{ scale: 1, opacity: 1, rotate: -6 }}
      transition={{ type: 'spring', stiffness: 520, damping: 18, mass: 0.8 }}
      aria-label={`Gate ${text}`} data-testid="gate-stamp">
      {text}
    </motion.div>
  )
}

// --------------------------------------------------------------------------------------
// Confetti - kept for the rare, real win
// --------------------------------------------------------------------------------------

export function Confetti({ fire }: { fire: boolean }) {
  const motionOn = useMotionOn()
  const [pieces, setPieces] = useState<{ id: number; x: number; y: number; r: number; c: string; w: number; delay: number }[]>([])
  const on = pieces.length > 0
  useEffect(() => {
    if (!fire || !motionOn) return
    const start = setTimeout(() => setPieces(Array.from({ length: 70 }, (_, i) => ({
      id: i,
      x: (Math.random() - 0.5) * 900,
      y: -(200 + Math.random() * 380),
      r: (Math.random() - 0.5) * 720,
      c: ['var(--accent)', 'var(--good)', 'var(--series-1)', 'var(--series-2)', 'var(--warn)'][i % 5],
      w: 6 + Math.random() * 6,
      delay: Math.random() * 0.15,
    }))), 250)
    const stop = setTimeout(() => setPieces([]), 2900)
    return () => { clearTimeout(start); clearTimeout(stop) }
  }, [fire, motionOn])
  return (
    <AnimatePresence>
      {on && (
        <div className="pointer-events-none fixed inset-x-0 top-1/3 z-[95] flex justify-center" aria-hidden>
          {pieces.map((p) => (
            <motion.span key={p.id} className="absolute rounded-[2px]" style={{ background: p.c, width: p.w, height: p.w * 0.45 }}
              initial={{ x: 0, y: 0, rotate: 0, opacity: 1 }}
              animate={{ x: p.x, y: [0, p.y, p.y + 700], rotate: p.r, opacity: [1, 1, 0] }}
              transition={{ duration: 2.4, delay: p.delay, ease: [0.2, 0.8, 0.4, 1], times: [0, 0.35, 1] }} />
          ))}
        </div>
      )}
    </AnimatePresence>
  )
}

// --------------------------------------------------------------------------------------
// Pipeline stages: where failures start
// --------------------------------------------------------------------------------------

export function StagePipeline({ stages, onPick, selected }: { stages: Stage[]; onPick?: (s: Stage) => void; selected?: string | null }) {
  if (!stages.length) return <p className="text-[13px] text-ink-3">No stage was exercised by the checks in this run.</p>
  const max = Math.max(1, ...stages.map((s) => s.failures))
  return (
    <div className="flex flex-wrap items-stretch gap-1.5" data-tour="stages">
      {stages.map((s, i) => (
        <div key={s.id} className="flex items-center gap-1.5">
          {i > 0 && <span className="text-ink-3" aria-hidden>›</span>}
          <motion.button type="button" onClick={() => onPick?.(s)}
            initial={{ opacity: 0, y: 6 }} animate={{ opacity: 1, y: 0 }} transition={{ delay: i * 0.06 }}
            className={clsx('min-w-[118px] rounded-lg border px-3 py-2 text-left transition-colors',
              selected === s.id ? 'border-accent ring-2 ring-accent/25' : 'border-line hover:border-line-strong')}
            style={{ background: s.failures ? `color-mix(in srgb, var(--bad) ${Math.round(6 + (s.failures / max) * 22)}%, var(--surface))` : 'var(--surface)' }}
            title={Object.entries(s.types).map(([t, n]) => `${FAILURE_LABELS[t] ?? t}: ${n}`).join('\n') || `Checks: ${s.checks.join(', ')}`}>
            <div className="text-[11px] font-medium text-ink-2">{s.label}</div>
            <div className={clsx('num text-lg font-semibold leading-tight', s.failures ? 'text-bad-ink' : 'text-good-ink')}>{s.failures}</div>
            <div className="text-[11px] text-ink-3">{s.failures === 1 ? 'failure' : 'failures'}</div>
          </motion.button>
        </div>
      ))}
    </div>
  )
}

// --------------------------------------------------------------------------------------
// Case matrix: cases down, runs across. A row red in every run is often a bad golden answer.
// --------------------------------------------------------------------------------------

export function CaseMatrixView({ data, filter = 'all', focusCase }: { data: CaseMatrix; filter?: 'all' | 'changed' | 'always_fail' | 'flaky'; focusCase?: string | null }) {
  const always = new Set(data.always_fail)
  const rows = data.cases.filter((c) => {
    const row = data.cells[c.id] ?? {}
    const vals = Object.values(row)
    if (!vals.length) return filter === 'all'
    if (filter === 'always_fail') return always.has(c.id)
    if (filter === 'flaky') return vals.some((v) => v.passed > 0 && v.passed < v.total)
    if (filter === 'changed') {
      const states = new Set(vals.map((v) => (v.passed === v.total ? 'p' : v.passed === 0 ? 'f' : 'm')))
      return states.size > 1
    }
    return true
  })
  return (
    <div className="scroll-thin max-h-[70vh] overflow-auto" data-tour="matrix">
      <table className="border-separate border-spacing-0 text-[12px]">
        <thead className="sticky top-0 z-10 bg-surface">
          <tr>
            <th className="sticky left-0 z-20 min-w-[220px] border-b border-line bg-surface px-3 py-2 text-left text-xs font-medium text-ink-3">Case</th>
            {data.runs.map((r) => (
              <th key={r.id} className="border-b border-line px-1 py-2 align-bottom" title={`${r.name}\n${r.target} - ${r.variant}\njudge: ${r.judge ?? 'none'}`}>
                <Link to={`/runs/${r.id}`} className="flex flex-col items-center gap-0.5 font-mono text-[11px] text-accent-ink hover:underline">
                  #{r.id}
                  <span className="num text-[10px] text-ink-3">{pct(r.pass_rate, 0)}</span>
                </Link>
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.map((c) => (
            <tr key={c.id} className={clsx(focusCase === c.id && 'bg-accent-wash')}>
              <td className="sticky left-0 z-[5] max-w-[280px] border-b border-line bg-surface px-3 py-1">
                <div className="flex items-center gap-2">
                  <span className="font-mono text-[11px]">{c.id}</span>
                  {always.has(c.id) && <span className="rounded bg-bad-wash px-1 text-[10px] text-bad-ink" title="Failed in every run: check the golden answer">always fails</span>}
                </div>
                <div className="truncate text-[11px] text-ink-3">{c.title}</div>
              </td>
              {data.runs.map((r, ri) => {
                const v = data.cells[c.id]?.[String(r.id)]
                const state = !v ? 'none' : v.errors ? 'error' : v.passed === v.total ? 'pass' : v.passed === 0 ? 'fail' : 'flaky'
                return (
                  <td key={r.id} className="border-b border-line px-1 py-1 text-center">
                    <Link to={`/runs/${r.id}?tab=cases&case=${encodeURIComponent(c.id)}`} title={v ? `#${r.id}: ${v.passed}/${v.total} passed` : `#${r.id}: not in this run`}
                      className="inline-block">
                      <motion.span initial={{ scale: 0.3, opacity: 0 }} animate={{ scale: 1, opacity: 1 }} transition={{ delay: Math.min(ri * 0.03, 0.4), duration: 0.18 }}
                        className={clsx('block size-5 rounded-[4px]',
                          state === 'pass' && 'bg-good', state === 'fail' && 'bg-bad', state === 'flaky' && 'bg-flaky',
                          state === 'error' && 'bg-error', state === 'none' && 'border border-dashed border-untested',
                          r.judge === 'heuristic' && state !== 'none' && 'hatched-light')} />
                    </Link>
                  </td>
                )
              })}
            </tr>
          ))}
        </tbody>
      </table>
      {!rows.length && <p className="p-4 text-[13px] text-ink-3">No case matches this filter.</p>}
    </div>
  )
}

export function MatrixLegend() {
  const item = (cls: string, label: string) => <span className="flex items-center gap-1.5"><span className={clsx('size-3 rounded-[3px]', cls)} />{label}</span>
  return (
    <div className="flex flex-wrap gap-x-4 gap-y-1 text-[11px] text-ink-3">
      {item('bg-good', 'passed every trial')}{item('bg-flaky', 'flaky')}{item('bg-bad', 'failed every trial')}{item('bg-error', 'error')}
      {item('border border-dashed border-untested', 'not in the run')}{item('bg-good hatched-light', 'run graded by the heuristic judge')}
    </div>
  )
}

// --------------------------------------------------------------------------------------
// Live run: one tile per trial, flipping as results arrive
// --------------------------------------------------------------------------------------

export function LiveGrid({ total, done, statuses }: { total: number; done: number; statuses: { key: string; status: string; caseId: string }[] }) {
  const tiles = Array.from({ length: Math.max(total, statuses.length) }, (_, i) => statuses[i] ?? null)
  return (
    <div className="flex flex-wrap gap-[3px]" aria-label={`${done} of ${total} trials finished`}>
      {tiles.map((t, i) => (
        <motion.span key={t?.key ?? `pending-${i}`} title={t ? `${t.caseId}: ${t.status}` : 'waiting'}
          initial={t ? { rotateY: 90, opacity: 0.4 } : false} animate={{ rotateY: 0, opacity: 1 }} transition={{ duration: 0.35 }}
          className={clsx('size-3.5 rounded-[3px]', !t && 'bg-surface-3', t?.status === 'passed' && 'bg-good', t?.status === 'failed' && 'bg-bad',
            t?.status === 'error' && 'bg-error', t && !['passed', 'failed', 'error'].includes(t.status) && 'bg-untested')} />
      ))}
    </div>
  )
}
