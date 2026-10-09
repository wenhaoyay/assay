// E1 Replay the answer: the trace as a timeline that plays. Bars fill as time passes, a cursor
// marks "now", the Now panel says what the bot is doing and the answer types itself out during the
// answer step. Space plays and pauses, ← / → step between span edges, the wheel zooms and a drag
// pans (d3.zoom); clicking the chart moves the cursor there. Checks (evaluator spans) are left out.
import clsx from 'clsx'
import * as d3 from 'd3'
import { Pause, Play, RotateCcw } from 'lucide-react'
import { motion } from 'motion/react'
import { useCallback, useEffect, useId, useMemo, useRef, useState } from 'react'
import { ms } from '../../lib/format'
import { useMotionOn } from '../../lib/prefs'
import type { Span } from '../../lib/types'
import { useWidth } from '../compare/useWidth'
import { Button, Card, Kbd } from '../ui'

const COLOR: Record<string, string> = {
  target_request: 'var(--ink-3)', retrieval: 'var(--series-1)', model_call: 'var(--accent)', tool_call: 'var(--series-2)',
  tool_result: 'var(--series-2)', post_processing: 'var(--error)',
}
const KIND: Record<string, string> = {
  target_request: 'request', retrieval: 'search', model_call: 'model', tool_call: 'tool', tool_result: 'tool result', post_processing: 'post-processing',
}
const RH = 30
const LABEL_W = 200
const AXIS_H = 24

interface Row { s: Span; o: number; d: number; depth: number }

function layout(spans: Span[]): { rows: Row[]; total: number } {
  const exec = spans.filter((s) => s.type !== 'evaluator')
  const root = exec.find((s) => !s.parent_span_id) ?? exec[0]
  if (!root) return { rows: [], total: 1 }
  const t0 = Math.min(...exec.map((s) => s.start_time))
  const kids = d3.group(exec.filter((s) => s !== root), (s) => s.parent_span_id ?? '')
  const rows: Row[] = []
  const walk = (s: Span, depth: number) => {
    rows.push({ s, o: (s.start_time - t0) * 1000, d: Math.max(s.duration_ms, 0), depth })
    for (const c of [...(kids.get(s.span_id) ?? [])].sort((a, b) => a.start_time - b.start_time)) walk(c, depth + 1)
  }
  walk(root, 0)
  // Spans whose parent is missing still get a row.
  for (const s of exec) if (!rows.some((r) => r.s === s)) rows.push({ s, o: (s.start_time - t0) * 1000, d: s.duration_ms, depth: 1 })
  return { rows, total: Math.max(1, ...rows.map((r) => r.o + r.d)) }
}

const fmtTick = (d: number, step: number) => (d >= 1000 ? `${(d / 1000).toFixed(step < 100 ? 2 : 1)}s` : `${Math.round(d)}ms`)

