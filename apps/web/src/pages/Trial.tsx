import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import clsx from 'clsx'
import { Check, ChevronRight, Pencil, X } from 'lucide-react'
import { AnimatePresence, motion } from 'motion/react'
import { useCallback, useMemo, useState, type ReactNode } from 'react'
import { Link, useNavigate, useParams } from 'react-router-dom'
import { CauseCard } from '../components/Causes'
import { AddFailureToDataset } from '../components/Golden'
import { TraceViewer } from '../components/TraceViewer'
import { AnswerDiff, AnswerText } from '../components/trial/AnswerText'
import { resolverFor, Sources } from '../components/trial/Sources'
import { TracePlayback } from '../components/trial/TracePlayback'
import { Badge, Button, Card, ErrorState, Field, Figs, Help, Input, Json, Kbd, PageSkeleton, Segmented, Select, Stat, StatusBadge, Term } from '../components/ui'
import { api } from '../lib/api'
import { useCrumbs } from '../lib/crumbs'
import { FAILURE_LABELS, ms, num, usd } from '../lib/format'
import { useHotkey } from '../lib/hotkeys'
import { describePattern, groupByCase } from '../lib/trials'
import type { RunHeader, Score, TrialDetail, TrialRow } from '../lib/types'

const ORDER: Record<string, number> = { fail: 0, error: 1, unknown: 2, pass: 3, not_evaluated: 4, not_applicable: 5 }
const ANSWER_FAILURES = new Set(['wrong_answer', 'incomplete_response', 'should_have_refused', 'malformed_output', 'unsupported_claim', 'citation_error'])
const STAGE_OF: Record<string, string> = {
  retrieval_miss: 'retrieval', incorrect_tool: 'tools', incorrect_tool_arguments: 'tools', unnecessary_tool: 'tools', tool_result_misused: 'tools',
  wrong_answer: 'the answer', incomplete_response: 'the answer', should_have_refused: 'the answer', malformed_output: 'the answer',
  unsupported_claim: 'grounding', citation_error: 'grounding', latency_regression: 'speed', cost_regression: 'cost', execution_error: 'execution',
}

/** The answer with required phrases (green), forbidden ones (red) and citation markers marked. */
export function HighlightedAnswer({ text, good, bad }: { text: string; good: string[]; bad: string[] }) {
  return <AnswerText text={text} good={good} bad={bad} />
}

export function TrialPage() {
  const { id } = useParams()
  const nav = useNavigate()
  const q = useQuery({ queryKey: ['trial', Number(id)], queryFn: () => api.get<TrialDetail>(`/api/trials/${id}`) })
  const runTrials = useQuery({ queryKey: ['trials', q.data?.run_id, {}], queryFn: () => api.get<TrialRow[]>(`/api/runs/${q.data!.run_id}/trials`), enabled: !!q.data })
  const run = useQuery({ queryKey: ['run', String(q.data?.run_id)], queryFn: () => api.get<{ project_id: number | null; experiment: string; judge: { provider: string } | null }>(`/api/runs/${q.data!.run_id}`), enabled: !!q.data })
  const projects = useQuery({ queryKey: ['projects'], queryFn: () => api.get<{ id: number; name: string }[]>('/api/projects') })
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
  const step = (by: 1 | -1) => {
    const i = failingCases.findIndex((g) => g.case_id === t?.case_id)
    const next = failingCases[i < 0 ? (by > 0 ? 0 : failingCases.length - 1) : (i + by + failingCases.length) % failingCases.length]
    if (next?.firstFailing) nav(`/trials/${next.firstFailing.id}`, { viewTransition: true })
  }
  useHotkey(['j', 'shift+j'], () => step(1), failingCases.length > 0)
  useHotkey(['k', 'shift+k'], () => step(-1), failingCases.length > 0)

  if (q.isLoading) return <PageSkeleton />
  if (q.isError) return <ErrorState error={q.error} />
  return <TrialView key={t!.id} t={t!} heuristic={run.data?.judge?.provider === 'heuristic'} projectId={run.data?.project_id ?? null}
    failIdx={failingCases.findIndex((g) => g.case_id === t!.case_id)} failN={failingCases.length} onNext={() => step(1)} />
}

