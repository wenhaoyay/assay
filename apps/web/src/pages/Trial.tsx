import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import clsx from 'clsx'
import { Check, ChevronRight, CircleAlert, Pencil, X } from 'lucide-react'
import { AnimatePresence, motion } from 'motion/react'
import { Fragment, useMemo, useState, type ReactNode } from 'react'
import { Link, useNavigate, useParams } from 'react-router-dom'
import { TraceViewer } from '../components/TraceViewer'
import { Badge, Button, Card, Consistency, ErrorState, Explain, Field, Input, Json, Kbd, PageSkeleton, Segmented, StatusBadge, Table, Term } from '../components/ui'
import { AddFailureToDataset } from '../components/Golden'
import { CauseBadge, CauseCard } from '../components/Causes'
import { api } from '../lib/api'
import { useCrumbs } from '../lib/crumbs'
import { FAILURE_LABELS, ms, num, usd } from '../lib/format'
import { useHotkey } from '../lib/hotkeys'
import { describePattern, groupByCase } from '../lib/trials'
import type { Score, TrialDetail, TrialRow } from '../lib/types'

const ORDER: Record<string, number> = { fail: 0, error: 1, unknown: 2, pass: 3, not_evaluated: 4, not_applicable: 5 }
const ANSWER_FAILURES = new Set(['wrong_answer', 'incomplete_response', 'should_have_refused', 'malformed_output', 'unsupported_claim', 'citation_error'])
const STAGE_OF: Record<string, string> = {
  retrieval_miss: 'retrieval', incorrect_tool: 'tools', incorrect_tool_arguments: 'tools', unnecessary_tool: 'tools', tool_result_misused: 'tools',
  wrong_answer: 'the answer', incomplete_response: 'the answer', should_have_refused: 'the answer', malformed_output: 'the answer',
  unsupported_claim: 'grounding', citation_error: 'grounding', latency_regression: 'speed', cost_regression: 'cost', execution_error: 'execution',
}

function escapeRe(s: string) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

/** The answer with required phrases (green), forbidden ones (red) and citation markers (accent) marked. */
export function HighlightedAnswer({ text, good, bad }: { text: string; good: string[]; bad: string[] }) {
  const parts = useMemo(() => {
    const terms = [...good.map((g) => ({ t: g, k: 'good' })), ...bad.map((b) => ({ t: b, k: 'bad' }))].filter((x) => x.t.trim())
    const alts = [...terms.map((x) => escapeRe(x.t)), '\\[[^\\]\\[]{1,120}\\]']
    const re = new RegExp(`(${alts.join('|')})`, 'gi')
    return text.split(re).map((chunk, i) => {
      if (i % 2 === 0) return { chunk, kind: null as string | null }
      const term = terms.find((x) => x.t.toLowerCase() === chunk.toLowerCase())
      return { chunk, kind: term ? term.k : 'cite' }
    })
  }, [text, good, bad])
  return (
    <>
      {parts.map((p, i) => p.kind === null ? <Fragment key={i}>{p.chunk}</Fragment> : (
        <mark key={i} className={clsx('rounded px-0.5',
          p.kind === 'good' && 'bg-good-wash text-good-ink underline decoration-good/60 decoration-2 underline-offset-2',
          p.kind === 'bad' && 'bg-bad-wash text-bad-ink line-through decoration-bad/70',
          p.kind === 'cite' && 'bg-accent-wash font-mono text-xs text-accent-ink')}>{p.chunk}</mark>
      ))}
    </>
  )
}

