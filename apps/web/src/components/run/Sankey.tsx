// A1 "Where the answers went": every try from the question to the verdict, as a Sankey diagram
// whose bands carry small particles in proportion to their count.
import * as d3 from 'd3'
import { sankey as d3Sankey, sankeyLinkHorizontal, type SankeyLink, type SankeyNode } from 'd3-sankey'
import { useEffect, useMemo, useRef, useState } from 'react'
import { useMotionOn } from '../../lib/prefs'
import type { ExploreTrial } from '../../lib/types'
import { SampleSize } from '../instrument'
import { Card } from '../ui'
import { CaseChip, ChartTip, NothingPasses, useWidth, type TipState } from './bits'
import { decided } from './data'

const KIND = { lookup: 'Look-up questions', decline: 'Should decline', tool: 'Needs a tool', other: 'Other' } as const
const ORDER = ['Asked', KIND.lookup, KIND.decline, KIND.tool, KIND.other, 'Search found it', 'Search missed', 'Declined', 'Answered anyway', 'Right tool', 'Wrong tool', 'Not measured', 'Answered', 'Passed', 'Failed']
const BAD = new Set(['Search missed', 'Answered anyway', 'Wrong tool', 'Failed'])

interface N { name: string }
interface L { source: number; target: number; value: number; key: string }
type SN = SankeyNode<N, L>
type SL = SankeyLink<N, L>

/** A check's outcome as a node name: only a real pass or fail says which way it went. */
const outcome = (t: ExploreTrial, check: string, pass: string, fail: string) => {
  const st = t.scores[check]?.status
  return st === 'pass' ? pass : st === 'fail' ? fail : 'Not measured'
}

export function flow(trials: ExploreTrial[]) {
  const counts = new Map<string, number>()
  const members = new Map<string, ExploreTrial[]>()
  const add = (a: string, b: string, t: ExploreTrial) => {
    const k = `${a}→${b}`
    counts.set(k, (counts.get(k) ?? 0) + 1)
    members.set(k, [...(members.get(k) ?? []), t])
  }
  for (const t of trials) {
    const kind = t.should_refuse ? KIND.decline : t.needs_tool ? KIND.tool : t.needs_documents ? KIND.lookup : KIND.other
    add('Asked', kind, t)
    const mid = kind === KIND.lookup ? outcome(t, 'recall_at_k', 'Search found it', 'Search missed')
      : kind === KIND.decline ? outcome(t, 'refusal_check', 'Declined', 'Answered anyway')
        : kind === KIND.tool ? outcome(t, 'tool_selection', 'Right tool', 'Wrong tool')
          : 'Answered'
    add(kind, mid, t)
    add(mid, t.status === 'passed' ? 'Passed' : 'Failed', t)
  }
  const used = new Set([...counts.keys()].flatMap((k) => k.split('→')))
  const keep = ORDER.filter((n) => used.has(n))
  const links: L[] = [...counts.entries()].map(([key, value]) => {
    const [a, b] = key.split('→')
    return { source: keep.indexOf(a), target: keep.indexOf(b), value, key }
  })
  return { nodes: keep.map((name) => ({ name })), links, members }
}

const linkColor = (target: string) => (BAD.has(target) ? 'var(--bad)' : target === 'Passed' ? 'var(--good)' : 'var(--accent)')
const nodeColor = (name: string) => (name === 'Passed' ? 'var(--good)' : BAD.has(name) ? 'var(--bad)' : 'var(--ink-3)')

