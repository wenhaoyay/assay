// Hand-drawn SVG visualisations (Recharts covers the plain bar charts). Each one turns numbers
// the screen already shows into a picture; the numbers stay next to it.
import clsx from 'clsx'
import { AnimatePresence, motion } from 'motion/react'
import { useEffect, useState } from 'react'
import { Link } from 'react-router-dom'
import { direction, fmtDelta, fmtValue, reading } from '../lib/compare'
import { FAILURE_LABELS, pct } from '../lib/format'
import { useMotionOn } from '../lib/prefs'
import type { CaseMatrix, ComparisonRow, Stage } from '../lib/types'
import { useWidth } from './compare/useWidth'
import { RowDelta } from './compare/delta'
import { Needle } from './instrument'
import { Badge, STATE_DOT, Term } from './ui'

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
  const motionOn = useMotionOn()
  const pts = values.map((v, i) => (v === null ? null : {
    x: values.length === 1 ? width / 2 : 4 + (i / (values.length - 1)) * (width - 8),
    y: height - 4 - ((v - domain[0]) / (domain[1] - domain[0] || 1)) * (height - 8),
  }))
  const real = pts.filter((p): p is { x: number; y: number } => p !== null)
  if (!real.length) return <span className="text-xs text-ink-3">No trend yet</span>
  const d = real.map((p, i) => `${i ? 'L' : 'M'}${p.x.toFixed(1)},${p.y.toFixed(1)}`).join(' ')
  const last = real[real.length - 1]
  const up = real.length > 1 && last.y < real[real.length - 2].y
  const down = real.length > 1 && last.y > real[real.length - 2].y
  return (
    <svg width={width} height={height} className={className} role="img" aria-label={label ?? 'trend'}>
      <line x1={0} x2={width} y1={height - 4} y2={height - 4} stroke="var(--line)" strokeDasharray="2 3" />
      {real.length === 1 && <line x1={4} x2={width - 4} y1={last.y} y2={last.y} stroke="var(--accent)" strokeDasharray="2 3" opacity={0.5} />}
      <motion.path d={d} fill="none" stroke="var(--accent)" strokeWidth={1.5} strokeLinecap="round" strokeLinejoin="round"
        initial={motionOn ? { pathLength: 0 } : false} animate={{ pathLength: 1 }} transition={{ duration: 0.9, ease: 'easeOut' }} />
      {real.slice(0, -1).map((p, i) => <circle key={i} cx={p.x} cy={p.y} r={1.6} fill="var(--accent)" opacity={0.5} />)}
      <motion.circle cx={last.x} cy={last.y} r={3.2} initial={motionOn ? { scale: 0 } : false} animate={{ scale: 1 }} transition={{ delay: 0.8, ...spring }}
        fill={up ? 'var(--good)' : down ? 'var(--bad)' : 'var(--accent)'} stroke="var(--surface)" strokeWidth={1.5} />
    </svg>
  )
}

// --------------------------------------------------------------------------------------
// Forest plot: one row per metric, the paired change with its 95% interval around zero
// --------------------------------------------------------------------------------------

function niceMax(v: number): number {
  for (const s of [0.05, 0.1, 0.2, 0.3, 0.4, 0.5, 1]) if (v <= s) return s
  return Math.ceil(v)
}