export function TrialPage() {
  const { id } = useParams()
  const nav = useNavigate()
  const q = useQuery({ queryKey: ['trial', Number(id)], queryFn: () => api.get<TrialDetail>(`/api/trials/${id}`) })
  const runTrials = useQuery({ queryKey: ['trials', q.data?.run_id, {}], queryFn: () => api.get<TrialRow[]>(`/api/runs/${q.data!.run_id}/trials`), enabled: !!q.data })
  const run = useQuery({ queryKey: ['run', String(q.data?.run_id)], queryFn: () => api.get<{ project_id: number | null; experiment: string; judge: { provider: string } | null }>(`/api/runs/${q.data!.run_id}`), enabled: !!q.data })
  const projects = useQuery({ queryKey: ['projects'], queryFn: () => api.get<{ id: number; name: string }[]>('/api/projects') })
  const [showNA, setShowNA] = useState(false)
  const [showPassed, setShowPassed] = useState(false)
  const [rawTab, setRawTab] = useState<'normalized' | 'raw'>('normalized')
  const t = q.data
  const project = projects.data?.find((p) => p.id === run.data?.project_id)
  useCrumbs([
    ...(project ? [{ label: project.name, to: `/p/${project.id}` }] : []),
    ...(t ? [{ label: `Run #${t.run_id}`, to: `/runs/${t.run_id}` }, { label: t.case_id, to: `/runs/${t.run_id}?tab=cases&case=${t.case_id}` }, { label: `try ${t.trial_index + 1}` }] : []),
  ], `trial-${id}-${!!t}-${project?.name}`)

  const failingCases = useMemo(() => groupByCase(runTrials.data ?? []).filter((g) => g.firstFailing), [runTrials.data])
  const siblings = t?.sibling_trials ?? []
  const idx = siblings.findIndex((s) => s.id === t?.id)
  useHotkey('[', () => { if (idx > 0) nav(`/trials/${siblings[idx - 1].id}`) }, idx > 0)
  useHotkey(']', () => { if (idx >= 0 && idx < siblings.length - 1) nav(`/trials/${siblings[idx + 1].id}`) }, idx >= 0 && idx < siblings.length - 1)
  const nextFailing = () => {
    const i = failingCases.findIndex((g) => g.case_id === t?.case_id)
    const next = failingCases[(i + 1) % failingCases.length]
    if (next?.firstFailing) nav(`/trials/${next.firstFailing.id}`, { viewTransition: true })
  }
  const prevFailing = () => {
    const i = failingCases.findIndex((g) => g.case_id === t?.case_id)
    const prev = failingCases[(i - 1 + failingCases.length) % failingCases.length]
    if (prev?.firstFailing) nav(`/trials/${prev.firstFailing.id}`, { viewTransition: true })
  }
  useHotkey('shift+j', nextFailing, failingCases.length > 0)
  useHotkey('shift+k', prevFailing, failingCases.length > 0)

  if (q.isLoading) return <PageSkeleton />
  if (q.isError) return <ErrorState error={q.error} />
  const tr = t!
  const c = tr.case
  const r = tr.result
  const heuristic = run.data?.judge?.provider === 'heuristic'
  const scores = [...tr.scores].sort((a, b) => (ORDER[a.status] ?? 9) - (ORDER[b.status] ?? 9))
  const failing = scores.filter((s) => (s.status === 'fail' || s.status === 'error') && s.gating)
  const failingDiag = scores.filter((s) => (s.status === 'fail' || s.status === 'error') && !s.gating)
  const passed = scores.filter((s) => s.status === 'pass')
  const other = scores.filter((s) => !['fail', 'error', 'pass'].includes(s.status) && (showNA || s.status !== 'not_applicable'))
  const relevant = new Set((c?.expected.relevant_documents ?? []).flatMap((d) => d.split('|')))
  const cited = new Set((r?.citations ?? []).map((x) => x.id))
  const citedN = new Set((r?.citations ?? []).filter((x) => x.n != null).map((x) => String(x.n)))
  const graded = tr.scores.some((sc) => sc.kind === 'llm_judge' && !['not_applicable', 'not_evaluated'].includes(sc.status))
  const answerFailed = tr.failure_types.some((f) => ANSWER_FAILURES.has(f))
  const mustMention = c?.expected.answer.must_mention ?? []
  const mustNot = c?.expected.answer.must_not_claim ?? []
  const missing = mustMention.filter((p) => !(tr.answer ?? '').toLowerCase().includes(p.toLowerCase()))
  const failIdx = failingCases.findIndex((g) => g.case_id === tr.case_id)

  return (
    <>
      <div className="mb-4 flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0">
          <div className="text-xs font-medium text-ink-3">{c?.category}{c?.difficulty ? `, ${c.difficulty}` : ''}</div>
          <h1 className="flex flex-wrap items-center gap-2 text-title font-semibold tracking-tight" style={{ viewTransitionName: `case-${tr.case_id}` }}>
            <span className="font-mono text-h">{tr.case_id}</span><span className="font-normal text-ink-2">{c?.title}</span>
          </h1>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          {(tr.status === 'failed' || tr.status === 'error') && tr.question && (
            <AddFailureToDataset projectId={run.data?.project_id} question={tr.question} answer={tr.answer ?? ''} runId={tr.run_id} trialId={tr.id} reference={c?.expected.answer.reference} />
          )}
          <Consistency statuses={siblings.map((s) => s.status)} />
          {siblings.length > 1 && (
            <div className="inline-flex rounded-lg border border-line bg-surface-2 p-0.5" aria-label="Tries of this case">
              {siblings.map((s) => (
                <Link key={s.id} to={`/trials/${s.id}`} title={s.status}
                  className={clsx('flex items-center gap-1 rounded-md px-2 py-0.5 text-xs', s.id === tr.id ? 'bg-surface font-medium shadow-sm' : 'text-ink-3 hover:text-ink')}>
                  {s.status === 'passed' ? <Check className="size-3 text-good-ink" /> : <X className="size-3 text-bad-ink" />}try {s.trial_index + 1}
                </Link>
              ))}
            </div>
          )}
          <span className="flex items-center gap-1 text-label text-ink-3 max-lg:hidden"><Kbd>[</Kbd><Kbd>]</Kbd> tries <Kbd>Shift</Kbd><Kbd>J</Kbd> next failing case{failIdx >= 0 && ` (${failIdx + 1}/${failingCases.length})`}</span>
        </div>
      </div>

      {/* The reason, first. */}
      <Verdict t={tr} failing={failing} />

      <div className="mt-5 grid gap-5 xl:grid-cols-[minmax(0,1fr)_400px]">
        <div className="space-y-5">
          <Card title="Question, answer and what was expected">
            <div className="mb-3 text-sm"><span className="text-xs font-medium text-ink-3">Question</span><div className="mt-0.5 text-base">{c?.input.message ?? tr.question}</div></div>
            <div className="grid gap-4 lg:grid-cols-2">
              <div>
                <div className="mb-1 flex items-center gap-2 text-xs font-medium text-ink-3">Answer {r?.provider?.model && <span className="font-normal">({r.provider.model})</span>}</div>
                <div className={clsx('whitespace-pre-wrap rounded-lg border px-3 py-2.5 text-sm leading-relaxed',
                  tr.status === 'passed' ? 'border-good/30 bg-good-wash/30' : answerFailed ? 'border-bad/40 bg-bad-wash/40' : 'border-line bg-surface-2/50')}>
                  {tr.answer ? <HighlightedAnswer text={tr.answer} good={mustMention} bad={mustNot} /> : <span className="text-ink-3">(empty)</span>}
                </div>
                {tr.status !== 'passed' && !answerFailed && tr.failure_types.length > 0 && (
                  <p className="mt-1 text-xs text-ink-3">The answer text itself was not marked wrong: the failure is in {[...new Set(tr.failure_types.map((f) => STAGE_OF[f] ?? f))].join(' and ')}.</p>
                )}
                {missing.length > 0 && <p className="mt-1 text-xs text-bad-ink">Missing required: {missing.map((m) => <code key={m} className="mx-0.5 rounded bg-bad-wash px-1">{m}</code>)}</p>}
                {r?.error && <div className="mt-1 text-xs text-bad-ink">Bot error: {r.error}</div>}
                <div className="mt-2 flex flex-wrap gap-3 text-label text-ink-3">
                  <span className="flex items-center gap-1"><mark className="rounded bg-good-wash px-1 text-good-ink">phrase</mark> required, present</span>
                  <span className="flex items-center gap-1"><mark className="rounded bg-bad-wash px-1 text-bad-ink line-through">phrase</mark> must not claim</span>
                  <span className="flex items-center gap-1"><mark className="rounded bg-accent-wash px-1 font-mono text-accent-ink">[doc]</mark> citation</span>
                </div>
              </div>
              <div>{c ? <Expectations c={c} /> : <p className="text-xs text-ink-3">No expected outcomes stored.</p>}</div>
            </div>
          </Card>

          <Card title="Every check" actions={<label className="flex items-center gap-1.5 text-xs text-ink-2"><input type="checkbox" className="accent-[var(--accent)]" checked={showNA} onChange={(e) => setShowNA(e.target.checked)} /> show not applicable</label>}>
            <ul className="space-y-2">
              {failing.map((s) => <ScoreRow key={s.evaluator_id} s={s} heuristic={heuristic} />)}
              {failingDiag.map((s) => <ScoreRow key={s.evaluator_id} s={s} heuristic={heuristic} />)}
              {other.map((s) => <ScoreRow key={s.evaluator_id} s={s} heuristic={heuristic} />)}
            </ul>
            {passed.length > 0 && (
              <div className="mt-3">
                <button type="button" onClick={() => setShowPassed((v) => !v)} className="flex items-center gap-1 text-sm font-medium text-good-ink">
                  <ChevronRight className={clsx('size-4 transition-transform', showPassed && 'rotate-90')} />{passed.length} check(s) passed
                </button>
                {!showPassed && <div className="mt-1.5 flex flex-wrap gap-1">{passed.map((s) => <Badge key={s.evaluator_id} tone="good" className={clsx(heuristic && s.kind === 'llm_judge' && 'hatched')}><Check className="size-3" />{s.evaluator_id}</Badge>)}</div>}
                <AnimatePresence initial={false}>
                  {showPassed && (
                    <motion.ul initial={{ height: 0, opacity: 0 }} animate={{ height: 'auto', opacity: 1 }} exit={{ height: 0, opacity: 0 }} className="mt-2 space-y-2 overflow-hidden">
                      {passed.map((s) => <ScoreRow key={s.evaluator_id} s={s} heuristic={heuristic} />)}
                    </motion.ul>
                  )}
                </AnimatePresence>
              </div>
            )}
          </Card>
          <Card title="Execution trace">{tr.trace ? <TraceViewer spans={tr.trace.spans} /> : <p className="text-sm text-ink-3">No trace stored.</p>}</Card>
        </div>

        <div className="space-y-5">
          <Card title="Telemetry">
            <dl className="grid grid-cols-2 gap-y-1 text-sm">
              <dt className="text-ink-3">Latency</dt><dd className="num text-right">{ms(tr.latency_ms)}</dd>
              <dt className="text-ink-3">Tokens</dt><dd className="num text-right">{num(tr.total_tokens)}</dd>
              <dt className="text-ink-3">Bot cost (est.)</dt><dd className="num text-right">{usd(tr.target_cost_usd)}</dd>
              <dt className="text-ink-3">Grading cost (est.)</dt><dd className="num text-right">{graded || tr.judge_cost_usd != null ? usd(tr.judge_cost_usd) : <span title="No grading model was asked about this answer">$0, no grading model</span>}</dd>
              <dt className="text-ink-3">Attempts</dt><dd className="num text-right">{tr.attempts}</dd>
            </dl>
          </Card>
          <Card title={`Retrieved documents${r?.retrieved_documents ? ` (${r.retrieved_documents.length})` : ''}`} padded={!r?.retrieved_documents?.length}>
            {r?.retrieved_documents == null ? <p className="text-sm text-ink-3">Not reported by the bot.</p> : r.retrieved_documents.length === 0 ? <p className="text-sm text-ink-3">None.</p> : (
              <Table>
                <thead><tr><th>#</th><th>Source</th><th className="text-right">Score</th><th></th></tr></thead>
                <tbody>
                  {r.retrieved_documents.map((d, i) => <SourceRow key={`${d.id}-${i}`} d={d} i={i} expected={relevant.has(d.id)}
                    cited={d.n != null && citedN.size ? citedN.has(String(d.n)) : cited.has(d.id)} />)}
                  {[...relevant].filter((d) => !r.retrieved_documents!.some((x) => x.id === d)).map((d) => (
                    <tr key={`missing-${d}`}><td className="text-ink-3">-</td><td className="font-mono text-xs text-bad-ink">{d}</td><td></td><td><Badge tone="bad">expected, not retrieved</Badge></td></tr>
                  ))}
                </tbody>
              </Table>
            )}
          </Card>
          <Card title={`Tool calls${r?.tool_calls ? ` (${r.tool_calls.length})` : ''}`}>
            {r?.tool_calls == null ? <p className="text-sm text-ink-3">Not reported by the bot.</p> : r.tool_calls.length === 0 ? <p className="text-sm text-ink-3">No tools called.</p> : (
              <ol className="space-y-2">
                {r.tool_calls.map((tc, i) => (
                  <li key={i} className="rounded-md border border-line p-2 text-xs">
                    <div className="flex items-center gap-2"><span className="font-mono font-medium">{tc.name}</span><StatusBadge status={tc.status === 'success' ? 'pass' : 'error'} /></div>
                    <div className="mt-1 break-all font-mono text-ink-2">args {JSON.stringify(tc.arguments)}</div>
                    <div className="mt-0.5 break-all font-mono text-ink-3">result {JSON.stringify(tc.result)}</div>
                  </li>
                ))}
              </ol>
            )}
          </Card>
          {tr.cause && <CauseCard t={tr} />}
          <FailureAnnotation t={tr} />
          <Card title="Response" actions={<Segmented size="sm" value={rawTab} onChange={setRawTab} options={[{ id: 'normalized', label: 'As GaugeLab read it' }, { id: 'raw', label: 'Raw' }]} />}>
            <Json value={rawTab === 'raw' ? tr.raw : r} maxHeight={320} />
          </Card>
        </div>
      </div>
    </>
  )
}

