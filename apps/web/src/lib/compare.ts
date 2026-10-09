// How a comparison row is formatted and read. Kept separate from the page so it can be tested
// and so the reading rules live in one place.
import { ms, num, pct, plural, pp, relative, score, usd } from './format'
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
  if (row.unit === 'rate') return pp(row.delta)
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
  if (!s.targetVersionId) errors.push('Choose a connection.')
  if (!s.datasetVersionId) errors.push('Choose a dataset.')
  if (s.evaluators.length === 0) errors.push('Pick at least one check.')
  const judges = s.evaluators.filter((e) => judgeIds.includes(e))
  if (judges.length && !s.judge) errors.push(`These checks need a grading model: ${judges.join(', ')}. Choose one in section 3, or untick them.`)
  return errors
}

/** One plain sentence for a comparison: the overall change, how sure, and what moved. */
export function verdictSentence(o: { overall: ComparisonRow | null; regressions: number; improvements: number; rows?: ComparisonRow[] }): { text: string; tone: 'good' | 'bad' | 'neutral' } {
  const r = o.overall
  if (!r || r.delta === null) return { text: 'Not enough shared questions to compare.', tone: 'neutral' }
  const read = reading(r)
  const change = pp(r.delta)
  const head =
    read.text === 'likely better' ? `Better: pass rate up ${change}, beyond noise.`
    : read.text === 'likely worse' ? `Worse: pass rate down ${change.replace(/^[-−]/, '')}, beyond noise.`
    : r.delta === 0 ? 'No change in pass rate.'
    : `No reliable difference: pass rate ${change}, within noise.`
  const moved = `${plural(o.regressions, 'question')} regressed, ${o.improvements} improved.`
  const extras: string[] = []
  for (const row of o.rows ?? []) {
    // Rates are already in the sentence as percentage points; mention big moves in latency, tokens, cost.
    if (row.unit === 'rate' || row.unit === 'score' || row.relative === null || row.relative === undefined) continue
    if (Math.abs(row.relative) >= 0.25) {
      const word = row.unit === 'cost' ? 'cost' : row.label.toLowerCase()
      extras.push(`${word} ${row.relative > 0 ? 'up' : 'down'} ${Math.abs(row.relative * 100).toFixed(0)}%`)
    }
  }
  return { text: [head, moved, extras.length ? `Also: ${extras.join(', ')}.` : ''].filter(Boolean).join(' '), tone: read.tone }
}

// --------------------------------------------------------------------------------------
// Per-question pairing, the bootstrap, the power curve and the word diff (Compare / one answer)
// --------------------------------------------------------------------------------------

export interface PairedCase {
  id: string
  title: string
  category: string | null
  /** Tries that passed / tries that were decided, in each run (null when the run did not ask it). */
  a: { passed: number; total: number } | null
  b: { passed: number; total: number } | null
  /** Candidate rate minus baseline rate (0 when either side is missing). */
  d: number
  /** The try to open for this question in each run (the first failing try, else the first try). */
  aTrial: number | null
  bTrial: number | null
}

interface TrialLike { id: number; case_id: string; trial_index: number; status: string; title: string; category: string | null }

function tally(rows: TrialLike[]) {
  const m = new Map<string, { passed: number; total: number; first: TrialLike; failing: TrialLike | null; title: string; category: string | null }>()
  for (const t of [...rows].sort((x, y) => x.trial_index - y.trial_index)) {
    const cur = m.get(t.case_id) ?? { passed: 0, total: 0, first: t, failing: null, title: t.title, category: t.category }
    if (t.status === 'passed' || t.status === 'failed' || t.status === 'error') cur.total++
    if (t.status === 'passed') cur.passed++
    if (!cur.failing && (t.status === 'failed' || t.status === 'error')) cur.failing = t
    m.set(t.case_id, cur)
  }
  return m
}