/** Lines draw in from the zero mark; hatched rows were scored by the word-overlap heuristic. */
export function ForestPlot({ rows, isHeuristic, onPick }: { rows: ComparisonRow[]; isHeuristic?: (metric: string) => boolean; onPick?: (r: ComparisonRow) => void }) {
  const motionOn = useMotionOn()
  const [box, W0] = useWidth(360)
  const ranged = rows.filter((r) => r.delta !== null && r.unit === 'rate')
  const max = niceMax(Math.max(0.05, ...ranged.flatMap((r) => [Math.abs(r.delta ?? 0), Math.abs(r.ci?.ci_low ?? 0), Math.abs(r.ci?.ci_high ?? 0)])))
  const W = Math.max(120, W0)
  const x = (v: number) => 8 + ((Math.max(-max, Math.min(max, v)) + max) / (2 * max)) * (W - 16)
  const ticks = [-max, -max / 2, 0, max / 2, max]
  const anyHeur = ranged.some((r) => isHeuristic?.(r.metric))
  if (!ranged.length) return null
  const RH = 40
  const tickLabel = (t: number) => `${t > 0 ? '+' : t < 0 ? '−' : ''}${Math.abs(Math.round(t * 100))}`
  return (
    <div data-tour="forest">
      <div className="grid grid-cols-[minmax(0,170px)_minmax(0,1fr)_96px] items-end gap-3 max-md:grid-cols-[minmax(0,1fr)_96px]">
        <span className="t-label">Metric</span>
        <div ref={box} className="relative h-4 max-md:hidden" aria-hidden>
          {ticks.map((t) => <span key={t} className="num absolute -translate-x-1/2 font-mono text-label text-ink-3" style={{ left: x(t) }}>{tickLabel(t)}</span>)}
        </div>
        <span className="t-label text-right">Change (pp)</span>
      </div>
      <div className="relative mt-1">
        {ranged.map((r, i) => {
          const read = reading(r)
          const col = read.tone === 'good' ? 'var(--good)' : read.tone === 'bad' ? 'var(--bad)' : 'var(--ink-3)'
          const lo = r.ci?.ci_low ?? null
          const hi = r.ci?.ci_high ?? null
          const heur = isHeuristic?.(r.metric)
          const tr = motionOn ? { duration: 0.7, delay: 0.2 + 0.07 * i, ease: [0.16, 1, 0.3, 1] as const } : { duration: 0 }
          return (
            <button key={r.metric} type="button" onClick={() => onPick?.(r)} title={`${r.label}: ${fmtDelta(r)}, ${read.text}`}
              className={clsx('grid w-full grid-cols-[minmax(0,170px)_minmax(0,1fr)_96px] items-center gap-3 rounded-md text-left hover:bg-surface-2 max-md:grid-cols-[minmax(0,1fr)_96px]')}
              style={{ height: RH }} data-testid={`forest-${r.metric}`}>
              <span className="flex min-w-0 items-center gap-1.5 pl-1 text-sm text-ink"><span className="truncate">{r.label.replace(/ \(grading model\)$/, '')}</span>{heur && <Badge tone="heuristic">Heuristic</Badge>}</span>
              <svg width={W} height={RH} className="max-md:hidden" role="img"
                aria-label={`${r.label}: ${fmtDelta(r)}${lo !== null ? `, interval ${(lo * 100).toFixed(1)} to ${((hi ?? 0) * 100).toFixed(1)}` : ''}`}>
                {ticks.map((t) => <line key={t} x1={x(t)} x2={x(t)} y1={0} y2={RH} stroke={t === 0 ? 'var(--ink-3)' : 'var(--line)'} strokeDasharray={t === 0 ? undefined : '2 3'} />)}
                {lo !== null && hi !== null && (
                  <motion.line y1={RH / 2} y2={RH / 2} stroke={col} strokeWidth={2.5} strokeLinecap="round"
                    initial={{ x1: x(0), x2: x(0) }} animate={{ x1: x(lo), x2: x(hi) }} transition={tr} />
                )}
                <motion.circle cy={RH / 2} r={5} fill={col} stroke="var(--surface)" strokeWidth={1.5}
                  initial={{ cx: x(0) }} animate={{ cx: x(r.delta ?? 0) }} transition={motionOn ? { ...tr, duration: 0.9, ease: [0.34, 1.56, 0.64, 1] as const } : tr} />
              </svg>
              <span className="pr-1 text-right leading-tight">
                <span className="block text-sm"><RowDelta row={r} /></span>
                <span className="block text-label text-ink-3">
                  {read.text === 'within noise' ? <Term k="within_noise">within noise</Term> : read.text === 'likely better' ? <Term k="likely_better">likely better</Term> : read.text === 'likely worse' ? <Term k="likely_worse">likely worse</Term> : read.text}
                </span>
              </span>
            </button>
          )
        })}
      </div>
      <div className="mt-2 flex flex-wrap items-center gap-x-4 gap-y-1 text-xs text-ink-3">
        <span className="max-md:hidden"><span className="text-bad-ink">← worse</span> · <span className="text-good-ink">better →</span></span>
        <span className="flex items-center gap-1.5"><span className="h-0.5 w-4 rounded bg-ink-3" />95% interval</span>
        {anyHeur && <span className="flex items-center gap-1.5"><span className="hatched inline-block h-2.5 w-4 rounded-sm border border-line" />scored by the word-overlap heuristic, not a model</span>}
      </div>
    </div>
  )
}

