// A2 linked charts and A3 any-against-any: every try drawn seven ways, all filtering one state.
// Drag across a histogram (d3.brushX) or a box on the scatter (d3.brush); click bars to pick.
import clsx from 'clsx'
import * as d3 from 'd3'
import { useEffect, useMemo, useRef, useState } from 'react'
import { Link, useNavigate } from 'react-router-dom'
import { ms } from '../../lib/format'
import { useMotionOn } from '../../lib/prefs'
import { causeColor, SampleSize } from '../instrument'
import { Card, Select } from '../ui'
import { ChartTip, Dot, NothingPasses, useWidth, type TipState } from './bits'
import { firstTries, plain, type XRow } from './data'

export type NumKey = 'lat' | 'tok' | 'len' | 'top' | 'corr' | 'mm'
export type CatKey = 'st' | 'cat' | 'cause'
export interface XFilter { ranges: Partial<Record<NumKey, [number, number]>>; picks: Partial<Record<CatKey, string[]>> }
export const EMPTY_FILTER: XFilter = { ranges: {}, picks: {} }

export function passes(r: XRow, f: XFilter, skip?: string): boolean {
  for (const [k, rg] of Object.entries(f.ranges) as [NumKey, [number, number]][]) {
    if (k === skip) continue
    const v = r[k]
    if (v === null || v < rg[0] || v > rg[1]) return false
  }
  for (const [k, vals] of Object.entries(f.picks) as [CatKey, string[]][]) {
    if (k === skip || !vals.length) continue
    if (!vals.includes(String(r[k]))) return false
  }
  return true
}
export const isFiltered = (f: XFilter) => Object.keys(f.ranges).length > 0 || Object.values(f.picks).some((v) => v && v.length)

const NUM: { k: NumKey; label: string; fmt: (v: number) => string }[] = [
  { k: 'lat', label: 'Speed', fmt: (v) => ms(v) },
  { k: 'tok', label: 'Tokens', fmt: (v) => String(Math.round(v)) },
  { k: 'len', label: 'Answer length (chars)', fmt: (v) => String(Math.round(v)) },
  { k: 'top', label: 'Best document score', fmt: (v) => v.toFixed(1) },
]
const EXTRA: { k: NumKey; label: string; fmt: (v: number) => string }[] = [
  { k: 'corr', label: 'Correctness (grading model)', fmt: (v) => v.toFixed(2) },
  { k: 'mm', label: 'Must-mention score', fmt: (v) => v.toFixed(2) },
]
const AXES = [...NUM, ...EXTRA]

// ---------------------------------------------------------------------------------------------

function Histogram({ rows, k, label, fmt, filter, setFilter, resetKey }: {
  rows: XRow[]; k: NumKey; label: string; fmt: (v: number) => string; filter: XFilter; setFilter: (f: (x: XFilter) => XFilter) => void; resetKey: number
}) {
  const [box, W] = useWidth<HTMLDivElement>(240)
  const H = 120
  const brushRef = useRef<SVGGElement>(null)
  const axisRef = useRef<SVGGElement>(null)
  const vals = useMemo(() => rows.filter((r) => r[k] !== null), [rows, k])
  const x = useMemo(() => {
    const ext = d3.extent(vals, (r) => r[k] as number) as [number, number] | [undefined, undefined]
    return d3.scaleLinear().domain(ext[0] === undefined ? [0, 1] : ext[0] === ext[1] ? [ext[0] - 1, (ext[1] as number) + 1] : ext as [number, number]).nice().range([12, W - 12])
  }, [vals, k, W])
  const bin = useMemo(() => d3.bin<XRow, number>().domain(x.domain() as [number, number]).thresholds(x.ticks(18)).value((r) => r[k] as number), [x, k])
  const all = useMemo(() => bin(vals), [bin, vals])
  const sub = bin(vals.filter((r) => passes(r, filter, k)))
  const y = d3.scaleLinear().domain([0, d3.max(all, (b) => b.length) || 1]).range([H - 18, 4])
  const setRef = useRef(setFilter)
  setRef.current = setFilter

  useEffect(() => {
    if (axisRef.current) d3.select(axisRef.current).call(d3.axisBottom(x).ticks(4).tickFormat((v) => fmt(+v)))
  }, [x, fmt])
  useEffect(() => {
    const g = brushRef.current
    if (!g) return
    const br = d3.brushX().extent([[0, 0], [W, H - 18]]).on('brush end', (e: d3.D3BrushEvent<unknown>) => {
      if (!e.sourceEvent) return
      const s = e.selection as [number, number] | null
      setRef.current((f) => {
        const ranges = { ...f.ranges }
        if (s && s[1] - s[0] > 1) ranges[k] = [x.invert(s[0]), x.invert(s[1])]
        else delete ranges[k]
        return { ...f, ranges }
      })
    })
    const sel = d3.select(g)
    sel.call(br)
    return () => { sel.on('.brush', null); sel.selectAll('*').remove() }
  }, [x, W, k, resetKey])

  return (
    <div ref={box} className="min-w-0" data-testid={`xf-hist-${k}`}>
      <div className="t-label mb-1.5">{label}</div>
      <svg width={W} height={H} className="block overflow-visible">
        {all.map((b, i) => <rect key={i} x={x(b.x0!) + 0.5} width={Math.max(0, x(b.x1!) - x(b.x0!) - 1)} y={y(b.length)} height={y(0) - y(b.length)} fill="var(--surface-3)" />)}
        {sub.map((b, i) => <rect key={i} x={x(b.x0!) + 0.5} width={Math.max(0, x(b.x1!) - x(b.x0!) - 1)} y={y(b.length)} height={y(0) - y(b.length)} fill="var(--accent)" className="transition-all duration-200" />)}
        <g ref={axisRef} className="axis" transform={`translate(0,${H - 18})`} />
        <g ref={brushRef} className="brush" />
      </svg>
    </div>
  )
}

