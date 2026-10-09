// F2: two graders on the same answers. Each dot is one answer you labelled; across is one grader,
// up the other. Off the diagonal they disagree; amber means they disagree on pass or fail. Click a
// dot to read the answer and both verdicts. A bake-off stores each judge's verdict per answer (not a
// score), so the axes are verdict bands; when per-answer scores are stored they become a 0-1 scale.
import { useQuery } from '@tanstack/react-query'
import clsx from 'clsx'
import * as d3 from 'd3'
import { motion } from 'motion/react'
import { useLayoutEffect, useRef, useState } from 'react'
import { Link } from 'react-router-dom'
import { api } from '../../lib/api'
import { useMotionOn } from '../../lib/prefs'
import type { Bakeoff, TrialDetail } from '../../lib/types'
import { Badge, Loading, Select } from '../ui'

/** What the bake-off endpoint returns beyond the shared type (assay/store/workspace.py). */
type JudgeResult = NonNullable<Bakeoff['results']>['judges'][number] & { labels?: string[]; scores?: (number | null)[]; reasons?: (string | null)[] }
type Results = Omit<NonNullable<Bakeoff['results']>, 'judges'> & { judges: JudgeResult[]; human?: string[]; trial_ids?: number[] }

interface Axis { id: string; name: string; labels: string[]; scores?: (number | null)[]; reasons?: (string | null)[] }

const YOU = 'you'
const BANDS: Record<string, [number, number]> = { FAIL: [0, 0.4], UNKNOWN: [0.4, 0.6], PASS: [0.6, 1] }
const hash = (s: string) => [...s].reduce((a, c) => (a * 31 + c.charCodeAt(0)) >>> 0, 7)
const verdictWord = (l: string | undefined) => (l === 'PASS' ? 'pass' : l === 'FAIL' ? 'fail' : 'no verdict')

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

export function hasPerItem(b: Bakeoff | null | undefined): boolean {
  const r = b?.results as Results | null | undefined
  return !!r?.trial_ids?.length && r.judges.some((j) => j.labels?.length)
}

