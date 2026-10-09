// Why answers failed, and what to change in the bot: the "What to fix first" list of a run, the
// cause of one answer (with a person's override and a grading model's explanation), what a change
// fixed and broke, a person's notes grouped into themes, and how a connection reads replies.
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import clsx from 'clsx'
import { ArrowRight, BookOpenCheck, Check, Eye, Pencil, Sparkles, Wand2 } from 'lucide-react'
import { motion } from 'motion/react'
import { useState } from 'react'
import { Link } from 'react-router-dom'
import { api } from '../lib/api'
import { useSettings } from '../lib/projects'
import { pct, when } from '../lib/format'
import type { CauseCount, ProviderConfig, RunCauses, TrialDetail, Verdict } from '../lib/types'
import { causeColor, SampleSize } from './instrument'
import { Badge, Button, Card, ErrorState, Field, Help, Notice, ProgressBar, Select } from './ui'
import { Capabilities } from '../pages/Connect'

/** Every cause, in the order the server ranks them (assay/diagnosis.py CAUSES). */
export const CAUSE_LABELS: Record<string, string> = {
  search_missed: 'Search missed it',
  not_in_documents: 'Not in the documents',
  model_missed: 'Found but not used',
  bad_source: 'Read a wrong or outdated passage',
  made_up: 'Made up',
  wrong_citation: 'Cited the wrong source',
  answered_out_of_scope: 'Answered when it should decline',
  tool_problem: 'Wrong tool use',
  format: 'Wrong format',
  too_slow: 'Too slow or too costly',
  bot_error: 'The bot returned an error',
  too_busy: 'Bot too busy (rate limit or time-out)',
  suspect_test: 'Suspect test',
  off_topic: 'Written for another chatbot',
  cant_tell: "Can't tell yet",
}

const KIND_TONE: Record<Verdict['kind'], 'bad' | 'warn' | 'info' | 'neutral'> = { bot: 'bad', content: 'warn', test: 'info', run: 'info', unknown: 'neutral' }
const KIND_HEAD: Record<Verdict['kind'], string> = {
  bot: 'In the bot', content: 'In the documents', unknown: 'Not placed yet', test: 'Not the bot: the test itself', run: 'Not the bot: how the run was set up',
}

export function useRunCauses(runId: number | undefined, enabled = true) {
  return useQuery({ queryKey: ['causes', runId], queryFn: () => api.get<RunCauses>(`/api/runs/${runId}/causes`), enabled: !!runId && enabled })
}

export function CauseBadge({ v, className }: { v: Pick<Verdict, 'label' | 'kind' | 'source'>; className?: string }) {
  return (
    <Badge tone={KIND_TONE[v.kind]} className={className} title={v.source === 'you' ? 'Set by you' : v.source === 'ai' ? 'Explained by a grading model' : 'Found by Assay\'s rules'}>
      {v.source === 'ai' && <Sparkles className="size-3" />}{v.source === 'you' && <Pencil className="size-3" />}{v.label}
    </Badge>
  )
}

export function CauseHelp() {
  return <Help title="How Assay finds the cause" wide><CauseHelpBody /></Help>
}

