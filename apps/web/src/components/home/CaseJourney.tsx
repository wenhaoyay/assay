// The chatbot page's case journey (B2): every question across every comparable run, and the slope
// chart of each question's pass rate from the first run to the last.
import { useNavigate } from 'react-router-dom'
import { pct } from '../../lib/format'
import type { CaseMatrix } from '../../lib/types'
import { cellState, type CellState } from '../instrument'
import { GaugeArt, Help } from '../ui'

export type JourneyFilter = 'all' | 'flip' | 'fail' | 'flaky'

const ORDER: Record<CellState, number> = { fail: 0, flaky: 1, pass: 2, none: 3 }
const FILL: Record<CellState, string> = { pass: 'var(--good)', fail: 'var(--bad)', flaky: 'var(--flaky)', none: 'var(--untested)' }

function rowsOf(m: CaseMatrix, runIds: number[]) {
  return m.cases.map((c) => {
    const st = runIds.map((r) => cellState(m.cells[c.id]?.[String(r)]))
    const flips = st.reduce((a, s, i) => a + (i && s !== st[i - 1] ? 1 : 0), 0)
    return { c, st, flips }
  })
}

export function journeyCounts(m: CaseMatrix, runIds: number[]) {
  const rows = rowsOf(m, runIds)
  return {
    all: rows.length,
    flip: rows.filter((r) => r.st[0] !== r.st[r.st.length - 1]).length,
    fail: rows.filter((r) => r.st.every((s) => s === 'fail')).length,
    flaky: rows.filter((r) => r.st[r.st.length - 1] === 'flaky').length,
  }
}