/** Latency, tokens, cost: measured once, no interval. Arrow = which way the number moved; colour = better/worse. */
/** `caution` marks rows that should not be read as a real change (e.g. latency under different load). */
export function DeltaList({ rows, caution }: { rows: ComparisonRow[]; caution?: (metric: string) => boolean }) {
  const motionOn = useMotionOn()
  const pts = rows.filter((r) => r.unit !== 'rate' && r.delta !== null)
  if (!pts.length) return null
  const max = Math.max(0.1, ...pts.map((r) => Math.abs(r.relative ?? 0)))
  return (
    <div className="divide-y divide-line border-y border-line">
      {pts.map((r, i) => {
        const d = direction(r)
        const rel = r.relative ?? 0
        const warn = caution?.(r.metric)
        return (
          <div key={r.metric} className={clsx('grid grid-cols-[minmax(0,170px)_minmax(0,1fr)_minmax(150px,auto)] items-center gap-3 px-1 py-1.5 text-sm max-md:grid-cols-[minmax(0,1fr)_auto]', warn && 'hatched-light')} data-testid={`metric-${r.metric}`}
            title={warn ? 'Measured at a different number of questions at a time: may be load, not the bot' : undefined}>
            <span className="truncate text-ink">{r.label}{warn && <span className="ml-1 text-xs text-warn-ink">(different load)</span>}</span>
            <div className="relative h-1.5 rounded-full bg-surface-2 max-md:hidden">
              <span className="absolute -inset-y-1 left-1/2 w-px bg-line-strong" />
              <motion.span className={clsx('absolute inset-y-0 rounded-full', d === 'better' ? 'bg-good' : d === 'worse' ? 'bg-bad' : 'bg-ink-3')}
                initial={motionOn ? { width: 0, left: '50%' } : false}
                animate={rel >= 0 ? { left: '50%', width: `${(rel / max) * 50}%` } : { left: `${50 + (rel / max) * 50}%`, width: `${(-rel / max) * 50}%` }}
                transition={{ ...spring, delay: 0.04 * i }} />
            </div>
            <span className="num flex items-center justify-end gap-2 whitespace-nowrap text-right font-mono">
              <span className="text-xs text-ink-3">{fmtValue(r, r.baseline)} → {fmtValue(r, r.candidate)}</span>
              <span className="text-sm"><RowDelta row={r} /></span>
            </span>
          </div>
        )
      })}
    </div>
  )
}

// --------------------------------------------------------------------------------------
// Verdict needle: the instrument's needle in delta mode (kept for screens that still use it)
// --------------------------------------------------------------------------------------

