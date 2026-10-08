// The instrument's own parts, shared by every screen: the needle (the one signature), a run's
// fingerprint (one dot per question), rolling figures, signed changes, receipts, and the colours
// for pass rates and causes. See docs/design.md for when to use which.
import clsx from 'clsx'
import { motion } from 'motion/react'
import { useEffect, useLayoutEffect, useRef, type ReactNode } from 'react'
import { Link } from 'react-router-dom'
import { useMotionOn } from '../lib/prefs'

// --------------------------------------------------------------------------------------
// Colours with a meaning
// --------------------------------------------------------------------------------------

/** Pass rate 0..1 as a colour, red through amber to green (mixed in OKLCH by the browser). */
export function rateColor(v: number | null | undefined): string {
  if (v === null || v === undefined || Number.isNaN(v)) return 'var(--untested)'
  return v >= 0.5
    ? `color-mix(in oklch, var(--good) ${Math.round((v - 0.5) * 200)}%, var(--warn))`
    : `color-mix(in oklch, var(--warn) ${Math.round(v * 200)}%, var(--bad))`
}

/** A fixed colour per likely cause of a failure (the same everywhere). */
export const CAUSE_COLORS: Record<string, string> = {
  search_missed: 'oklch(0.62 0.12 235)',
  model_missed: 'oklch(0.6 0.14 290)',
  made_up: 'oklch(0.6 0.19 27)',
  answered_out_of_scope: 'oklch(0.7 0.15 55)',
  tool_problem: 'oklch(0.58 0.15 330)',
  declined_wrongly: 'oklch(0.66 0.12 190)',
  wrong_citation: 'oklch(0.66 0.13 110)',
  off_topic: 'oklch(0.62 0.02 200)',
  test_suspect: 'oklch(0.62 0.02 200)',
  cant_tell: 'oklch(0.62 0.02 200)',
}
export function causeColor(cause: string | null | undefined): string {
  if (!cause) return 'var(--untested)'
  if (CAUSE_COLORS[cause]) return CAUSE_COLORS[cause]
  const h = ([...cause].reduce((a, ch) => a + ch.charCodeAt(0), 0) * 47) % 360
  return `oklch(0.62 0.11 ${h})`
}

// --------------------------------------------------------------------------------------
// Fingerprint: one dot per question, in dataset order
// --------------------------------------------------------------------------------------

export interface Cell {
  id: string
  passed: number
  total: number
  title?: string
}
export type CellState = 'pass' | 'fail' | 'flaky' | 'none'
export function cellState(c: Pick<Cell, 'passed' | 'total'> | undefined | null): CellState {
  if (!c || !c.total) return 'none'
  return c.passed === c.total ? 'pass' : c.passed === 0 ? 'fail' : 'flaky'
}
const STATE_BG: Record<CellState, string> = { pass: 'bg-good', fail: 'bg-bad', flaky: 'bg-flaky', none: 'bg-untested' }
const STATE_TEXT: Record<CellState, string> = { pass: 'passed every try', fail: 'failed every try', flaky: 'flaky', none: 'not asked' }

/**
 * A run's fingerprint. Each dot carries ``data-case`` so hovering it lights the same question
 * everywhere on the page. ``flipped`` marks questions to pulse (Compare replay).
 */
export function Fingerprint({ cells, size = 'md', hrefFor, vt, className, flipped, label }: {
  cells: Cell[]
  size?: 'sm' | 'md' | 'lg'
  hrefFor?: (id: string) => string | null
  vt?: string
  className?: string
  flipped?: Set<string>
  label?: string
}) {
  const px = size === 'sm' ? 6 : size === 'lg' ? 12 : 9
  const pass = cells.filter((c) => cellState(c) === 'pass').length
  return (
    <div className={clsx('flex flex-wrap items-center', size === 'sm' ? 'gap-[2.5px]' : 'gap-[3px]', className)}
      style={vt ? { viewTransitionName: vt } : undefined} role="img"
      aria-label={label ?? `${pass} of ${cells.length} questions passed every try`} data-testid="fingerprint">
      {cells.map((c) => {
        const st = cellState(c)
        const title = `${c.title ? c.title + ' · ' : ''}${c.id}: ${st === 'flaky' ? `${c.passed}/${c.total} tries passed` : STATE_TEXT[st]}`
        const dot = (
          <span data-case={c.id} title={title}
            className={clsx('block rounded-full transition-transform duration-150 hover:scale-150', STATE_BG[st], flipped?.has(c.id) && 'fp-flip')}
            style={{ width: px, height: px }} />
        )
        const href = hrefFor?.(c.id)
        return href ? <Link key={c.id} to={href} aria-label={title}>{dot}</Link> : <span key={c.id}>{dot}</span>
      })}
    </div>
  )
}

