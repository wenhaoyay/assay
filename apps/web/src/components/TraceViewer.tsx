// A trace: what the target did, as a timeline (request, retrieval, model and tool calls), then the
// checks that graded it. Only observable data - no hidden reasoning. Step names are never cut off:
// the timeline column shrinks instead. The slowest step is called out.
import clsx from 'clsx'
import { AlertTriangle, Bot, Check, ChevronRight, Database, Gauge, Search, Sparkles, Wrench, X } from 'lucide-react'
import { AnimatePresence, motion } from 'motion/react'
import { useState } from 'react'
import { ms, num, usd } from '../lib/format'
import type { Span } from '../lib/types'
import { Badge, Json } from './ui'

const ICON: Record<string, typeof Bot> = {
  target_request: Bot, retrieval: Search, model_call: Sparkles, tool_call: Wrench, tool_result: Database,
  post_processing: Gauge, evaluator: Gauge, error: AlertTriangle,
}
const LABEL: Record<string, string> = {
  target_request: 'request', retrieval: 'retrieval', model_call: 'model', tool_call: 'tool', tool_result: 'tool result',
  post_processing: 'post-processing', evaluator: 'check', error: 'error',
}
const BAR: Record<string, string> = {
  retrieval: 'bg-series-1', model_call: 'bg-accent', tool_call: 'bg-series-2', tool_result: 'bg-series-2/70', post_processing: 'bg-error', target_request: 'bg-line-strong',
}

export function TraceViewer({ spans, showEvaluators = true }: { spans: Span[]; showEvaluators?: boolean }) {
  const execution = spans.filter((s) => s.type !== 'evaluator')
  const checks = spans.filter((s) => s.type === 'evaluator')
  const root = execution.find((s) => !s.parent_span_id)
  const [open, setOpen] = useState<string | null>(null)
  const modelSpans = spans.filter((s) => s.type === 'model_call')
  const tokenSum = root?.usage?.total_tokens ?? modelSpans.reduce((a, s) => a + (s.usage?.total_tokens ?? 0), 0)
  const costs = spans.map((s) => s.cost_usd).filter((c): c is number => c !== null && c !== undefined)
  const totals = { tokens: tokenSum || null, cost: costs.length ? costs.reduce((a, b) => a + b, 0) : null }
  if (!root) return <p className="text-sm text-ink-3">No spans recorded.</p>
  const t0 = root.start_time
  const total = Math.max(root.duration_ms, ...execution.map((s) => (s.end_time - t0) * 1000), 1)
  const children = execution.filter((s) => s.parent_span_id === root.span_id)
  const slowest = children.reduce<Span | null>((a, s) => (!a || s.duration_ms > a.duration_ms ? s : a), null)

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap gap-x-6 gap-y-1 text-xs text-ink-2">
        <span>Total <b className="num font-mono font-medium text-ink">{ms(root.duration_ms)}</b></span>
        <span>Tokens <b className="num font-mono font-medium text-ink">{num(totals.tokens)}</b>
          {root.usage?.input_tokens != null && <span className="num text-ink-3"> ({num(root.usage.input_tokens)} in / {num(root.usage.output_tokens)} out)</span>}
        </span>
        <span>Est. cost <b className="num font-mono font-medium text-ink">{usd(totals.cost)}</b></span>
        {Array.isArray(root.metadata?.missing_telemetry) && (root.metadata.missing_telemetry as string[]).length > 0 && (
          <span className="text-ink-3">Not reported by the bot: {(root.metadata.missing_telemetry as string[]).join(', ')}</span>
        )}
      </div>
      <div className="divide-y divide-line border-y border-line">
        {[root, ...children].map((s, i) => {
          const Icon = ICON[s.type] ?? Gauge
          const left = ((s.start_time - t0) * 1000 / total) * 100
          const width = Math.max(0.8, (s.duration_ms / total) * 100)
          const expanded = open === s.span_id
          const isSlow = i > 0 && slowest?.span_id === s.span_id && s.duration_ms > total * 0.3
          return (
            <div key={s.span_id}>
              <button type="button" onClick={() => setOpen(expanded ? null : s.span_id)} aria-expanded={expanded}
                className="grid w-full grid-cols-[minmax(0,1fr)_minmax(80px,180px)_64px] items-center gap-3 px-3 py-2 text-left hover:bg-surface-2 max-md:grid-cols-[minmax(0,1fr)_64px]">
                <span className="flex min-w-0 items-start gap-2" style={{ paddingLeft: i === 0 ? 0 : 16 }}>
                  <ChevronRight className={clsx('mt-0.5 size-3.5 shrink-0 text-ink-3 transition-transform', expanded && 'rotate-90')} />
                  <Icon className={clsx('mt-0.5 size-3.5 shrink-0', s.status === 'error' ? 'text-bad-ink' : 'text-ink-2')} aria-hidden />
                  <span className="min-w-0">
                    <span className="flex flex-wrap items-center gap-x-2">
                      <span className="t-label">{LABEL[s.type] ?? s.type}</span>
                      <span className={clsx('break-all text-sm font-medium', s.status === 'error' && 'text-bad-ink')}>{s.name}</span>
                      {isSlow && <Badge tone="warn">slowest step</Badge>}
                    </span>
                    {s.output_summary && <span className="line-clamp-2 block text-xs text-ink-3">{s.output_summary}</span>}
                  </span>
                </span>
                <span className="relative h-2 rounded bg-surface-2 max-md:hidden" aria-hidden>
                  <motion.span className={clsx('absolute inset-y-0 rounded', s.status === 'error' ? 'bg-bad' : BAR[s.type] ?? 'bg-accent', isSlow && 'ring-2 ring-warn/50')}
                    initial={{ width: 0 }} animate={{ width: `${Math.min(width, 100 - Math.min(left, 99))}%` }} transition={{ delay: 0.04 * i, type: 'spring', stiffness: 160, damping: 24 }}
                    style={{ left: `${Math.min(left, 99)}%` }} />
                </span>
                <span className="num text-right font-mono text-xs text-ink-2">{s.duration_ms ? ms(s.duration_ms) : '-'}</span>
              </button>
              <AnimatePresence initial={false}>
                {expanded && (
                  <motion.div initial={{ height: 0, opacity: 0 }} animate={{ height: 'auto', opacity: 1 }} exit={{ height: 0, opacity: 0 }} transition={{ duration: 0.18 }} className="overflow-hidden">
                    <SpanDetail span={s} />
                  </motion.div>
                )}
              </AnimatePresence>
            </div>
          )
        })}
      </div>
      {showEvaluators && checks.length > 0 && (
        <div>
          <div className="t-label mb-1.5">Checks that graded this answer</div>
          <div className="flex flex-wrap gap-1.5">
            {checks.map((c) => {
              const pass = (c.output_summary ?? '').startsWith('pass')
              const fail = (c.output_summary ?? '').startsWith('fail')
              const heur = (c.output_summary ?? '').includes('[heuristic]')
              return (
                <span key={c.span_id} title={c.output_summary ?? ''}
                  className={clsx('inline-flex items-center gap-1 rounded-md border px-2 py-0.5 text-xs', heur && 'hatched',
                    pass ? 'border-good/30 text-good-ink' : fail ? 'border-bad/40 bg-bad-wash text-bad-ink' : 'border-line text-ink-3')}>
                  {pass ? <Check className="size-3" /> : fail ? <X className="size-3" /> : null}{c.name.replace(/^evaluate: /, '')}
                </span>
              )
            })}
          </div>
        </div>
      )}
    </div>
  )
}

