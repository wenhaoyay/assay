// D2 How many questions do I need? The smallest reliable change against the number of questions,
// for this pair's share of questions that flip; a slider moves the marker.
import * as d3 from 'd3'
import { useId, useMemo, useState } from 'react'
import { minDetectable, questionsFor } from '../../lib/compare'
import { Card } from '../ui'
import { useWidth } from './useWidth'

const H = 240
const M = { l: 46, r: 16, t: 14, b: 28 }

export function Power({ flipShare, n0 }: { flipShare: number; n0: number }) {
  const [box, w] = useWidth(800)
  const here = Math.min(600, Math.max(20, n0))
  const [n, setN] = useState(here)
  const id = useId()
  const W = Math.max(260, w)
  const mde = (k: number) => minDetectable(flipShare, k)
  const x = d3.scaleLog().domain([20, 600]).range([M.l, W - M.r])
  const y = d3.scaleLinear().domain([0, Math.max(0.1, mde(20) * 1.08)]).nice().range([H - M.b, M.t])
  const pts = useMemo(() => d3.range(20, 601, 4), [])
  const line = d3.line<number>().x((k) => x(k)).y((k) => y(mde(k)))(pts) ?? ''
  const area = d3.area<number>().x((k) => x(k)).y0(H - M.b).y1((k) => y(mde(k)))(pts) ?? ''
  const need5 = questionsFor(flipShare, 0.05)
  return (
    <Card title="How many questions do I need?"
      help={<>
        <p>The smallest change in pass rate a set of this size can detect reliably. Move the slider to see how a bigger set narrows it.</p>
        <p>A rough guide: 80% power at the 5% level, questions paired between the two runs, using this pair's share of questions that changed result ({Math.round(flipShare * 100)}%). The detectable change is about 2.8 × √(share ÷ questions).</p>
        <p>Pairs of versions that change fewer questions can see smaller changes with the same set.</p>
      </>}>
      <div className="grid items-center gap-6 lg:grid-cols-[minmax(0,2fr)_minmax(0,1fr)]">
        <div ref={box} className="min-w-0">
          <svg width={W} height={H} role="img" aria-label="Detectable change by number of questions">
            {y.ticks(4).map((t) => (
              <g key={t}>
                <line x1={M.l} x2={W - M.r} y1={y(t)} y2={y(t)} stroke="var(--line)" strokeDasharray="2 3" />
                <text x={M.l - 6} y={y(t) + 4} textAnchor="end" className="c-num">{Math.round(t * 100)}pp</text>
              </g>
            ))}
            <line x1={M.l} x2={W - M.r} y1={H - M.b} y2={H - M.b} stroke="var(--line-strong)" />
            {[20, 50, 100, 200, 400, 600].map((t) => <text key={t} x={x(t)} y={H - M.b + 16} textAnchor="middle" className="c-num">{t}</text>)}
            <path d={area} fill="var(--accent)" opacity={0.08} />
            <path d={line} fill="none" stroke="var(--accent)" strokeWidth={2} />
            <circle cx={x(here)} cy={y(mde(here))} r={4} fill="var(--ink-3)" />
            <text x={x(here) + 8} y={y(mde(here)) - 7}>this set</text>
            <line x1={x(n)} x2={x(n)} y1={M.t} y2={H - M.b} stroke="var(--ink)" strokeDasharray="3 3" />
            <circle cx={x(n)} cy={y(mde(n))} r={6} fill="var(--accent)" stroke="var(--surface)" strokeWidth={2} data-testid="power-marker" />
          </svg>
        </div>
        <div className="space-y-3">
          <label htmlFor={id} className="t-label block">Questions in the set: <b className="font-mono font-medium text-ink">{n}</b></label>
          <input id={id} type="range" min={20} max={600} step={1} value={n} onChange={(e) => setN(+e.target.value)} className="w-full accent-[var(--accent)]" data-testid="power-slider" />
          <p className="t-readout" aria-live="polite" data-testid="power-readout">
            With <span className="font-mono">{n}</span> questions you can trust changes of about <b className="font-mono font-medium text-accent-ink">{Math.round(mde(n) * 100)}pp</b> or more.{' '}
            <span className="text-ink-2">Seeing a 5pp change takes about <span className="font-mono">{need5.toLocaleString()}</span>.</span>
          </p>
        </div>
      </div>
    </Card>
  )
}
