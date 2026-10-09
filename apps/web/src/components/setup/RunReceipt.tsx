// "Before you start": the New run estimate printed as a receipt. Each line reprints itself when the
// choice above changes it (ReceiptLine), so you can see what a click did.
import type { ReactNode } from 'react'
import { Link } from 'react-router-dom'
import { fmtDate, usd } from '../../lib/format'
import { Receipt, ReceiptLine } from '../instrument'
import { Help } from '../ui'

export interface Estimate {
  cases: number
  target_calls: number
  per_call_ms: number | null
  based_on_runs: number
  target_cost_usd: number | null
  judge_calls: number
  judge_cost_usd: number | null
  estimated_seconds: number | null
  note: string
  blocked: string | null
  spend_cap_usd: number | null
  target_cost_visible?: boolean
  target_cost_source?: string | null
  cost_per_answer_usd?: number | null
  shared?: boolean
  judge_ms_per_call?: number | null
  judge_local?: boolean
}

export function duration(s: number | null): string {
  if (s === null) return 'unknown'
  if (s < 60) return `~${Math.max(1, s)} s`
  if (s < 3600) return `~${Math.round(s / 60)} min`
  return `~${(s / 3600).toFixed(1)} h`
}

// Printed at load, like the time on a till slip; a render never reads the clock.
const PRINTED = fmtDate(new Date().toISOString())

export function RunReceipt({ e, trials, concurrency, gateName, judgeLabel, targetId, loading, children }: {
  e: Estimate | undefined
  trials: number
  concurrency: number
  gateName: string | null
  judgeLabel: string
  targetId: number | null
  loading: boolean
  children?: ReactNode
}) {
  const title = (
    <span className="inline-flex items-center gap-1.5">
      Before you start
      <Help title="Before you start">
        <p>What this run will ask, how long it should take and what it should cost. Change anything on the left and the lines it changes reprint.</p>
        <p>Estimates come from how long earlier runs of this version took. A local grading model on a CPU is slow (tens of seconds per call).</p>
        {e?.note && <p>{e.note}</p>}
        <p>Nothing is asked until you press the button under the receipt.</p>
      </Help>
    </span>
  )
  if (!e) {
    return (
      <Receipt title={title} sub={PRINTED}>
        {loading ? <div className="skeleton h-40" /> : <p className="py-6 text-center font-sans text-sm text-ink-2">Pick a version and a dataset to see the estimate.</p>}
        {children}
      </Receipt>
    )
  }
  const hidden = e.target_cost_visible === false
  const botCost = hidden ? 'unknown — the cap cannot limit it' : usd(e.target_cost_usd ?? 0)
  const gradingCost = !e.judge_calls ? '$0' : e.judge_local ? '$0 (this PC)' : judgeLabel === 'heuristic' ? '$0 (heuristic)' : e.judge_cost_usd === null ? 'price unknown' : usd(e.judge_cost_usd)
  const time = duration(e.estimated_seconds)
  const total = hidden
    ? `${time} · ${e.judge_cost_usd ? usd(e.judge_cost_usd) : '$0'} + bot`
    : `${time} · ${usd((e.target_cost_usd ?? 0) + (e.judge_cost_usd ?? 0))}`
  const notes: ReactNode[] = []
  if (e.judge_local && e.judge_calls > 0) notes.push('Local grading runs on this PC, one call at a time: the judge is the slow part.')
  if (hidden) {
    notes.push(<>The spend cap cannot see this bot's cost (it reports no token counts, so its answers count as $0). Set Max answers, or {targetId ? <Link className="text-accent-ink underline" to={`/targets/${targetId}`}>enter a cost per answer on the connection</Link> : 'enter a cost per answer on the connection'}.</>)
  }
  return (
    <Receipt title={title} sub={PRINTED}>
      <ReceiptLine label="Questions" value={String(e.cases)} />
      <ReceiptLine label="Tries each" value={`× ${trials}`} />
      <ReceiptLine label={hidden ? 'Answers from the bot (billed)' : 'Answers from the bot'} value={String(e.target_calls)} />
      <ReceiptLine label="Grading calls" value={e.judge_calls ? String(e.judge_calls) : 'none'} />
      <ReceiptLine label="In parallel" value={`${concurrency}${concurrency >= 8 ? ' (speed figures inflated)' : ''}`} />
      <hr />
      <ReceiptLine label="Time" value={time} />
      <ReceiptLine label="Per answer" value={e.per_call_ms ? `${(e.per_call_ms / 1000).toFixed(1)} s` : 'no past runs'} />
      <ReceiptLine label={e.target_cost_source === 'per answer (set on the connection)' ? 'Bot cost (your price)' : 'Bot cost'} value={botCost} />
      <ReceiptLine label="Grading cost" value={gradingCost} />
      <ReceiptLine label="Release gate" value={gateName ?? '–'} />
      <hr />
      <ReceiptLine label="Total" value={total} strong />
      {notes.length > 0 && (
        <div className="mt-3 space-y-1.5 font-sans text-xs text-warn-ink" data-testid="receipt-notes">
          {notes.map((n, i) => <p key={i}>{n}</p>)}
        </div>
      )}
      {children}
    </Receipt>
  )
}
