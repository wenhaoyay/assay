// Small helpers shared by the home page and the chatbot page.
import { useQuery } from '@tanstack/react-query'
import { api } from '../../lib/api'
import type { CaseMatrix, Gate, Lineage } from '../../lib/types'
import type { Cell } from '../instrument'

/** "6 Oct" */
export function dayLabel(iso: string | null | undefined): string {
  if (!iso) return ''
  return new Date(iso).toLocaleDateString('en-GB', { day: 'numeric', month: 'short' })
}

/** The release gate's minimum pass rate for each chatbot (project id), when a gate sets one. */
export function useGateThresholds(): Record<number, number> {
  const q = useQuery({ queryKey: ['gates'], queryFn: () => api.get<Gate[]>('/api/gates'), staleTime: 60_000 })
  const out: Record<number, number> = {}
  for (const g of q.data ?? []) {
    const rule = (g.config as Record<string, unknown>).overall_pass_rate as { min?: number } | undefined
    if (typeof rule?.min === 'number' && out[g.project_id] === undefined) out[g.project_id] = rule.min
  }
  return out
}

/** A run's fingerprint cells from a case matrix, in dataset order. */
export function matrixCells(m: CaseMatrix | undefined, runId: number | null | undefined): Cell[] {
  if (!m || runId === null || runId === undefined) return []
  const key = String(runId)
  return m.cases
    .filter((c) => m.cells[c.id]?.[key])
    .map((c) => ({ id: c.id, title: c.title, passed: m.cells[c.id][key].passed, total: m.cells[c.id][key].total }))
}

export type Point = Lineage['points'][number]

/** What changed in the variant label between two runs: only the words that differ. */
export function variantChange(prev: string | null | undefined, cur: string | null | undefined): string | null {
  if (!cur || !prev || prev === cur) return null
  // What the new version added, as a phrase a reader understands ("+ rerank (k=3 bug)",
  // "prompt v2"). A part that only lost words (a "(fix)" note dropped again) is not news.
  const a = prev.split(' / ').map((x) => x.trim())
  const notes: string[] = []
  cur.split(' / ').map((x) => x.trim()).forEach((seg, i) => {
    const old = a[i]
    if (seg === old) return
    if (old && seg.startsWith(old)) { notes.push(`+ ${seg.slice(old.length).replace(/^[\s+]+/, '')}`); return }
    if (old && old.startsWith(seg)) return
    notes.push(seg)
  })
  if (!notes.length) return null
  const text = notes.join(' · ')
  return text.length > 30 ? text.slice(0, 29) + '…' : text
}

const WORDS = ['no', 'one', 'two', 'three', 'four', 'five', 'six', 'seven', 'eight', 'nine', 'ten']

/** "in three weeks", "in 5 days", "in a day" */
export function spanWords(fromIso: string | null | undefined, toIso: string | null | undefined): string {
  if (!fromIso || !toIso) return ''
  const days = Math.round((new Date(toIso).getTime() - new Date(fromIso).getTime()) / 86_400_000)
  if (days <= 1) return 'in a day'
  if (days < 14) return `in ${days < WORDS.length ? WORDS[days] : days} days`
  const weeks = Math.round(days / 7)
  if (weeks < 9) return `in ${WORDS[weeks]} weeks`
  const months = Math.round(days / 30)
  return `in ${months < WORDS.length ? WORDS[months] : months} months`
}
