// A5 category × difficulty: the pass rate of every try in each cell; click a cell for its questions.
import clsx from 'clsx'
import { useState } from 'react'
import { pct } from '../../lib/format'
import { rateColor, SampleSize } from '../instrument'
import { Card } from '../ui'
import { CaseChip, NothingPasses } from './bits'
import { firstTries, plain, type XRow } from './data'

const DIFF_ORDER = ['easy', 'medium', 'hard']

export function caseRates(rows: XRow[]): Map<string, number> {
  const m = new Map<string, [number, number]>()
  for (const r of rows) { const v = m.get(r.c) ?? [0, 0]; v[0] += r.st === 'passed' ? 1 : 0; v[1] += 1; m.set(r.c, v) }
  return new Map([...m].map(([k, [p, n]]) => [k, p / n]))
}

export function Heatmap({ rows }: { rows: XRow[] }) {
  const cats = [...new Set(rows.map((r) => r.cat))]
  const difOf = (r: XRow) => r.t.difficulty ?? 'unrated'
  const found = [...new Set(rows.map(difOf))]
  const diffs = [...DIFF_ORDER.filter((d) => found.includes(d)), ...found.filter((d) => !DIFF_ORDER.includes(d)).sort()]
  const [pick, setPick] = useState<[string, string] | null>(null)
  const rates = caseRates(rows)
  const cell = (cat: string, dif: string) => {
    const ts = rows.filter((r) => r.cat === cat && difOf(r) === dif)
    return ts.length ? { v: ts.filter((t) => t.st === 'passed').length / ts.length, n: ts.length, ts } : null
  }
  const picked = pick ? cell(pick[0], pick[1]) : null
  return (
    <Card title="Category × difficulty" id="heat" meta={<SampleSize n={rows.length} unit="tries" />}
      help={<>
        <p>Pass rate of every try, by question category and difficulty. Click a cell to list its questions.</p>
        <p>Cells with few tries are a hint, not a finding.</p>
      </>}>
      {!rows.length ? <NothingPasses>No scored tries.</NothingPasses> : (
        <>
          <table className="w-full border-separate [border-spacing:4px]" data-testid="heatmap">
            <thead><tr><td />{diffs.map((d) => <td key={d} className="t-label text-center">{d}</td>)}</tr></thead>
            <tbody>
              {cats.map((cat) => (
                <tr key={cat}>
                  <td className="whitespace-nowrap pr-2 text-sm text-ink-2">{plain(cat)}</td>
                  {diffs.map((dif) => {
                    const c = cell(cat, dif)
                    if (!c) return <td key={dif} className="rounded-lg bg-surface-2 text-center text-xs text-ink-3">–</td>
                    const on = pick?.[0] === cat && pick?.[1] === dif
                    return (
                      <td key={dif} className="p-0">
                        <button type="button" onClick={() => setPick(on ? null : [cat, dif])} aria-pressed={on}
                          className={clsx('h-12 w-full rounded-lg text-center transition-transform duration-150 hover:scale-105', on && 'ring-2 ring-ink')}
                          style={{ background: `color-mix(in srgb, ${rateColor(c.v)} 48%, var(--surface))` }}>
                          <div className="num font-mono text-sm font-medium text-ink">{pct(c.v, 0)}</div>
                          <div className={clsx('num font-mono text-label', c.n < 8 ? 'text-warn-ink' : 'text-ink-2')}>n={c.n}</div>
                        </button>
                      </td>
                    )
                  })}
                </tr>
              ))}
            </tbody>
          </table>
          {picked && (
            <div className="mt-3 flex flex-wrap gap-1.5">
              {firstTries(picked.ts).map((r) => {
                const v = rates.get(r.c) ?? 0
                return <CaseChip key={r.c} caseId={r.c} trialId={r.id} tone={v >= 1 ? 'good' : v <= 0 ? 'bad' : 'warn'} title={r.t.question}>{r.t.title}</CaseChip>
              })}
            </div>
          )}
        </>
      )}
    </Card>
  )
}