export function VerdictNeedle({ delta, low, high, size = 168, label }: { delta: number | null; low?: number | null; high?: number | null; size?: number; label?: string }) {
  return <Needle mode="delta" value={delta} low={low} high={high} size={size} label={label ?? 'verdict gauge'} endLabels={['', '']} />
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
    <motion.div className={clsx('inline-flex -rotate-6 select-none items-center rounded-md border-2 bg-surface px-3 py-1 font-mono text-base font-semibold tracking-[0.18em]', tone)}
      style={{ boxShadow: 'inset 0 0 0 2px var(--surface), inset 0 0 0 3px currentColor' }}
      initial={first && motionOn ? { scale: 2.4, opacity: 0, rotate: -18 } : false}
      animate={{ scale: 1, opacity: 1, rotate: -6 }}
      transition={{ type: 'spring', stiffness: 520, damping: 18, mass: 0.8 }}
      aria-label={`Gate ${text}`} data-testid="gate-stamp">
      {status === 'PASS' ? '✓ ' : status === 'FAIL' ? '✕ ' : ''}{text}
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
        <div className="pointer-events-none fixed inset-x-0 top-1/3 z-(--z-stamp) flex justify-center" aria-hidden>
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
  const motionOn = useMotionOn()
  if (!stages.length) return <p className="text-sm text-ink-3">No stage was exercised by the checks in this run.</p>
  const max = Math.max(1, ...stages.map((s) => s.failures))
  return (
    <div className="grid grid-cols-2 items-stretch gap-2 sm:flex sm:flex-wrap sm:gap-1.5" data-tour="stages">
      {stages.map((s, i) => (
        <div key={s.id} className="flex items-center gap-1.5 max-sm:last:odd:col-span-2">
          {i > 0 && <span className="text-ink-3 max-sm:hidden" aria-hidden>›</span>}
          <motion.button type="button" onClick={() => onPick?.(s)}
            initial={motionOn ? { opacity: 0, y: 6 } : false} animate={{ opacity: 1, y: 0 }} transition={{ delay: i * 0.06 }}
            className={clsx('min-w-[118px] rounded-lg border px-3 py-2 text-left transition-colors max-sm:w-full',
              selected === s.id ? 'border-accent ring-2 ring-accent/25' : 'border-line hover:border-line-strong')}
            style={{ background: s.failures ? `color-mix(in srgb, var(--bad) ${Math.round(6 + (s.failures / max) * 20)}%, var(--surface))` : 'var(--surface)' }}
            title={Object.entries(s.types).map(([t, n]) => `${FAILURE_LABELS[t] ?? t}: ${n}`).join('\n') || `Checks: ${s.checks.join(', ')}`}>
            <div className="t-label">{s.label}</div>
            <div className={clsx('t-fig mt-1', s.failures ? 'text-bad-ink' : 'text-good-ink')}>{s.failures}</div>
            <div className="text-xs text-ink-3">{s.failures === 1 ? 'failure' : 'failures'}</div>
          </motion.button>
        </div>
      ))}
    </div>
  )
}

// --------------------------------------------------------------------------------------
// Question matrix: questions down, runs across. A row red in every run is often a wrong expected answer.
// --------------------------------------------------------------------------------------

