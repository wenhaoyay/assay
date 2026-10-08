// Data helpers shared by the run page and its charts: the explore rows, the run a figure is
// compared with, the variant in plain words, and the 95% Wilson interval.
import { useQuery } from '@tanstack/react-query'
import { api } from '../../lib/api'
import { groupByCase } from '../../lib/trials'
import type { Comparison, ExploreData, ExploreTrial, Gate, RunHeader, TrialRow } from '../../lib/types'

export function useExplore(runId: number, enabled = true) {
  return useQuery({ queryKey: ['explore', runId], queryFn: () => api.get<ExploreData>(`/api/runs/${runId}/explore`), enabled })
}

/** Every try of a run (the same cache entry every tab uses). */
export function useRunTrials(runId: number | null | undefined, live = false) {
  return useQuery({
    queryKey: ['trials', runId, {}],
    queryFn: () => api.get<TrialRow[]>(`/api/runs/${runId}/trials`),
    enabled: !!runId,
    refetchInterval: live ? 1500 : false,
  })
}

/** Pass rate per question of a run, for "#base → now". */
export function useCaseRates(runId: number | null | undefined) {
  const q = useRunTrials(runId)
  if (!q.data) return null
  const out: Record<string, number> = {}
  for (const g of groupByCase(q.data)) if (g.decided) out[g.case_id] = g.passed / g.decided
  return out
}

const done = (x: RunHeader) => x.status === 'completed' || x.status === 'completed_with_errors'

/** The last earlier run of the same chatbot over the same questions, never an off-topic one. */
export function usePreviousComparable(r: RunHeader | undefined) {
  const runs = useQuery({ queryKey: ['runs'], queryFn: () => api.get<RunHeader[]>('/api/runs?limit=300'), enabled: !!r })
  if (!r || !runs.data) return null
  return runs.data.find((x) => x.id < r.id && x.comparability_key === r.comparability_key && done(x) && !x.off_topic
    && (r.project_id == null || x.project_id == null || x.project_id === r.project_id)) ?? null
}

/** A run header by id (from the shared runs list). */
export function useRunHeader(id: number | null | undefined) {
  const runs = useQuery({ queryKey: ['runs'], queryFn: () => api.get<RunHeader[]>('/api/runs?limit=300'), enabled: !!id })
  return id ? runs.data?.find((x) => x.id === id) ?? null : null
}

export function useComparison(baseline: number | null | undefined, candidate: number | null | undefined) {
  return useQuery({
    queryKey: ['compare', baseline, candidate],
    queryFn: () => api.get<Comparison>(`/api/runs/compare?baseline=${baseline}&candidate=${candidate}`),
    enabled: !!baseline && !!candidate,
    retry: false,
  })
}

/** The pass-rate floor of the chatbot's gate (for the needle's tick and the live funnel). */
export function useGateFloor(projectId: number | null | undefined) {
  const gates = useQuery({ queryKey: ['gates'], queryFn: () => api.get<Gate[]>('/api/gates') })
  const list = Array.isArray(gates.data) ? gates.data : []
  const g = list.find((x) => x.project_id === projectId) ?? list[0]
  const v = (g?.config as Record<string, { min?: number }> | undefined)?.overall_pass_rate?.min
  return typeof v === 'number' ? v : null
}

/** 95% Wilson interval of k successes in n. */
export function wilson(k: number, n: number): [number, number] {
  if (!n) return [0, 1]
  const z = 1.96, p = k / n, den = 1 + (z * z) / n
  const c = (p + (z * z) / (2 * n)) / den
  const half = (z * Math.sqrt((p * (1 - p)) / n + (z * z) / (4 * n * n))) / den
  return [Math.max(0, c - half), Math.min(1, c + half)]
}

const PART: Record<string, string> = { rrf: 'fused', rerank: 'reranked', reranker: 'reranked', bm25: 'search' }
const RETRIEVAL = new Set(['hybrid', 'lexical', 'dense', 'semantic', 'vector', 'keyword', 'sparse'])

/** One part of a variant label in plain words: "lexical BM25 top-5" → "Lexical search, top 5". */
export function tidyPart(s: string): string {
  const parts = s.split(/\s+\+\s+/).map((p, i) => {
    let t = p.trim().replace(/\btop-(\d+)\b/gi, ', top $1').replace(/\s+,/g, ',')
    t = t.split(' ').map((w) => { const m = /^(\w+)(\W*)$/.exec(w); return m && PART[m[1].toLowerCase()] ? PART[m[1].toLowerCase()] + m[2] : w }).join(' ').replace(/\b(\w+) search search\b/i, '$1 search')
    if (i === 0 && RETRIEVAL.has(t.split(/[\s,]/)[0].toLowerCase()) && !/search/i.test(t)) t = t.replace(/^(\w+)/, '$1 search')
    return t.replace(/\s{2,}/g, ' ').trim()
  })
  const joined = parts.length > 2 ? `${parts.slice(0, -1).join(', ')} and ${parts.at(-1)}` : parts.length === 2 ? `${parts[0]}, ${parts[1]}` : parts[0]
  return joined.charAt(0).toUpperCase() + joined.slice(1)
}

/** The variant label split for the title: the plain first part and the italic rest. */
export function variantTitle(r: Pick<RunHeader, 'variant_label' | 'experiment'>): [string, string | null] {
  const v = (r.variant_label || '').trim()
  if (!v) return [r.experiment, null]
  const [a, ...rest] = v.split(' / ')
  return [tidyPart(a), rest.length ? rest.join(' / ') : null]
}

// ---------------------------------------------------------------------------------------------
// Explore rows: one per try, with the measures the charts use
// ---------------------------------------------------------------------------------------------

export interface XRow {
  t: ExploreTrial
  id: number
  c: string
  lat: number | null
  tok: number | null
  len: number | null
  top: number | null
  corr: number | null
  mm: number | null
  st: 'passed' | 'failed'
  cat: string
  cause: string
  causeKey: string | null
}

export const decided = (t: ExploreTrial) => t.status === 'passed' || t.status === 'failed' || t.status === 'error'

export function toRows(trials: ExploreTrial[]): XRow[] {
  return trials.filter(decided).map((t) => ({
    t, id: t.id, c: t.case_id,
    lat: t.latency_ms, tok: t.total_tokens, len: t.answer_length, top: t.top_score,
    corr: t.scores.correctness?.score ?? null, mm: t.scores.must_mention?.score ?? null,
    st: t.status === 'passed' ? 'passed' : 'failed',
    cat: t.category ?? 'uncategorised',
    cause: t.status === 'passed' ? 'Passed' : t.cause?.label ?? 'No cause found',
    causeKey: t.status === 'passed' ? null : t.cause?.cause ?? null,
  }))
}

/** The first try of each question, in dataset order. */
export function firstTries<T extends { c: string }>(rows: T[]): T[] {
  const seen = new Set<string>()
  return rows.filter((r) => !seen.has(r.c) && !!seen.add(r.c))
}

export const plain = (s: string) => s.replace(/_/g, ' ')