function Verdict({ t, failing }: { t: TrialDetail; failing: Score[] }) {
  if (t.status === 'passed') {
    return (
      <motion.div initial={{ opacity: 0, y: -4 }} animate={{ opacity: 1, y: 0 }} className="flex items-center gap-3 rounded-xl border border-good/30 bg-good-wash px-4 py-3">
        <Check className="size-5 text-good-ink" /><div className="text-base font-medium text-good-ink">Passed every gating check.</div>
      </motion.div>
    )
  }
  return (
    <motion.div initial={{ opacity: 0, y: -4 }} animate={{ opacity: 1, y: 0 }} className="rounded-xl border border-bad/30 bg-bad-wash px-4 py-3" data-testid="trial-verdict">
      <div className="flex items-start gap-3">
        <CircleAlert className="mt-0.5 size-5 shrink-0 text-bad-ink" />
        <div className="min-w-0 space-y-1.5">
          <div className="text-base font-semibold text-bad-ink">
            {t.status === 'error' ? 'The bot did not answer.' : `Failed ${failing.length} check${failing.length === 1 ? '' : 's'}${t.failure_types.length ? `: ${t.failure_types.map((f) => FAILURE_LABELS[f] ?? f).join(', ').toLowerCase()}` : ''}.`}
          </div>
          {failing.map((s) => (
            <div key={s.evaluator_id} className="text-sm text-ink">
              <span className="font-mono text-xs font-medium">{s.evaluator_id}</span> - {s.explanation}
            </div>
          ))}
          {t.result?.error && <div className="text-sm">{t.result.error}</div>}
          {t.cause && (
            <div className="flex flex-wrap items-center gap-1.5 pt-0.5 text-sm">
              <span className="text-ink-2">Likely cause:</span><CauseBadge v={t.cause} />
              {t.cause.evidence[0] && <span className="text-ink-2">{t.cause.evidence[0]}</span>}
            </div>
          )}
        </div>
      </div>
    </motion.div>
  )
}

