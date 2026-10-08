// Number formatting in one place, so every screen says "n/a" the same way.

export const NA = 'n/a'

export function pct(v: number | null | undefined, digits = 1): string {
  return v === null || v === undefined || Number.isNaN(v) ? NA : `${(v * 100).toFixed(digits)}%`
}

export function pp(v: number | null | undefined, digits = 1): string {
  if (v === null || v === undefined) return NA
  const s = (v * 100).toFixed(digits)
  return `${v > 0 ? '+' : ''}${s}pp`
}

export function ms(v: number | null | undefined): string {
  if (v === null || v === undefined) return NA
  return v >= 1000 ? `${(v / 1000).toFixed(2)}s` : `${Math.round(v)}ms`
}

export function usd(v: number | null | undefined): string {
  if (v === null || v === undefined) return 'unknown'
  if (v === 0) return '$0'
  return v < 0.01 ? `$${v.toFixed(5)}` : `$${v.toFixed(3)}`
}

export function num(v: number | null | undefined, digits = 0): string {
  return v === null || v === undefined ? NA : v.toLocaleString(undefined, { maximumFractionDigits: digits })
}

export function score(v: number | null | undefined): string {
  return v === null || v === undefined ? NA : v.toFixed(3)
}

export function relative(v: number | null | undefined): string {
  return v === null || v === undefined ? NA : `${v > 0 ? '+' : ''}${(v * 100).toFixed(1)}%`
}

export function when(iso: string | null | undefined): string {
  if (!iso) return NA
  const d = new Date(iso)
  return d.toLocaleString(undefined, { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' })
}

export function duration(start: string | null, end: string | null): string {
  if (!start || !end) return NA
  return ms(new Date(end).getTime() - new Date(start).getTime())
}

export function label(id: string): string {
  return id.replace(/_/g, ' ').replace(/\bat k\b/, '@k')
}

export const FAILURE_LABELS: Record<string, string> = {
  retrieval_miss: 'Retrieval miss',
  wrong_answer: 'Wrong answer',
  unsupported_claim: 'Unsupported claim',
  should_have_refused: 'Should have refused',
  incorrect_tool: 'Incorrect tool',
  incorrect_tool_arguments: 'Incorrect tool arguments',
  unnecessary_tool: 'Unnecessary tool',
  tool_result_misused: 'Tool result misused',
  citation_error: 'Citation error',
  malformed_output: 'Malformed output',
  incomplete_response: 'Incomplete response',
  latency_regression: 'Latency regression',
  cost_regression: 'Cost regression',
  judge_disagreement: 'Judge disagreement',
  execution_error: 'Execution error',
  unknown: 'Unknown',
}