function TrialView({ t: tr, heuristic, projectId, failIdx, failN, onNext }: { t: TrialDetail; heuristic: boolean; projectId: number | null; failIdx: number; failN: number; onNext: () => void }) {
  const c = tr.case
  const r = tr.result
  const siblings = tr.sibling_trials
  const scores = [...tr.scores].sort((a, b) => (ORDER[a.status] ?? 9) - (ORDER[b.status] ?? 9))
  const failing = scores.filter((s) => (s.status === 'fail' || s.status === 'error') && s.gating)
  const answerFailed = tr.failure_types.some((f) => ANSWER_FAILURES.has(f))
  const mustMention = c?.expected.answer.must_mention ?? []
  const mustNot = c?.expected.answer.must_not_claim ?? []
  const answer = tr.answer ?? ''
  const missing = mustMention.filter((p) => !p.split('|').some((alt) => answer.toLowerCase().includes(alt.toLowerCase())))
  const docs = r?.retrieved_documents
  const resolve = useMemo(() => resolverFor(docs), [docs])
  const cited = useMemo(() => {
    const ids = new Set((r?.citations ?? []).map((x) => x.id))
    const ns = new Set((r?.citations ?? []).filter((x) => x.n != null).map((x) => String(x.n)))
    // Markers in the text count too, when the bot did not report its citations separately.
    for (const m of answer.matchAll(/\[([^\][]{1,120})\]/g)) for (const part of m[1].split(/\s*[,;]\s*/)) { const k = resolve(part); if (k) ids.add(k) }
    return (d: { id: string; n?: number | string }) => (d.n != null && ns.size ? ns.has(String(d.n)) : ids.has(d.id))
  }, [r, answer, resolve])
  const [lit, setLit] = useState<string | null>(null)
  const [retFrac, setRetFrac] = useState(1)
  const onRetrieval = useCallback((f: number) => setRetFrac(f), [])
  const hasTrace = !!tr.trace?.spans.length

  return (
    <>
      <header className="flex flex-wrap items-start justify-between gap-4">
        <div className="min-w-0">
          <div className="t-label">{[c?.category?.replace(/_/g, ' '), c?.difficulty].filter(Boolean).join(' · ')}{c?.category ? ' · ' : ''}run <span className="font-mono">#{tr.run_id}</span></div>
          <h1 className="t-title mt-1.5" style={{ viewTransitionName: `case-${tr.case_id}` }}>
            <span className="t-fig mr-3 align-middle text-accent-ink">{tr.case_id}</span>{c?.title ?? tr.title}
          </h1>
        </div>
        <div className="flex flex-wrap items-center gap-1.5">
          {(tr.status === 'failed' || tr.status === 'error') && tr.question && (
            <AddFailureToDataset projectId={projectId} question={tr.question} answer={answer} runId={tr.run_id} trialId={tr.id} reference={c?.expected.answer.reference} />
          )}
          {siblings.length > 1 && siblings.map((s) => (
            <Link key={s.id} to={`/trials/${s.id}`} title={`try ${s.trial_index + 1}: ${s.status} ([ and ] step between tries)`} aria-current={s.id === tr.id ? 'page' : undefined}
              className={clsx('inline-flex h-7 items-center gap-1.5 rounded-lg border px-2.5 text-xs transition-colors',
                s.id === tr.id ? 'border-accent/50 bg-accent-wash text-accent-ink' : 'border-line bg-surface text-ink-2 hover:border-line-strong')}>
              <span className={clsx('size-2 rounded-full', s.status === 'passed' ? 'bg-good' : s.status === 'error' ? 'bg-error' : 'bg-bad')} />try {s.trial_index + 1}
            </Link>
          ))}
          {failN > 0 && (
            <Button size="sm" onClick={onNext} title="Next failing question (J); previous: K">
              next failing{failIdx >= 0 && <span className="font-mono text-ink-3">{failIdx + 1}/{failN}</span>}<Kbd>J</Kbd>
            </Button>
          )}
        </div>
      </header>

      <Verdict t={tr} failing={failing} diag={scores.some((s) => (s.status === 'fail' || s.status === 'error') && !s.gating)} />

      <div className="mt-8 grid items-start gap-x-10 gap-y-10 xl:grid-cols-[minmax(0,7fr)_minmax(0,5fr)]">
        <div className="min-w-0 space-y-10">
          <AnswerBlock tr={tr} mustMention={mustMention} mustNot={mustNot} missing={missing} answerFailed={answerFailed} resolve={resolve} lit={lit} onLight={setLit} />
          <Card title="Expected" help={<p>Written or approved by a person, never inferred. The checks compare the answer with these.</p>}>
            {c ? <Expectations c={c} /> : <p className="text-sm text-ink-3">No expected outcomes stored.</p>}
          </Card>
        </div>
        <div className="min-w-0 space-y-10">
          <Sources docs={docs} relevant={c?.expected.relevant_documents ?? []} cited={cited} lit={lit} onLight={setLit} shown={hasTrace ? retFrac : 1} />
          <Checks scores={scores} heuristic={heuristic} />
        </div>
      </div>

      <div className="mt-12 space-y-12">
        {hasTrace ? <TracePlayback spans={tr.trace!.spans} answer={answer} onRetrieval={onRetrieval} />
          : <Card title="Replay the answer"><p className="text-sm text-ink-3">No trace stored for this answer. Bots that report their steps (search, model calls, tools) can be replayed here.</p></Card>}

        <div className="grid items-start gap-x-10 gap-y-12 xl:grid-cols-2">
          <div className="min-w-0 space-y-12">
            {tr.cause && <CauseCard t={tr} />}
            <FailureAnnotation t={tr} />
            {tr.annotations.length > 0 && (
              <Card title="Your labels" meta={tr.annotations.length} help={<p>Labels people gave this answer while checking the grading model (Judge trust). They are the reference the judge is measured against.</p>}>
                <ul className="divide-y divide-line">
                  {tr.annotations.map((a, i) => (
                    <li key={i} className="flex flex-wrap items-baseline gap-2 py-2 text-sm">
                      <span className="font-mono text-xs text-ink-3">{a.dimension}</span>
                      <Badge tone={/^(pass|yes|correct|good)/i.test(a.label) ? 'good' : /^(fail|no|wrong|bad)/i.test(a.label) ? 'bad' : 'neutral'}>{a.label}</Badge>
                      <span className="text-ink-2">{a.annotator}</span>
                      {a.note && <span className="w-full text-ink-2">{a.note}</span>}
                    </li>
                  ))}
                </ul>
              </Card>
            )}
            <ToolCalls r={r} />
          </div>
          <div className="min-w-0 space-y-12">
            <Telemetry tr={tr} />
            <Card title="Execution trace" help={<p>Every step the bot reported, with its timing. Click a step for its input, output, tokens and the passages or tool arguments it carried. The slowest step is marked.</p>}>
              {tr.trace ? <TraceViewer spans={tr.trace.spans} /> : <p className="text-sm text-ink-3">No trace stored.</p>}
            </Card>
            <RawResponse tr={tr} />
          </div>
        </div>
      </div>
    </>
  )
}

