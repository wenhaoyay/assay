// C1 the live run: a tile per try, the latest questions, the pass rate so far with its 95% interval
// narrowing as tries finish, and each answer's speed dropping into a beeswarm.
import clsx from 'clsx'
import * as d3 from 'd3'
import { motion } from 'motion/react'
import { useEffect, useMemo, useRef, useState } from 'react'
import { Link } from 'react-router-dom'
import { ms, num, pct, usd } from '../../lib/format'
import { useMotionOn } from '../../lib/prefs'
import { isLive } from '../../lib/runstate'
import type { RunHeader, TrialRow } from '../../lib/types'
import { pctTick } from '../charts'
import { Odometer, SampleSize } from '../instrument'
import { Card, Help } from '../ui'
import { LegendItem, useWidth } from './bits'
import { wilson } from './data'

const FINISHED = new Set(['passed', 'failed', 'error'])

export function finishedTries(rows: TrialRow[]) {
  return rows.filter((t) => FINISHED.has(t.status)).sort((a, b) => a.id - b.id)
}

function clock(sec: number) {
  if (!Number.isFinite(sec) || sec < 0) return '–'
  if (sec >= 3600) { const h = Math.floor(sec / 3600), m = Math.round((sec % 3600) / 60); return m ? `${h}h ${String(m).padStart(2, '0')}m` : `${h}h` }
  const m = Math.floor(sec / 60), s = Math.round(sec % 60)
  return m ? `${m}m ${String(s).padStart(2, '0')}s` : `${s}s`
}

/** What the run is waiting on right now, in words ("Grading with ollama/llama3.1:8b · call 41 of 3,480"). */
export function waitingLine(r: RunHeader): string | null {
  const p = r.progress
  if (!p || !p.waiting_on) return null
  if (p.waiting_on === 'bot') return 'Waiting for the bot'
  const who = p.grading_model ? `Grading with ${p.grading_model}` : 'Grading'
  return p.judge_calls_total ? `${who} · call ${num(Math.min(p.judge_calls_done ?? 0, p.judge_calls_total))} of ${num(p.judge_calls_total)}` : who
}
export function LiveFigures({ r, rows, now }: { r: RunHeader; rows: TrialRow[]; now: number }) {
  const fin = finishedTries(rows)
  const pass = fin.filter((t) => t.status === 'passed').length
  const n = fin.length
  const [lo, hi] = wilson(pass, n)
  const total = r.progress_total || rows.length
  const elapsed = r.started_at ? ((r.finished_at ? new Date(r.finished_at).getTime() : now) - new Date(r.started_at).getTime()) / 1000 : 0
  const done = Math.max(n, r.progress_done)
  const observed = done > 0 && done < total ? (elapsed / done) * (total - done) : NaN
  const eta = r.progress?.eta_s
  const left = eta != null ? eta : observed
  const waiting = waitingLine(r)
  const spend = rows.reduce((a, t) => a + (t.target_cost_usd ?? 0) + (t.judge_cost_usd ?? 0), 0)
  const active = isLive(r.status)
  return (
    <div className="flex flex-wrap items-end gap-x-8 gap-y-3" data-testid="live-figures">
      <div><div className="t-label">Answered</div><div className="t-fig mt-1"><Odometer text={String(done)} /><span className="text-ink-3"> / {total}</span></div></div>
      <div>
        <div className="t-label">Pass rate so far</div>
        <div className="t-fig mt-1">{n ? <><Odometer text={pct(pass / n)} /><span className="ml-1.5 font-mono text-xs text-ink-3">± {Math.round(((hi - lo) / 2) * 100)} pp</span></> : '–'}</div>
      </div>
      <div><div className="t-label">{active ? 'Time left' : 'Took'}</div><div className="t-fig mt-1 num">{active ? (r.status === 'queued' && eta == null ? 'queued' : r.status === 'cancelling' ? 'stopping' : clock(left)) : clock(elapsed)}</div>
        {active && waiting && r.status !== 'cancelling' && <div className="mt-0.5 max-w-xs text-xs text-ink-3" data-testid="live-waiting">{waiting}</div>}</div>
      <div><div className="t-label">Spent</div><div className="t-fig mt-1 text-ink-2"><Odometer text={usd(spend)} /></div></div>
    </div>
  )
}

