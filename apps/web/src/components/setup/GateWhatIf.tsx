// "What if the gate were stricter?": every comparable past run as a bar (its pass rate), a dashed
// line you drag to move the pass-rate limit, a slider for the p95 limit, and a stamp over each bar
// that flips (with a small pop) when the run crosses the line.
import * as d3 from 'd3'
import { motion } from 'motion/react'
import { useEffect, useLayoutEffect, useRef, useState, type KeyboardEvent, type PointerEvent } from 'react'
import { Link } from 'react-router-dom'
import { ms } from '../../lib/format'
import { useMotionOn } from '../../lib/prefs'

export interface WhatIfRun {
  run_id: number
  pass_rate: number
  p95_latency_ms: number | null
  variant?: string
}

function useWidth<T extends HTMLElement>() {
  const ref = useRef<T>(null)
  const [w, setW] = useState(0)
  useLayoutEffect(() => {
    const el = ref.current
    if (!el) return
    setW(el.clientWidth)
    const ro = new ResizeObserver(() => setW(el.clientWidth))
    ro.observe(el)
    return () => ro.disconnect()
  }, [])
  return [ref, w] as const
}

const clamp = (v: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, v))
const GOOD_FILL = 'color-mix(in srgb, var(--good) 60%, var(--surface))'
const BAD_FILL = 'color-mix(in srgb, var(--bad) 45%, var(--surface))'