export function FlowSankey({ trials }: { trials: ExploreTrial[] }) {
  const rows = useMemo(() => trials.filter(decided), [trials])
  const [box, W] = useWidth<HTMLDivElement>(1000)
  const H = 400
  const motionOn = useMotionOn()
  const [tip, setTip] = useState<TipState | null>(null)
  const [hover, setHover] = useState<string | null>(null)
  const [picked, setPicked] = useState<string | null>(null)
  const linksRef = useRef<SVGGElement>(null)
  const partsRef = useRef<SVGGElement>(null)
  const data = useMemo(() => flow(rows), [rows])
  const G = useMemo(() => {
    if (!data.links.length) return null
    const sk = d3Sankey<N, L>().nodeWidth(12).nodePadding(18).nodeSort(null).extent([[1, 10], [Math.max(320, W - 150), H - 10]])
    return sk({ nodes: data.nodes.map((d) => ({ ...d })), links: data.links.map((d) => ({ ...d })) })
  }, [data, W])
  const path = sankeyLinkHorizontal<N, L>()
  const total = rows.length

  // Draw the bands in, column by column.
  useEffect(() => {
    if (!G || !motionOn || !linksRef.current) return
    const sel = d3.select(linksRef.current).selectAll<SVGPathElement, unknown>('path')
    sel.each(function () {
      const len = this.getTotalLength()
      const depth = Number(this.dataset.depth ?? 0)
      d3.select(this).attr('stroke-dasharray', `${len} ${len}`).attr('stroke-dashoffset', len)
        .transition().duration(900).delay(depth * 250).attr('stroke-dashoffset', 0)
        .on('end', function () { d3.select(this).attr('stroke-dasharray', null) })
    })
    return () => { sel.interrupt() }
  }, [G, motionOn])

  // Particles: dots flow along each band, as many as its share. Stop on reduced motion, a hidden
  // tab and unmount.
  useEffect(() => {
    if (!G || !motionOn || !linksRef.current || !partsRef.current || !total) return
    const paths = Array.from(linksRef.current.querySelectorAll<SVGPathElement>('path'))
    const lens = paths.map((p) => p.getTotalLength())
    const links = G.links as SL[]
    const g = d3.select(partsRef.current)
    let parts: { i: number; t: number; off: number; sp: number }[] = []
    let raf = 0
    let last = performance.now()
    let spawn = 0
    const tick = (now: number) => {
      const dt = Math.min(64, now - last)
      last = now
      spawn += dt
      if (spawn > 90) {
        spawn = 0
        links.forEach((l, i) => {
          if (Math.random() < (l.value / total) * 2.2) parts.push({ i, t: 0, off: (Math.random() - 0.5) * Math.max(1, (l.width ?? 1) - 3), sp: 0.00028 + Math.random() * 0.00012 })
        })
      }
      parts = parts.filter((p) => p.t <= 1)
      g.selectAll<SVGCircleElement, (typeof parts)[number]>('circle').data(parts).join('circle').attr('r', 1.8)
        .each(function (p) {
          p.t += p.sp * dt
          const pt = paths[p.i].getPointAtLength(Math.min(1, p.t) * lens[p.i])
          const l = links[p.i]
          this.setAttribute('cx', String(pt.x))
          this.setAttribute('cy', String(pt.y + p.off))
          this.setAttribute('fill', linkColor((l.target as SN).name))
          this.setAttribute('opacity', String(Math.sin(Math.PI * Math.min(1, p.t)) * 0.9))
        })
      raf = requestAnimationFrame(tick)
    }
    const start = () => { cancelAnimationFrame(raf); last = performance.now(); raf = requestAnimationFrame(tick) }
    const vis = () => { if (document.visibilityState === 'visible') start(); else cancelAnimationFrame(raf) }
    start()
    document.addEventListener('visibilitychange', vis)
    return () => { cancelAnimationFrame(raf); document.removeEventListener('visibilitychange', vis); g.selectAll('circle').remove() }
  }, [G, motionOn, total])

  const list = picked ? data.members.get(picked) ?? [] : []
  const seen = new Set<string>()
  const uniq = list.filter((t) => !seen.has(t.case_id) && !!seen.add(t.case_id))
  const [pa, pb] = picked?.split('→') ?? []

  return (
    <Card title="Where the answers went" meta={<SampleSize n={total} unit="tries" />}
      help={<>
        <p>Every try, from the question to the verdict. Each band is a group of tries; its width is how many.</p>
        <p>Look-up questions split by whether search found the right documents, questions it should decline by whether it did, tool questions by whether it picked the right tool.</p>
        <p>Hover a band for its count; click it to list its questions. Follow the red to see where answers are lost.</p>
      </>}>
      <div ref={box} data-testid="run-sankey">
        {!G ? <NothingPasses>No scored tries yet.</NothingPasses> : (
          <svg width={W} height={H} className="block overflow-visible">
            <g ref={linksRef} fill="none">
              {(G.links as SL[]).map((l) => {
                const k = `${(l.source as SN).name}→${(l.target as SN).name}`
                const on = hover === k || picked === k
                return (
                  <path key={k} d={path(l) ?? ''} data-depth={(l.source as SN).depth} stroke={linkColor((l.target as SN).name)}
                    strokeOpacity={on ? 0.4 : 0.16} strokeWidth={Math.max(1, l.width ?? 1)} className="cursor-pointer transition-[stroke-opacity] duration-150"
                    onMouseEnter={() => setHover(k)} onMouseLeave={() => { setHover(null); setTip(null) }}
                    onMouseMove={(e) => setTip({ x: e.clientX, y: e.clientY, body: <><div className="font-medium text-ink">{(l.source as SN).name} → {(l.target as SN).name}</div><span className="num font-mono">{l.value}</span> tries</> })}
                    onClick={() => setPicked(picked === k ? null : k)} />
                )
              })}
            </g>
            <g ref={partsRef} style={{ pointerEvents: 'none' }} />
            {(G.nodes as SN[]).map((n) => {
              const y = ((n.y0 ?? 0) + (n.y1 ?? 0)) / 2
              return (
                <g key={n.name}>
                  <rect x={n.x0} y={n.y0} width={(n.x1 ?? 0) - (n.x0 ?? 0)} height={Math.max(2, (n.y1 ?? 0) - (n.y0 ?? 0))} rx={3} fill={nodeColor(n.name)} />
                  <text x={(n.x1 ?? 0) + 8} y={y - 2} className="c-name">{n.name}</text>
                  <text x={(n.x1 ?? 0) + 8} y={y + 13} className="c-num">{n.value}{n.name === 'Asked' ? ' tries' : ''}</text>
                </g>
              )
            })}
          </svg>
        )}
        <ChartTip tip={tip} />
        {picked && (
          <div className="mt-3" data-testid="sankey-list">
            <div className="mb-2 flex items-baseline gap-2">
              <span className="text-sm font-semibold">{pa} → {pb}</span>
              <span className="num font-mono text-xs text-ink-3">{list.length} tries · {uniq.length} questions</span>
              <button type="button" className="ml-auto text-xs font-medium text-accent-ink hover:underline" onClick={() => setPicked(null)}>Close</button>
            </div>
            <div className="flex flex-wrap gap-1.5">
              {uniq.map((t) => <CaseChip key={t.case_id} caseId={t.case_id} trialId={t.id} tone={t.status === 'passed' ? 'good' : 'bad'} title={t.question}>{t.title}</CaseChip>)}
            </div>
          </div>
        )}
      </div>
    </Card>
  )
}
