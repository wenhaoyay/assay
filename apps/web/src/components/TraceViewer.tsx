// A trace as a tree with a timeline bar per span. Only observable data: requests, retrieval,
// model calls, tool calls/results, evaluators, errors - no hidden reasoning.
import clsx from 'clsx'
import { AlertTriangle, Bot, ChevronDown, ChevronRight, Database, Gauge, Search, Sparkles, Wrench } from 'lucide-react'
import { useMemo, useState } from 'react'
import { ms, num, usd } from '../lib/format'
import type { Span } from '../lib/types'
import { Json } from './ui'

const ICON: Record<string, typeof Bot> = {
  target_request: Bot,
  retrieval: Search,
  model_call: Sparkles,
  tool_call: Wrench,
  tool_result: Database,
  post_processing: Gauge,
  evaluator: Gauge,
  error: AlertTriangle,
}

const LABEL: Record<string, string> = {
  target_request: 'request',
  retrieval: 'retrieval',
  model_call: 'model',
  tool_call: 'tool',
  tool_result: 'tool result',
  post_processing: 'post-processing',
  evaluator: 'evaluator',
  error: 'error',
}

export function TraceViewer({ spans, showEvaluators = true }: { spans: Span[]; showEvaluators?: boolean }) {
  const shown = showEvaluators ? spans : spans.filter((s) => s.type !== 'evaluator')
  const root = shown.find((s) => !s.parent_span_id)
  const [open, setOpen] = useState<string | null>(null)
  const totals = useMemo(() => {
    const model = spans.filter((s) => s.type === 'model_call')
    const tokens = root?.usage?.total_tokens ?? model.reduce((a, s) => a + (s.usage?.total_tokens ?? 0), 0)
    const costs = spans.map((s) => s.cost_usd).filter((c): c is number => c !== null && c !== undefined)
    return { tokens: tokens || null, cost: costs.length ? costs.reduce((a, b) => a + b, 0) : null }
  }, [spans, root])
  if (!root) return <p className="text-[13px] text-ink-3">No spans recorded.</p>
  const t0 = root.start_time
  const total = Math.max(root.duration_ms, ...shown.map((s) => (s.end_time - t0) * 1000), 1)
  const children = shown.filter((s) => s.parent_span_id === root.span_id)

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap gap-x-6 gap-y-1 text-xs text-ink-2">
        <span>Total latency <b className="num text-ink">{ms(root.duration_ms)}</b></span>
        <span>Tokens <b className="num text-ink">{num(totals.tokens)}</b>
          {root.usage?.input_tokens != null && <span className="num text-ink-3"> ({num(root.usage.input_tokens)} in / {num(root.usage.output_tokens)} out)</span>}
        </span>
        <span>Est. cost <b className="num text-ink">{usd(totals.cost)}</b></span>
        {Array.isArray(root.metadata?.missing_telemetry) && (root.metadata.missing_telemetry as string[]).length > 0 && (
          <span className="text-ink-3">Not reported by target: {(root.metadata.missing_telemetry as string[]).join(', ')}</span>
        )}
      </div>
      <div className="overflow-hidden rounded-md border border-line">
        {[root, ...children].map((s, i) => {
          const depth = i === 0 ? 0 : 1
          const Icon = ICON[s.type] ?? Gauge
          const left = ((s.start_time - t0) * 1000 / total) * 100
          const width = Math.max(0.6, (s.duration_ms / total) * 100)
          const expanded = open === s.span_id
          return (
            <div key={s.span_id} className={clsx(i > 0 && 'border-t border-line')}>
              <button
                onClick={() => setOpen(expanded ? null : s.span_id)}
                className="grid w-full grid-cols-[minmax(0,1fr)_200px_70px] items-center gap-3 px-3 py-1.5 text-left hover:bg-surface-2 max-md:grid-cols-[minmax(0,1fr)_70px]"
                aria-expanded={expanded}
              >
                <span className="flex min-w-0 items-center gap-2" style={{ paddingLeft: depth * 18 }}>
                  {expanded ? <ChevronDown className="size-3.5 shrink-0 text-ink-3" /> : <ChevronRight className="size-3.5 shrink-0 text-ink-3" />}
                  <Icon className={clsx('size-3.5 shrink-0', s.status === 'error' ? 'text-bad-ink' : 'text-ink-2')} aria-hidden />
                  <span className="shrink-0 text-[11px] uppercase tracking-wide text-ink-3">{LABEL[s.type] ?? s.type}</span>
                  <span className={clsx('truncate text-[13px]', s.status === 'error' && 'text-bad-ink')}>{s.name}</span>
                  {s.output_summary && <span className="truncate text-xs text-ink-3">{s.output_summary}</span>}
                </span>
                <span className="relative h-2 rounded bg-surface-2 max-md:hidden" aria-hidden>
                  <span
                    className={clsx('absolute inset-y-0 rounded', s.status === 'error' ? 'bg-bad' : s.type === 'evaluator' ? 'bg-line-strong' : 'bg-series-1')}
                    style={{ left: `${Math.min(left, 99)}%`, width: `${Math.min(width, 100 - Math.min(left, 99))}%` }}
                  />
                </span>
                <span className="num text-right text-xs text-ink-2">{s.duration_ms ? ms(s.duration_ms) : '-'}</span>
              </button>
              {expanded && <SpanDetail span={s} />}
            </div>
          )
        })}
      </div>
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
        <ul className="space-y-0.5">
          {docs.map((d) => (
            <li key={d.id} className="flex gap-3 font-mono">
              <span className="w-48 truncate">{d.id}</span>
              <span className="num text-ink-3">{d.score != null ? d.score.toFixed(3) : ''}</span>
            </li>
          ))}
        </ul>
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