export function CaseMatrixView({ data, filter = 'all', focusCase }: { data: CaseMatrix; filter?: 'all' | 'changed' | 'always_fail' | 'flaky'; focusCase?: string | null }) {
  const motionOn = useMotionOn()
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
      <table className="border-separate border-spacing-0 text-xs">
        <thead className="sticky top-0 z-10 bg-surface">
          <tr>
            <th className="t-label sticky left-0 z-20 min-w-[220px] border-b border-line bg-surface px-3 py-2 text-left">Question</th>
            {data.runs.map((r) => (
              <th key={r.id} className="border-b border-line px-1 py-2 align-bottom" title={`${r.name}\n${r.target} · ${r.variant}\nGrading model: ${r.judge ?? 'none'}`}>
                <Link to={`/runs/${r.id}`} className="flex flex-col items-center gap-0.5 font-mono text-label text-accent-ink hover:underline">
                  #{r.id}
                  <span className="num text-label text-ink-3">{pct(r.pass_rate, 0)}</span>
                </Link>
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.map((c) => (
            <tr key={c.id} data-case={c.id} className={clsx(focusCase === c.id && 'bg-accent-wash')}>
              <td className="sticky left-0 z-(--z-sticky) max-w-[280px] border-b border-line bg-surface px-3 py-1">
                <div className="flex items-center gap-2">
                  <span className="font-mono text-xs text-ink">{c.id}</span>
                  {always.has(c.id) && <Badge tone="fail" title="Failed in every run: check the expected answer">Always fails</Badge>}
                </div>
                <div className="truncate text-xs text-ink-3">{c.title}</div>
              </td>
              {data.runs.map((r, ri) => {
                const v = data.cells[c.id]?.[String(r.id)]
                const state = !v ? 'none' : v.errors ? 'error' : v.passed === v.total ? 'pass' : v.passed === 0 ? 'fail' : 'flaky'
                return (
                  <td key={r.id} className="border-b border-line px-1 py-1 text-center">
                    <Link to={`/runs/${r.id}?tab=cases&case=${encodeURIComponent(c.id)}`} title={v ? `#${r.id}: ${v.passed}/${v.total} passed` : `#${r.id}: not in this run`}
                      className="inline-block">
                      <motion.span initial={motionOn ? { scale: 0.3, opacity: 0 } : false} animate={{ scale: 1, opacity: 1 }} transition={{ delay: Math.min(ri * 0.03, 0.4), duration: 0.18 }}
                        className={clsx('block size-4 rounded-full',
                          state === 'none' ? 'border border-dashed border-untested' : STATE_DOT[state],
                          r.judge === 'heuristic' && state !== 'none' && 'hatched-light')} />
                    </Link>
                  </td>
                )
              })}
            </tr>
          ))}
        </tbody>
      </table>
      {!rows.length && <p className="p-4 text-sm text-ink-3">No questions match this filter.</p>}
    </div>
  )
}

export function MatrixLegend() {
  const item = (cls: string, label: string) => <span className="flex items-center gap-1.5"><span className={clsx('size-3 rounded-full', cls)} />{label}</span>
  return (
    <div className="flex flex-wrap gap-x-4 gap-y-1 text-xs text-ink-3">
      {item('bg-good', 'passed every try')}{item('bg-flaky', 'flaky')}{item('bg-bad', 'failed every try')}{item('bg-error', 'error')}
      {item('border border-dashed border-untested', 'not in the run')}{item('bg-good hatched-light', 'run graded by heuristic grading')}
    </div>
  )
}

// --------------------------------------------------------------------------------------
// Live run: one tile per trial, flipping as results arrive
// --------------------------------------------------------------------------------------

export function LiveGrid({ total, done, statuses }: { total: number; done: number; statuses: { key: string; status: string; caseId: string }[] }) {
  const motionOn = useMotionOn()
  const tiles = Array.from({ length: Math.max(total, statuses.length) }, (_, i) => statuses[i] ?? null)
  return (
    <div className="flex flex-wrap gap-[3px]" role="img" aria-label={`${done} of ${total} tries finished`}>
      {tiles.map((t, i) => (
        <motion.span key={t?.key ?? `pending-${i}`} title={t ? `${t.caseId}: ${t.status}` : 'waiting'}
          data-case={t?.caseId}
          initial={t && motionOn ? { rotateY: 90, opacity: 0.4 } : false} animate={{ rotateY: 0, opacity: 1 }} transition={{ duration: 0.35 }}
          className={clsx('size-3 rounded-full', !t && 'bg-surface-3', t?.status === 'passed' && 'bg-good', t?.status === 'failed' && 'bg-bad',
            t?.status === 'error' && 'bg-error', t && !['passed', 'failed', 'error'].includes(t.status) && 'bg-untested')} />
      ))}
    </div>
  )
}