function Expectations({ c }: { c: NonNullable<TrialDetail['case']> }) {
  const e = c.expected
  const rows: [string, ReactNode][] = []
  if (e.answer.reference) rows.push(['Reference answer', e.answer.reference])
  if (e.answer.must_mention.length) rows.push(['Must mention', e.answer.must_mention.map((m) => <code key={m} className="mr-1 rounded bg-good-wash px-1 text-good-ink">{m}</code>)])
  if (e.answer.must_not_claim.length) rows.push(['Must not claim', e.answer.must_not_claim.map((m) => <code key={m} className="mr-1 rounded bg-bad-wash px-1 text-bad-ink">{m}</code>)])
  if (e.answer.regex.length) rows.push(['Must match', <PatternList key="re" patterns={e.answer.regex} tone="good" />])
  if (e.answer.forbidden_regex?.length) rows.push(['Must not match', <PatternList key="fre" patterns={e.answer.forbidden_regex} tone="bad" />])
  if (e.answer.exact) rows.push(['Exact answer', e.answer.exact])
  if (Number(e.min_citations ?? 0) > 0) rows.push(['Citations', `at least ${Number(e.min_citations)}`])
  if (e.relevant_documents.length) rows.push(['Documents needed', e.relevant_documents.join(', ')])
  if (e.required_tools.length) rows.push(['Required tools', e.required_tools.join(', ')])
  if (e.tool_calls.length) rows.push(['Expected calls', e.tool_calls.map((t) => `${t.name}(${JSON.stringify(t.arguments)})`).join('; ')])
  if (Object.keys(e.expected_outcome).length) rows.push(['Expected outcome', JSON.stringify(e.expected_outcome)])
  if (e.refusal_expected != null) rows.push(['Should decline', e.refusal_expected ? 'yes' : 'no'])
  if (c.description) rows.push(['Note', c.description])
  return (
    <div>
      <div className="mb-1 text-xs font-medium text-ink-3">Expected (written or approved by a person)</div>
      {!rows.length ? <p className="text-xs text-ink-3">No expected outcomes: only black-box checks apply.</p> : (
        <dl className="space-y-2 rounded-lg border border-line px-3 py-2.5 text-sm">
          {rows.map(([k, v]) => <div key={k}><dt className="text-xs text-ink-3">{k}</dt><dd>{v}</dd></div>)}
        </dl>
      )}
    </div>
  )
}