export function FingerprintLegend({ className }: { className?: string }) {
  const item = (cls: string, text: string) => <span className="inline-flex items-center gap-1.5"><span className={clsx('size-2 rounded-full', cls)} />{text}</span>
  return (
    <div className={clsx('flex flex-wrap items-center gap-x-3.5 gap-y-1 text-xs text-ink-3', className)}>
      {item('bg-good', 'passed every try')}{item('bg-flaky', 'flaky')}{item('bg-bad', 'failed every try')}
    </div>
  )
}

// --------------------------------------------------------------------------------------
// The needle
// --------------------------------------------------------------------------------------

/**
 * The gauge. ``level``: a value 0..1 (pass rate, agreement) with an optional gate tick.
 * ``delta``: a change -0.5..+0.5 with its interval as an arc. It sweeps up from rest and settles on
 * a spring; ``tremble`` while a run is live.
 */
export function Needle({ mode = 'level', value, low, high, gate, gateLabel = 'gate', size = 180, tremble = false, label, endLabels }: {
  mode?: 'level' | 'delta'
  value: number | null | undefined
  low?: number | null
  high?: number | null
  gate?: number | null
  gateLabel?: string
  size?: number
  tremble?: boolean
  label?: string
  endLabels?: [string, string]
}) {
  const motionOn = useMotionOn()
  const R = size / 2 - 10
  const cx = size / 2
  const cy = size / 2 + 4
  const H = size / 2 + 26
  const toA = mode === 'delta'
    ? (v: number) => Math.max(-1, Math.min(1, v / 0.5)) * 90
    : (v: number) => Math.max(0, Math.min(1, v)) * 180 - 90
  const pt = (a: number, r: number) => [cx + r * Math.sin((a * Math.PI) / 180), cy - r * Math.cos((a * Math.PI) / 180)]
  const arc = (a0: number, a1: number, r: number) => {
    const [x0, y0] = pt(a0, r)
    const [x1, y1] = pt(a1, r)
    return `M${x0},${y0} A${r},${r} 0 ${a1 - a0 > 180 ? 1 : 0} 1 ${x1},${y1}`
  }
  const g = gate ?? (mode === 'level' ? null : null)
  const bands: [number, number, string][] = mode === 'delta'
    ? [[-90, -8, 'var(--bad)'], [-8, 8, 'var(--line-strong)'], [8, 90, 'var(--good)']]
    : g !== null && g !== undefined
      ? [[-90, toA(g), 'var(--bad)'], [toA(g), 90, 'var(--good)']]
      : [[-90, 90, 'var(--line-strong)']]
  const target = value === null || value === undefined ? (mode === 'delta' ? 0 : -90) : toA(value)
  const ticks = Array.from({ length: 13 }, (_, i) => -90 + i * 15)
  const [ends0, ends1] = endLabels ?? (mode === 'delta' ? ['worse', 'better'] : ['0', '100'])
  const origin = { transformBox: 'view-box' as const, transformOrigin: `${cx}px ${cy}px` }
  return (
    <svg width={size} height={H} viewBox={`0 0 ${size} ${H}`} role="img" aria-label={label ?? 'gauge'} className="overflow-visible" data-testid="needle">
      <path d={arc(-90, 90, R)} stroke="var(--surface-3)" strokeWidth={10} fill="none" strokeLinecap="round" />
      {bands.map(([a, b, c]) => <path key={`${a}`} d={arc(a, b, R)} stroke={c} strokeWidth={mode === 'delta' ? 3 : 4} fill="none" opacity={0.55} />)}
      {low !== null && low !== undefined && high !== null && high !== undefined && (
        <motion.path d={arc(toA(low), toA(high), R)} stroke="var(--accent)" strokeWidth={10} fill="none" strokeLinecap="round"
          initial={{ opacity: 0 }} animate={{ opacity: 0.28 }} transition={{ delay: motionOn ? 0.9 : 0, duration: 0.5 }} />
      )}
      {ticks.map((a) => {
        const major = a % 45 === 0
        const [x1, y1] = pt(a, R - 14)
        const [x2, y2] = pt(a, major ? R - 22 : R - 18)
        return <line key={a} x1={x1} y1={y1} x2={x2} y2={y2} stroke="var(--ink-3)" strokeWidth={major ? 1.4 : 0.8} opacity={0.6} />
      })}
      {mode === 'level' && g !== null && g !== undefined && (() => {
        const a = toA(g)
        const [x1, y1] = pt(a, R + 8)
        const [x2, y2] = pt(a, R - 8)
        const [tx, ty] = pt(a, R + 17)
        return <g><line x1={x1} y1={y1} x2={x2} y2={y2} stroke="var(--ink)" strokeWidth={2} /><text x={tx} y={ty} textAnchor="middle" className="c-num">{gateLabel}</text></g>
      })()}
      <motion.g initial={motionOn ? { rotate: mode === 'delta' ? -90 : -90 } : { rotate: target }} animate={{ rotate: target }}
        transition={motionOn ? { type: 'spring', stiffness: 70, damping: 8, mass: 0.9, delay: 0.15 } : { duration: 0 }} style={origin}>
        <g className={clsx(tremble && motionOn && 'needle-tremble')} style={origin}>
          <line x1={cx} y1={cy + 8} x2={cx} y2={cy - R + 6} stroke="var(--ink)" strokeWidth={2.4} strokeLinecap="round" />
          <line x1={cx} y1={cy - R + 22} x2={cx} y2={cy - R + 6} stroke="var(--accent)" strokeWidth={2.6} strokeLinecap="round" />
        </g>
      </motion.g>
      <circle cx={cx} cy={cy} r={5.5} fill="var(--ink)" />
      <circle cx={cx} cy={cy} r={2} fill="var(--surface)" />
      <text x={cx - R} y={cy + 20} textAnchor="middle" className={mode === 'level' ? 'c-num' : undefined}>{ends0}</text>
      <text x={cx + R} y={cy + 20} textAnchor="middle" className={mode === 'level' ? 'c-num' : undefined}>{ends1}</text>
    </svg>
  )
}