/** One verdict line, then the evidence once. */
function Verdict({ t, failing, diag }: { t: TrialDetail; failing: Score[]; diag: boolean }) {
  const passed = t.status === 'passed'
  const what = t.status === 'error' ? 'the bot did not answer'
    : t.cause ? t.cause.label.toLowerCase()
      : t.failure_types.length ? t.failure_types.map((f) => FAILURE_LABELS[f] ?? f).join(', ').toLowerCase()
        : `${failing.length} check${failing.length === 1 ? '' : 's'}`
  const evidence = passed ? null : (t.cause?.evidence[0] ?? failing[0]?.explanation ?? t.result?.error ?? null)
  return (
    <motion.div initial={{ opacity: 0, y: -4 }} animate={{ opacity: 1, y: 0 }} className="mt-4 max-w-[980px]" data-testid="trial-verdict">
      <p className={clsx('t-verdict', passed ? 'text-good-ink' : 'text-bad-ink')}>
        {passed ? (diag ? 'Passed every gating check.' : 'Passed every check.') : `Failed: ${what}.`}
      </p>
      {evidence && <p className="mt-1.5 text-lead text-ink-2">{evidence}</p>}
    </motion.div>
  )
}

/** E2 + E3: the question, the answer with linked citations, and the diff against another run. */
function AnswerBlock({ tr, mustMention, mustNot, missing, answerFailed, resolve, lit, onLight }: {
  tr: TrialDetail; mustMention: string[]; mustNot: string[]; missing: string[]; answerFailed: boolean
  resolve: (m: string) => string | null; lit: string | null; onLight: (k: string | null) => void
}) {
  const c = tr.case
  const r = tr.result
  const answer = tr.answer ?? ''
  const runs = useQuery({ queryKey: ['runs'], queryFn: () => api.get<RunHeader[]>('/api/runs?limit=300') })
  const me = runs.data?.find((x) => x.id === tr.run_id)
  // Other runs that asked the same questions: comparable ones first, nearest first.
  const options = useMemo(() => {
    if (!me) return []
    return (runs.data ?? [])
      .filter((x) => x.id !== me.id && (x.status === 'completed' || x.status === 'completed_with_errors') && x.dataset === me.dataset)
      .sort((a, b) => Number(b.comparability_key === me.comparability_key) - Number(a.comparability_key === me.comparability_key) || Math.abs(a.id - me.id) - Math.abs(b.id - me.id))
  }, [runs.data, me])
  const preferred = options.filter((x) => x.comparability_key === me?.comparability_key)
  const fallback = preferred.filter((x) => x.id < (me?.id ?? 0)).sort((a, b) => b.id - a.id)[0] ?? preferred[0] ?? options[0]
  const [pick, setPick] = useState<number | null>(null)
  const otherId = pick ?? fallback?.id ?? null
  const [mode, setMode] = useState<'answer' | 'diff'>('answer')
  const other = useQuery({ queryKey: ['trials', otherId, {}], queryFn: () => api.get<TrialRow[]>(`/api/runs/${otherId}/trials`), enabled: !!otherId })
  const otherTrial = other.data && (other.data.find((x) => x.case_id === tr.case_id && x.trial_index === tr.trial_index) ?? other.data.find((x) => x.case_id === tr.case_id))

  return (
    <section>
      <div className="t-label">Question</div>
      <p className="mt-1.5 text-lead text-ink">{c?.input.message ?? tr.question}</p>
      <div className="mt-6 flex flex-wrap items-center gap-2">
        <span className="t-label flex items-center gap-2">
          Answer{r?.provider?.model && <span className="font-mono normal-case tracking-normal">· {r.provider.model}</span>}
          <Help title="The answer">
            <p>Hover a citation chip to light the passage it came from, in "What the bot read"; hover a passage to light its citations. A dashed chip cites something the bot did not report reading.</p>
            <p>Phrases the question must mention are underlined green; phrases it must not claim are struck through in red.</p>
            <p>Diff shows what changed from another run's answer to the same question (the same try where it exists): removed words struck in red, added words in green.</p>
          </Help>
        </span>
        {otherId && (
          <span className="ml-auto flex items-center gap-2">
            <Segmented size="sm" value={mode} onChange={setMode} label="Answer view"
              options={[{ id: 'answer', label: 'This answer' }, { id: 'diff', label: <>Diff vs run <span className="font-mono">#{otherId}</span></> }]} />
            {mode === 'diff' && options.length > 1 && (
              <Select aria-label="Run to compare with" value={String(otherId)} onChange={(e) => setPick(Number(e.target.value))} className="h-7 w-auto text-xs">
                {options.map((o) => <option key={o.id} value={o.id}>#{o.id} {o.variant_label}{o.comparability_key === me?.comparability_key ? '' : ' (different setup)'}</option>)}
              </Select>
            )}
          </span>
        )}
      </div>
      <div className="mt-2 whitespace-pre-wrap text-lead leading-relaxed text-ink" data-testid="answer">
        {mode === 'diff' && otherId ? (
          other.isLoading ? <div className="skeleton h-20" /> : !otherTrial ? <p className="text-sm text-ink-3">Run #{otherId} did not ask this question.</p> : (
            <>
              <div className="mb-2 flex flex-wrap items-center gap-x-3 text-xs text-ink-3" data-testid="diff-legend">
                <span><span className="rounded-[3px] bg-bad-wash px-1 text-bad-ink line-through">removed</span> from run <Link className="font-mono text-accent-ink hover:underline" to={`/trials/${otherTrial.id}`}>#{otherId}</Link> (try {otherTrial.trial_index + 1}, {otherTrial.status})</span>
                <span><span className="rounded-[3px] bg-good-wash px-1 text-good-ink">added</span> in this answer</span>
              </div>
              <AnswerDiff from={otherTrial.answer ?? ''} to={answer} />
            </>
          )
        ) : answer ? <AnswerText text={answer} good={mustMention} bad={mustNot} resolve={resolve} lit={lit} onLight={onLight} /> : <span className="text-ink-3">(empty)</span>}
      </div>
      <div className="mt-3 space-y-1 text-sm">
        {mustMention.length > 0 && (missing.length
          ? <p className="text-bad-ink">Missing: {missing.map((m, i) => <span key={m}>{i > 0 && ', '}<b className="font-semibold">{m.split('|').join(' or ')}</b></span>)}</p>
          : <p><span className="text-good-ink">Every must-mention phrase is there</span> <span className="text-ink-3">(underlined)</span></p>)}
        {tr.status !== 'passed' && !answerFailed && tr.failure_types.length > 0 && (
          <p className="text-ink-2">The answer text itself was not marked wrong: the failure is in {[...new Set(tr.failure_types.map((f) => STAGE_OF[f] ?? f))].join(' and ')}.</p>
        )}
        {r?.error && <p className="text-bad-ink">Bot error: {r.error}</p>}
      </div>
    </section>
  )
}

function Expectations({ c }: { c: NonNullable<TrialDetail['case']> }) {
  const e = c.expected
  const chip = (m: string, tone: 'good' | 'bad' | 'plain') => (
    <span key={m} className={clsx('mb-1 mr-1 inline-block rounded-full border px-2 font-mono text-xs leading-5',
      tone === 'good' ? 'border-good/40 bg-good-wash text-good-ink' : tone === 'bad' ? 'border-bad/40 bg-bad-wash text-bad-ink' : 'border-line-strong text-ink-2')}>{m}</span>
  )
  const rows: [string, ReactNode][] = []
  if (e.answer.reference) rows.push(['Reference answer', <span key="r" className="text-sm text-ink">{e.answer.reference}</span>])
  if (e.answer.must_mention.length) rows.push(['Must mention', e.answer.must_mention.map((m) => chip(m.split('|').join(' or '), 'good'))])
  if (e.answer.must_not_claim.length) rows.push(['Must not claim', e.answer.must_not_claim.map((m) => chip(m.split('|').join(' or '), 'bad'))])
  if (e.answer.regex.length) rows.push(['Must match', <PatternList key="re" patterns={e.answer.regex} tone="good" />])
  if (e.answer.forbidden_regex?.length) rows.push(['Must not match', <PatternList key="fre" patterns={e.answer.forbidden_regex} tone="bad" />])
  if (e.answer.exact) rows.push(['Exact answer', e.answer.exact])
  if (Number(e.min_citations ?? 0) > 0) rows.push(['Citations', <>at least <span className="font-mono">{Number(e.min_citations)}</span></>])
  if (e.relevant_documents.length) rows.push(['Documents needed', e.relevant_documents.map((d) => chip(d.split('|').join(' or '), 'plain'))])
  if (e.required_tools.length) rows.push(['Required tools', e.required_tools.map((d) => chip(d, 'plain'))])
  if (e.tool_calls.length) rows.push(['Expected calls', <span key="tc" className="break-all font-mono text-xs">{e.tool_calls.map((t) => `${t.name}(${JSON.stringify(t.arguments)})`).join('; ')}</span>])
  if (Object.keys(e.expected_outcome).length) rows.push(['Expected outcome', <span key="eo" className="break-all font-mono text-xs">{JSON.stringify(e.expected_outcome)}</span>])
  if (e.refusal_expected != null) rows.push(['Should decline', e.refusal_expected ? 'yes' : 'no'])
  if (c.description) rows.push(['Note', c.description])
  if (!rows.length) return <p className="text-sm text-ink-3">No expected outcomes: only black-box checks apply.</p>
  return (
    <dl className="grid gap-x-8 gap-y-4 sm:grid-cols-2" data-testid="expected">
      {rows.map(([k, v]) => <div key={k} className={clsx(k === 'Reference answer' && 'sm:row-span-2')}><dt className="t-label">{k}</dt><dd className="mt-1 text-sm text-ink-2">{v}</dd></div>)}
    </dl>
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
            <code className={clsx('block break-all rounded px-1 font-mono text-xs', plain ? 'text-ink-3' : tone === 'good' ? 'bg-good-wash text-good-ink' : 'bg-bad-wash text-bad-ink')}>{p}</code>
          </li>
        )
      })}
    </ul>
  )
}