function PatternList({ patterns, tone }: { patterns: string[]; tone: 'good' | 'bad' }) {
  return (
    <ul className="space-y-0.5">
      {patterns.map((p) => {
        const plain = describePattern(p)
        return (
          <li key={p}>
            {plain ? <span>{plain}</span> : null}
            <code className={clsx('block break-all rounded px-1 font-mono text-label', plain ? 'text-ink-3' : tone === 'good' ? 'bg-good-wash text-good-ink' : 'bg-bad-wash text-bad-ink')}>{p}</code>
          </li>
        )
      })}
    </ul>
  )
}

type Source = NonNullable<NonNullable<TrialDetail['result']>['retrieved_documents']>[number]

function SourceRow({ d, i, expected, cited }: { d: Source; i: number; expected: boolean; cited: boolean }) {
  const [open, setOpen] = useState(false)
  const where = d.label ?? (d.page != null ? `p. ${d.page}` : null)
  return (
    <>
      <tr className={clsx(d.text && 'cursor-pointer hover:bg-surface-2/60')} onClick={() => d.text && setOpen((v) => !v)}>
        <td className="num align-top text-ink-3">{d.n ?? i + 1}</td>
        <td className="align-top">
          <div className="flex items-start gap-1">
            {d.text && <ChevronRight className={clsx('mt-0.5 size-3.5 shrink-0 text-ink-3 transition-transform', open && 'rotate-90')} />}
            <span className="min-w-0">
              <span className="block text-xs font-medium">{d.title ?? d.id}</span>
              <span className="block font-mono text-label text-ink-3">{where ? `${where} - ` : ''}{d.id}{d.date ? ` - ${d.date}` : ''}</span>
            </span>
          </div>
        </td>
        <td className="num text-right align-top text-xs">{d.score != null ? (Math.abs(d.score) >= 10 ? d.score.toFixed(1) : d.score.toFixed(3)) : '-'}</td>
        <td className="space-x-1 whitespace-nowrap align-top">{expected && <Badge tone="good">expected</Badge>}{cited && <Badge tone="accent">cited</Badge>}</td>
      </tr>
      {open && d.text && <tr><td /><td colSpan={3}><div className="max-h-48 overflow-auto whitespace-pre-wrap rounded-md bg-surface-2/60 p-2 text-xs text-ink-2">{d.text}</div></td></tr>}
    </>
  )
}