function BarList({ rows, k, label, filter, setFilter }: { rows: XRow[]; k: CatKey; label: string; filter: XFilter; setFilter: (f: (x: XFilter) => XFilter) => void }) {
  const counts = [...d3.rollup(rows, (v) => v.length, (r) => String(r[k]))].sort((a, b) => b[1] - a[1])
  const max = counts[0]?.[1] ?? 1
  const sub = d3.rollup(rows.filter((r) => passes(r, filter, k)), (v) => v.length, (r) => String(r[k]))
  const picked = filter.picks[k] ?? []
  const keyOf = new Map(rows.map((r) => [r.cause, r.causeKey]))
  const color = (v: string) => k === 'st' ? (v === 'passed' ? 'var(--good)' : 'var(--bad)')
    : k === 'cause' ? (v === 'Passed' ? 'var(--good)' : causeColor(keyOf.get(v) ?? null)) : 'var(--accent)'
  const toggle = (v: string) => setFilter((f) => {
    const cur = f.picks[k] ?? []
    return { ...f, picks: { ...f.picks, [k]: cur.includes(v) ? cur.filter((x) => x !== v) : [...cur, v] } }
  })
  return (
    <div className="min-w-0" data-testid={`xf-bars-${k}`}>
      <div className="t-label mb-1.5">{label}</div>
      <div className="space-y-1">
        {counts.map(([v, n]) => {
          const on = picked.includes(v)
          const m = sub.get(v) ?? 0
          return (
            <button key={v} type="button" onClick={() => toggle(v)} aria-pressed={on}
              className={clsx('flex w-full items-center gap-2 rounded px-1 py-0.5 text-left text-xs transition-colors duration-(--dur-fast) hover:bg-surface-2', on ? 'font-semibold text-ink' : 'text-ink-2')}>
              <span className="w-36 shrink-0 leading-snug" title={plain(v)}>{plain(v)}</span>
              <span className="relative h-3.5 flex-1">
                <i className="absolute inset-y-0 left-0 rounded-[3px] bg-surface-3" style={{ width: `${(n / max) * 100}%` }} />
                <i className="absolute inset-y-0 left-0 rounded-[3px] transition-[width] duration-300" style={{ width: `${(m / max) * 100}%`, background: color(v) }} />
              </span>
              <span className="num w-10 text-right font-mono text-ink-3">{m}</span>
            </button>
          )
        })}
      </div>
    </div>
  )
}