/** Failures first with their reason; passes as small chips (hatched when the heuristic judged). */
function Checks({ scores, heuristic }: { scores: Score[]; heuristic: boolean }) {
  const [showNA, setShowNA] = useState(false)
  const [open, setOpen] = useState(false)
  const bad = scores.filter((s) => s.status === 'fail' || s.status === 'error')
  const passed = scores.filter((s) => s.status === 'pass')
  const na = scores.filter((s) => s.status === 'not_applicable')
  const other = scores.filter((s) => !['fail', 'error', 'pass', 'not_applicable'].includes(s.status))
  const heur = (s: Score) => heuristic && s.kind === 'llm_judge'
  return (
    <Card title="Every check" meta={<><span className={bad.length ? 'text-bad-ink' : undefined}>{bad.length} failed</span> · {passed.length} passed</>}
      help={<>
        <p>Every check run on this answer: failures first, with the reason. Passed checks are the small chips; open them for their scores and explanations.</p>
        <p>Hatched chips were scored by the word-overlap heuristic, not a model. A <Term k="gating">diagnostic</Term> check is reported but does not decide pass or fail.</p>
      </>}>
      <div className="space-y-2" data-testid="checks">
        {bad.map((s) => <ScoreRow key={s.evaluator_id} s={s} heuristic={heuristic} />)}
        {other.map((s) => <ScoreRow key={s.evaluator_id} s={s} heuristic={heuristic} />)}
        {passed.length > 0 && (
          <div className="flex flex-wrap gap-1 pt-1">
            {passed.map((s) => (
              <span key={s.evaluator_id} title={`${s.explanation}${heur(s) ? ' (heuristic judge)' : ''}`}
                className={clsx('inline-flex h-6 items-center gap-1 rounded-full border border-good/40 bg-good-wash px-2 font-mono text-xs text-good-ink', heur(s) && 'hatched')}>
                <Check className="size-3" />{s.evaluator_id}
              </span>
            ))}
          </div>
        )}
        <div className="flex flex-wrap items-center gap-4 pt-1 text-xs text-ink-2">
          {passed.length > 0 && (
            <button type="button" onClick={() => setOpen((v) => !v)} className="flex items-center gap-1 text-accent-ink hover:underline" aria-expanded={open}>
              <ChevronRight className={clsx('size-3.5 transition-transform', open && 'rotate-90')} />details of the passed checks
            </button>
          )}
          {na.length > 0 && (
            <label className="flex items-center gap-1.5"><input type="checkbox" className="accent-[var(--accent)]" checked={showNA} onChange={(e) => setShowNA(e.target.checked)} />show <span className="font-mono">{na.length}</span> not applicable</label>
          )}
        </div>
        <AnimatePresence initial={false}>
          {open && (
            <motion.div initial={{ height: 0, opacity: 0 }} animate={{ height: 'auto', opacity: 1 }} exit={{ height: 0, opacity: 0 }} className="space-y-2 overflow-hidden">
              {passed.map((s) => <ScoreRow key={s.evaluator_id} s={s} heuristic={heuristic} />)}
            </motion.div>
          )}
        </AnimatePresence>
        {showNA && na.map((s) => <ScoreRow key={s.evaluator_id} s={s} heuristic={heuristic} />)}
      </div>
    </Card>
  )
}