function ScoreRow({ s, heuristic }: { s: Score; heuristic: boolean }) {
  const judge = s.kind === 'llm_judge'
  const bad = s.status === 'fail' || s.status === 'error'
  return (
    <li className={clsx('rounded-lg border px-3 py-2', bad ? (s.gating ? 'border-bad/40 bg-bad-wash/30' : 'border-warn/40') : 'border-line', heuristic && judge && 'hatched')}>
      <div className="flex flex-wrap items-center gap-2">
        <StatusBadge status={s.status} />
        <span className="text-sm font-medium">{s.evaluator_id}</span>
        <Badge>{s.kind === 'llm_judge' ? (heuristic ? 'heuristic judge' : 'grading model') : s.kind}</Badge>
        {!s.gating && <span className="text-xs text-ink-3"><Term k="gating">diagnostic</Term></span>}
        {s.failure_type && bad && <Badge tone="bad">{FAILURE_LABELS[s.failure_type] ?? s.failure_type}</Badge>}
        {s.score != null && <span className="num ml-auto text-xs text-ink-3">{judge ? 'confidence' : 'score'} {s.score.toFixed(2)}{s.threshold != null && ` / needs ${s.threshold}`}</span>}
      </div>
      <p className="mt-1 text-sm text-ink-2">{s.explanation}</p>
      {s.evidence.length > 0 && <div className="mt-1 flex flex-wrap gap-1">{s.evidence.slice(0, 8).map((e, i) => <code key={i} className="rounded bg-surface-2 px-1 text-xs">{e}</code>)}</div>}
      {judge && s.metadata?.model != null && (
        <div className="mt-1 font-mono text-label text-ink-3">
          {String(s.metadata.provider)}/{String(s.metadata.model)} - rubric v{String(s.metadata.rubric_version)} - prompt {String(s.metadata.prompt_hash)}{s.judge_cost_usd != null && ` - ${usd(s.judge_cost_usd)}`}
        </div>
      )}
    </li>
  )
}