/** Every question of either run, in the baseline's order, with its tries in both runs. */
export function pairCases(base: TrialLike[], cand: TrialLike[]): PairedCase[] {
  const A = tally(base)
  const B = tally(cand)
  const ids = [...A.keys(), ...[...B.keys()].filter((k) => !A.has(k))]
  return ids.map((id) => {
    const a = A.get(id)
    const b = B.get(id)
    const ra = a && a.total ? a.passed / a.total : null
    const rb = b && b.total ? b.passed / b.total : null
    return {
      id,
      title: (a ?? b)!.title,
      category: (a ?? b)!.category,
      a: a ? { passed: a.passed, total: a.total } : null,
      b: b ? { passed: b.passed, total: b.total } : null,
      d: ra !== null && rb !== null ? rb - ra : 0,
      aTrial: a ? (a.failing ?? a.first).id : null,
      bTrial: b ? (b.failing ?? b.first).id : null,
    }
  })
}

/** A small seeded generator, so the same pair always re-draws the same way. */
export function mulberry32(seed: number) {
  let s = seed >>> 0
  return () => {
    s = (s + 0x6d2b79f5) >>> 0
    let t = s
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

/** One paired bootstrap re-draw: the mean of n per-question differences drawn with repeats. */
export function redraw(diffs: number[], rand: () => number): number {
  let s = 0
  for (let j = 0; j < diffs.length; j++) s += diffs[Math.floor(rand() * diffs.length)]
  return s / (diffs.length || 1)
}

/**
 * The smallest change in pass rate a paired set of ``n`` questions detects reliably (80% power,
 * 5% level): about 2.8 x sqrt(d / n), where ``d`` is the share of questions that flip.
 */
export function minDetectable(flipShare: number, n: number): number {
  return 2.8 * Math.sqrt(Math.max(flipShare, 0.01) / Math.max(n, 1))
}

/** How many questions it takes to detect a change of ``change`` (e.g. 0.05 = 5 points). */
export function questionsFor(flipShare: number, change: number): number {
  return Math.ceil(Math.max(flipShare, 0.01) * (2.8 / change) ** 2)
}

/** A p-value as a plain frequency: "about 3 times in 1,000". */
export function chancePhrase(p: number): string {
  if (p < 0.001) return 'less than once in 1,000'
  if (p < 0.01) return `about ${Math.max(1, Math.round(p * 1000))} times in 1,000`
  if (p < 0.1) return `about ${Math.max(1, Math.round(p * 100))} times in 100`
  return `about ${Math.max(1, Math.round(p * 10))} times in 10`
}

export type DiffPart = { kind: 'same' | 'del' | 'ins'; text: string }

/** A word-level diff (longest common subsequence) from ``a`` to ``b``. Whitespace is kept. */
export function wordDiff(a: string, b: string): DiffPart[] {
  const A = a.split(/(\s+)/)
  const B = b.split(/(\s+)/)
  const n = A.length
  const m = B.length
  const L = Array.from({ length: n + 1 }, () => new Int32Array(m + 1))
  for (let i = n - 1; i >= 0; i--) for (let j = m - 1; j >= 0; j--) L[i][j] = A[i] === B[j] ? L[i + 1][j + 1] + 1 : Math.max(L[i + 1][j], L[i][j + 1])
  const out: DiffPart[] = []
  const push = (kind: DiffPart['kind'], text: string) => {
    const last = out[out.length - 1]
    if (last && last.kind === kind) last.text += text
    else out.push({ kind, text })
  }
  let i = 0
  let j = 0
  while (i < n && j < m) {
    if (A[i] === B[j]) { push('same', A[i]); i++; j++ }
    else if (L[i + 1][j] >= L[i][j + 1]) push('del', A[i++])
    else push('ins', B[j++])
  }
  while (i < n) push('del', A[i++])
  while (j < m) push('ins', B[j++])
  // Read as phrases: a run of changes (with the single spaces between them) becomes one removed
  // phrase followed by one added phrase, instead of alternating words.
  const merged: DiffPart[] = []
  let k = 0
  while (k < out.length) {
    if (out[k].kind === 'same') { merged.push(out[k]); k++; continue }
    let del = ''
    let ins = ''
    while (k < out.length) {
      const p = out[k]
      if (p.kind === 'del') del += p.text
      else if (p.kind === 'ins') ins += p.text
      else if (/^\s+$/.test(p.text) && k + 1 < out.length && out[k + 1].kind !== 'same') { del += p.text; ins += p.text }
      else break
      k++
    }
    if (del) merged.push({ kind: 'del', text: del })
    if (del && ins && !/\s$/.test(del)) merged.push({ kind: 'same', text: ' ' })
    if (ins) merged.push({ kind: 'ins', text: ins })
  }
  return merged
}
