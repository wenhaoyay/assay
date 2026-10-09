// Number and date formatting in one place, so every screen says "n/a", "340 ms" and "9 Oct 2026"
// the same way. Units are spaced; a minus is U+2212 (−); every date uses one locale.

/** The one marker for "nothing to show" (not reported, not measured). */
export const NA = 'n/a'

/** The one locale for dates and numbers. */
export const LOCALE = 'en-GB'

const MINUS = '−'
const bad = (v: number | null | undefined): v is null | undefined => v === null || v === undefined || Number.isNaN(v)

export function pct(v: number | null | undefined, digits = 1): string {
  return bad(v) ? NA : `${(v * 100).toFixed(digits)}%`
}

/** A change in percentage points: "+23.6 pp", "−2.0 pp", "0.0 pp". One decimal by default. */
export function pp(v: number | null | undefined, digits = 1): string {
  if (bad(v)) return NA
  const x = Number((v * 100).toFixed(digits))
  const body = Math.abs(x).toFixed(digits)
  return `${x > 0 ? '+' : x < 0 ? MINUS : ''}${body} pp`
}

/** Seconds with a spaced unit: "1.2 s". Pass seconds, not milliseconds (see ``ms``). */
export function seconds(v: number | null | undefined, digits = 1): string {
  return bad(v) ? NA : `${v.toFixed(digits)} s`
}

/** Milliseconds with a spaced unit: "340 ms", and from a second up "1.2 s". ``signed`` adds + or − for a change. */
export function ms(v: number | null | undefined, signed = false): string {
  if (bad(v)) return NA
  const sign = signed ? (v > 0 ? '+' : v < 0 ? MINUS : '') : v < 0 ? MINUS : ''
  const a = Math.abs(v)
  return `${sign}${a >= 1000 ? seconds(a / 1000) : `${Math.round(a)} ms`}`
}

export function usd(v: number | null | undefined): string {
  if (v === null || v === undefined) return 'unknown'
  if (v === 0) return '$0'
  return v < 0.01 ? `$${v.toFixed(5)}` : `$${v.toFixed(3)}`
}

export function num(v: number | null | undefined, digits = 0): string {
  return bad(v) ? NA : v.toLocaleString(LOCALE, { maximumFractionDigits: digits })
}

export function score(v: number | null | undefined): string {
  return bad(v) ? NA : v.toFixed(3)
}

export function relative(v: number | null | undefined): string {
  return bad(v) ? NA : `${v > 0 ? '+' : ''}${(v * 100).toFixed(1)}%`
}

const parse = (iso: string | null | undefined): Date | null => {
  if (!iso) return null
  const d = new Date(iso)
  return Number.isNaN(d.getTime()) ? null : d
}

/** "9 Oct 2026": a day. */
export function fmtDay(iso: string | null | undefined): string {
  const d = parse(iso)
  return d ? d.toLocaleDateString(LOCALE, { day: 'numeric', month: 'short', year: 'numeric' }) : NA
}

/** "9 Oct 2026, 14:05": a moment. */
export function fmtDate(iso: string | null | undefined): string {
  const d = parse(iso)
  return d ? d.toLocaleString(LOCALE, { day: 'numeric', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit', hour12: false }) : NA
}

/** "9 Oct, 14:05": a moment, short (no year), for tables and tooltips. */
export function when(iso: string | null | undefined): string {
  const d = parse(iso)
  return d ? d.toLocaleString(LOCALE, { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit', hour12: false }) : NA
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

/** "1 run", "2 runs": real plurals, never "(s)". */
export function plural(n: number, word: string, pluralWord?: string): string {
  return `${n.toLocaleString(LOCALE)} ${n === 1 ? word : pluralWord ?? `${word}s`}`
}

/** A span of seconds in plain words: "45 seconds", "12 minutes", "29 hours". */
export function spanOf(seconds: number): string {
  if (seconds < 90) return plural(Math.max(1, Math.round(seconds)), 'second')
  if (seconds < 5400) return plural(Math.round(seconds / 60), 'minute')
  if (seconds < 172800) return plural(Math.round(seconds / 3600), 'hour')
  return plural(Math.round(seconds / 86400), 'day')
}

/** Estimates above this ask before starting. */
export const LONG_SECONDS = 3600
