// How a change reads on the comparison and chatbot pages: always `<Delta>`, with `pp` for rates.
// A change that rounds to nothing shows no arrow and no sign.
import { direction } from '../../lib/compare'
import { NA, pp } from '../../lib/format'
import type { ComparisonRow } from '../../lib/types'
import { Delta } from '../instrument'

const MINUS = '−'

/** "+14.7%", "−3.0%", "0.0%": a relative change. */
export function fmtRel(v: number, digits = 1): string {
  const x = Number((v * 100).toFixed(digits))
  return `${x > 0 ? '+' : x < 0 ? MINUS : ''}${Math.abs(x).toFixed(digits)}%`
}

function fmtScore(v: number): string {
  const x = Number(v.toFixed(3))
  return `${x > 0 ? '+' : x < 0 ? MINUS : ''}${Math.abs(x).toFixed(3)}`
}

function Flat({ text }: { text: string }) {
  return <span className="num font-mono text-ink-3">{text}</span>
}

/** A change in pass rate (a fraction), as `<Delta>` in percentage points. */
export function PpDelta({ value, higherIsBetter = true, digits = 1 }: { value: number | null | undefined; higherIsBetter?: boolean; digits?: number }) {
  if (value === null || value === undefined || Number.isNaN(value)) return <span className="text-ink-3">{NA}</span>
  const text = pp(value, digits)
  if (Number((value * 100).toFixed(digits)) === 0) return <Flat text={text} />
  return <Delta value={value} noise={0} higherIsBetter={higherIsBetter} format={(_, v) => pp(v, digits)} />
}

/** One metric row's change: pp for rates, a signed score, a relative change for speed, tokens and cost. */
export function RowDelta({ row }: { row: ComparisonRow }) {
  if (row.delta === null) return <span className="text-ink-3">{NA}</span>
  const higher = row.delta === 0 || (direction(row) === 'better') === (row.delta > 0)
  if (row.unit === 'rate') return <PpDelta value={row.delta} higherIsBetter={higher} />
  if (row.unit === 'score') {
    if (Number(row.delta.toFixed(3)) === 0) return <Flat text={fmtScore(0)} />
    return <Delta value={row.delta} noise={0} higherIsBetter={higher} format={(_, v) => fmtScore(v)} />
  }
  if (row.relative === null || Number.isNaN(row.relative)) return <span className="text-ink-3">{NA}</span>
  if (Number((row.relative * 100).toFixed(1)) === 0) return <Flat text={fmtRel(0)} />
  return <Delta value={row.relative} noise={0} higherIsBetter={higher} format={(_, v) => fmtRel(v)} />
}
