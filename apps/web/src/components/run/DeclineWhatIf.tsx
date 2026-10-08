// A4 "What if the bot declined below a score?": two rows of tries placed by their best document
// score, and a line you drag; tries left of it would have been declined.
import * as d3 from 'd3'
import { useEffect, useMemo, useRef, useState } from 'react'
import { useMotionOn } from '../../lib/prefs'
import { SampleSize } from '../instrument'
import { Card } from '../ui'
import { NothingPasses, useWidth } from './bits'
import type { XRow } from './data'

interface P { r: XRow; top: number; refuse: boolean; ok: boolean; x: number; y: number }

function score(rows: P[], X: number) {
  let fixed = 0, lost = 0
  for (const r of rows) if (r.top < X) { if (r.refuse && !r.ok) fixed++; else if (!r.refuse && r.ok) lost++ }
  return { fixed, lost }
}

export function DeclineWhatIf({ rows }: { rows: XRow[] }) {
  const [box, W] = useWidth<HTMLDivElement>(1000)
  const H = 170, m = { l: 120, r: 20 }
  const rowY = { refuse: 50, answer: 118 }
  const motionOn = useMotionOn()
  const base = useMemo(() => rows.filter((r) => r.top !== null).map((r) => ({ r, top: r.top as number, refuse: r.t.should_refuse, ok: r.st === 'passed' })), [rows])
  const max = d3.max(base, (b) => b.top) ?? 1
  const x = useMemo(() => d3.scaleLinear().domain([0, max]).nice().range([m.l, W - m.r]), [max, W, m.l, m.r])
  const dom = x.domain()[1]
  const digits = dom > 5 ? 1 : 2
  const pts: P[] = useMemo(() => {
    const nodes = base.map((b) => ({ ...b, x: x(b.top), y: b.refuse ? rowY.refuse : rowY.answer }))
    const sim = d3.forceSimulation(nodes).force('x', d3.forceX<(typeof nodes)[number]>((d) => x(d.top)).strength(1))
      .force('y', d3.forceY<(typeof nodes)[number]>((d) => (d.refuse ? rowY.refuse : rowY.answer)).strength(0.12)).force('c', d3.forceCollide(4.2)).stop()
    for (let i = 0; i < 120; i++) sim.tick()
    return nodes
  }, [base, x, rowY.refuse, rowY.answer])
  const best = useMemo(() => {
    let b: [number, number] = [0, 0]
    const cands = [...new Set(base.map((p) => p.top))].sort((a, c) => a - c)
    for (const v of cands) {
      const X = Math.ceil((v + 1e-9) * 10 ** digits) / 10 ** digits
      const s = score(pts, X)
      if (s.fixed - s.lost > b[1]) b = [X, s.fixed - s.lost]
    }
    return b[0]
  }, [base, pts, digits])
  const [X, setX] = useState(0)
  const svgRef = useRef<SVGSVGElement>(null)
  const started = useRef(false)

  // On first view, sweep the line from 0 to the best place for this set.
  useEffect(() => {
    const el = svgRef.current
    if (!el || started.current || !base.length) return
    if (!motionOn) { started.current = true; setX(best); return }
    let raf = 0
    let timer = 0
    const io = new IntersectionObserver((es) => {
      if (!es.some((e) => e.isIntersecting) || started.current) return
      started.current = true
      timer = window.setTimeout(() => {
        const t0 = performance.now()
        const an = (now: number) => {
          const k = Math.min(1, (now - t0) / 1400)
          setX(best * d3.easeCubicInOut(k))
          if (k < 1) raf = requestAnimationFrame(an)
        }
        raf = requestAnimationFrame(an)
      }, 600)
    }, { threshold: 0.4 })
    io.observe(el)
    return () => { io.disconnect(); cancelAnimationFrame(raf); clearTimeout(timer) }
  }, [best, motionOn, base.length])

  const dragging = useRef(false)
  const at = (clientX: number) => {
    const r = svgRef.current?.getBoundingClientRect()
    if (!r) return
    started.current = true
    setX(Math.max(0, Math.min(dom, x.invert(clientX - r.left))))
  }
  const s = score(pts, X)
  const net = s.fixed - s.lost
  const wrongly = pts.filter((p) => p.refuse && !p.ok).length
  const nRefuse = pts.filter((p) => p.refuse).length
  const near = Math.abs(X - best) < 0.6 * 10 ** -digits

  return (
    <Card title="What if the bot declined below a score?" id="decline" meta={<SampleSize n={pts.length} unit="tries" />}
      help={<>
        <p>If the bot said "I don't know" whenever its best document scored below the line, which tries would change?</p>
        <p>Top row: questions it should decline (green = now declined). Bottom row: questions it should answer (amber = good answers it would lose).</p>
        <p>Drag the line, or click anywhere on the chart. The best line is the one with the most tries fixed minus good answers lost, for this set of questions only.</p>
      </>}>
      <div ref={box} data-testid="decline-whatif">
        {!pts.length ? <NothingPasses>This bot does not report document scores, so there is nothing to place.</NothingPasses> : (
          <>
            <svg ref={svgRef} width={W} height={H} className="block cursor-crosshair touch-none select-none overflow-visible"
              onPointerDown={(e) => { dragging.current = true; (e.target as Element).setPointerCapture?.(e.pointerId); at(e.clientX) }}
              onPointerMove={(e) => { if (dragging.current) at(e.clientX) }}
              onPointerUp={() => { dragging.current = false }}>
              <rect x={m.l} y={18} height={132} width={Math.max(0, x(X) - m.l)} fill="var(--warn)" opacity={0.1} />
              <text x={0} y={rowY.refuse + 4} className="c-name">Should decline</text>
              <text x={0} y={rowY.answer + 4} className="c-name">Should answer</text>
              <Axis x={x} y={H - 16} />
              {pts.map((p) => {
                const below = p.top < X
                const fill = below ? (p.refuse ? 'var(--good)' : p.ok ? 'var(--warn)' : 'var(--bad)') : p.ok ? 'var(--good)' : 'var(--bad)'
                return <circle key={p.r.id} cx={p.x} cy={p.y} r={3.6} data-case={p.r.c} fill={fill} fillOpacity={below ? 1 : 0.55}
                  stroke={below && !p.refuse && p.ok ? 'var(--warn-ink)' : 'none'}><title>{`${p.r.t.title}: best document score ${p.top.toFixed(2)}`}</title></circle>
              })}
              <g transform={`translate(${x(X)},0)`} className="cursor-ew-resize" data-testid="decline-line">
                <line y1={14} y2={154} stroke="var(--ink)" strokeWidth={2} />
                <rect x={-17} y={2} width={34} height={16} rx={4} fill="var(--ink)" />
                <text y={14} textAnchor="middle" className="c-num c-on-dark">{X.toFixed(digits)}</text>
              </g>
            </svg>
            <p className="t-readout mt-3 max-w-4xl" data-testid="decline-readout">
              {X < 10 ** -digits / 2
                ? <>Drag the line. Today the bot never declines on its own score; {nRefuse ? <><span className="num font-mono">{wrongly}</span> tries answered questions it should have declined.</> : 'this set has no question it should decline.'}{nRefuse > 0 && best === 0 && <span className="text-ink-3"> No line helps this set: the questions it should decline score as high as the ones it answers well.</span>}</>
                : <>Declining below <span className="num font-mono">{X.toFixed(digits)}</span> would fix <span className="num font-mono text-good-ink">{s.fixed}</span> tries and lose{' '}
                  <span className={s.lost ? 'num font-mono text-bad-ink' : 'num font-mono text-ink-3'}>{s.lost}</span> good answers <span className="text-ink-3">(net {net >= 0 ? '+' : ''}{net})</span>.{' '}
                  {best > 0 && near ? <span className="text-accent-ink">This is the best line for this set.</span> : best > 0 ? <span className="text-ink-3">Best line: <span className="num font-mono">{best.toFixed(digits)}</span>.</span> : <span className="text-ink-3">No line helps this set.</span>}</>}
            </p>
          </>
        )}
      </div>
    </Card>
  )
}

function Axis({ x, y }: { x: d3.ScaleLinear<number, number>; y: number }) {
  const ref = useRef<SVGGElement>(null)
  useEffect(() => { if (ref.current) d3.select(ref.current).call(d3.axisBottom(x).ticks(10)) }, [x])
  return <g ref={ref} className="axis" transform={`translate(0,${y})`} />
}