function ScoreRow({ s, heuristic }: { s: Score; heuristic: boolean }) {
  const judge = s.kind === 'llm_judge'
  const bad = s.status === 'fail' || s.status === 'error'
  return (
    <div className={clsx('rounded-r-lg border-l-[3px] px-3 py-2',
      bad ? (s.gating ? 'border-bad bg-bad-wash' : 'border-warn bg-warn-wash') : s.status === 'pass' ? 'border-good bg-surface-2' : 'border-line-strong bg-surface-2',
      heuristic && judge && 'hatched')}>
      <div className="flex flex-wrap items-center gap-2">
        <span className="font-mono text-sm font-medium text-ink">{s.evaluator_id}</span>
        {s.score != null && <span className="font-mono text-xs text-ink-3">{s.score.toFixed(2)}{s.threshold != null && ` / needs ${s.threshold}`}</span>}
        {!bad && s.status !== 'pass' && <StatusBadge status={s.status} />}
        {!s.gating && <span className="text-xs text-ink-3"><Term k="gating">diagnostic</Term></span>}
        {judge && <span className="text-xs text-ink-3">{heuristic ? 'heuristic judge' : 'grading model'}</span>}
        {s.failure_type && bad && <Badge tone="bad" className="ml-auto">{FAILURE_LABELS[s.failure_type] ?? s.failure_type}</Badge>}
      </div>
      <p className="mt-0.5 text-sm text-ink-2">{s.explanation}</p>
      {s.evidence.length > 0 && <div className="mt-1 flex flex-wrap gap-1">{s.evidence.slice(0, 8).map((e, i) => <code key={i} className="rounded bg-surface px-1 font-mono text-xs">{e}</code>)}</div>}
      {judge && s.metadata?.model != null && (
        <div className="mt-1 font-mono text-xs text-ink-3">
          {String(s.metadata.provider)}/{String(s.metadata.model)} · rubric v{String(s.metadata.rubric_version)} · prompt {String(s.metadata.prompt_hash)}{s.judge_cost_usd != null && ` · ${usd(s.judge_cost_usd)}`}
        </div>
      )}
    </div>
  )
}