function Scatter({ rows, filter, setFilter, kx, ky, onTip }: {
  rows: XRow[]; filter: XFilter; setFilter: (f: (x: XFilter) => XFilter) => void; kx: NumKey; ky: NumKey; onTip: (t: TipState | null) => void
}) {
  const [box, W] = useWidth<HTMLDivElement>(760)
  const H = 380, m = { l: 54, r: 14, t: 10, b: 36 }
  const nav = useNavigate()
  const motionOn = useMotionOn()
  const pts = useMemo(() => rows.filter((r) => r[kx] !== null && r[ky] !== null), [rows, kx, ky])
  const ax = AXES.find((a) => a.k === kx)!, ay = AXES.find((a) => a.k === ky)!
  const x = useMemo(() => { const e = d3.extent(pts, (r) => r[kx] as number); return d3.scaleLinear().domain(e[0] === undefined ? [0, 1] : e as [number, number]).nice().range([m.l, W - m.r]) }, [pts, kx, W, m.l, m.r])
  const y = useMemo(() => { const e = d3.extent(pts, (r) => r[ky] as number); return d3.scaleLinear().domain(e[0] === undefined ? [0, 1] : e as [number, number]).nice().range([H - m.b, m.t]) }, [pts, ky, m.b, m.t])
  const xr = (x.domain()[1] - x.domain()[0]) * 0.012, yr = (y.domain()[1] - y.domain()[0]) * 0.012
  const axX = useRef<SVGGElement>(null), axY = useRef<SVGGElement>(null), grid = useRef<SVGGElement>(null), brushG = useRef<SVGGElement>(null)
  const setRef = useRef(setFilter)
  setRef.current = setFilter
  const [shown, setShown] = useState(!motionOn)
  useEffect(() => { if (!motionOn) return; const t = setTimeout(() => setShown(true), 30); return () => clearTimeout(t) }, [motionOn, kx, ky])
  useEffect(() => {
    if (axX.current) d3.select(axX.current).call(d3.axisBottom(x).ticks(7).tickFormat((v) => ax.fmt(+v)))
    if (axY.current) d3.select(axY.current).call(d3.axisLeft(y).ticks(5).tickFormat((v) => ay.fmt(+v)))
    if (grid.current) d3.select(grid.current).call(d3.axisLeft(y).ticks(5).tickSize(-(W - m.l - m.r)).tickFormat(() => '')).call((g) => g.select('.domain').remove())
  }, [x, y, W, m.l, m.r, ax, ay])
  useEffect(() => {
    const g = brushG.current
    if (!g) return
    const br = d3.brush().extent([[m.l, m.t], [W - m.r, H - m.b]]).on('end', (e: d3.D3BrushEvent<unknown>) => {
      if (!e.sourceEvent) return
      const s = e.selection as [[number, number], [number, number]] | null
      setRef.current((f) => {
        const ranges = { ...f.ranges }
        if (s) { ranges[kx] = [x.invert(s[0][0]), x.invert(s[1][0])]; ranges[ky] = [y.invert(s[1][1]), y.invert(s[0][1])] } else { delete ranges[kx]; delete ranges[ky] }
        return { ...f, ranges }
      })
    })
    const sel = d3.select(g)
    sel.call(br)
    return () => { sel.on('.brush', null); sel.selectAll('*').remove() }
  }, [x, y, W, kx, ky, m.l, m.t, m.r, m.b])
  const off = (id: number, s: number) => (((id * 7919) % 100) / 100 - 0.5) * s
  return (
    <div ref={box} className="min-w-0" data-testid="xf-scatter">
      {pts.length === 0 ? <NothingPasses>No try has both of these measures.</NothingPasses> : (
        <svg width={W} height={H} className="block overflow-visible">
          <g ref={grid} className="gridline" transform={`translate(${m.l},0)`} />
          <g ref={axY} className="axis" transform={`translate(${m.l},0)`} />
          <g ref={axX} className="axis" transform={`translate(0,${H - m.b})`} />
          <text x={W - m.r} y={H - 4} textAnchor="end">{ax.label}</text>
          <text x={m.l + 6} y={m.t + 10}>{ay.label}</text>
          <g ref={brushG} className="brush" />
          <g>
            {pts.map((r, i) => {
              const ok = passes(r, filter)
              return (
                <circle key={r.id} data-case={r.c} cx={x((r[kx] as number) + off(r.id, xr))} cy={y((r[ky] as number) + off(r.id * 31, yr))} r={shown ? 4.5 : 0}
                  fill={r.st === 'passed' ? 'var(--good)' : 'var(--bad)'} fillOpacity={ok ? 0.8 : 0.08} stroke="var(--surface)" strokeWidth={1}
                  className="cursor-pointer" style={{ transition: `r 400ms ${i * 3}ms, fill-opacity 200ms` }}
                  onMouseMove={(e) => onTip({ x: e.clientX, y: e.clientY, body: <><div className="font-medium text-ink">{r.t.title}</div><span className="num font-mono">{ax.fmt(r[kx] as number)}</span> · <span className="num font-mono">{ay.fmt(r[ky] as number)}</span></> })}
                  onMouseLeave={() => onTip(null)}
                  onClick={() => nav(`/trials/${r.id}`, { viewTransition: true })} />
              )
            })}
          </g>
        </svg>
      )}
    </div>
  )
}

// ---------------------------------------------------------------------------------------------

