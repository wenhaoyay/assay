// A gate's rules said as one sentence: "Passes when the pass rate is at least 70%, tool accuracy
// 90%, p95 speed at most 3.0 s, and nothing drops more than 3pp from the baseline."
import type { ReactNode } from 'react'
import { label as metricLabel } from '../../lib/format'

export type Rule = { metric: string; kind: 'min' | 'max' | 'drop'; value: string }

const NAMES: Record<string, string> = {
  overall_pass_rate: 'pass rate',
  tool_accuracy: 'tool accuracy',
  must_mention: 'must-mention',
  'recall_at_k.mean': 'search recall',
  p95_latency_ms: 'p95 speed',
  p50_latency_ms: 'p50 speed',
  average_cost_usd: 'cost per question',
  average_total_tokens: 'tokens per question',
}

export const ruleName = (metric: string) => NAMES[metric] ?? metricLabel(metric)

function unit(metric: string): 'ms' | 'usd' | 'n' | 'rate' {
  if (metric.includes('latency') || metric.endsWith('_ms')) return 'ms'
  if (metric.includes('cost')) return 'usd'
  if (metric.includes('tokens')) return 'n'
  return 'rate'
}

/** A limit as people say it: 0.7 -> 70%, 3000 ms -> 3.0 s. */
export function limitText(metric: string, value: number, drop = false): string {
  const u = unit(metric)
  if (u === 'rate') return drop ? `${+(value * 100).toFixed(1)}pp` : `${+(value * 100).toFixed(1)}%`
  if (u === 'ms') return value >= 1000 ? `${(value / 1000).toFixed(1)}\u00a0s` : `${Math.round(value)}\u00a0ms`
  if (u === 'usd') return `$${value}`
  return value.toLocaleString()
}

const Fig = ({ children }: { children: ReactNode }) => <b className="num font-mono font-medium text-ink">{children}</b>

export function GateSentence({ rules }: { rules: Rule[] }) {
  const parts: ReactNode[] = []
  let lastKind: Rule['kind'] | null = null
  const abs = rules.filter((r) => r.kind !== 'drop' && r.value !== '')
  abs.forEach((r, i) => {
    const verb = r.kind === lastKind ? '' : `${i === 0 ? ' is' : ''} ${r.kind === 'min' ? 'at least' : 'at most'}`
    parts.push(<span key={`a${i}`}>{i === 0 ? 'the ' : ''}{ruleName(r.metric)}{verb} <Fig>{limitText(r.metric, Number(r.value))}</Fig></span>)
    lastKind = r.kind
  })
  const drops = rules.filter((r) => r.kind === 'drop' && r.value !== '')
  if (drops.length) {
    const allSame = drops.every((d) => d.value === drops[0].value && unit(d.metric) === unit(drops[0].metric))
    parts.push(allSame && drops.length > 1
      ? <span key="d">nothing drops more than <Fig>{limitText(drops[0].metric, Number(drops[0].value), true)}</Fig> from the baseline</span>
      : <span key="d">{drops.map((d, i) => (
          <span key={i}>{i > 0 ? (i === drops.length - 1 ? ' and ' : ', ') : ''}{i === 0 && !abs.length ? 'the ' : ''}{ruleName(d.metric)}{i === 0 ? ' drops' : ''} no more than <Fig>{limitText(d.metric, Number(d.value), true)}</Fig></span>
        ))} from the baseline</span>)
  }
  if (!parts.length) return <>This gate has no rules yet: every run would pass it.</>
  return (
    <>Passes when {parts.map((p, i) => <span key={i}>{i > 0 ? (i === parts.length - 1 ? ', and ' : ', ') : ''}{p}</span>)}.</>
  )
}