export function TracePlayback({ spans, answer, onRetrieval }: { spans: Span[]; answer: string; onRetrieval?: (fraction: number) => void }) {
  const motionOn = useMotionOn()
  const { rows, total } = useMemo(() => layout(spans), [spans])
  const [box, w] = useWidth(900)
  const svgRef = useRef<SVGSVGElement>(null)
  const clip = `tp-${useId().replace(/[^a-zA-Z0-9]/g, '')}`
  const labelW = w < 520 ? 96 : LABEL_W // narrow screens: names truncate, the chart keeps room
  const chartW = Math.max(140, w - labelW)
  const H = rows.length * RH + AXIS_H
  const [tf, setTf] = useState<d3.ZoomTransform>(d3.zoomIdentity)
  const [T, setT] = useState(() => (motionOn ? 0 : total))
  const tRef = useRef(T)
  const [playing, setPlaying] = useState(false)
  const x0 = useMemo(() => d3.scaleLinear().domain([0, total]).range([8, chartW - 8]), [total, chartW])
  const x = tf.rescaleX(x0)
  const seek = useCallback((t: number) => { tRef.current = Math.max(0, Math.min(total, t)); setT(tRef.current) }, [total])

  // Wheel zooms, drag pans.
  useEffect(() => {
    const svg = d3.select(svgRef.current!)
    const zoom = d3.zoom<SVGSVGElement, unknown>().scaleExtent([1, 40])
      .extent([[0, 0], [chartW, H]]).translateExtent([[0, 0], [chartW, H]])
      .on('zoom', (e: d3.D3ZoomEvent<SVGSVGElement, unknown>) => setTf(e.transform))
    svg.call(zoom)
    svg.on('dblclick.zoom', null)
    return () => { svg.on('.zoom', null) }
  }, [chartW, H])
  const resetZoom = () => { if (svgRef.current) d3.select(svgRef.current).call(d3.zoom<SVGSVGElement, unknown>().transform, d3.zoomIdentity); setTf(d3.zoomIdentity) }

  // Playback: a trace plays in 2.5 to 7 seconds whatever its real length.
  useEffect(() => {
    if (!playing) return
    const rate = total / Math.min(7000, Math.max(2500, total / 0.6))
    let last = performance.now()
    let raf = 0
    const f = (now: number) => {
      tRef.current = Math.min(total, tRef.current + (now - last) * rate)
      last = now
      setT(tRef.current)
      if (tRef.current >= total) setPlaying(false)
      else raf = requestAnimationFrame(f)
    }
    raf = requestAnimationFrame(f)
    return () => cancelAnimationFrame(raf)
  }, [playing, total])
  const toggle = useCallback(() => {
    setPlaying((p) => {
      if (!p && tRef.current >= total) { tRef.current = 0; setT(0) }
      return !p
    })
  }, [total])

  // Auto-play once on first view (not under reduced motion).
  useEffect(() => {
    if (!motionOn) return
    const t = window.setTimeout(() => setPlaying(true), 700)
    return () => window.clearTimeout(t)
  }, [motionOn])

  // Keys: Space plays / pauses, arrows step between span edges.
  const edges = useMemo(() => [...new Set(rows.flatMap((r) => [r.o, r.o + r.d]))].sort((a, b) => a - b), [rows])
  useEffect(() => {
    const key = (e: KeyboardEvent) => {
      const el = e.target as HTMLElement | null
      if (e.ctrlKey || e.metaKey || e.altKey || !el) return
      if (['INPUT', 'TEXTAREA', 'SELECT'].includes(el.tagName) || el.isContentEditable) return
      if (e.key === ' ') {
        if (el.tagName === 'BUTTON' || el.getAttribute('role') === 'button') return
        e.preventDefault()
        toggle()
      } else if (e.key === 'ArrowRight') {
        e.preventDefault(); setPlaying(false); seek(edges.find((v) => v > tRef.current + 0.01) ?? total)
      } else if (e.key === 'ArrowLeft') {
        e.preventDefault(); setPlaying(false); seek([...edges].reverse().find((v) => v < tRef.current - 0.01) ?? 0)
      }
    }
    document.addEventListener('keydown', key)
    return () => document.removeEventListener('keydown', key)
  }, [edges, seek, toggle, total])

  // The passages appear as the search step completes.
  const ret = rows.find((r) => r.s.type === 'retrieval')
  const retFrac = !ret ? 1 : ret.d <= 0 ? (T >= ret.o ? 1 : 0) : Math.max(0, Math.min(1, (T - ret.o) / ret.d))
  const q = Math.round(retFrac * 20) / 20
  useEffect(() => { onRetrieval?.(q) }, [q, onRetrieval])

  const active = rows.filter((r) => r.depth > 0 && r.o <= T && T <= r.o + r.d)
  const models = rows.filter((r) => r.s.type === 'model_call')
  const ans = models.find((r) => /answer|respon|generat/i.test(r.s.name)) ?? models[models.length - 1] ?? rows[0]
  const frac = ans ? (ans.d <= 0 ? (T >= ans.o ? 1 : 0) : Math.max(0, Math.min(1, (T - ans.o) / ans.d))) : T >= total ? 1 : 0
  const typed = answer.slice(0, Math.round(answer.length * frac))
  const ticks = x.ticks(Math.max(3, Math.floor(chartW / 90))).filter((t) => x(t) >= 0 && x(t) <= chartW)

  if (!rows.length) return null
  return (
    <Card title="Replay the answer"
      help={<>
        <p>What the bot did for this answer, step by step: search, the model calls, tools, formatting. The passages in "What the bot read" appear as search returns them, and the answer types itself out during the answer step.</p>
        <p>Play, drag the slider, or step between the starts and ends of steps with ← and →; Space plays and pauses. Scroll over the chart to zoom, drag to pan, click to move the cursor.</p>
        <p>Only what the bot reported is shown: no hidden reasoning. The checks that graded the answer are listed under Checks.</p>
      </>}
      actions={<>
        {tf.k > 1.01 && <Button size="sm" variant="ghost" onClick={resetZoom}>Reset zoom</Button>}
        <Button size="sm" onClick={toggle} data-testid="trace-play" aria-label={playing ? 'Pause' : 'Play'}>
          {playing ? <><Pause className="size-3.5" />Pause</> : T >= total ? <><RotateCcw className="size-3.5" />Again</> : <><Play className="size-3.5" />Play</>}
          <Kbd>Space</Kbd>
        </Button>
      </>}>
      <div ref={box} className="relative" data-testid="trace-playback">
        <div className="flex">
          <ul className="shrink-0" style={{ width: labelW }}>
            {rows.map((r) => (
              <li key={r.s.span_id} className="flex items-center gap-2" style={{ height: RH, paddingLeft: Math.min(r.depth, 4) * 14 }} title={`${KIND[r.s.type] ?? r.s.type}: ${r.s.name}`}>
                <span className="size-2 shrink-0 rounded-full" style={{ background: r.s.status === 'error' ? 'var(--bad)' : COLOR[r.s.type] ?? 'var(--ink-3)' }} />
                <span className={clsx('truncate text-sm', r.depth === 0 ? 'text-ink-2' : 'text-ink', r.s.status === 'error' && 'text-bad-ink')}>{r.s.name}</span>
              </li>
            ))}
          </ul>
          <svg ref={svgRef} width={chartW} height={H} className="cursor-grab touch-none select-none active:cursor-grabbing" role="img" aria-label="Trace timeline"
            onClick={(e) => { const r = e.currentTarget.getBoundingClientRect(); setPlaying(false); seek(x.invert(e.clientX - r.left)) }}>
            <defs><clipPath id={clip}><rect x={0} y={0} width={chartW} height={H} /></clipPath></defs>
            {ticks.map((t) => <line key={t} x1={x(t)} x2={x(t)} y1={0} y2={H - AXIS_H} stroke="var(--line)" strokeDasharray="2 3" />)}
            <g clipPath={`url(#${clip})`}>
              {rows.map((r, i) => {
                const y = i * RH + 7
                const xs = x(r.o)
                const xe = Math.min(x(r.o + r.d), chartW)
                const filled = x(r.o + Math.min(r.d, Math.max(0, T - r.o)))
                const col = r.s.status === 'error' ? 'var(--bad)' : COLOR[r.s.type] ?? 'var(--ink-3)'
                const done = r.o + r.d <= T
                const label = ms(r.d)
                const lw = label.length * 6.8 + 6
                // Labels never run off the right edge: outside if there is room, else inside the bar, else to its left.
                const place = xe + 5 + lw <= chartW ? 'out' : xe - xs >= lw + 10 ? 'in' : 'left'
                return (
                  <g key={r.s.span_id}>
                    <rect x={xs} y={y} width={Math.max(2, x(r.o + r.d) - xs)} height={RH - 14} rx={4} fill={col} opacity={0.16} />
                    {T > r.o && <rect x={xs} y={y} width={Math.max(2, filled - xs)} height={RH - 14} rx={4} fill={col} />}
                    {done && (
                      <text x={place === 'out' ? xe + 5 : place === 'in' ? xe - 6 : xs - 5} y={y + (RH - 14) / 2 + 4}
                        textAnchor={place === 'out' ? 'start' : 'end'} className={clsx('c-num', place === 'in' ? 'c-on-dark' : undefined)}
                        style={place === 'in' ? undefined : { fill: 'var(--ink-2)' }}>{label}</text>
                    )}
                  </g>
                )
              })}
              {x(T) >= 0 && x(T) <= chartW && <line x1={x(T)} x2={x(T)} y1={0} y2={H - AXIS_H} stroke="var(--ink)" strokeWidth={1.5} data-testid="trace-cursor" />}
            </g>
            <line x1={0} x2={chartW} y1={H - AXIS_H} y2={H - AXIS_H} stroke="var(--line-strong)" />
            {ticks.map((t) => <text key={t} x={x(t)} y={H - 8} textAnchor={x(t) < 24 ? 'start' : x(t) > chartW - 24 ? 'end' : 'middle'} className="c-num">{fmtTick(t, ticks.length > 1 ? ticks[1] - ticks[0] : 1000)}</text>)}
          </svg>
        </div>
        <div className="mt-2 flex items-center gap-3">
          <input type="range" min={0} max={1000} value={Math.round((T / total) * 1000)} aria-label="Time in the trace"
            onChange={(e) => { setPlaying(false); seek((+e.target.value / 1000) * total) }} className="flex-1 accent-[var(--accent)]" data-testid="trace-scrubber" />
          <span className="num w-28 text-right font-mono text-sm text-ink" data-testid="trace-time">{ms(T)} <span className="text-ink-3">/ {ms(total)}</span></span>
        </div>
        <div className="mt-4 grid gap-6 md:grid-cols-2">
          <div>
            <div className="t-label">Now</div>
            <div className="mt-1.5 min-h-10 space-y-1 text-sm" data-testid="trace-now">
              {T >= total ? <span className="text-good-ink">Done in <span className="font-mono">{ms(total)}</span>.</span>
                : active.length ? active.map((r) => (
                  <div key={r.s.span_id} className="flex gap-2">
                    <span className="mt-1.5 size-2 shrink-0 rounded-full" style={{ background: COLOR[r.s.type] ?? 'var(--ink-3)' }} />
                    <span className="min-w-0"><span className="font-medium text-ink">{r.s.name}</span> <span className="text-ink-3">{KIND[r.s.type] ?? r.s.type}</span>
                      {(r.s.output_summary || r.s.input_summary) && <span className="line-clamp-2 text-ink-2">{r.s.output_summary || r.s.input_summary}</span>}</span>
                  </div>
                )) : <span className="text-ink-3">Between steps.</span>}
            </div>
          </div>
          <div>
            <div className="t-label">Answer so far</div>
            <p className="mt-1.5 min-h-10 whitespace-pre-wrap text-sm leading-relaxed text-ink" data-testid="trace-answer">
              {typed}
              {frac > 0 && frac < 1 && <motion.span className="ml-px inline-block h-[1.1em] w-1.5 bg-accent align-text-bottom" animate={{ opacity: [1, 0] }} transition={{ duration: 0.5, repeat: Infinity, repeatType: 'reverse' }} />}
              {frac === 0 && <span className="text-ink-3">Nothing yet.</span>}
            </p>
          </div>
        </div>
      </div>
    </Card>
  )
}