function SpanDetail({ span }: { span: Span }) {
  const meta = span.metadata ?? {}
  const docs = meta.documents as { id: string; title?: string; score?: number }[] | undefined
  return (
    <div className="space-y-2 border-t border-line bg-surface-2/50 px-4 py-3 text-xs">
      {span.input_summary && <div><span className="text-ink-3">Input: </span>{span.input_summary}</div>}
      {span.output_summary && <div><span className="text-ink-3">Output: </span>{span.output_summary}</div>}
      {span.error && <div className="text-bad-ink">Error: {span.error}</div>}
      {span.usage && (
        <div className="num text-ink-2">
          Tokens: {num(span.usage.input_tokens)} in / {num(span.usage.output_tokens)} out
          {span.cost_usd != null && <> - est. {usd(span.cost_usd)}</>}
        </div>
      )}
      {docs && (
        <ol className="space-y-0.5">
          {docs.map((d, i) => (
            <li key={`${d.id}-${i}`} className="flex gap-3 font-mono">
              <span className="w-5 text-ink-3">{i + 1}</span>
              <span className="w-56 truncate">{d.id}</span>
              <span className="num text-ink-3">{d.score != null ? d.score.toFixed(3) : ''}</span>
            </li>
          ))}
        </ol>
      )}
      {'arguments' in meta && (
        <div className="grid gap-2 md:grid-cols-2">
          <div><div className="mb-1 text-ink-3">Arguments</div><Json value={meta.arguments} maxHeight={180} /></div>
          <div><div className="mb-1 text-ink-3">Result</div><Json value={meta.result} maxHeight={180} /></div>
        </div>
      )}
      {!('arguments' in meta) && !docs && Object.keys(meta).length > 0 && <Json value={meta} maxHeight={200} />}
    </div>
  )
}