function CauseHelpBody() {
  return (
    <>
      <p>For each failed answer, Assay looks for what a correct answer needed (the must-mention phrases, the patterns, the reference answer's codes and numbers) in three places:</p>
      <ol className="mt-1.5 list-decimal space-y-1 pl-4">
        <li><b>In the answer</b>: missing, so the answer failed.</li>
        <li><b>In the passages the bot read</b>: there, so search worked and the model left it out: <i>Found but not used</i>.</li>
        <li><b>In the documents you uploaded</b>: there but not read: <i>Search missed it</i>. Nowhere: <i>Not in the documents</i>.</li>
      </ol>
      <p className="mt-1.5">It also flags answers that say what no passage says, citations that point at a passage without the fact, and questions that fail in every run (often the test, not the bot). Plain text matching, no model, so it costs nothing and shows its evidence. When the evidence does not decide it, it says <i>Can't tell yet</i>: you can ask a grading model, or set the cause yourself.</p>
      <p className="mt-1.5 text-ink-3">After Barnett et al., "Seven failure points when engineering a retrieval-augmented generation system" (2024).</p>
    </>
  )
}

/** "What to fix first": a run's failures counted by cause, largest first, each with its fix and examples. */
export function FixFirst({ runId, targetId, selected, onPick, compact = false }: {
  runId: number; targetId?: number | null; selected?: string | null; onPick?: (cause: string | null) => void; compact?: boolean
}) {
  const q = useRunCauses(runId)
  if (q.isLoading) return <Card title="What to fix first"><div className="skeleton h-24" /></Card>
  if (q.isError) return <Card title="What to fix first"><ErrorState error={q.error} /></Card>
  const d = q.data!
  if (!d?.causes?.length) return null
  const total = d.causes.reduce((a, c) => a + c.cases, 0)
  const max = Math.max(...d.causes.map((c) => c.cases))
  const kinds = new Set(d.causes.map((c) => c.kind))
  const groups = (['bot', 'content', 'unknown', 'test', 'run'] as const).map((k) => ({ k, rows: d.causes.filter((c) => c.kind === k).sort((a, b) => b.cases - a.cases) })).filter((g) => g.rows.length)
  return (
    <Card title="What to fix first" meta={<SampleSize n={total} min={0} unit={total === 1 ? 'question' : 'questions'} />}
      help={<>
        <p>Failing questions grouped by their likely cause, largest group first, with the change most likely to fix them. Each chip opens one example.{onPick ? ' Show lists only that cause\'s questions.' : ''}</p>
        <CauseHelpBody />
      </>}>
      <div data-testid="fix-first">
      {d.off_topic && (
        <div className="mb-3"><Notice tone="warn" title={`These questions were written for ${d.off_topic}`}>
          Their failures say nothing about this bot. Run this chatbot's own question set; New run now offers it first.
        </Notice></div>
      )}
      {!d.sources_reported && !d.off_topic && <SourcesNotice targetId={targetId} />}
      <div className="space-y-5">
        {groups.map((g) => (
          <section key={g.k}>
            {kinds.size > 1 && <div className="t-label mb-2">{KIND_HEAD[g.k]}</div>}
            <ul className="space-y-4">
              {g.rows.map((c, i) => (
                <CauseRow key={c.cause} c={c} max={max} delay={i * 0.04} compact={compact}
                  selected={selected === c.cause} onPick={onPick ? () => onPick(selected === c.cause ? null : c.cause) : undefined} />
              ))}
            </ul>
          </section>
        ))}
      </div>
      {d.unplaced.length > 0 && <ExplainAll runId={runId} ids={d.unplaced} />}
      </div>
    </Card>
  )
}

function CauseRow({ c, max, delay, onPick, selected, compact }: {
  c: CauseCount; max: number; delay: number; onPick?: () => void; selected: boolean; compact: boolean
}) {
  const col = causeColor(c.cause)
  const ex = compact ? c.examples.slice(0, 4) : c.examples
  return (
    <motion.li initial={{ opacity: 0, y: 3 }} animate={{ opacity: 1, y: 0 }} transition={{ delay }}
      className={clsx('rounded-lg', selected && 'bg-accent-wash/50 ring-1 ring-accent ring-offset-4 ring-offset-page')} data-cause={c.cause}>
      <div className="flex items-center gap-2">
        <span className="size-2 shrink-0 rounded-full" style={{ background: col }} />
        <span className="text-sm font-semibold">{c.label}</span>
        <span className="num font-mono text-xs text-ink-3">{c.cases}</span>
        <span className="h-1.5 max-w-56 flex-1 overflow-hidden rounded-full bg-surface-3">
          <motion.span className="block h-full rounded-full" style={{ background: col }}
            initial={{ width: 0 }} animate={{ width: `${(c.cases / max) * 100}%` }} transition={{ delay: delay + 0.1, duration: 0.5 }} />
        </span>
        {onPick && <Button size="sm" variant={selected ? 'primary' : 'ghost'} className="ml-auto" onClick={onPick}>{selected ? 'Showing' : 'Show'}</Button>}
      </div>
      {!compact && <p className="ml-4 mt-1 max-w-[640px] text-sm text-ink-2">{c.fix}</p>}
      <div className="ml-4 mt-1.5 flex flex-wrap items-center gap-1.5">
        {ex.map((e) => (
          <Link key={e.trial_id} to={`/trials/${e.trial_id}`} data-case={e.case_id} title={e.question || e.title}
            className="inline-flex h-6 items-center rounded-full border border-line-strong px-2.5 font-mono text-xs text-ink-2 hover:bg-surface-2">{e.case_id}</Link>
        ))}
        {c.cases > ex.length && <span className="text-xs text-ink-3">and {c.cases - ex.length} more</span>}
      </div>
    </motion.li>
  )
}

function SourcesNotice({ targetId }: { targetId?: number | null }) {
  return (
    <div className="mb-3">
      <Notice tone="info" title="Assay cannot see what the bot read"
        action={targetId ? <Link className="inline-flex h-7 items-center gap-1 rounded-md border border-line bg-surface px-2.5 text-xs font-medium hover:bg-surface-2" to={`/targets/${targetId}#reading`}>Check the connection<ArrowRight className="size-3" /></Link> : undefined}>
        This connection reads only the answer, so "search missed it" and "found but not used" cannot be told apart. If the bot sends its sources, let the connection read them, then re-read this run's replies (free: no questions are asked again).
      </Notice>
    </div>
  )
}

/** Ask the grading model about every failure the rules could not place, one call each. */
function ExplainAll({ runId, ids }: { runId: number; ids: number[] }) {
  const qc = useQueryClient()
  const settings = useSettings()
  const [done, setDone] = useState(0)
  const [running, setRunning] = useState(false)
  const [error, setError] = useState<unknown>(null)
  const hasJudge = !!settings.data?.values.default_judge && settings.data.values.default_judge.provider !== 'heuristic'
  const go = async () => {
    setRunning(true); setDone(0); setError(null)
    for (const id of ids) {
      try { await api.post(`/api/trials/${id}/explain`) } catch (e) { setError(e); break }
      setDone((n) => n + 1)
    }
    setRunning(false)
    qc.invalidateQueries({ queryKey: ['causes', runId] })
  }
  return (
    <div className="mt-4 rounded-lg bg-surface-2/60 p-3">
      <div className="flex flex-wrap items-center gap-2">
        <Wand2 className="size-4 text-accent-ink" />
        <span className="text-sm">{ids.length} failure{ids.length === 1 ? '' : 's'} not placed by the rules.</span>
        <Help title="Ask the grading model">{hasJudge ? 'One short call per failure to your default grading model. It picks a cause and says why in a sentence; you can change it on the answer\'s page.' : 'Set a default grading model in Settings > Models & keys first.'}</Help>
        <Button size="sm" className="ml-auto" disabled={!hasJudge} loading={running} onClick={go}>Ask the grading model ({ids.length} call{ids.length === 1 ? '' : 's'})</Button>
      </div>
      {running && <ProgressBar value={done / ids.length} className="mt-2" />}
      {error != null && <div className="mt-2"><ErrorState error={error} /></div>}
    </div>
  )
}

/** The cause of one failed answer: the verdict, its evidence, the fix, and a way to correct it. */
export function CauseCard({ t }: { t: TrialDetail }) {
  const qc = useQueryClient()
  const [editing, setEditing] = useState(false)
  const v = t.cause
  const refresh = () => { qc.invalidateQueries({ queryKey: ['trial', t.id] }); qc.invalidateQueries({ queryKey: ['causes', t.run_id] }) }
  const set = useMutation({ mutationFn: (cause: string | null) => api.put(`/api/trials/${t.id}/cause`, { cause }), onSuccess: () => { refresh(); setEditing(false) }, meta: { silent: true } })
  const ask = useMutation({ mutationFn: () => api.post(`/api/trials/${t.id}/explain`), onSuccess: refresh, meta: { silent: true } })
  if (!v) return null
  const ruleSaid = v.rule ?? v.cause
  return (
    <Card title="Why it failed" help={<CauseHelpBody />}
      actions={!editing && <Button size="sm" variant="ghost" onClick={() => setEditing(true)}><Pencil className="size-3.5" />Change</Button>}>
      <div className="space-y-2" data-testid="cause-card">
        <div className="flex flex-wrap items-center gap-1.5">
          <CauseBadge v={v} />
          <span className="text-label text-ink-3">{v.source === 'you' ? 'set by you' : v.source === 'ai' ? `explained by ${v.model ?? 'a grading model'}${v.confidence ? `, ${v.confidence} confidence` : ''}` : 'found by the rules'}</span>
        </div>
        {v.evidence.length > 0 && (
          <ul className="space-y-1 text-sm">
            {v.evidence.map((e, i) => <li key={i} className="flex gap-1.5"><Eye className="mt-0.5 size-3.5 shrink-0 text-ink-3" /><span>{e}</span></li>)}
          </ul>
        )}
        <div className="rounded-lg bg-surface-2/60 px-3 py-2 text-sm"><span className="font-medium">What to change: </span>{v.fix}</div>
        {ruleSaid === 'cant_tell' && v.source === 'rule' && (
          <Button size="sm" loading={ask.isPending} onClick={() => ask.mutate()}><Sparkles className="size-3.5" />Ask the grading model why (1 call)</Button>
        )}
        {ask.isError && <ErrorState error={ask.error} />}
        {editing && (
          <div className="space-y-2 rounded-lg border border-line p-3">
            <Field label={<span className="inline-flex items-center gap-1.5">Cause <Help title="Your choice counts">Run summaries and comparisons count your choice.</Help></span>}>
              <Select defaultValue={v.cause} disabled={set.isPending} onChange={(e) => set.mutate(e.target.value)} aria-label="Cause">
                {Object.entries(CAUSE_LABELS).map(([id, label]) => <option key={id} value={id}>{label}</option>)}
              </Select>
            </Field>
            {set.isError && <ErrorState error={set.error} />}
            <div className="flex gap-2">
              {v.source === 'you' && <Button size="sm" variant="ghost" loading={set.isPending} onClick={() => set.mutate(null)}>Back to automatic</Button>}
              <Button size="sm" variant="ghost" onClick={() => setEditing(false)}>Close</Button>
            </div>
          </div>
        )}
      </div>
    </Card>
  )
}

/** What a change fixed (the old causes of questions that now pass) and broke (the new causes). */
export function CompareCauses({ fixed, broke, baseline, candidate }: { fixed: CauseCount[]; broke: CauseCount[]; baseline: number; candidate: number }) {
  if (!fixed.length && !broke.length) return null
  const list = (rows: CauseCount[], tone: 'good' | 'bad', empty: string) => rows.length === 0 ? <p className="text-sm text-ink-3">{empty}</p> : (
    <ul className="space-y-1.5">
      {rows.map((c) => (
        <li key={c.cause} className="text-sm">
          <div className="flex items-center gap-2"><Badge tone={tone}>{c.cases}</Badge><span className="font-medium">{c.label}</span></div>
          <div className="mt-0.5 pl-1 text-xs text-ink-3">{c.examples.map((e, i) => <span key={e.trial_id}>{i > 0 && ', '}<Link className="font-mono hover:underline" to={`/trials/${e.trial_id}`}>{e.case_id}</Link></span>)}</div>
        </li>
      ))}
    </ul>
  )
  return (
    <Card title="By cause" help={<><p>Did the change fix what you meant it to? Fixed lists why the newly passing questions failed before; Broke lists why the newly failing ones fail now.</p><CauseHelpBody /></>}>
      <div data-testid="compare-causes">
      <div className="grid gap-5 md:grid-cols-2">
        <div><div className="mb-1.5 text-xs font-medium text-good-ink">Fixed: why they failed in #{baseline}</div>{list(fixed, 'good', 'Nothing newly passing.')}</div>
        <div><div className="mb-1.5 text-xs font-medium text-bad-ink">Broke: why they fail in #{candidate}</div>{list(broke, 'bad', 'Nothing newly failing.')}</div>
      </div>
      </div>
    </Card>
  )
}

interface Note { trial_id: number; run_id: number; case_id: string; note: string }
interface Themes { themes: { name: string; items: Note[] }[]; method: string | null; notes: number }

/** Your notes on failed answers, grouped into themes and counted (open coding, then axial coding). */
export function NotesCard({ projectId }: { projectId: number }) {
  const notes = useQuery({ queryKey: ['notes', projectId], queryFn: () => api.get<Note[]>(`/api/projects/${projectId}/notes`) })
  const providers = useQuery({ queryKey: ['providers'], queryFn: () => api.get<ProviderConfig[]>('/api/providers') })
  const [model, setModel] = useState<string>('')
  const group = useMutation({ mutationFn: () => api.post<Themes>(`/api/projects/${projectId}/notes/group`, { provider_config_id: model ? Number(model) : null }) })
  const n = notes.data?.length ?? 0
  return (
    <Card title="Your notes on failures"
      help={<><p>Reading failures and writing one line on each ("ignores the plant", "too formal") finds problems no check was written for. Grouping the notes and counting them shows which problem is biggest: the practice evaluation teams call error analysis.</p>{n ? <p>{n} note{n === 1 ? '' : 's'} across this chatbot's runs.</p> : null}</>}
      meta={n ? `${n} note${n === 1 ? '' : 's'}` : undefined}>
      <div data-testid="notes-card">
      {notes.isLoading ? <div className="skeleton h-12" /> : n === 0 ? (
        <p className="text-sm text-ink-3">No notes yet. On a failed answer's page, use <b>Kind of failure &gt; Change &gt; Why</b> to write one line about what went wrong. Twenty or thirty notes are enough to group.</p>
      ) : (
        <>
          <div className="flex flex-wrap items-end gap-2">
            <Field label="Group with">
              <Select value={model} onChange={(e) => setModel(e.target.value)} aria-label="Group with" className="w-56">
                <option value="">Shared words (no model, free)</option>
                {(providers.data ?? []).map((p) => <option key={p.id} value={p.id}>{p.name} ({p.model})</option>)}
              </Select>
            </Field>
            <Button loading={group.isPending} onClick={() => group.mutate()}><BookOpenCheck className="size-3.5" />Group my notes</Button>
          </div>
          {group.isError && <div className="mt-2"><ErrorState error={group.error} /></div>}
          {group.data && (
            <ul className="mt-3 space-y-2">
              {group.data.themes.map((th, i) => (
                <motion.li key={th.name + i} initial={{ opacity: 0, y: 3 }} animate={{ opacity: 1, y: 0 }} transition={{ delay: i * 0.04 }} className="rounded-lg border border-line px-3 py-2">
                  <div className="flex items-center gap-2"><span className="text-sm font-medium">{th.name}</span><Badge>{th.items.length}</Badge><span className="num ml-auto text-xs text-ink-3">{pct(th.items.length / group.data!.notes, 0)}</span></div>
                  <ul className="mt-1 space-y-0.5">
                    {th.items.slice(0, 4).map((it) => <li key={it.trial_id} className="text-xs text-ink-2"><Link className="font-mono text-accent-ink hover:underline" to={`/trials/${it.trial_id}`}>{it.case_id}</Link> {it.note}</li>)}
                    {th.items.length > 4 && <li className="text-xs text-ink-3">and {th.items.length - 4} more</li>}
                  </ul>
                </motion.li>
              ))}
            </ul>
          )}
        </>
      )}
      </div>
    </Card>
  )
}

interface Caps { field: string; label: string; unlocks: string; mapped: boolean; received: boolean; count: number | null }
interface Reading {
  supported: boolean; current?: Record<string, unknown>; standard?: boolean; updated_at?: string | null; sample_trial_id?: number | null
  suggestion?: { mapping: Record<string, unknown>; reasons: Record<string, string> } | null
  current_caps?: Caps[]; suggested_caps?: Caps[]; same?: boolean
  runs?: { id: number; name: string; source: string; pass_rate: number | null; created_at: string | null }[]
}

/** How a connection reads each reply, what a stored reply shows it could read, and re-reading past runs. */
export function ReadingCard({ targetId }: { targetId: number }) {
  const qc = useQueryClient()
  const q = useQuery({ queryKey: ['reading', targetId], queryFn: () => api.get<Reading>(`/api/targets/${targetId}/reading`) })
  const save = useMutation({
    mutationFn: (response: Record<string, unknown>) => api.put(`/api/targets/${targetId}/reading`, { response }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['reading', targetId] }),
  })
  const [started, setStarted] = useState<Record<number, number>>({})
  const reread = useMutation({
    mutationFn: (runId: number) => api.post<{ id: number }>(`/api/runs/${runId}/reread`),
    onSuccess: (r, runId) => { setStarted((s) => ({ ...s, [runId]: r.id })); qc.invalidateQueries({ queryKey: ['runs'] }) },
  })
  const d = q.data
  if (!d || !d.supported) return null
  const gained = (d.suggested_caps ?? []).filter((c) => c.received && !(d.current_caps ?? []).find((x) => x.field === c.field)?.received)
  return (
    <Card id="reading" title="Reading the reply"
      help={<><p>What Assay takes from each reply. Each reply from the bot is read for its answer and, when the bot sends them, the passages it read, its citations, tool calls and token counts. The more Assay reads, the more checks can run and the more precisely it can say why an answer failed.</p><p>Changing this changes how Assay reads, not what is inside the bot, so it does not make a new version.</p></>}
      meta={d.updated_at ? `changed ${when(d.updated_at)}` : undefined}>
      {q.isLoading ? <div className="skeleton h-16" /> : (
        <div className="space-y-4">
          {d.standard ? <p className="text-sm text-ink-2">The bot replies in the Assay shape: everything it sends is read.</p> : (
            <div className="grid gap-4 md:grid-cols-2">
              <div><div className="mb-1 text-xs font-medium text-ink-3">Now</div><Capabilities caps={d.current_caps ?? []} /></div>
              {d.suggestion && !d.same && gained.length > 0 && (
                <div className="rounded-lg border border-accent/40 bg-accent-wash/40 p-3">
                  <div className="mb-1 flex items-center gap-1.5 text-xs font-medium text-accent-ink">The last stored reply also has <Help title="Where this comes from">Found in a reply already stored{d.sample_trial_id ? <> (<Link className="underline" to={`/trials/${d.sample_trial_id}`}>this one</Link>)</> : ''}; nothing is sent to the bot.</Help></div>
                  <Capabilities caps={(d.suggested_caps ?? []).filter((c) => gained.some((g) => g.field === c.field))} />
                  <Button className="mt-2" size="sm" variant="primary" loading={save.isPending} onClick={() => save.mutate(d.suggestion!.mapping)}><Check className="size-3.5" />Read these too</Button>
                </div>
              )}
            </div>
          )}
          {save.isError && <ErrorState error={save.error} />}
          {(d.runs ?? []).length > 0 && (
            <div>
              <div className="mb-1 flex items-center gap-1.5 text-xs font-medium text-ink-3">Read past runs again with the current reading <Help title="Re-reading is free">Free: the stored replies are read again and the checks that need no grading model run again. Grading-model verdicts are carried over, not asked again. Each re-read is a new run, so the original stays as it was.</Help></div>
              <ul className="space-y-1">
                {d.runs!.map((r) => (
                  <li key={r.id} className="flex items-center gap-2 text-sm">
                    <Link className="font-mono text-xs text-accent-ink hover:underline" to={`/runs/${r.id}`}>#{r.id}</Link>
                    <span className="min-w-0 flex-1 truncate">{r.name}{r.source === 'reevaluated' && <span className="text-ink-3"> (re-graded)</span>}</span>
                    <span className="num text-xs text-ink-3">{pct(r.pass_rate, 0)}</span>
                    {started[r.id] ? <Link className="text-xs font-medium text-accent-ink hover:underline" to={`/runs/${started[r.id]}`}>Open #{started[r.id]}</Link>
                      : <Button size="sm" variant="ghost" loading={reread.isPending && reread.variables === r.id} onClick={() => reread.mutate(r.id)}>Re-read</Button>}
                  </li>
                ))}
              </ul>
              {reread.isError && <div className="mt-2"><ErrorState error={reread.error} /></div>}
            </div>
          )}
        </div>
      )}
    </Card>
  )
}
