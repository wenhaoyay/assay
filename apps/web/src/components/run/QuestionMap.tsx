// A7 question map: questions placed by the words they share (TF-IDF, then the first two principal
// components by power iteration, all in the browser). Colour is the pass rate in this run.
import * as d3 from 'd3'
import { useEffect, useMemo, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { pct } from '../../lib/format'
import { useMotionOn } from '../../lib/prefs'
import { rateColor, SampleSize } from '../instrument'
import { Card } from '../ui'
import { ChartTip, NothingPasses, useWidth, type TipState } from './bits'
import { firstTries, plain, type XRow } from './data'
import { caseRates } from './Heatmap'
import { tokens } from './Words'

interface QP { r: XRow; px: number; py: number; rate: number }

function project(qs: XRow[]): { x: number; y: number }[] {
  const docs = qs.map((q) => { const t = tokens(q.t.question || q.t.title); return t.concat(t.slice(1).map((w, i) => `${t[i]}_${w}`)) })
  const df = new Map<string, number>()
  docs.forEach((d) => new Set(d).forEach((w) => df.set(w, (df.get(w) ?? 0) + 1)))
  const vocab = [...df.keys()]
  const vi = new Map(vocab.map((w, i) => [w, i]))
  const N = docs.length, V = vocab.length
  const X = docs.map((d) => {
    const v = new Float64Array(V)
    d.forEach((w) => { v[vi.get(w)!] += 1 })
    let n = 0
    for (let i = 0; i < V; i++) { v[i] *= Math.log((N + 1) / (df.get(vocab[i])! + 1)); n += v[i] * v[i] }
    n = Math.sqrt(n) || 1
    for (let i = 0; i < V; i++) v[i] /= n
    return v
  })
  const mean = new Float64Array(V)
  for (const r of X) for (let j = 0; j < V; j++) mean[j] += r[j] / N
  for (const r of X) for (let j = 0; j < V; j++) r[j] -= mean[j]
  const K = X.map((a) => X.map((b) => { let s = 0; for (let j = 0; j < V; j++) s += a[j] * b[j]; return s }))
  const eig = (orth?: number[]): [number[], number] => {
    let v = K.map((_, i) => Math.sin(i + 1) + (orth ? Math.cos(i * 3) : 0))
    let lam = 0
    for (let it = 0; it < 200; it++) {
      let w = K.map((row) => row.reduce((s, x, j) => s + x * v[j], 0))
      if (orth) { const d = w.reduce((s, x, i) => s + x * orth[i], 0); w = w.map((x, i) => x - d * orth[i]) }
      lam = Math.hypot(...w) || 1
      v = w.map((x) => x / lam)
    }
    return [v, lam]
  }
  const [e1, l1] = eig()
  const [e2, l2] = eig(e1)
  return qs.map((_, i) => ({ x: e1[i] * Math.sqrt(l1), y: e2[i] * Math.sqrt(l2) }))
}

export function QuestionMap({ rows }: { rows: XRow[] }) {
  const [box, W] = useWidth<HTMLDivElement>(1000)
  const H = 440, m = 30
  const nav = useNavigate()
  const motionOn = useMotionOn()
  const [tip, setTip] = useState<TipState | null>(null)
  const qs = useMemo(() => firstTries(rows), [rows])
  const coords = useMemo(() => (qs.length >= 3 ? project(qs) : []), [qs])
  const rates = useMemo(() => caseRates(rows), [rows])
  const layout = useMemo(() => {
    if (!coords.length) return null
    const x = d3.scaleLinear().domain(d3.extent(coords, (p) => p.x) as [number, number]).nice().range([m, W - m])
    const y = d3.scaleLinear().domain(d3.extent(coords, (p) => p.y) as [number, number]).nice().range([H - m, m])
    const nodes = qs.map((r, i) => ({ r, X: x(coords[i].x), Y: y(coords[i].y), x: x(coords[i].x), y: y(coords[i].y), rate: rates.get(r.c) ?? 0 }))
    const sim = d3.forceSimulation(nodes).force('x', d3.forceX<(typeof nodes)[number]>((d) => d.X).strength(0.4)).force('y', d3.forceY<(typeof nodes)[number]>((d) => d.Y).strength(0.4)).force('c', d3.forceCollide(8)).stop()
    for (let i = 0; i < 80; i++) sim.tick()
    const pts: QP[] = nodes.map((n) => ({ r: n.r, px: n.x, py: n.y, rate: n.rate }))
    const groups = [...d3.group(pts, (p) => p.r.cat)].map(([cat, ps]) => ({
      cat, hull: ps.length >= 3 ? d3.polygonHull(ps.map((p) => [p.px, p.py] as [number, number])) : null,
      lx: Math.max(54, Math.min(W - 54, d3.mean(ps, (p) => p.px) ?? 0)), ly: Math.max(14, (d3.min(ps, (p) => p.py) ?? 0) - 14),
    }))
    // Keep the category names apart: nudge a label up while it would sit on a neighbour.
    const placed: { lx: number; ly: number }[] = []
    for (const g of [...groups].sort((a, b) => a.ly - b.ly)) {
      let guard = 0
      while (guard++ < 12 && (placed.some((o) => Math.abs(o.lx - g.lx) < 120 && Math.abs(o.ly - g.ly) < 15) || pts.some((p) => Math.abs(p.px - g.lx) < 52 && Math.abs(p.py - g.ly + 4) < 11))) g.ly = Math.max(12, g.ly - 12)
      placed.push(g)
    }
    return { pts, groups }
  }, [coords, qs, rates, W])
  const [placed, setPlaced] = useState(!motionOn)
  useEffect(() => {
    if (placed || !layout) return
    const r = requestAnimationFrame(() => requestAnimationFrame(() => setPlaced(true)))
    return () => cancelAnimationFrame(r)
  }, [placed, layout])
  return (
    <Card title="Question map" id="qmap" meta={<SampleSize n={qs.length} unit="questions" />}
      help={<>
        <p>Questions placed by the words they share: similar questions sit close. Colour is the pass rate in this run; outlines group the categories.</p>
        <p>Click a dot to open its answer.</p>
        <p>TF-IDF and the first two principal components, computed in your browser. Distances are rough: a way to spot clusters, not a measure.</p>
      </>}>
      <div ref={box} data-testid="qmap">
        {!layout ? <NothingPasses>Too few questions to map.</NothingPasses> : (
          <svg width={W} height={H} className="block overflow-visible">
            {layout.groups.map((g) => g.hull && (
              <path key={`h-${g.cat}`} d={`M${g.hull.join('L')}Z`} fill="var(--ink-3)" opacity={0.06} stroke="var(--line-strong)" strokeDasharray="3 3" strokeLinejoin="round" />
            ))}
            {layout.pts.map((p, i) => (
              <circle key={p.r.c} data-case={p.r.c} r={6.5} stroke="var(--surface)" strokeWidth={1.5} className="cursor-pointer"
                style={{ fill: rateColor(p.rate), transform: placed ? `translate(${p.px}px, ${p.py}px)` : `translate(${W / 2}px, ${H / 2}px)`, transition: motionOn ? `transform 1200ms cubic-bezier(0.33,1,0.68,1) ${i * 12}ms` : undefined }}
                onMouseMove={(e) => setTip({ x: e.clientX, y: e.clientY, body: <><div className="font-medium text-ink">{p.r.t.title}</div><span className="num font-mono">{pct(p.rate, 0)}</span> of tries passed</> })}
                onMouseLeave={() => setTip(null)}
                onClick={() => nav(`/trials/${p.r.id}`, { viewTransition: true })} />
            ))}
            {layout.groups.map((g) => (
              <text key={`t-${g.cat}`} x={g.lx} y={g.ly} textAnchor="middle" className="c-note pointer-events-none"
                style={{ paintOrder: 'stroke', stroke: 'var(--surface)', strokeWidth: 4, strokeLinejoin: 'round' }}>{plain(g.cat)}</text>
            ))}
          </svg>
        )}
        <ChartTip tip={tip} />
      </div>
    </Card>
  )
}