function Tiles({ total, fin, inFlight }: { total: number; fin: TrialRow[]; inFlight: number }) {
  const motionOn = useMotionOn()
  return (
    <div className="flex flex-wrap gap-[3px]" aria-label={`${fin.length} of ${total} tries finished`} data-testid="live-tiles">
      {Array.from({ length: Math.max(total, fin.length) }, (_, i) => {
        const t = fin[i]
        const flying = !t && i < fin.length + inFlight
        return (
          <motion.span key={t ? `t${t.id}` : `p${i}`} data-case={t?.case_id} title={t ? `${t.case_id}: ${t.status}` : flying ? 'being asked' : 'waiting'}
            initial={t && motionOn ? { scale: 0.4, opacity: 0.4 } : false} animate={{ scale: 1, opacity: 1 }} transition={{ type: 'spring', stiffness: 500, damping: 18 }}
            className={clsx('size-3.5 rounded-[3px]', !t && !flying && 'bg-surface-3', flying && 'bg-accent/50', flying && motionOn && 'animate-pulse',
              t?.status === 'passed' && 'bg-good', t?.status === 'failed' && 'bg-bad', t?.status === 'error' && 'bg-error')} />
        )
      })}
    </div>
  )
}

function Funnel({ fin, total, gate }: { fin: TrialRow[]; total: number; gate: number | null }) {
  const [box, W] = useWidth<HTMLDivElement>(480)
  const H = 260, m = { l: 40, r: 10, t: 10, b: 26 }
  const x = d3.scaleLinear().domain([0, Math.max(1, total)]).range([m.l, W - m.r])
  const y = d3.scaleLinear().domain([0, 1]).range([H - m.b, m.t])
  const hist = useMemo(() => {
    let p = 0
    return fin.map((t, i) => { if (t.status === 'passed') p++; const [lo, hi] = wilson(p, i + 1); return { n: i + 1, r: p / (i + 1), lo, hi } })
  }, [fin])
  const ax = useRef<SVGGElement>(null), ay = useRef<SVGGElement>(null)
  useEffect(() => {
    if (ax.current) d3.select(ax.current).call(d3.axisBottom(x).ticks(6))
    if (ay.current) d3.select(ay.current).call(d3.axisLeft(y).ticks(4).tickFormat((v) => pctTick(+v)))
  }, [x, y])
  const band = d3.area<(typeof hist)[number]>().x((d) => x(d.n)).y0((d) => y(d.lo)).y1((d) => y(d.hi))(hist) ?? ''
  const line = d3.line<(typeof hist)[number]>().x((d) => x(d.n)).y((d) => y(d.r))(hist) ?? ''
  return (
    <div ref={box} data-testid="live-funnel">
      <svg width={W} height={H} className="block overflow-visible">
        <g ref={ay} className="axis" transform={`translate(${m.l},0)`} />
        <g ref={ax} className="axis" transform={`translate(0,${H - m.b})`} />
        {gate !== null && <><line x1={m.l} x2={W - m.r} y1={y(gate)} y2={y(gate)} stroke="var(--ink-3)" strokeDasharray="4 4" /><text x={m.l + 6} y={y(gate) - 5} className="c-num">gate {pct(gate, 0)}</text></>}
        <path d={band} fill="var(--accent)" opacity={0.14} />
        <path d={line} fill="none" stroke="var(--accent)" strokeWidth={2} />
        {hist.length > 0 && <circle cx={x(hist.at(-1)!.n)} cy={y(hist.at(-1)!.r)} r={3.5} fill="var(--accent)" />}
      </svg>
    </div>
  )
}

function Swarm({ fin }: { fin: TrialRow[] }) {
  const [box, W] = useWidth<HTMLDivElement>(1000)
  const H = 200
  const motionOn = useMotionOn()
  const pts = fin.filter((t) => t.latency_ms !== null)
  const ext = d3.extent(pts, (t) => t.latency_ms as number)
  const x = d3.scaleLinear().domain(ext[0] === undefined ? [0, 1000] : [ext[0] * 0.9, (ext[1] as number) * 1.05]).nice().range([20, W - 20])
  const ax = useRef<SVGGElement>(null)
  useEffect(() => { if (ax.current) d3.select(ax.current).call(d3.axisBottom(x).ticks(10).tickFormat((d) => ms(+d))) }, [x])
  const binW = 8
  const stack = new Map<number, number>()
  const placed = pts.map((t) => {
    const cx = x(t.latency_ms as number)
    const b = Math.round(cx / binW)
    const k = (stack.get(b) ?? 0) + 1
    stack.set(b, k)
    return { t, cx: b * binW, cy: H - 28 - (k - 1) * 7 }
  })
  return (
    <div ref={box} data-testid="live-swarm">
      <svg width={W} height={H} className="block overflow-visible">
        <g ref={ax} className="axis" transform={`translate(0,${H - 22})`} />
        {placed.map(({ t, cx, cy }) => (
          <motion.circle key={t.id} data-case={t.case_id} r={3.6} fill={t.status === 'passed' ? 'var(--good)' : 'var(--bad)'}
            initial={motionOn ? { cx, cy: 0, opacity: 0 } : false} animate={{ cx, cy: Math.max(6, cy), opacity: 1 }}
            transition={motionOn ? { cy: { duration: 0.45, ease: (v: number) => d3.easeBounceOut(v) }, cx: { duration: 0.3 }, opacity: { duration: 0.1 } } : { duration: 0 }}>
            <title>{`${t.case_id}: ${ms(t.latency_ms)}`}</title>
          </motion.circle>
        ))}
      </svg>
    </div>
  )
}

