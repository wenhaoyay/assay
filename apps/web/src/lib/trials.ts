// Trials grouped by test case: a case is the unit people reason about ("fact_03 fails 3 of 3"),
// trials are repeats of it.
import type { TrialRow } from './types'

export interface CaseGroup {
  case_id: string
  title: string
  question: string | null
  category: string | null
  trials: TrialRow[]
  statuses: string[]
  passed: number
  decided: number
  state: 'passed' | 'failed' | 'flaky' | 'error' | 'other'
  failure_types: string[]
  failed_evaluators: string[]
  latency_ms: number | null
  firstFailing: TrialRow | null
}

export function groupByCase(rows: TrialRow[]): CaseGroup[] {
  const m = new Map<string, TrialRow[]>()
  for (const t of rows) m.set(t.case_id, [...(m.get(t.case_id) ?? []), t])
  return [...m.entries()].map(([case_id, ts]) => {
    const trials = [...ts].sort((a, b) => a.trial_index - b.trial_index)
    const statuses = trials.map((t) => t.status)
    const decided = statuses.filter((s) => s === 'passed' || s === 'failed' || s === 'error').length
    const passed = statuses.filter((s) => s === 'passed').length
    const errors = statuses.filter((s) => s === 'error').length
    const state: CaseGroup['state'] = !decided ? 'other' : passed === decided ? 'passed' : errors === decided ? 'error' : passed === 0 ? 'failed' : 'flaky'
    const lat = trials.map((t) => t.latency_ms).filter((v): v is number => v !== null).sort((a, b) => a - b)
    return {
      case_id, title: trials[0].title, question: trials[0].question, category: trials[0].category, trials, statuses, passed, decided, state,
      failure_types: [...new Set(trials.flatMap((t) => t.failure_types))],
      failed_evaluators: [...new Set(trials.flatMap((t) => t.failed_evaluators))],
      latency_ms: lat.length ? lat[Math.floor(lat.length / 2)] : null,
      firstFailing: trials.find((t) => t.status === 'failed' || t.status === 'error') ?? null,
    }
  })
}