export function LinkedCharts({ rows, filter, setFilter, resetKey }: { rows: XRow[]; filter: XFilter; setFilter: (f: (x: XFilter) => XFilter) => void; resetKey: number }) {
  const nums = NUM.filter((n) => rows.some((r) => r[n.k] !== null))
  return (
    <Card title="Linked charts" meta={<SampleSize n={rows.length} unit="tries" />} id="xf"
      help={<>
        <p>All {rows.length} tries, drawn seven ways. Faint bars are every try; solid bars are the tries that pass every filter.</p>
        <p>Drag across a histogram to keep only those tries; the other charts redraw. Click a bar under Result, Category or Cause to pick it, again to drop it.</p>
        <p>Try it: drag across the slow end of Speed and watch Cause.</p>
      </>}>
      <div className="grid gap-6 sm:grid-cols-2 xl:grid-cols-4">
        {nums.map((n) => <Histogram key={n.k} rows={rows} k={n.k} label={n.label} fmt={n.fmt} filter={filter} setFilter={setFilter} resetKey={resetKey} />)}
        {nums.length === 0 && <NothingPasses>This bot reports no speed, tokens or document scores.</NothingPasses>}
      </div>
      <div className="mt-6 grid gap-6 md:grid-cols-3">
        <BarList rows={rows} k="st" label="Result" filter={filter} setFilter={setFilter} />
        <BarList rows={rows} k="cat" label="Category" filter={filter} setFilter={setFilter} />
        <BarList rows={rows} k="cause" label="Cause" filter={filter} setFilter={setFilter} />
      </div>
    </Card>
  )
}

export function AnyAgainstAny({ rows, filter, setFilter, resetKey }: { rows: XRow[]; filter: XFilter; setFilter: (f: (x: XFilter) => XFilter) => void; resetKey: number }) {
  const axes = AXES.filter((a) => rows.some((r) => r[a.k] !== null))
  const [kx, setKx] = useState<NumKey>(axes.some((a) => a.k === 'top') ? 'top' : axes[0]?.k ?? 'lat')
  const [ky, setKy] = useState<NumKey>(axes.some((a) => a.k === 'lat') ? 'lat' : axes[1]?.k ?? axes[0]?.k ?? 'lat')
  const [tip, setTip] = useState<TipState | null>(null)
  const change = (which: 'x' | 'y', v: NumKey) => {
    setFilter((f) => { const ranges = { ...f.ranges }; delete ranges[kx]; delete ranges[ky]; return { ...f, ranges } })
    if (which === 'x') setKx(v); else setKy(v)
  }
  const sub = rows.filter((r) => passes(r, filter))
  const qs = firstTries(sub)
  return (
    <Card title="Any against any" id="scatter" meta={<SampleSize n={rows.length} unit="tries" />}
      help={<>
        <p>One dot per try: green passed, red failed. Pick the two measures with the menus; grading-model scores from heuristic grading are word overlap, not meaning.</p>
        <p>Drag a box to filter; the linked charts above and the list on the right follow. Click a dot to open that answer.</p>
      </>}
      actions={<>
        <Select className="w-48" value={kx} onChange={(e) => change('x', e.target.value as NumKey)} aria-label="Across">{axes.map((a) => <option key={a.k} value={a.k}>{a.label}</option>)}</Select>
        <span className="text-xs text-ink-3">against</span>
        <Select className="w-48" value={ky} onChange={(e) => change('y', e.target.value as NumKey)} aria-label="Up">{axes.map((a) => <option key={a.k} value={a.k}>{a.label}</option>)}</Select>
      </>}>
      <div className="grid gap-6 lg:grid-cols-[minmax(0,8fr)_minmax(0,4fr)]">
        <Scatter key={`${kx}-${ky}-${resetKey}`} rows={rows} filter={filter} setFilter={setFilter} kx={kx} ky={ky} onTip={setTip} />
        <div className="min-w-0">
          <div className="mb-2 flex items-center gap-2"><span className="t-label">Questions in the filter</span><SampleSize n={qs.length} min={10} /></div>
          <div className="scroll-thin max-h-[380px] overflow-y-auto" data-testid="xf-list">
            {qs.length === 0 ? <NothingPasses /> : qs.slice(0, 80).map((r) => (
              <Link key={r.c} to={`/trials/${r.id}`} data-case={r.c} viewTransition
                className="flex items-center gap-2 border-b border-dashed border-line py-1 text-sm hover:bg-surface-2">
                <Dot className={r.st === 'passed' ? 'bg-good' : 'bg-bad'} />
                <span className="min-w-0 flex-1 truncate">{r.t.title}</span>
                <span className="font-mono text-xs text-ink-3">{r.c}</span>
              </Link>
            ))}
          </div>
        </div>
      </div>
      <ChartTip tip={tip} />
    </Card>
  )
}