// --------------------------------------------------------------------------------------
// Rolling figures
// --------------------------------------------------------------------------------------

/** A figure whose digits roll into place (odometer) when it first shows and when it changes. */
export function Odometer({ text, className }: { text: string; className?: string }) {
  const ref = useRef<HTMLSpanElement>(null)
  const motionOn = useMotionOn()
  const chars = [...text]
  useLayoutEffect(() => {
    const cols = ref.current?.querySelectorAll<HTMLElement>('[data-digit]') ?? []
    const set = () => cols.forEach((c, i) => {
      c.style.transitionDelay = motionOn ? `${i * 40}ms` : '0ms'
      c.style.transform = `translateY(-${c.dataset.digit}em)`
    })
    if (!motionOn) { set(); return }
    const raf = requestAnimationFrame(() => requestAnimationFrame(set))
    return () => cancelAnimationFrame(raf)
  }, [text, motionOn])
  return (
    <span ref={ref} className={clsx('odo num', className)} aria-label={text} role="text">
      {chars.map((ch, i) => /\d/.test(ch)
        ? <span key={i} className="odo-col" data-digit={ch} aria-hidden>{'0123456789'.split('').map((d) => <span key={d}>{d}</span>)}</span>
        : <span key={i} aria-hidden>{ch === ' ' ? ' ' : ch}</span>)}
    </span>
  )
}

// --------------------------------------------------------------------------------------
// A signed change: arrow = direction, colour = good or bad (never conflated)
// --------------------------------------------------------------------------------------

