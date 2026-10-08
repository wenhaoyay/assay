// D1 Show me why: the paired bootstrap, made visible. Each re-draw of the questions drops a dot
// into a stacked histogram; the 95% band forms as they land.
import * as d3 from 'd3'
import { Play, RotateCcw } from 'lucide-react'
import { useEffect, useMemo, useRef, useState } from 'react'
import { mulberry32, redraw } from '../../lib/compare'
import { useMotionOn } from '../../lib/prefs'
import { Button, Card } from '../ui'
import { useWidth } from './useWidth'

const N = 600
const H = 280
const M = { l: 16, r: 16, b: 30, t: 12 }
const ppf = (v: number, digits = 0) => `${v > 0 ? '+' : v < 0 ? '−' : ''}${Math.abs(v * 100).toFixed(digits)}pp`

interface Readout { n: number; lo: number; hi: number; zero: number; done: boolean }

export function Bootstrap({ diffs, nQuestions }: { diffs: number[]; nQuestions: number }) {
  const motionOn = useMotionOn()
  const [box, w] = useWidth(800)
  const svgRef = useRef<SVGSVGElement>(null)
  const [run, setRun] = useState(0)
  const [say, setSay] = useState<Readout | null>(null)
  const obs = d3.mean(diffs) ?? 0
  // Every re-draw is computed up front (seeded: the same pair re-draws the same way each time).
  const draws = useMemo(() => {
    const rand = mulberry32(42)
    return Array.from({ length: N }, () => redraw(diffs, rand))
  }, [diffs])
  const chartW = Math.max(240, w)

  useEffect(() => {
    const svg = d3.select(svgRef.current!)
    svg.selectAll('*').interrupt().remove()
    const sd = d3.deviation(diffs) ?? 0.1
    const se = sd / Math.sqrt(Math.max(diffs.length, 1))
    const lo0 = Math.min(-0.05, obs - 4.5 * se, d3.min(draws) ?? 0)
    const hi0 = Math.max(0.05, obs + 4.5 * se, d3.max(draws) ?? 0)
    const x = d3.scaleLinear().domain([lo0, hi0]).nice().range([M.l, chartW - M.r])
    const base = H - M.b
    svg.append('g').attr('class', 'axis').attr('transform', `translate(0,${base})`)
      .call(d3.axisBottom(x).ticks(Math.max(3, Math.floor(chartW / 90))).tickFormat((d) => ppf(+d)))
    svg.append('line').attr('x1', x(0)).attr('x2', x(0)).attr('y1', M.t).attr('y2', base).attr('stroke', 'var(--bad)').attr('stroke-dasharray', '4 3')
    svg.append('text').attr('x', x(0) + 6).attr('y', M.t + 10).style('fill', 'var(--bad-ink)').text('no change')
    const band = svg.append('rect').attr('y', M.t).attr('height', base - M.t).attr('fill', 'var(--ink-3)').attr('opacity', 0)
    svg.append('line').attr('x1', x(obs)).attr('x2', x(obs)).attr('y1', M.t).attr('y2', base).attr('stroke', 'var(--accent)').attr('stroke-width', 2)
    const right = x(obs) > chartW - 150
    svg.append('text').attr('x', right ? x(obs) - 6 : x(obs) + 6).attr('y', M.t + 10).attr('text-anchor', right ? 'end' : 'start')
      .style('fill', 'var(--accent-ink)').text(`measured ${ppf(obs, 1)}`)
    if (run === 0) return
    // Bins a dot wide; the stack step shrinks if the tallest stack would not fit.
    const r = 2.6
    const bw = (x.domain()[1] - x.domain()[0]) / ((chartW - M.l - M.r) / (r * 2.2))
    const bins = draws.map((v) => Math.round(v / bw))
    const tallest = d3.max(d3.rollup(bins, (v) => v.length, (b) => b).values()) ?? 1
    const step = Math.min(r * 2 - 0.4, (base - M.t - 30) / tallest)
    const g = svg.append('g')
    const stacks = new Map<number, number>()
    let i = 0
    let timer: number | undefined
    const tick = () => {
      const batch = !motionOn ? N : i < 40 ? 1 : i < 150 ? 4 : 12
      for (let k = 0; k < batch && i < N; k++, i++) {
        const b = bins[i]
        const h = (stacks.get(b) ?? 0) + 1
        stacks.set(b, h)
        const c = g.append('circle').attr('cx', x(b * bw)).attr('r', r).attr('fill', 'var(--accent)').attr('opacity', 0.8)
        const cy = base - 4 - (h - 1) * step
        if (motionOn) c.attr('cy', M.t).transition().duration(500).ease(d3.easeBounceOut).attr('cy', cy)
        else c.attr('cy', cy)
      }
      const done = draws.slice(0, i).sort((a, b) => a - b)
      if (done.length >= 30 || i >= N) {
        const lo = d3.quantileSorted(done, 0.025) ?? 0
        const hi = d3.quantileSorted(done, 0.975) ?? 0
        band.attr('x', x(lo)).attr('width', Math.max(1, x(hi) - x(lo))).attr('opacity', 0.1)
        const zero = obs >= 0 ? done.filter((v) => v <= 0).length : done.filter((v) => v >= 0).length
        setSay({ n: done.length, lo, hi, zero, done: i >= N })
      }
      if (i < N) timer = window.setTimeout(tick, 30)
    }
    tick()
    return () => {
      window.clearTimeout(timer)
      svg.selectAll('*').interrupt()
    }
  }, [chartW, run, draws, diffs, obs, motionOn])

  const beyond = !!say && (say.lo > 0 || say.hi < 0)
  return (
    <Card title="Show me why"
      help={<>
        <p>Draws {nQuestions} questions at random, with repeats, and measures the change in pass rate again, {N} times; each dot is one re-draw (the paired bootstrap).</p>
        <p>If the change were luck, many re-draws would land on zero or beyond it. The grey band is where 95% of them land: the same interval as the needle's.</p>
        <p>The draws are seeded, so the same two runs always re-draw the same way.</p>
      </>}
      actions={<Button size="sm" variant="primary" onClick={() => { setSay(null); setRun((v) => v + 1) }} data-testid="bootstrap-go">
        {run ? <RotateCcw className="size-3.5" /> : <Play className="size-3.5" />}Resample {N} times
      </Button>}>
      <div className="grid items-center gap-6 lg:grid-cols-[minmax(0,2fr)_minmax(0,1fr)]">
        <div ref={box} className="min-w-0"><svg ref={svgRef} width={chartW} height={H} role="img" aria-label="Bootstrap re-draws of the pass-rate change" /></div>
        <p className="t-readout" aria-live="polite" data-testid="bootstrap-readout">
          {!say ? <>Pick {nQuestions} questions at random, with repeats, and measure the change again. Do it {N} times.</> : (
            <>
              <span className="font-mono">{say.n}</span> re-draws. 95% land between <b className="font-mono font-medium">{ppf(say.lo)}</b> and <b className="font-mono font-medium">{ppf(say.hi)}</b>;{' '}
              <b className={say.zero ? 'font-mono font-medium text-bad-ink' : 'font-mono font-medium text-good-ink'}>{say.zero}</b> reach zero.
              {say.done && (beyond
                ? <span className="text-accent-ink"> That is "beyond noise".</span>
                : <span className="text-ink-2"> Zero is inside the band: that is "within noise".</span>)}
            </>
          )}
        </p>
      </div>
    </Card>
  )
}