export function BakeoffScatter({ bakeoff, dimension }: { bakeoff: Bakeoff; dimension: string }) {
  const motionOn = useMotionOn()
  const r = bakeoff.results as Results
  const ids = r.trial_ids ?? []
  const axes: Axis[] = [
    ...(r.human ? [{ id: YOU, name: 'You', labels: r.human }] : []),
    ...r.judges.filter((j) => j.labels).map((j) => ({ id: j.name, name: j.name, labels: j.labels!, scores: j.scores, reasons: j.reasons })),
  ]
  const judgeAxes = axes.filter((a) => a.id !== YOU)
  const [xId, setX] = useState(judgeAxes.length >= 2 ? judgeAxes[0].id : YOU)
  const [yId, setY] = useState(judgeAxes.length >= 2 ? judgeAxes[1].id : judgeAxes[0]?.id ?? YOU)
  const ax = axes.find((a) => a.id === xId) ?? axes[0]
  const ay = axes.find((a) => a.id === yId) ?? axes[1] ?? axes[0]
  const continuous = !!ax?.scores && !!ay?.scores

  const pos = (a: Axis, i: number, salt: string) => {
    const sc = a.scores?.[i]
    if (continuous && sc !== null && sc !== undefined) return sc
    const [lo, hi] = BANDS[a.labels[i]] ?? BANDS.UNKNOWN
    const j = ((hash(`${ids[i]}${salt}`) % 1000) / 1000) * 0.8 + 0.1
    return lo + (hi - lo) * j
  }
  const pf = (l: string) => l === 'PASS' || l === 'FAIL'
  const pts = ids.map((id, i) => {
    const lx = ax.labels[i]
    const ly = ay.labels[i]
    return { id, i, x: pos(ax, i, 'x'), y: pos(ay, i, 'y'), lx, ly, split: pf(lx) && pf(ly) && lx !== ly }
  })
  const firstSplit = pts.find((p) => p.split)
  const [picked, setPicked] = useState<number | null>(null)
  const sel = pts.find((p) => p.id === picked) ?? firstSplit ?? null

  const [box, W] = useWidth<HTMLDivElement>()
  const H = 360
  const m = { l: 76, r: 16, t: 30, b: 42 }
  const width = Math.max(W, 300)
  const x = d3.scaleLinear().domain([0, 1]).range([m.l, width - m.r])
  const y = d3.scaleLinear().domain([0, 1]).range([H - m.b, m.t])
  const splits = pts.filter((p) => p.split).length
  const axisOptions = axes.map((a) => <option key={a.id} value={a.id}>{a.name}</option>)

  if (axes.length < 2) return <p className="text-sm text-ink-2">This bake-off has one grading model and no labels to set it against.</p>
  return (
    <div>
      <div className="mb-3 flex flex-wrap items-center gap-2 text-sm text-ink-2">
        <span className="t-label">Across</span>
        <Select className="w-auto" value={xId} onChange={(e) => { setX(e.target.value); setPicked(null) }} aria-label="Across">{axisOptions}</Select>
        <span className="t-label">Up</span>
        <Select className="w-auto" value={yId} onChange={(e) => { setY(e.target.value); setPicked(null) }} aria-label="Up">{axisOptions}</Select>
        <span className="ml-auto t-readout" data-testid="bakeoff-splits">
          <b className="num font-mono font-semibold">{splits}</b> of <span className="num font-mono">{pts.length}</span> answers split on pass or fail
        </span>
      </div>
      <div className="grid gap-6 lg:grid-cols-[minmax(0,1fr)_340px]">
        <div ref={box} className="min-w-0">
          {W > 0 && (
            <svg width={width} height={H} role="group" aria-label={`${ax.name} against ${ay.name}: ${splits} answers split on pass or fail`} data-testid="bakeoff-scatter">
              {continuous ? [0, 0.2, 0.4, 0.6, 0.8, 1].map((t) => (
                <g key={t}>
                  <g className="gridline">
                    <line x1={x(t)} x2={x(t)} y1={m.t} y2={H - m.b} />
                    <line x1={m.l} x2={width - m.r} y1={y(t)} y2={y(t)} />
                  </g>
                  <text x={x(t)} y={H - m.b + 16} textAnchor="middle" className="c-num">{t.toFixed(1)}</text>
                  <text x={m.l - 8} y={y(t) + 4} textAnchor="end" className="c-num">{t.toFixed(1)}</text>
                </g>
              )) : Object.entries(BANDS).map(([lab, [lo, hi]]) => (
                <g key={lab}>
                  <rect x={x(lo)} y={m.t} width={x(hi) - x(lo)} height={H - m.b - m.t} fill={lab === 'UNKNOWN' ? 'var(--surface-2)' : 'transparent'} opacity={0.6} />
                  <rect x={m.l} y={y(hi)} width={width - m.l - m.r} height={y(lo) - y(hi)} fill={lab === 'UNKNOWN' ? 'var(--surface-2)' : 'transparent'} opacity={0.6} />
                  <text x={x((lo + hi) / 2)} y={H - m.b + 16} textAnchor="middle">{verdictWord(lab)}</text>
                  <text x={m.l - 8} y={y((lo + hi) / 2) + 4} textAnchor="end">{verdictWord(lab)}</text>
                </g>
              ))}
              <g className="axis"><line x1={x(0)} y1={y(0)} x2={x(1)} y2={y(1)} strokeDasharray="4 4" /></g>
              <text x={width - m.r} y={H - 6} textAnchor="end" className="c-note">{ax.name} {continuous ? 'score' : 'verdict'} →</text>
              <text x={m.l} y={m.t - 14} className="c-note">↑ {ay.name} {continuous ? 'score' : 'verdict'}</text>
              {pts.map((p, k) => (
                <motion.circle key={`${xId}-${yId}-${p.id}`} cx={x(p.x)} r={sel?.id === p.id ? 8 : 6} tabIndex={0} role="button"
                  aria-label={`Answer ${p.id}: ${ax.name} ${verdictWord(p.lx)}, ${ay.name} ${verdictWord(p.ly)}`}
                  initial={motionOn ? { cy: y(0) } : false} animate={{ cy: y(p.y) }} transition={{ delay: k * 0.02, type: 'spring', stiffness: 160, damping: 14 }}
                  fill={p.split ? 'var(--warn)' : 'var(--ink-3)'} stroke={sel?.id === p.id ? 'var(--ink)' : 'var(--surface)'} strokeWidth={sel?.id === p.id ? 2 : 1.5}
                  style={{ cursor: 'pointer' }} onClick={() => setPicked(p.id)} onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') setPicked(p.id) }}
                  data-testid="bakeoff-dot" data-split={p.split ? '1' : '0'}>
                  <title>{`${ax.name}: ${verdictWord(p.lx)} · ${ay.name}: ${verdictWord(p.ly)}`}</title>
                </motion.circle>
              ))}
            </svg>
          )}
          <div className="mt-1 flex flex-wrap gap-x-4 gap-y-1 text-xs text-ink-2">
            <span className="inline-flex items-center gap-1.5"><span className="size-2.5 rounded-full bg-warn" />grading models disagree on pass or fail</span>
            <span className="inline-flex items-center gap-1.5"><span className="size-2.5 rounded-full bg-ink-3" />grading models agree</span>
          </div>
        </div>
        <aside className="min-w-0" data-testid="bakeoff-side">
          {sel ? <DotDetail key={sel.id} trialId={sel.id} index={sel.i} axes={axes} shown={[ax.id, ay.id]} dimension={dimension} />
            : <p className="text-sm text-ink-2">The two grading models agree on every answer here. Click any dot to read it.</p>}
        </aside>
      </div>
    </div>
  )
}