const GROUPS: { label: string; types: string[] }[] = [
  { label: 'Retrieval', types: ['retrieval_miss'] },
  { label: 'Tools', types: ['incorrect_tool', 'incorrect_tool_arguments', 'unnecessary_tool', 'tool_result_misused'] },
  { label: 'Answer', types: ['wrong_answer', 'incomplete_response', 'should_have_refused', 'malformed_output'] },
  { label: 'Grounding', types: ['unsupported_claim', 'citation_error'] },
  { label: 'Other', types: ['latency_regression', 'cost_regression', 'judge_disagreement', 'execution_error', 'unknown'] },
]

function FailureAnnotation({ t }: { t: TrialDetail }) {
  const qc = useQueryClient()
  const [editing, setEditing] = useState(false)
  const [sel, setSel] = useState<string[]>(t.failure_types)
  const [note, setNote] = useState(t.failure_note)
  const save = useMutation({
    mutationFn: (clear: boolean) => api.put(`/api/trials/${t.id}/failure`, { failure_types: clear ? null : sel, note }),
    onSuccess: () => { qc.invalidateQueries({ queryKey: ['trial', t.id] }); qc.invalidateQueries({ queryKey: ['run', String(t.run_id)] }); setEditing(false) },
  })
  return (
    <Card title="Kind of failure" actions={<>{t.failure_override ? <Badge tone="info">set by you</Badge> : <Badge>automatic</Badge>}{!editing && <Button size="sm" variant="ghost" onClick={() => setEditing(true)}><Pencil className="size-3.5" />Change</Button>}</>}>
      {!editing ? (
        <div className="space-y-1.5">
          {t.failure_types.length ? <div className="flex flex-wrap gap-1">{t.failure_types.map((f) => <Badge key={f} tone="bad">{FAILURE_LABELS[f] ?? f}</Badge>)}</div> : <p className="text-sm text-ink-3">None.</p>}
          {t.failure_note && <p className="text-xs text-ink-2">Your note: {t.failure_note}</p>}
          <Explain>Classified automatically from the failing checks. Change it when you know better - run summaries count your classification.</Explain>
        </div>
      ) : (
        <div className="space-y-3">
          {GROUPS.map((g) => (
            <fieldset key={g.label}>
              <legend className="mb-1 text-label font-medium uppercase tracking-wide text-ink-3">{g.label}</legend>
              <div className="flex flex-wrap gap-1">
                {g.types.map((ft) => (
                  <button key={ft} type="button" aria-pressed={sel.includes(ft)} onClick={() => setSel((s) => (s.includes(ft) ? s.filter((x) => x !== ft) : [...s, ft]))}
                    className={clsx('rounded-md border px-2 py-0.5 text-xs transition-colors', sel.includes(ft) ? 'border-bad/50 bg-bad-wash text-bad-ink' : 'border-line text-ink-2 hover:bg-surface-2')}>
                    {sel.includes(ft) && <Check className="mr-0.5 inline size-3" />}{FAILURE_LABELS[ft] ?? ft}
                  </button>
                ))}
              </div>
            </fieldset>
          ))}
          <Field label="Why (optional)"><Input value={note} onChange={(e) => setNote(e.target.value)} placeholder="e.g. the reference answer is outdated" /></Field>
          {save.isError && <ErrorState error={save.error} />}
          <div className="flex gap-2">
            <Button size="sm" variant="primary" loading={save.isPending} onClick={() => save.mutate(false)}>Save</Button>
            {t.failure_override && <Button size="sm" variant="ghost" onClick={() => save.mutate(true)}>Back to automatic</Button>}
            <Button size="sm" variant="ghost" onClick={() => setEditing(false)}>Cancel</Button>
          </div>
        </div>
      )}
    </Card>
  )
}