export function CaseJourney({ matrix, runIds, filter, trialFor, latestRun }: {
  matrix: CaseMatrix
  runIds: number[]
  filter: JourneyFilter
  trialFor: Record<string, number>
  latestRun: number
}) {
  const nav = useNavigate()
  let rows = rowsOf(matrix, runIds)
  if (filter === 'flip') rows = rows.filter((r) => r.st[0] !== r.st[r.st.length - 1])
  if (filter === 'fail') rows = rows.filter((r) => r.st.every((s) => s === 'fail'))
  if (filter === 'flaky') rows = rows.filter((r) => r.st[r.st.length - 1] === 'flaky')
  rows.sort((a, b) => ORDER[a.st[a.st.length - 1]] - ORDER[b.st[b.st.length - 1]] || b.flips - a.flips)

  if (!rows.length) {
    return (
      <div className="grid place-items-center rounded-xl border-[1.5px] border-dashed border-line-strong p-10 text-center text-ink-3">
        <GaugeArt size={56} />
        <div className="mt-2 text-sm">Nothing here. Either the bot is perfect or the filter is.</div>
      </div>
    )
  }
  const cw = 34
  const rh = 19
  const lw = 220
  const W = lw + runIds.length * cw + 12
  const H = 30 + rows.length * rh
  const open = (caseId: string) => {
    const t = trialFor[caseId]
    nav(t ? `/trials/${t}` : `/runs/${latestRun}`)
  }
  return (
    <div className="scroll-thin overflow-x-auto" data-testid="case-journey">
      <svg width={W} height={H} role="img" aria-label="Case journey">
        {runIds.map((r, j) => <text key={r} x={lw + j * cw + cw / 2} y={14} textAnchor="middle" className="c-num">#{r}</text>)}
        {rows.map((r, i) => {
          const Y = 30 + i * rh + rh / 2
          const title = r.c.title || r.c.id
          return (
            <g key={r.c.id} data-case={r.c.id} style={{ cursor: 'pointer' }} role="link" tabIndex={0} aria-label={`${title}: open its latest answer`}
              onClick={() => open(r.c.id)} onKeyDown={(e) => { if (e.key === 'Enter') open(r.c.id) }}>
              <title>{`${title} · ${r.c.id}\n${r.st.map((s, j) => `#${runIds[j]} ${s === 'none' ? 'not asked' : s}`).join(' · ')}`}</title>
              <rect x={0} y={Y - rh / 2} width={W} height={rh} fill="transparent" />
              <text x={0} y={Y + 4} className="c-row">{title.length > 28 ? title.slice(0, 27) + '…' : title}</text>
              {r.st.map((s, j) => {
                if (!j) return null
                const prev = r.st[j - 1]
                const changed = s !== prev
                const better = ORDER[s] > ORDER[prev]
                return <line key={j} x1={lw + (j - 1) * cw + cw / 2} x2={lw + j * cw + cw / 2} y1={Y} y2={Y}
                  stroke={changed && s !== 'none' && prev !== 'none' ? (better ? 'var(--good)' : 'var(--bad)') : 'var(--line)'} strokeWidth={changed ? 2.4 : 1} />
              })}
              {r.st.map((s, j) => <circle key={j} cx={lw + j * cw + cw / 2} cy={Y} r={4.6} fill={FILL[s]} />)}
            </g>
          )
        })}
      </svg>
    </div>
  )
}

export function SlopeChart({ matrix, first, last }: { matrix: CaseMatrix; first: number; last: number }) {
  const W = 280
  const H = 420
  const y = (v: number) => H - 14 - v * (H - 44)
  const jitter = (id: string) => (([...id].reduce((a, ch) => a + ch.charCodeAt(0) * 7, 0) % 9) - 4) * 1.6
  const rate = (id: string, run: number) => {
    const c = matrix.cells[id]?.[String(run)]
    return c && c.total ? c.passed / c.total : null
  }
  return (
    <div data-testid="slope-chart">
      <div className="t-label mb-2 flex items-center gap-2"><span><span className="font-mono">#{first}</span> → <span className="font-mono">#{last}</span>, per question</span>
        <Help title="Per question">
          <p>Each line is one question: its pass rate in run #{first} on the left, in run #{last} on the right. Green rose, red fell, grey stayed.</p>
          <p>Lines are nudged apart a little so they do not hide each other; hover one to light that question everywhere.</p>
        </Help>
      </div>
      <svg width={W} height={H} role="img" aria-label={`Pass rate per question, run #${first} to run #${last}`} className="max-w-full overflow-visible">
        <text x={30} y={10} textAnchor="middle" className="c-num">#{first}</text>
        <text x={W - 30} y={10} textAnchor="middle" className="c-num">#{last}</text>
        {[0, 0.5, 1].map((t) => <text key={t} x={0} y={y(t) + 4} className="c-num">{t * 100}%</text>)}
        {matrix.cases.map((c) => {
          const a = rate(c.id, first)
          const b = rate(c.id, last)
          if (a === null || b === null) return null
          const col = b > a ? 'var(--good)' : b < a ? 'var(--bad)' : 'var(--untested)'
          const same = a === b
          const ya = y(a) + jitter(c.id)
          const yb = y(b) + jitter(c.id + 'x')
          return (
            <g key={c.id} data-case={c.id}>
              <title>{`${c.title || c.id}: ${pct(a, 0)} → ${pct(b, 0)}`}</title>
              <line x1={30} x2={W - 30} y1={ya} y2={yb} stroke={col} strokeWidth={same ? 1 : 1.8} opacity={same ? 0.5 : 0.85} />
              <circle cx={30} cy={ya} r={3} fill={col} />
              <circle cx={W - 30} cy={yb} r={3} fill={col} />
            </g>
          )
        })}
      </svg>
      <div className="mt-2 flex gap-3.5 text-xs text-ink-3">
        <span className="inline-flex items-center gap-1.5"><span className="size-2 rounded-full bg-good" />better</span>
        <span className="inline-flex items-center gap-1.5"><span className="size-2 rounded-full bg-bad" />worse</span>
        <span className="inline-flex items-center gap-1.5"><span className="size-2 rounded-full bg-untested" />same</span>
      </div>
    </div>
  )
}