export function Delta({ value, format, higherIsBetter = true, noise = 0.005, suffix, className }: {
  value: number | null | undefined
  format: (absValue: number, value: number) => string
  higherIsBetter?: boolean
  noise?: number
  suffix?: ReactNode
  className?: string
}) {
  if (value === null || value === undefined || Number.isNaN(value)) return <span className={clsx('text-ink-3', className)}>no baseline</span>
  const flat = Math.abs(value) < noise
  const good = flat ? null : (value > 0) === higherIsBetter
  const arrow = flat ? '→' : value > 0 ? '↑' : '↓'
  return (
    <span className={clsx('num font-mono', good === null ? 'text-ink-3' : good ? 'text-good-ink' : 'text-bad-ink', className)}>
      {arrow} {format(Math.abs(value), value)}{suffix && <span className="ml-1 font-sans text-ink-3">{suffix}</span>}
    </span>
  )
}

// --------------------------------------------------------------------------------------
// Receipts
// --------------------------------------------------------------------------------------

export function Receipt({ title, sub, children, className }: { title: ReactNode; sub?: ReactNode; children: ReactNode; className?: string }) {
  return (
    <div className={clsx('receipt', className)} data-testid="receipt">
      <div className="t-verdict text-center">{title}</div>
      {sub && <div className="mt-0.5 text-center text-xs text-ink-3">{sub}</div>}
      <hr />
      {children}
    </div>
  )
}

/** One line of a receipt, dotted leader to the value; it reprints itself when its value changes. */
export function ReceiptLine({ label, value, strong }: { label: ReactNode; value: ReactNode; strong?: boolean }) {
  const ref = useRef<HTMLDivElement>(null)
  const prev = useRef<string | null>(null)
  const key = typeof value === 'string' || typeof value === 'number' ? String(value) : null
  useEffect(() => {
    const el = ref.current
    if (!el || key === null) return
    if (prev.current !== null && prev.current !== key) {
      el.classList.remove('receipt-print')
      void el.offsetWidth
      el.classList.add('receipt-print')
    }
    prev.current = key
  }, [key])
  return (
    <div ref={ref} className={clsx('receipt-line', strong && 'text-base font-semibold')}>
      <span>{label}</span><span className="leader" /><span className="text-right">{value}</span>
    </div>
  )
}

// --------------------------------------------------------------------------------------
// Linked highlight: hover a question anywhere (anything with data-case) and it lights everywhere
// --------------------------------------------------------------------------------------

export function useLinkedHighlight() {
  useEffect(() => {
    let timer: number | undefined
    const clear = () => {
      document.body.classList.remove('hl-on')
      document.querySelectorAll('.hl').forEach((x) => x.classList.remove('hl'))
    }
    const over = (e: MouseEvent) => {
      const el = (e.target as Element | null)?.closest?.('[data-case]') as HTMLElement | null
      if (!el) return
      window.clearTimeout(timer)
      const id = el.dataset.case
      if (!id) return
      clear()
      document.querySelectorAll(`[data-case="${CSS.escape(id)}"]`).forEach((x) => x.classList.add('hl'))
      document.body.classList.add('hl-on')
    }
    const out = (e: MouseEvent) => {
      if (!(e.target as Element | null)?.closest?.('[data-case]')) return
      timer = window.setTimeout(clear, 40)
    }
    document.addEventListener('mouseover', over)
    document.addEventListener('mouseout', out)
    return () => { document.removeEventListener('mouseover', over); document.removeEventListener('mouseout', out); clear() }
  }, [])
}

/** A small "n=58" badge: every chart says how many things it rests on; amber when that is few. */
export function SampleSize({ n, min = 30, unit }: { n: number; min?: number; unit?: string }) {
  return (
    <span className={clsx('num rounded-[5px] border border-dashed px-1.5 font-mono text-label', n < min ? 'border-warn text-warn-ink' : 'border-line-strong text-ink-3')}
      title={n < min ? 'A small sample: treat it as a hint' : 'How many this rests on'}>
      n={n}{unit ? ` ${unit}` : ''}
    </span>
  )
}