export function GateWhatIf({ runs, passMin, p95Max }: { runs: WhatIfRun[]; passMin: number | null; p95Max: number | null }) {
  const motionOn = useMotionOn()
  const [box, W] = useWidth<HTMLDivElement>()
  const svg = useRef<SVGSVGElement>(null)
  const [thr, setThr] = useState(passMin ?? 0.7)
  const [p95, setP95] = useState<number | null>(p95Max)
  const [armed, setArmed] = useState(false) // stamps pop only on a change, not on first paint
  useEffect(() => { const t = window.setTimeout(() => setArmed(true), 50); return () => window.clearTimeout(t) }, [])

  const H = 320
  const m = { l: 46, r: 20, t: 58, b: 30 }
  const width = Math.max(W, 320)
  const x = d3.scaleBand<number>().domain(runs.map((r) => r.run_id)).range([m.l, width - m.r]).padding(0.45)
  const y = d3.scaleLinear().domain([0, 1]).range([H - m.b, m.t])
  const ok = (r: WhatIfRun) => r.pass_rate >= thr && (p95 === null || r.p95_latency_ms === null || r.p95_latency_ms <= p95)
  const n = runs.filter(ok).length

  const p95s = runs.map((r) => r.p95_latency_ms).filter((v): v is number => v !== null)
  const sMin = Math.floor((Math.min(...p95s, p95Max ?? Infinity) * 0.8) / 50) * 50
  const sMax = Math.ceil((Math.max(...p95s, p95Max ?? 0) * 1.25) / 50) * 50

  const dragTo = (e: PointerEvent) => {
    const r = svg.current?.getBoundingClientRect()
    if (!r) return
    setThr(clamp(Math.round(y.invert(e.clientY - r.top) * 100) / 100, 0, 1))
  }
  const onKey = (e: KeyboardEvent) => {
    const step = e.key === 'PageUp' || e.key === 'PageDown' ? 0.05 : 0.01
    if (e.key === 'ArrowUp' || e.key === 'PageUp') { e.preventDefault(); setThr((t) => clamp(Math.round((t + step) * 100) / 100, 0, 1)) }
    if (e.key === 'ArrowDown' || e.key === 'PageDown') { e.preventDefault(); setThr((t) => clamp(Math.round((t - step) * 100) / 100, 0, 1)) }
  }

  return (
    <div>
      <p className="t-readout mb-2" data-testid="whatif-readout" aria-live="polite">
        <b className="num font-mono font-semibold">{n}</b> of <span className="num font-mono">{runs.length}</span> past runs would pass
        {n === 0 && <span className="text-bad-ink"> · nothing ever ships</span>}
      </p>
      <div ref={box} className="w-full">
        {W > 0 && (
          <svg ref={svg} width={width} height={H} role="img" aria-label={`${n} of ${runs.length} past runs would pass at a pass-rate limit of ${Math.round(thr * 100)}%`} data-testid="whatif-chart">
            {[0, 0.2, 0.4, 0.6, 0.8, 1].map((t) => (
              <g key={t}>
                <line x1={m.l} x2={width - m.r} y1={y(t)} y2={y(t)} className="gridline" stroke="var(--line)" strokeDasharray={t === 0 ? undefined : '2 4'} />
                <text x={m.l - 8} y={y(t) + 4} textAnchor="end" className="c-num">{Math.round(t * 100)}%</text>
              </g>
            ))}
            {runs.map((r, i) => {
              const good = ok(r)
              const cx = (x(r.run_id) ?? 0) + x.bandwidth() / 2
              return (
                <g key={r.run_id}>
                  <motion.rect x={x(r.run_id)} width={x.bandwidth()} rx={4}
                    initial={motionOn ? { y: y(0), height: 0 } : false} animate={{ y: y(r.pass_rate), height: y(0) - y(r.pass_rate) }}
                    transition={{ delay: i * 0.06, duration: 0.7, ease: [0.16, 1, 0.3, 1] }}
                    fill={good ? GOOD_FILL : BAD_FILL} data-run={r.run_id}>
                    <title>{`Run #${r.run_id}${r.variant ? ` (${r.variant})` : ''}: pass rate ${(r.pass_rate * 100).toFixed(1)}%, p95 ${ms(r.p95_latency_ms)}`}</title>
                  </motion.rect>
                  <Link to={`/runs/${r.run_id}`}>
                    <text x={cx} y={H - m.b + 16} textAnchor="middle" className="c-num">#{r.run_id}</text>
                  </Link>
                  <g transform={`translate(${cx},${m.t - 30}) rotate(-6)`}>
                    <motion.g key={`${r.run_id}-${good}`} initial={armed && motionOn ? { scale: 1.35 } : false} animate={{ scale: 1 }}
                      transition={{ type: 'spring', stiffness: 520, damping: 14 }} style={{ transformBox: 'fill-box', transformOrigin: 'center' }}
                      data-testid={`whatif-stamp-${r.run_id}`} data-state={good ? 'PASS' : 'FAIL'}>
                      <rect x={-24} y={-11} width={48} height={21} rx={4} fill="var(--surface)" stroke={good ? 'var(--good-ink)' : 'var(--bad-ink)'} strokeWidth={1.8} />
                      <text y={4} textAnchor="middle" className="c-num c-strong" style={{ fill: good ? 'var(--good-ink)' : 'var(--bad-ink)', letterSpacing: '0.08em' }}>{good ? 'PASS' : 'FAIL'}</text>
                    </motion.g>
                  </g>
                </g>
              )
            })}
            <g transform={`translate(0,${y(thr)})`} style={{ cursor: 'ns-resize', touchAction: 'none' }}
              onPointerDown={(e) => { (e.currentTarget as Element).setPointerCapture(e.pointerId); dragTo(e) }}
              onPointerMove={(e) => { if ((e.currentTarget as Element).hasPointerCapture(e.pointerId)) dragTo(e) }}
              role="slider" tabIndex={0} aria-label="Pass-rate limit" aria-valuemin={0} aria-valuemax={100} aria-valuenow={Math.round(thr * 100)}
              aria-valuetext={`at least ${Math.round(thr * 100)}%`} onKeyDown={onKey} data-testid="whatif-line" className="outline-none focus-visible:[&>rect]:stroke-accent">
              <rect x={m.l} y={-9} width={width - m.l - m.r} height={18} fill="transparent" />
              <line x1={m.l} x2={width - m.r} stroke="var(--ink)" strokeWidth={2} strokeDasharray="6 4" />
              <rect x={width - m.r - 66} y={-11} width={66} height={22} rx={6} fill="var(--ink)" strokeWidth={2} />
              <text x={width - m.r - 33} y={4} textAnchor="middle" className="c-num c-on-dark">≥ {Math.round(thr * 100)}%</text>
            </g>
          </svg>
        )}
      </div>
      {p95 !== null && p95s.length > 0 && (
        <div className="mt-3 flex flex-wrap items-center gap-4">
          <span className="t-label">p95 limit</span>
          <input type="range" min={sMin} max={sMax} step={50} value={p95} onChange={(e) => setP95(Number(e.target.value))}
            className="w-64 accent-[var(--accent)]" aria-label="p95 limit" data-testid="whatif-p95" />
          <span className="num font-mono text-sm text-ink">{ms(p95)}</span>
        </div>
      )}
    </div>
  )
}