function Telemetry({ tr }: { tr: TrialDetail }) {
  const graded = tr.scores.some((sc) => sc.kind === 'llm_judge' && !['not_applicable', 'not_evaluated'].includes(sc.status))
  return (
    <Card title="Telemetry" help={<p>What this one answer took. Costs are estimates from the token counts and the price list; the grading cost is what the grading model charged to check it.</p>}>
      <Figs>
        <Stat label="Latency" value={ms(tr.latency_ms)} />
        <Stat label="Tokens" value={num(tr.total_tokens)} />
        <Stat label="Attempts" value={tr.attempts} />
      </Figs>
      <Figs className="border-t-0">
        <Stat label="Bot cost (est.)" value={usd(tr.target_cost_usd)} />
        <Stat label="Grading cost (est.)" value={graded || tr.judge_cost_usd != null ? usd(tr.judge_cost_usd) : '$0'} title={graded ? undefined : 'No grading model was asked about this answer'} />
      </Figs>
    </Card>
  )
}

function ToolCalls({ r }: { r: TrialDetail['result'] }) {
  return (
    <Card title="Tool calls" meta={r?.tool_calls ? r.tool_calls.length : undefined}>
      {r?.tool_calls == null ? <p className="text-sm text-ink-3">The bot did not report tool calls.</p> : r.tool_calls.length === 0 ? <p className="text-sm text-ink-3">No tools called.</p> : (
        <ol className="space-y-2">
          {r.tool_calls.map((tc, i) => (
            <li key={i} className="rounded-lg border border-line p-2.5 text-xs">
              <div className="flex items-center gap-2"><span className="font-mono text-sm font-medium">{tc.name}</span><StatusBadge status={tc.status === 'success' ? 'pass' : 'error'} /></div>
              <div className="mt-1 break-all font-mono text-ink-2"><span className="font-sans text-ink-3">arguments </span>{JSON.stringify(tc.arguments)}</div>
              <div className="mt-0.5 break-all font-mono text-ink-3"><span className="font-sans">result </span>{JSON.stringify(tc.result)}</div>
            </li>
          ))}
        </ol>
      )}
    </Card>
  )
}

