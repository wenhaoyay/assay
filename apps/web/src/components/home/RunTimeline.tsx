// The chatbot page's run timeline (B1): every comparable run as a bead on a dated line, the 95%
// band behind it, notes where the variant changed, the gate, and a brushable strip to read a range.
import * as d3 from 'd3'
import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import { Link } from 'react-router-dom'
import { ms, pct, pp } from '../../lib/format'
import { useHotkey } from '../../lib/hotkeys'
import { useMotionOn } from '../../lib/prefs'
import type { CaseMatrix, Lineage } from '../../lib/types'
import { cellState, Delta, Fingerprint, FingerprintLegend } from '../instrument'
import { Kbd, Segmented, linkButton } from '../ui'
import { dayLabel, matrixCells, variantChange, type Point } from './shared'

export type Metric = 'pass' | 'p95'

const HEIGHT = 380
const M = { t: 62, r: 20, b: 84, l: 46 }
const CTX_H = 34

const at = (p: Point) => new Date(p.at ?? 0)

export function RunTimeline({ lineage, offTopic, gate, matrix, defaultRun, metric }: {
  metric: Metric
  lineage: Lineage
  offTopic: Point[]
  gate: number | null
  matrix: CaseMatrix | undefined
  defaultRun: number | null
}) {
  const motionOn = useMotionOn()
  const line = useMemo(() => lineage.points.filter((p) => !p.off_topic && p.at).sort((a, b) => at(a).getTime() - at(b).getTime()), [lineage])
  const all = useMemo(() => [...line, ...offTopic.filter((p) => p.at)].sort((a, b) => at(a).getTime() - at(b).getTime()), [line, offTopic])
  const [picked, setPicked] = useState<number | null>(null)
  const sel = picked !== null && all.some((p) => p.run_id === picked) ? picked : (defaultRun !== null && all.some((p) => p.run_id === defaultRun) ? defaultRun : all.at(-1)?.run_id ?? null)
  const [range, setRange] = useState<[number, number] | 'few' | null>(null)
  const wrap = useRef<HTMLDivElement>(null)
  const svgRef = useRef<SVGSVGElement>(null)
  const [width, setWidth] = useState(0)
  const pickRef = useRef(setPicked)
  const rangeRef = useRef(setRange)
  const selRef = useRef(sel)
  useEffect(() => { selRef.current = sel })

  useEffect(() => {
    const el = wrap.current
    if (!el) return
    const ro = new ResizeObserver(([e]) => setWidth(Math.floor(e.contentRect.width)))
    ro.observe(el)
    return () => ro.disconnect()
  }, [])

  // Draw the chart (not on selection: the selection effect below restyles the beads).
  useEffect(() => {
    const svgEl = svgRef.current
    if (!svgEl || !width || !all.length) return
    const W = width
    const svg = d3.select(svgEl)
    svg.selectAll('*').remove()
    const height = line.length > 1 ? HEIGHT : HEIGHT - CTX_H
    svg.attr('width', W).attr('height', height)
    const isP = metric === 'pass'
    const val = (p: Point) => (isP ? p.pass_rate : p.p95_latency_ms)
    const [d0, d1] = d3.extent(all, at) as [Date, Date]
    const pad = Math.max(86_400_000, (d1.getTime() - d0.getTime()) * 0.04)
    const x = d3.scaleTime().domain([new Date(d0.getTime() - pad), new Date(d1.getTime() + pad)]).range([M.l, W - M.r])
    const p95s = all.map((p) => p.p95_latency_ms).filter((v): v is number => v !== null && v !== undefined)
    const [lo, hi] = p95s.length ? (d3.extent(p95s) as [number, number]) : [0, 1000]
    const y = isP ? d3.scaleLinear().domain([0, 1]).range([HEIGHT - M.b, M.t])
      : d3.scaleLinear().domain([Math.max(0, lo - (hi - lo || lo * 0.2) * 0.6), hi + (hi - lo || hi * 0.2) * 0.6]).nice().range([HEIGHT - M.b, M.t])
    const fmtY = isP ? d3.format('.0%') : (v: d3.NumberValue) => `${(+v / 1000).toFixed(1)}s`

    svg.append('g').attr('class', 'gridline').attr('transform', `translate(${M.l},0)`)
      .call(d3.axisLeft(y).ticks(5).tickSize(-(W - M.l - M.r)).tickFormat(() => ''))
    svg.append('g').attr('class', 'axis').attr('transform', `translate(${M.l},0)`)
      .call(d3.axisLeft(y).ticks(5).tickFormat(fmtY)).call((g) => g.select('.domain').remove())
    svg.append('g').attr('class', 'axis').attr('transform', `translate(0,${HEIGHT - M.b})`)
      .call(d3.axisBottom(x).ticks(d1.getTime() - d0.getTime() < 10 * 86_400_000 ? d3.timeDay.every(1)! : d3.timeWeek.every(1)!).tickFormat((d) => d3.timeFormat('%d %b')(d as Date)))

    const drawn = line.filter((p) => val(p) !== null && val(p) !== undefined)
    if (isP && gate !== null) {
      svg.append('line').attr('x1', M.l).attr('x2', W - M.r).attr('y1', y(gate)).attr('y2', y(gate)).attr('stroke', 'var(--ink-3)').attr('stroke-dasharray', '5 4')
      svg.append('text').attr('x', M.l + 6).attr('y', y(gate) - 6).text(`release gate ${Math.round(gate * 100)}%`)
    }
    if (isP) {
      const band = drawn.filter((p) => p.ci_low != null && p.ci_high != null)
      if (band.length > 1) {
        svg.append('path').datum(band).attr('fill', 'var(--accent)').attr('opacity', 0.1)
          .attr('d', d3.area<Point>().x((p) => x(at(p))).y0((p) => y(p.ci_low!)).y1((p) => y(p.ci_high!)).curve(d3.curveMonotoneX))
      }
    }
    if (drawn.length > 1) {
      const path = svg.append('path').datum(drawn).attr('fill', 'none').attr('stroke', 'var(--accent)').attr('stroke-width', 2.2)
        .attr('d', d3.line<Point>().x((p) => x(at(p))).y((p) => y(val(p)!)).curve(d3.curveMonotoneX))
      if (motionOn) {
        const L = (path.node() as SVGPathElement).getTotalLength()
        path.attr('stroke-dasharray', `${L} ${L}`).attr('stroke-dashoffset', L).transition().duration(1100).ease(d3.easeCubicOut).attr('stroke-dashoffset', 0)
      }
    }

    // Notes: where the variant changed (red when the pass rate fell there).
    const notes: { p: Point; text: string; drop: boolean }[] = []
    drawn.forEach((p, i) => {
      if (i === 0) { notes.push({ p, text: 'First reading', drop: false }); return }
      const t = variantChange(drawn[i - 1].variant, p.variant)
      const drop = p.pass_rate !== null && drawn[i - 1].pass_rate !== null && p.pass_rate < drawn[i - 1].pass_rate! - 0.005
      if (t) notes.push({ p, text: t, drop })
    })
    const levels: number[] = [-Infinity, -Infinity, -Infinity]
    for (const n of notes) {
      const X = x(at(n.p))
      const w = n.text.length * 6.6
      const left = Math.max(M.l, Math.min(X - w / 2, W - M.r - w))
      let lv = levels.findIndex((end) => end < left - 8)
      if (lv < 0) lv = levels.indexOf(Math.min(...levels))
      levels[lv] = left + w
      const ty = 14 + lv * 16
      const v = val(n.p)
      if (v !== null && v !== undefined) svg.append('line').attr('x1', X).attr('x2', X).attr('y1', ty + 5).attr('y2', y(v) - 8).attr('stroke', 'var(--line-strong)').attr('stroke-dasharray', '2 3')
      svg.append('text').attr('x', left + w / 2).attr('y', ty).attr('text-anchor', 'middle').attr('class', 'c-note')
        .style('fill', n.drop ? 'var(--bad-ink)' : '').text(n.text)
    }

    // Beads
    const g = svg.append('g')
    const selected = selRef.current
    all.forEach((p, i) => {
      const v = val(p)
      const X = x(at(p))
      const Y = v === null || v === undefined ? HEIGHT - M.b : y(v)
      const b = g.append('g').attr('class', 'bead').attr('data-run', p.run_id).style('cursor', 'pointer')
        .attr('role', 'button').attr('aria-label', `Run #${p.run_id}`)
        .on('click', () => pickRef.current(p.run_id))
      b.append('title').text(`Run #${p.run_id} · ${dayLabel(p.at)}\n${p.variant}\n${isP ? pct(p.pass_rate) : ms(p.p95_latency_ms)}${p.off_topic ? `\nasked ${p.off_topic}'s questions: not comparable` : ''}`)
      b.append('circle').attr('class', 'halo').attr('cx', X).attr('cy', Y).attr('r', 14).attr('fill', 'none').attr('stroke', 'var(--accent)')
        .attr('opacity', p.run_id === selected ? 0.35 : 0)
      if (p.off_topic) {
        b.append('circle').attr('class', 'dot').attr('cx', X).attr('cy', Y).attr('r', 7).attr('fill', 'var(--page)').attr('stroke', 'var(--warn)').attr('stroke-width', 2).attr('stroke-dasharray', '3 2')
        b.append('text').attr('x', X).attr('y', Y + 22).attr('text-anchor', 'middle').style('fill', 'var(--warn-ink)').text('not comparable')
      } else {
        const r = p.run_id === selected ? 8 : 5.5
        const c = b.append('circle').attr('class', 'dot').attr('data-r', r).attr('cx', X).attr('cy', Y).attr('fill', 'var(--accent)').attr('stroke', 'var(--surface)').attr('stroke-width', 2)
        if (motionOn) c.attr('r', 0).transition().delay(300 + i * 70).duration(500).ease(d3.easeBackOut.overshoot(3)).attr('r', r)
        else c.attr('r', r)
      }
      b.append('text').attr('class', 'c-num runno').attr('x', X).attr('y', HEIGHT - M.b + 32).attr('text-anchor', 'middle')
        .style('fill', p.run_id === selected ? 'var(--ink)' : '').text(`#${p.run_id}`)
    })

    // One run: a dotted ghost line where the next run will go, and no strip to brush.
    if (line.length < 2) {
      const only = drawn[0]
      if (only && val(only) != null) {
        const X = x(at(only))
        const Y = y(val(only)!)
        svg.append('path').attr('d', `M${X + 12},${Y} C${X + 60},${Y} ${X + 90},${Y - 14} ${Math.min(W - M.r, X + 220)},${Y - 22}`)
          .attr('fill', 'none').attr('stroke', 'var(--line-strong)').attr('stroke-dasharray', '3 4')
        svg.append('text').attr('class', 'c-note').attr('x', Math.min(W - M.r, X + 220)).attr('y', Y - 30).attr('text-anchor', 'end').text('The next run draws the line.')
      }
      return () => { svg.selectAll('*').interrupt() }
    }

    // Context strip with a brush: read a range of runs.
    const cy0 = HEIGHT - CTX_H + 4
    svg.append('rect').attr('x', M.l).attr('y', cy0).attr('width', W - M.l - M.r).attr('height', CTX_H - 10).attr('rx', 6).attr('fill', 'var(--surface-2)')
    const cyS = d3.scaleLinear().domain([0, 1]).range([cy0 + CTX_H - 12, cy0 + 2])
    const ctxLine = line.filter((p) => p.pass_rate !== null)
    if (ctxLine.length > 1) svg.append('path').datum(ctxLine).attr('fill', 'none').attr('stroke', 'var(--ink-3)').attr('stroke-width', 1.2)
      .attr('d', d3.line<Point>().x((p) => x(at(p))).y((p) => cyS(p.pass_rate!)))
    const brush = d3.brushX().extent([[M.l, cy0], [W - M.r, cy0 + CTX_H - 10]]).on('brush end', (e: d3.D3BrushEvent<unknown>) => {
      if (!e.selection) { rangeRef.current(null); return }
      const [a, b] = (e.selection as [number, number]).map((v) => x.invert(v))
      const inR = line.filter((p) => at(p) >= a && at(p) <= b)
      rangeRef.current(inR.length < 2 ? 'few' : [inR[0].run_id, inR[inR.length - 1].run_id])
    })
    svg.append('g').attr('class', 'brush').attr('data-testid', 'timeline-brush').call(brush)
    return () => { svg.selectAll('*').interrupt() }
  }, [width, metric, all, line, gate, motionOn])

  // Restyle the beads when the selection changes.
  useEffect(() => {
    const svgEl = svgRef.current
    if (!svgEl) return
    d3.select(svgEl).selectAll<SVGGElement, unknown>('g.bead').each(function () {
      const g = d3.select(this)
      const on = Number(g.attr('data-run')) === sel
      g.select('circle.halo').attr('opacity', on ? 0.35 : 0)
      g.select('text.runno').style('fill', on ? 'var(--ink)' : '')
      const dot = g.select<SVGCircleElement>('circle.dot[data-r]')
      const r = on ? 8 : 5.5
      if (!dot.empty() && Number(dot.attr('data-r')) !== r) dot.attr('data-r', r).interrupt().transition().duration(motionOn ? 180 : 0).attr('r', r)
    })
  }, [sel, motionOn, width, metric])

  useHotkey([']', '['], (e) => {
    const i = all.findIndex((p) => p.run_id === sel)
    if (e.key === ']' && i < all.length - 1) setPicked(all[i + 1].run_id)
    if (e.key === '[' && i > 0) setPicked(all[i - 1].run_id)
  })

  const selPoint = all.find((p) => p.run_id === sel) ?? null
  const cells = matrixCells(matrix, sel)

  // Brushed range readout.
  let readout: ReactNode = null
  if (range === 'few') readout = <span className="text-ink-3">Pick at least two runs.</span>
  else if (range) {
    const f = line.find((p) => p.run_id === range[0])!
    const l = line.find((p) => p.run_id === range[1])!
    const changed = matrix ? matrix.cases.filter((c) => cellState(matrix.cells[c.id]?.[String(f.run_id)]) !== cellState(matrix.cells[c.id]?.[String(l.run_id)])).length : null
    const dp95 = f.p95_latency_ms != null && l.p95_latency_ms != null ? l.p95_latency_ms - f.p95_latency_ms : null
    readout = (
      <span className="text-ink-2" data-testid="timeline-readout">
        Runs <span className="font-mono font-semibold text-ink">#{f.run_id} → #{l.run_id}</span>: pass rate{' '}
        <Delta value={f.pass_rate != null && l.pass_rate != null ? l.pass_rate - f.pass_rate : null} format={(_, v) => pp(v, 0)} />
        {changed !== null && <> · <span className="font-mono">{changed}</span> question{changed === 1 ? '' : 's'} changed status</>}
        {dp95 !== null && <> · p95 <Delta value={dp95} higherIsBetter={false} noise={40} format={(a) => ms(a)} /></>}
      </span>
    )
  }

  return (
    <div className="grid items-start gap-8 xl:grid-cols-[minmax(0,8fr)_minmax(260px,4fr)]">
      <div className="min-w-0">
        <div ref={wrap} className="w-full" data-testid="run-timeline"><svg ref={svgRef} role="img" aria-label="Run timeline" className="block overflow-visible" /></div>
        {line.length > 1 && readout && <div className="mt-1 text-sm">{readout}</div>}
      </div>
      {selPoint && (
        <div className="min-w-0" data-testid="timeline-side">
          <div className="t-label">Run <span className="font-mono">#{selPoint.run_id}</span> · {dayLabel(selPoint.at)}</div>
          <div className="mb-2.5 mt-1 text-base font-semibold">{selPoint.variant}</div>
          {selPoint.off_topic && (
            <div className="mb-2.5 rounded-lg border border-warn/40 bg-warn-wash px-3 py-2 text-sm text-warn-ink">
              It asked {selPoint.off_topic}’s questions, so it is not comparable and left out of the line.
            </div>
          )}
          <div className="mb-3 flex gap-6">
            <div><div className="t-label">Pass rate</div><div className="t-fig mt-1">{pct(selPoint.pass_rate)}</div></div>
            <div><div className="t-label">p95</div><div className="t-fig mt-1">{selPoint.p95_latency_ms != null ? ms(selPoint.p95_latency_ms) : <span className="text-sm font-normal text-ink-3">not reported</span>}</div></div>
          </div>
          {cells.length > 0 && <><Fingerprint cells={cells} size="md" vt={`fp-run-${selPoint.run_id}`} /><FingerprintLegend className="mt-2" /></>}
          <div className="mt-3 flex items-center gap-2 text-sm">
            <Link to={`/runs/${selPoint.run_id}`} viewTransition className={linkButton('secondary', 'sm')}>Open run <span className="font-mono">#{selPoint.run_id}</span></Link>
            <span className="ml-auto flex items-center gap-1 text-ink-3"><Kbd>[</Kbd><Kbd>]</Kbd></span>
          </div>
        </div>
      )}
    </div>
  )
}

/** The metric switch for the timeline's heading. */
export function MetricSwitch({ value, onChange }: { value: Metric; onChange: (m: Metric) => void }) {
  return <Segmented size="sm" value={value} onChange={onChange} label="Timeline metric" options={[{ id: 'pass', label: 'Pass rate' }, { id: 'p95', label: 'p95 speed' }]} />
}
