// How a comparison row is formatted and read. Kept separate from the page so it can be tested
// and so the reading rules live in one place.
import { ms, num, pct, relative, score, usd } from './format'
import type { ComparisonRow } from './types'

const LOWER_BETTER = new Set(['latency', 'cost', 'count'])

export function fmtValue(row: Pick<ComparisonRow, 'unit'>, v: number | null): string {
  switch (row.unit) {
    case 'rate': return pct(v)
    case 'latency': return ms(v)
    case 'cost': return usd(v)
    case 'count': return num(v)
    default: return score(v)
  }
}

export function fmtDelta(row: ComparisonRow): string {
  if (row.delta === null) return 'n/a'
  if (row.unit === 'rate') return `${row.delta > 0 ? '+' : ''}${(row.delta * 100).toFixed(1)}pp`
  if (row.unit === 'score') return `${row.delta > 0 ? '+' : ''}${row.delta.toFixed(3)}`
  return relative(row.relative)
}

export function direction(row: ComparisonRow): 'better' | 'worse' | 'same' {
  if (row.delta === null || row.delta === 0) return 'same'
  const lower = LOWER_BETTER.has(row.unit)
  return (lower ? row.delta < 0 : row.delta > 0) ? 'better' : 'worse'
}

/** Plain-language reading of the paired interval. Never calls a difference "significant". */
export function reading(row: ComparisonRow): { text: string; tone: 'neutral' | 'good' | 'bad' } {
  if (row.delta === null) return { text: 'not available', tone: 'neutral' }
  if (!row.ci || row.ci.ci_low === null) return { text: row.unit === 'rate' ? 'no interval' : 'point estimate', tone: 'neutral' }
  if (!row.ci.excludes_zero) return { text: 'within noise', tone: 'neutral' }
  return { text: direction(row) === 'better' ? 'likely better' : 'likely worse', tone: direction(row) === 'better' ? 'good' : 'bad' }
}

export interface SetupState {
  targetVersionId: number | ''
  datasetVersionId: number | ''
  evaluators: string[]
  judge: string // '' | 'heuristic' | provider id
}

/** Client-side checks mirror the server's, so problems show before anything is created. */
export function validateSetup(s: SetupState, judgeIds: string[]): string[] {
  const errors: string[] = []
  if (!s.targetVersionId) errors.push('Choose a target.')
  if (!s.datasetVersionId) errors.push('Choose a dataset version.')
  if (s.evaluators.length === 0) errors.push('Select at least one evaluator.')
  const judges = s.evaluators.filter((e) => judgeIds.includes(e))
  if (judges.length && !s.judge) errors.push(`Judge evaluators selected (${judges.join(', ')}) but no judge chosen.`)
  return errors
}