function RawResponse({ tr }: { tr: TrialDetail }) {
  const [rawTab, setRawTab] = useState<'normalized' | 'raw'>('normalized')
  return (
    <Card title="Response" help={<p>"As Assay read it" is the bot's response after the connector mapped it to answer, citations, passages and tools; "Raw" is exactly what the bot sent.</p>}
      actions={<Segmented size="sm" value={rawTab} onChange={setRawTab} options={[{ id: 'normalized', label: 'As Assay read it' }, { id: 'raw', label: 'Raw' }]} />}>
      <Json value={rawTab === 'raw' ? tr.raw : tr.result} maxHeight={320} />
    </Card>
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
    <Card title="Kind of failure"
      help={<p>Classified automatically from the failing checks. Change it when you know better: run summaries count your classification. Your note is kept with it.</p>}
      actions={<>{t.failure_override ? <Badge tone="info">set by you</Badge> : <Badge>automatic</Badge>}{!editing && <Button size="sm" variant="ghost" onClick={() => setEditing(true)}><Pencil className="size-3.5" />Change</Button>}</>}>
      {!editing ? (
        <div className="space-y-1.5">
          {t.failure_types.length ? <div className="flex flex-wrap gap-1">{t.failure_types.map((f) => <Badge key={f} tone="bad">{FAILURE_LABELS[f] ?? f}</Badge>)}</div> : <p className="text-sm text-ink-3">None.</p>}
          {t.failure_note && <p className="text-sm text-ink-2">Your note: {t.failure_note}</p>}
        </div>
      ) : (
        <div className="space-y-3">
          {GROUPS.map((g) => (
            <fieldset key={g.label}>
              <legend className="t-label mb-1">{g.label}</legend>
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
            {t.failure_override && <Button size="sm" variant="ghost" onClick={() => save.mutate(true)}><X className="size-3.5" />Back to automatic</Button>}
            <Button size="sm" variant="ghost" onClick={() => setEditing(false)}>Cancel</Button>
          </div>
        </div>
      )}
    </Card>
  )
}