export function LiveRun({ r, rows, gate }: { r: RunHeader; rows: TrialRow[]; gate: number | null }) {
  const fin = useMemo(() => finishedTries(rows), [rows])
  const active = isLive(r.status)
  const lanes = Math.max(1, r.concurrency ?? 1)
  const inFlight = active && r.status === 'running' ? Math.min(lanes, Math.max(0, r.progress_total - fin.length)) : 0
  const latest = fin.slice(-lanes).reverse()
  const [, tick] = useState(0)
  useEffect(() => { if (!active) return; const t = setInterval(() => tick((n) => n + 1), 1000); return () => clearInterval(t) }, [active])
  return (
    <div className="space-y-10" data-testid="live-run">
      <div className="grid items-start gap-10 lg:grid-cols-[minmax(0,7fr)_minmax(0,5fr)]">
        <div className="min-w-0">
          <div className="t-label mb-2 flex items-center gap-2">Every try <Help title="Every try"><p>One square per try, in the order they finished. Breathing squares are being asked now ({lanes} at a time); green passed, red failed, violet the bot returned an error.</p></Help></div>
          <Tiles total={r.progress_total} fin={fin} inFlight={inFlight} />
          <div className="t-label mb-2 mt-7 flex items-center gap-2">{active ? 'Just answered' : 'Last answers'} <Help title="Just answered"><p>The latest questions to finish, newest first. Assay sees an answer when it arrives, not while it is being asked.</p></Help></div>
          <ul className="space-y-1.5" data-testid="live-lanes">
            {latest.length === 0 && <li className="text-sm text-ink-3">{r.status === 'queued' ? 'Waiting for a free slot.' : 'Asking the first questions.'}</li>}
            {latest.map((t) => (
              <motion.li key={t.id} layout initial={{ opacity: 0, x: -6 }} animate={{ opacity: 1, x: 0 }} data-case={t.case_id} className="flex items-center gap-3 text-sm">
                <span className={clsx('size-2 shrink-0 rounded-full', t.status === 'passed' ? 'bg-good' : t.status === 'error' ? 'bg-error' : 'bg-bad')} />
                <Link to={`/trials/${t.id}`} className="w-20 shrink-0 font-mono text-xs text-accent-ink hover:underline">{t.case_id}</Link>
                <span className="min-w-0 flex-1 truncate">{t.question ?? t.title}</span>
                <span className="num font-mono text-xs text-ink-3">{ms(t.latency_ms)}</span>
              </motion.li>
            ))}
          </ul>
        </div>
        <div className="min-w-0">
          <div className="t-label mb-1 flex items-center gap-2">Pass rate so far <SampleSize n={fin.length} unit="tries" />
            <Help title="Pass rate so far"><p>The line is the pass rate of the tries finished so far; the band is its 95% interval (Wilson). It narrows as answers arrive: early figures swing, late ones settle.</p><p>Counted per try here; the final figure averages per question first, so it can differ a little.</p>{gate !== null && <p>The dashed line is the release gate's floor.</p>}</Help></div>
          <Funnel fin={fin} total={r.progress_total} gate={gate} />
        </div>
      </div>
      <Card title="Speed of each answer" meta={<SampleSize n={fin.length} unit="answers" />}
        help={<p>Each answer drops in as it finishes, placed by how long it took. Tall stacks are the common speeds; the dots far right are the slow tail that sets p95.</p>}
        actions={<span className="flex gap-3"><LegendItem className="bg-good">passed</LegendItem><LegendItem className="bg-bad">failed</LegendItem></span>}>
        <Swarm fin={fin} />
      </Card>
    </div>
  )
}