function DotDetail({ trialId, index, axes, shown, dimension }: { trialId: number; index: number; axes: Axis[]; shown: string[]; dimension: string }) {
  const t = useQuery({ queryKey: ['trial', trialId], queryFn: () => api.get<TrialDetail>(`/api/trials/${trialId}`) })
  const original = t.data?.scores.find((s) => s.evaluator_id === dimension)
  const question = t.data?.question ?? t.data?.case?.input.message
  return (
    <div className="space-y-3">
      <div className="t-label flex items-center gap-2">
        <Link className="font-mono normal-case tracking-normal text-accent-ink hover:underline" to={`/trials/${trialId}`} data-case={t.data?.case_id}>{t.data?.case_id ?? `#${trialId}`}</Link>
      </div>
      {t.isLoading ? <Loading rows={3} /> : t.data && (
        <>
          {question && <div className="text-lead font-medium text-ink">{question}</div>}
          <div className="line-clamp-6 text-sm text-ink-2"><span className="font-medium text-ink">Answer: </span>{t.data.answer}</div>
        </>
      )}
      <ul className="space-y-2">
        {axes.map((a) => {
          const l = a.labels[index]
          const on = shown.includes(a.id)
          const reason = a.reasons?.[index]
          return (
            <li key={a.id} className={clsx('rounded-r-lg border-l-[3px] px-3 py-2 text-sm', on ? 'bg-accent-wash/60' : 'bg-surface-2/60', l === 'FAIL' ? 'border-bad' : l === 'PASS' ? 'border-good' : 'border-line-strong')}>
              <div className="flex items-center gap-2">
                <span className="font-medium text-ink">{a.name}</span>
                <Badge tone={l === 'PASS' ? 'pass' : l === 'FAIL' ? 'fail' : 'unscored'}>{verdictWord(l)}</Badge>
                {a.scores?.[index] != null && <span className="num font-mono text-xs text-ink-3">{a.scores[index]!.toFixed(2)}</span>}
              </div>
              {reason && <div className="mt-1 text-ink-2">“{reason}”</div>}
            </li>
          )
        })}
      </ul>
      {original?.explanation && (
        <div className="text-sm text-ink-2">
          <span className="t-label mr-1.5">When the run graded it</span>
          {original.status} {original.score != null && <span className="num font-mono">({original.score.toFixed(2)})</span>}: “{original.explanation}”
        </div>
      )}
    </div>
  )
}
