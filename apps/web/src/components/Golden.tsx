// Building datasets faster without lowering the bar: the machine types, a person vouches.
// Every question added here records where it came from and who approved it (metadata.provenance).
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { Check, ClipboardCopy, FileUp, Keyboard, ListChecks, MessageSquareQuote, Sparkles, ThumbsDown, ThumbsUp, Users, X } from 'lucide-react'
import { AnimatePresence, motion } from 'motion/react'
import { useDeferredValue, useMemo, useState } from 'react'
import { Link } from 'react-router-dom'
import { api } from '../lib/api'
import { fmtDay, plural } from '../lib/format'
import { usePrefs } from '../lib/prefs'
import type { Dataset, DatasetVersion, EditResult, Project, RunHeader, TestCase, TrialRow } from '../lib/types'
import { Badge, Button, Card, Dialog, Empty, ErrorState, Field, Help, Input, Kbd, Loading, Notice, PanelButton, ProgressBar, Select, Textarea } from './ui'
import { Checkbox, Chip, FileInput } from './form'
import { LabelHelp } from './LabelHelp'

// --------------------------------------------------------------------------------------
// Shared bits
// --------------------------------------------------------------------------------------

export interface Provenance { source?: string; drafted_by?: string; approved_by?: string; approved_at?: string; run_id?: number; trial_id?: number; file?: string }

const SOURCE_LABEL: Record<string, string> = {
  typed: 'Typed', import: 'Imported', 'approved-answer': 'Approved answer', 'corrected-answer': 'Corrected answer',
  'prompt-kit': 'Prompt kit', 'real-traffic': 'Real question', interview: 'Interview', 'failed-trial': 'From a failure',
  generated: 'AI-drafted', 'variation:typo': 'Typo variant', 'variation:paraphrase': 'Paraphrase', 'variation:zh': '中文', 'variation:ja': '日本語',
}

/** "AI-drafted, approved by Wen, 6 Oct": where a question came from and who vouched for it. */
export function ProvenanceBadge({ c, origin }: { c: TestCase; origin?: string }) {
  const p = (c.metadata?.provenance ?? null) as Provenance | null
  const src = p?.source ?? (c.metadata?.generated ? 'generated' : origin)
  if (!src) return null
  const label = SOURCE_LABEL[src] ?? src
  const who = p?.approved_by ? `approved by ${p.approved_by}${p.approved_at ? `, ${fmtDay(p.approved_at)}` : ''}` : ''
  const ai = p?.drafted_by?.startsWith('AI') || src === 'generated' || src === 'prompt-kit'
  return <Badge tone={ai && !p?.approved_by ? 'warn' : 'neutral'} title={[p?.drafted_by && `drafted by ${p.drafted_by}`, who, p?.file].filter(Boolean).join(' · ')}>{label}{who ? ' ✓' : ''}</Badge>
}

/** Suggested must-mention phrases for a text (codes, numbers, names), as toggleable chips. */
export function TermChips({ text, picked, onToggle, exclude = [] }: { text: string; picked: string[]; onToggle: (t: string) => void; exclude?: string[] }) {
  const deferred = useDeferredValue(text)
  const terms = useQuery({
    queryKey: ['suggest-terms', deferred], enabled: deferred.trim().length > 3,
    queryFn: () => api.post<{ terms: string[] }>('/api/suggest-terms', { text: deferred, limit: 10 }),
    staleTime: Infinity,
  })
  const list = (terms.data?.terms ?? []).filter((t) => !exclude.some((x) => x.toLowerCase() === t.toLowerCase()))
  if (!list.length) return null
  return (
    <div className="flex flex-wrap items-center gap-1.5">
      <span className="t-label">Suggested</span>
      {list.map((t) => (
        <Chip key={t} selected={picked.includes(t)} onClick={() => onToggle(t)} icon={picked.includes(t) ? <Check className="size-3" /> : undefined}>
          {picked.includes(t) ? '' : '+ '}{t}
        </Chip>
      ))}
    </div>
  )
}

const slug = (q: string) => q.toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_|_$/g, '').slice(0, 40) || 'case'

/** Adds a case to a version, following the draft when a frozen version branches. */
function useAddCase(versionId: number, onEdited: (r: EditResult) => void) {
  const qc = useQueryClient()
  // A frozen version branches into a draft on the first edit; keep adding to that draft.
  const [current, setCurrent] = useState(versionId)
  const target = Math.max(current, versionId)
  const add = useMutation({
    mutationFn: (c: Record<string, unknown>) => api.post<EditResult>(`/api/dataset-versions/${target}/cases`, c),
    onSuccess: (r) => {
      setCurrent(r.id)
      qc.invalidateQueries({ queryKey: ['dataset-version'] })
      qc.invalidateQueries({ queryKey: ['dataset'] })
      qc.invalidateQueries({ queryKey: ['datasets'] })
      onEdited(r)
    },
  })
  return add
}

function makeCase(question: string, existing: Set<string>, extra: { reference?: string; must_mention?: string[]; must_not_claim?: string[]; refusal?: boolean | null; provenance: Provenance; category?: string }) {
  let id = slug(question)
  for (let i = 2; existing.has(id); i++) id = `${slug(question)}_${i}`
  existing.add(id)
  return {
    id, title: question.slice(0, 120), category: extra.category ?? 'general',
    input: { message: question },
    expected: {
      answer: { reference: extra.reference || null, must_mention: extra.must_mention ?? [], must_not_claim: extra.must_not_claim ?? [] },
      refusal_expected: extra.refusal ?? null,
    },
    metadata: { provenance: { ...extra.provenance, approved_at: extra.provenance.approved_at ?? new Date().toISOString() } },
  }
}

// --------------------------------------------------------------------------------------
// The Build tab
// --------------------------------------------------------------------------------------

export function BuildPanel({ dataset, version, project, onEdited }: { dataset: Dataset; version: DatasetVersion; project?: Project; onEdited: (r: EditResult) => void }) {
  const [tool, setTool] = useState<'kit' | 'real' | 'interview' | null>(null)
  return (
    <div className="space-y-12">
      <div className="grid gap-12 xl:grid-cols-2">
        <CoverageCard versionId={version.id} />
        <ChecksCard versionId={version.id} />
      </div>
      <AnswerReview dataset={dataset} version={version} onEdited={onEdited} />
      <Card title="More ways to add questions" help={<p>Each one ends with a person vouching for every question. AI-drafted questions go to the review queue (Generate &amp; review) first.</p>}>
        <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
          <ToolTile icon={ClipboardCopy} title="Prompt kit" body="A ready prompt for your own ChatGPT or Claude, with your documents; the result lands in the review queue." onClick={() => setTool('kit')} />
          <ToolTile icon={MessageSquareQuote} title="Real questions" body="Upload chat history; near-identical questions are grouped by how often they were asked." onClick={() => setTool('real')} />
          <ToolTile icon={Keyboard} title="Expert interview" body="One question at a time: what must a right answer say, and never say? Keyboard only." onClick={() => setTool('interview')} />
          <PanelButton href="/api/datasets/template.csv">
            <Users className="size-4 text-accent-ink" />
            <div className="mt-1.5 text-sm font-semibold">Spreadsheet for colleagues</div>
            <div className="text-xs text-ink-2">A CSV template with examples, filled in Excel; import it on the Datasets page.</div>
          </PanelButton>
        </div>
      </Card>
      <Dialog open={tool === 'kit'} onClose={() => setTool(null)} title="Prompt kit: draft questions with your own chatbot" width={760}>
        <PromptKit dataset={dataset} project={project} />
      </Dialog>
      <Dialog open={tool === 'real'} onClose={() => setTool(null)} title="Real questions from chat history" width={720}>
        <RealQuestions version={version} onEdited={onEdited} />
      </Dialog>
      <Dialog open={tool === 'interview'} onClose={() => setTool(null)} title="Expert interview" width={640}>
        <Interview version={version} onEdited={onEdited} />
      </Dialog>
    </div>
  )
}

function ToolTile({ icon: Icon, title, body, onClick }: { icon: typeof Users; title: string; body: string; onClick: () => void }) {
  return (
    <PanelButton onClick={onClick}>
      <Icon className="size-4 text-accent-ink" />
      <div className="mt-1.5 text-sm font-semibold">{title}</div>
      <div className="text-xs text-ink-2">{body}</div>
    </PanelButton>
  )
}

// --------------------------------------------------------------------------------------
// Coverage and checks
// --------------------------------------------------------------------------------------

interface Coverage { total: number; kinds: { id: string; label: string; count: number; target: number }[]; categories: Record<string, number>; documents_without_cases?: string[] }

function CoverageCard({ versionId }: { versionId: number }) {
  const cov = useQuery({ queryKey: ['coverage', versionId], queryFn: () => api.get<Coverage>(`/api/dataset-versions/${versionId}/coverage`) })
  const c = cov.data
  return (
    <Card title="Coverage" meta={c ? plural(c.total, 'question') : undefined} help={<>
      <p>Kinds of question in this dataset, against a suggested mix{c ? ` for ${Math.max(20, c.total)} questions` : ''}.</p>
      <p>Kinds come from each question: “should decline” means a refusal; two or more needed documents, multi-source; a per-question field (region, product), specific; a tag “confusable”, easy to confuse.</p>
    </>}>
      {!c ? <Loading rows={3} /> : (
        <div className="space-y-2">
          {c.kinds.map((k) => (
            <div key={k.id} className="grid grid-cols-[minmax(0,1fr)_120px_60px] items-center gap-2 text-sm">
              <span>{k.label}</span>
              <ProgressBar value={Math.min(1, k.count / k.target)} tone={k.count >= k.target ? 'good' : 'accent'} />
              <span className="num text-right font-mono text-xs text-ink-2">{k.count}/{k.target}</span>
            </div>
          ))}
          {c.documents_without_cases && c.documents_without_cases.length > 0 && (
            <p className="text-xs text-warn-ink">No questions yet from: {c.documents_without_cases.slice(0, 6).join(', ')}{c.documents_without_cases.length > 6 ? ` and ${c.documents_without_cases.length - 6} more` : ''}.</p>
          )}
        </div>
      )}
    </Card>
  )
}

const ISSUE_LABEL: Record<string, string> = {
  duplicate: 'Duplicate', near_duplicate: 'Near duplicate', too_generic: 'Too generic', in_question: 'In the question',
  bad_pattern: 'Invalid pattern', match_all: 'Cannot fail', not_in_documents: 'Not in documents', no_expectations: 'No expectations', always_fails: 'Always fails',
}

export function ChecksCard({ versionId }: { versionId: number }) {
  const lint = useQuery({ queryKey: ['lint', versionId], queryFn: () => api.get<{ issues: { case_id: string; kind: string; message: string }[]; documents_checked: number }>(`/api/dataset-versions/${versionId}/lint`) })
  const issues = lint.data?.issues ?? []
  return (
    <Card title="Checks on this dataset" meta={lint.data ? `${issues.length}` : undefined} help={<>
      <p>Weak questions make a dataset look stricter (or kinder) than it is: duplicates, phrases too generic to test anything, patterns that cannot fail, questions that always fail. Click a question id to open it.</p>
      <p>Upload this chatbot’s documents (Generate &amp; review) to also check expectations against them.</p>
    </>}>
      {lint.isLoading ? <Loading rows={3} /> : issues.length === 0 ? <p className="text-sm text-good-ink"><Check className="mr-1 inline size-4" />No weak questions found.</p> : (
        <ul className="scroll-thin max-h-64 space-y-1.5 overflow-y-auto">
          {issues.map((i, k) => (
            <li key={k} data-case={i.case_id} className="flex items-start gap-2 text-sm">
              <Badge tone={i.kind === 'always_fails' || i.kind === 'match_all' || i.kind === 'bad_pattern' ? 'bad' : 'warn'}>{ISSUE_LABEL[i.kind] ?? i.kind}</Badge>
              <span><Link className="font-mono text-xs text-accent-ink underline" to={`?tab=cases&case=${encodeURIComponent(i.case_id)}`}>{i.case_id}</Link> {i.message}</span>
            </li>
          ))}
        </ul>
      )}
      {lint.data && !lint.data.documents_checked && <p className="mt-2 text-xs text-ink-2">Not checked against documents: none uploaded.</p>}
    </Card>
  )
}

// --------------------------------------------------------------------------------------
// Approve good answers: flashcards over a run's answers
// --------------------------------------------------------------------------------------

function AnswerReview({ dataset, version, onEdited }: { dataset: Dataset; version: DatasetVersion; onEdited: (r: EditResult) => void }) {
  const prefs = usePrefs()
  const runs = useQuery({ queryKey: ['runs'], queryFn: () => api.get<RunHeader[]>('/api/runs?limit=300') })
  const own = (runs.data ?? []).filter((r) => r.project_id === dataset.project_id && ['completed', 'completed_with_errors'].includes(r.status))
  const [runId, setRunId] = useState<number | ''>('')
  const rid = runId || own[0]?.id || ''
  const trials = useQuery({ queryKey: ['run-trials', rid], enabled: !!rid, queryFn: () => api.get<TrialRow[]>(`/api/runs/${rid}/trials`) })
  // Questions already in this set: those with expectations are done; those without (typed or real
  // questions) are exactly what needs reviewing, and a verdict fills in their expectations.
  const inSet = useMemo(() => new Map((version.cases ?? []).map((c) => [c.input.message.trim().toLowerCase(), c])), [version.cases])
  const ids = useMemo(() => new Set((version.cases ?? []).map((c) => c.id)), [version.cases])
  const cards = useMemo(() => {
    const seen = new Set<string>()
    return (trials.data ?? []).filter((t) => {
      if (!t.question || !t.answer || seen.has(t.case_id)) return false
      seen.add(t.case_id)
      const existing = inSet.get(t.question.trim().toLowerCase())
      return !existing || !hasExpectations(existing)
    })
  }, [trials.data, inSet])
  const [i, setI] = useState(0)
  const [mode, setMode] = useState<'judge' | 'right' | 'wrong'>('judge')
  const [chips, setChips] = useState<string[]>([])
  const [keepRef, setKeepRef] = useState(true)
  const [correction, setCorrection] = useState('')
  const [saved, setSaved] = useState(0)
  const add = useAddCase(version.id, onEdited)
  const card = cards[i]
  const existing = card?.question ? inSet.get(card.question.trim().toLowerCase()) : undefined
  const next = () => { setI((x) => x + 1); setMode('judge'); setChips([]); setCorrection(''); setKeepRef(true) }
  const toggle = (t: string) => setChips((c) => (c.includes(t) ? c.filter((x) => x !== t) : [...c, t]))
  const save = () => {
    if (!card?.question) return
    const right = mode === 'right'
    const built = makeCase(card.question, ids, {
      reference: right ? (keepRef ? card.answer : undefined) : correction,
      must_mention: chips,
      category: card.category ?? undefined,
      provenance: { source: right ? 'approved-answer' : 'corrected-answer', drafted_by: right ? 'the bot' : prefs.annotator || 'you', approved_by: prefs.annotator || 'you', run_id: card.run_id, trial_id: card.id },
    })
    const done = { onSuccess: () => { setSaved((n) => n + 1); next() } }
    if (existing) {
      // Fill in the expectations of the question already in the set (same id, its other fields kept).
      update.mutate({ ...existing, expected: { ...existing.expected, answer: { ...existing.expected.answer, ...built.expected.answer } }, metadata: { ...existing.metadata, ...built.metadata } }, done)
    } else add.mutate(built, done)
  }
  const update = useMutation({
    mutationFn: (c: TestCase) => api.put<EditResult>(`/api/dataset-versions/${version.id}/cases/${encodeURIComponent(c.id)}`, c),
    onSuccess: onEdited,
  })

  return (
    <Card title="Approve good answers"
      help={<>
        <p>Judging an answer takes seconds; writing one takes minutes. Mark the bot’s answers right or wrong, and keep what a correct answer must mention.</p>
        <p>A wrong answer with your one-line correction becomes a question the current bot fails: the most valuable kind. Keys: Y right, N wrong, S skip, Enter save.</p>
      </>}
      actions={own.length > 0 && (
        <Select className="w-64" value={rid} onChange={(e) => { setRunId(Number(e.target.value)); setI(0); setMode('judge') }} aria-label="Answers from run">
          {own.map((r) => <option key={r.id} value={r.id}>Run #{r.id} · {r.variant_label || r.experiment}</option>)}
        </Select>
      )}>
      {!own.length ? <Empty title="No answers to review yet">The bot has not spoken: run this chatbot once (any dataset), then come back, and its answers appear here as cards.</Empty>
        : trials.isLoading ? <Loading rows={3} />
        : !card ? <Notice tone="good" title={saved ? `${plural(saved, 'question')} saved` : 'Nothing left to review in this run'}>Every question in run #{rid} already has expectations in this dataset. Pick another run above.</Notice>
        : (
          <div onKeyDown={(e) => {
            if ((e.target as HTMLElement).tagName === 'TEXTAREA' || (e.target as HTMLElement).tagName === 'INPUT') return
            if (mode === 'judge' && e.key.toLowerCase() === 'y') setMode('right')
            if (mode === 'judge' && e.key.toLowerCase() === 'n') setMode('wrong')
            if (mode === 'judge' && e.key.toLowerCase() === 's') next()
            if (mode !== 'judge' && e.key === 'Enter') save()
          }} tabIndex={0} className="outline-none">
            <div className="mb-2 flex items-center justify-between text-xs text-ink-3"><span><span className="font-mono">{i + 1}</span> of <span className="font-mono">{cards.length}</span>{saved ? <> · <span className="font-mono">{saved}</span> added</> : ''}</span><span className="flex items-center gap-1"><Kbd>Y</Kbd> right <Kbd>N</Kbd> wrong <Kbd>S</Kbd> skip <Kbd>Enter</Kbd> save</span></div>
            <AnimatePresence mode="wait">
              <motion.div key={card.id} initial={{ opacity: 0, x: 12 }} animate={{ opacity: 1, x: 0 }} exit={{ opacity: 0, x: -12 }} transition={{ duration: 0.16 }} className="rounded-xl border border-line bg-surface-2/40 p-[var(--card-p)]">
                <div className="t-label">Question</div>
                <div className="mt-1 text-lead font-medium text-ink">{card.question}</div>
                <div className="t-label mt-3">The bot answered</div>
                <div className="scroll-thin max-h-56 overflow-y-auto whitespace-pre-wrap text-sm text-ink-2">{card.answer}</div>
              </motion.div>
            </AnimatePresence>
            {mode === 'judge' && (
              <div className="mt-3 flex gap-2">
                <Button onClick={() => setMode('right')}><ThumbsUp className="size-3.5 text-good-ink" />Right</Button>
                <Button onClick={() => setMode('wrong')}><ThumbsDown className="size-3.5 text-bad-ink" />Wrong</Button>
                <Button variant="ghost" onClick={next}>Skip</Button>
              </div>
            )}
            {mode === 'right' && (
              <div className="mt-3 space-y-2">
                <div className="text-sm font-medium">Which phrases must a correct answer contain?</div>
                <TermChips text={card.answer} picked={chips} onToggle={toggle} />
                <Checkbox checked={keepRef} onChange={setKeepRef} label="Keep this answer as the reference answer" />
                <div className="flex gap-2"><Button variant="primary" loading={add.isPending || update.isPending} onClick={save}><Check className="size-3.5" />{existing ? 'Save expectations' : 'Add question'}</Button><Button variant="ghost" onClick={() => setMode('judge')}>Back</Button></div>
              </div>
            )}
            {mode === 'wrong' && (
              <div className="mt-3 space-y-2">
                <Field label={<LabelHelp label="What should it have said? (one line)" title="Your correction"><p>This becomes a question the current bot fails: the most valuable kind.</p></LabelHelp>}>
                  <Textarea rows={2} className="font-sans text-sm" value={correction} autoFocus onChange={(e) => setCorrection(e.target.value)} onKeyDown={(e) => { if (e.key === 'Enter' && !e.shiftKey && correction.trim()) { e.preventDefault(); save() } }} />
                </Field>
                <TermChips text={correction} picked={chips} onToggle={toggle} />
                <div className="flex gap-2"><Button variant="primary" disabled={!correction.trim()} loading={add.isPending || update.isPending} onClick={save}><Check className="size-3.5" />{existing ? 'Save expectations' : 'Add question'}</Button><Button variant="ghost" onClick={() => setMode('judge')}>Back</Button></div>
              </div>
            )}
            {(add.isError || update.isError) && <div className="mt-2"><ErrorState error={add.error ?? update.error} /></div>}
          </div>
        )}
    </Card>
  )
}

// --------------------------------------------------------------------------------------
// Prompt kit
// --------------------------------------------------------------------------------------

export function buildPrompt({ bot, domain, docs, n, mix }: { bot: string; domain: string; docs: string[]; n: number; mix: Record<string, number> }) {
  const docLine = docs.length ? docs.map((d) => `- ${d}`).join('\n') : '- (the documents attached to this conversation)'
  return `You are helping me build a dataset of test questions for a chatbot called "${bot}".
${domain ? `It answers questions about: ${domain}.\n` : ''}It answers from these documents, which I have attached:
${docLine}

Your job: write ${n} questions. Each is a question a real user might ask, plus what a correct answer must contain. A person will review every question before it is used, so precision matters more than quantity.

Rules (follow all of them)
1. Use only the attached documents. If the documents do not state something, do not write a question about it. Never use outside knowledge.
2. For every answerable question, copy the exact sentence from the document that proves the answer into "evidence_quote", and give the document name and page or section in "source" and "source_page".
3. "Must mention" means short exact phrases a correct answer cannot avoid: codes (e.g. RMA-17), numbers with units, names, key terms. 1 to 4 phrases per question. Not whole sentences. Not common words like "the", "system" or "Acme". Do not repeat words that are already in the question.
4. Write the questions the way real users talk: short, sometimes informal, a few with small typos. Do not copy section headings.
5. Use this mix of kinds (category column):
${Object.entries(mix).map(([k, v]) => `   - ${v} x ${k}`).join('\n')}
   lookup = one fact from one passage; multi_source = needs facts from two places combined; specific = the answer depends on a region/product (name it in the question); refusal = a plausible question the documents do NOT answer, where the right response is to say so (leave must mention empty, set "Should refuse?" to yes); confusable = about one item that is easy to confuse with a similar one.
6. Self-check before you answer: for each question, confirm the evidence quote really contains every must-mention phrase. Drop any question that fails this check.

Output: a CSV only, no commentary, with exactly this header row:
Question,Must mention (comma-separated),Must never say,Should refuse? (yes/no),Correct answer (optional),Topic,evidence_quote,source,source_page

- Put the kind (lookup, multi_source, specific, refusal, confusable) in the Topic column.
- Wrap any value that contains a comma in double quotes.
- "Must never say" is for a tempting wrong answer (e.g. a similar code that does not apply); otherwise leave it empty.`
}

function PromptKit({ dataset, project }: { dataset: Dataset; project?: Project }) {
  const qc = useQueryClient()
  const docs = useQuery({ queryKey: ['docs', dataset.id], queryFn: () => api.get<{ id: number; filename: string }[]>(`/api/datasets/${dataset.id}/documents`) })
  const [domain, setDomain] = useState(project?.description ?? '')
  const [n, setN] = useState(20)
  const [copied, setCopied] = useState(false)
  const [file, setFile] = useState<File | null>(null)
  const mix = { lookup: Math.round(n * 0.4), multi_source: Math.round(n * 0.2), specific: Math.round(n * 0.15), refusal: Math.round(n * 0.15), confusable: n - Math.round(n * 0.4) - Math.round(n * 0.2) - Math.round(n * 0.15) * 2 }
  const prompt = buildPrompt({ bot: project?.name ?? dataset.name, domain, docs: (docs.data ?? []).map((d) => d.filename), n, mix })
  const upload = useMutation({
    mutationFn: () => { const fd = new FormData(); fd.set('file', file!); fd.set('source', 'prompt-kit'); return api.upload<{ created: number; notice: string }>(`/api/datasets/${dataset.id}/candidates/import`, fd) },
    onSuccess: () => { qc.invalidateQueries({ queryKey: ['candidates'] }); qc.invalidateQueries({ queryKey: ['dataset'] }) },
  })
  return (
    <div className="space-y-3">
      <ol className="list-decimal space-y-0.5 pl-5 text-sm text-ink-2">
        <li>Copy the prompt into your own ChatGPT or Claude (one your organisation allows), and attach the documents.</li>
        <li>Save its CSV answer as a file.</li>
        <li>Upload it below: the questions enter the <span className="font-semibold">review queue</span> as AI-drafted, and only those you approve join the dataset.</li>
      </ol>
      <div className="grid gap-3 md:grid-cols-[minmax(0,1fr)_120px]">
        <Field label="What the chatbot answers about"><Input value={domain} onChange={(e) => setDomain(e.target.value)} placeholder="e.g. orders, returns and warranty for Acme devices" /></Field>
        <Field label="Questions"><Select value={n} onChange={(e) => setN(Number(e.target.value))}>{[10, 20, 30, 50].map((x) => <option key={x}>{x}</option>)}</Select></Field>
      </div>
      <Textarea rows={12} readOnly value={prompt} aria-label="Prompt" />
      <div className="flex flex-wrap items-center gap-2">
        <Button variant="primary" onClick={() => { void navigator.clipboard?.writeText(prompt); setCopied(true) }}><ClipboardCopy className="size-3.5" />{copied ? 'Copied' : 'Copy the prompt'}</Button>
        <span className="text-xs text-ink-2">{(docs.data ?? []).length ? `Lists the ${plural((docs.data ?? []).length, 'document')} uploaded for this chatbot.` : 'No documents uploaded here: the prompt refers to the ones you attach.'}</span>
      </div>
      <div className="border-t border-line pt-3">
        <Field label="Upload the result (CSV, YAML or JSON)"><FileInput accept=".csv,.yaml,.yml,.json" aria-label="Drafted questions file" onFiles={(f) => setFile(f[0] ?? null)} /></Field>
        <Button className="mt-2" disabled={!file} loading={upload.isPending} onClick={() => upload.mutate()}><FileUp className="size-3.5" />Send to the review queue</Button>
        {upload.data && <div className="mt-2"><Notice tone="good" title={`${plural(upload.data.created, 'drafted question')} in the review queue`}>{upload.data.notice} Open <span className="font-semibold">Generate &amp; review</span> to go through them.</Notice></div>}
        {upload.isError && <div className="mt-2"><ErrorState error={upload.error} /></div>}
      </div>
    </div>
  )
}

// --------------------------------------------------------------------------------------
// Real questions and expert interview
// --------------------------------------------------------------------------------------

function RealQuestions({ version, onEdited }: { version: DatasetVersion; onEdited: (r: EditResult) => void }) {
  const prefs = usePrefs()
  const [picked, setPicked] = useState<string[]>([])
  const [done, setDone] = useState(0)
  const group = useMutation({ mutationFn: (f: File) => { const fd = new FormData(); fd.set('file', f); return api.upload<{ n_questions: number; n_groups: number; groups: { question: string; count: number; examples: string[] }[] }>('/api/questions/group', fd) } })
  const add = useAddCase(version.id, onEdited)
  const ids = useMemo(() => new Set((version.cases ?? []).map((c) => c.id)), [version.cases])
  const addAll = async () => {
    let n = 0
    for (const q of picked) {
      const count = group.data?.groups.find((g) => g.question === q)?.count ?? 1
      await add.mutateAsync(makeCase(q, ids, { provenance: { source: 'real-traffic', drafted_by: `a user (asked ${count} times)`, approved_by: prefs.annotator || 'you' } }))
      n++
    }
    setDone(n)
    setPicked([])
  }
  return (
    <div className="space-y-3">
      <p className="text-sm text-ink-2">The questions users actually ask are the best test questions. Upload chat history (JSONL or JSON with a question field, a CSV with a question column, or one question per line); similar questions are grouped and counted.</p>
      <FileInput accept=".jsonl,.ndjson,.json,.csv,.txt" aria-label="Chat history file" onFiles={(f) => group.mutate(f[0])} />
      {group.isPending && <Loading rows={3} />}
      {group.isError && <ErrorState error={group.error} />}
      {group.data && (
        <>
          <div className="flex items-center gap-1.5 text-xs text-ink-2"><span><span className="font-mono">{group.data.n_questions}</span> questions, <span className="font-mono">{group.data.n_groups}</span> groups. Tick the ones worth testing (20–30 is plenty to start).</span>
            <Help title="No expectations yet"><p>They are added with no expectations yet: open each question (or use Approve good answers after a run) to say what a correct answer must contain.</p></Help></div>
          <ul className="scroll-thin max-h-80 space-y-1 overflow-y-auto rounded-lg border border-line p-2">
            {group.data.groups.map((g) => (
              <li key={g.question}>
                <div className="flex items-start gap-2 rounded px-1 py-0.5 hover:bg-surface-2">
                  <Checkbox className="flex-1" checked={picked.includes(g.question)} onChange={() => setPicked((p) => (p.includes(g.question) ? p.filter((x) => x !== g.question) : [...p, g.question]))}
                    label={g.question} hint={g.examples.length > 1 ? `also: ${g.examples.slice(1, 3).join(' · ')}` : undefined} />
                  <Badge tone={g.count > 1 ? 'accent' : 'neutral'}><span className="font-mono">{g.count}×</span></Badge>
                </div>
              </li>
            ))}
          </ul>
          <Button variant="primary" disabled={!picked.length} loading={add.isPending} onClick={() => void addAll()}>{picked.length ? `Add ${plural(picked.length, 'question')}` : 'Add questions'}</Button>
        </>
      )}
      {done > 0 && <Notice tone="good" title={`${plural(done, 'real question')} added`} />}
      {add.isError && <ErrorState error={add.error} />}
    </div>
  )
}

function Interview({ version, onEdited }: { version: DatasetVersion; onEdited: (r: EditResult) => void }) {
  const prefs = usePrefs()
  const [q, setQ] = useState('')
  const [must, setMust] = useState('')
  const [never, setNever] = useState('')
  const [refuse, setRefuse] = useState(false)
  const [count, setCount] = useState(0)
  const [chips, setChips] = useState<string[]>([])
  const add = useAddCase(version.id, onEdited)
  const ids = useMemo(() => new Set((version.cases ?? []).map((c) => c.id)), [version.cases])
  const split = (s: string) => s.split(/,\s+|\n|;/).map((x) => x.trim()).filter(Boolean)
  const save = () => {
    if (!q.trim()) return
    add.mutate(makeCase(q.trim(), ids, {
      must_mention: [...new Set([...split(must), ...chips])], must_not_claim: split(never), refusal: refuse ? true : null,
      category: refuse ? 'refusal' : undefined,
      provenance: { source: 'interview', drafted_by: prefs.annotator || 'an expert', approved_by: prefs.annotator || 'an expert' },
    }), { onSuccess: () => { setCount((n) => n + 1); setQ(''); setMust(''); setNever(''); setRefuse(false); setChips([]) } })
  }
  return (
    <div className="space-y-3" onKeyDown={(e) => { if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) save() }}>
      <p className="text-sm text-ink-2">For someone who knows the subject: one question at a time, no YAML. <Kbd>Ctrl</Kbd>+<Kbd>Enter</Kbd> saves and starts the next.{count ? <b className="ml-1 text-good-ink">{count} saved</b> : null}</p>
      <Field label="A question users ask"><Input autoFocus value={q} onChange={(e) => setQ(e.target.value)} aria-label="Interview question" /></Field>
      <Field label="What must a correct answer say? (comma-separated)"><Input value={must} onChange={(e) => setMust(e.target.value)} aria-label="Must say" placeholder="e.g. RMA-17, restocking fee" /></Field>
      <TermChips text={`${q} ${must}`} picked={chips} onToggle={(t) => setChips((c) => (c.includes(t) ? c.filter((x) => x !== t) : [...c, t]))} exclude={split(must)} />
      <Field label="What must it never say? (optional)"><Input value={never} onChange={(e) => setNever(e.target.value)} aria-label="Never say" placeholder="e.g. ZPP3" /></Field>
      <Checkbox checked={refuse} onChange={setRefuse} label="The chatbot should decline this one (out of scope)" />
      <Button variant="primary" disabled={!q.trim() || (!must.trim() && !chips.length && !refuse)} loading={add.isPending} onClick={save}><Sparkles className="size-3.5" />Save and next</Button>
      {add.isError && <ErrorState error={add.error} />}
    </div>
  )
}

// --------------------------------------------------------------------------------------
// From a failed answer (Trial page)
// --------------------------------------------------------------------------------------

export function AddFailureToDataset({ projectId, question, answer, runId, trialId, reference }: {
  projectId?: number | null; question: string; answer: string; runId: number; trialId: number; reference?: string | null
}) {
  const prefs = usePrefs()
  const [open, setOpen] = useState(false)
  const datasets = useQuery({ queryKey: ['datasets'], queryFn: () => api.get<Dataset[]>('/api/datasets'), enabled: open })
  const own = (datasets.data ?? []).filter((d) => !projectId || d.project_id === projectId)
  const [dsId, setDsId] = useState<number | ''>('')
  const ds = own.find((d) => d.id === dsId) ?? own[0]
  const [should, setShould] = useState(reference ?? '')
  const [chips, setChips] = useState<string[]>([])
  const [done, setDone] = useState<EditResult | null>(null)
  const add = useMutation({
    mutationFn: async () => {
      const v = await api.get<DatasetVersion>(`/api/dataset-versions/${ds!.latest!.id}`)
      const c = makeCase(question, new Set((v.cases ?? []).map((x) => x.id)), {
        reference: should || undefined, must_mention: chips,
        provenance: { source: 'failed-trial', drafted_by: prefs.annotator || 'you', approved_by: prefs.annotator || 'you', run_id: runId, trial_id: trialId },
      })
      return api.post<EditResult>(`/api/dataset-versions/${v.id}/cases`, c)
    },
    onSuccess: setDone,
  })
  return (
    <>
      <Button size="sm" onClick={() => setOpen(true)}><ListChecks className="size-3.5" />Add to a dataset</Button>
      <Dialog open={open} onClose={() => { setOpen(false); setDone(null) }} title="Keep this failure as a question">
        {done ? (
          <Notice tone="good" title="Added">{done.branched ? done.notice : `Saved in version ${done.version}.`} Every future run now checks this question.</Notice>
        ) : (
          <div className="space-y-3">
            <p className="text-sm text-ink-2">A question the bot got wrong in real use is the best guard against the same mistake coming back.</p>
            <div className="rounded-lg border border-line bg-surface-2/40 p-3 text-sm"><div className="t-label mb-0.5">Question</div>{question}<div className="t-label mb-0.5 mt-2">It answered</div><div className="line-clamp-4 text-ink-2">{answer}</div></div>
            {own.length === 0 && !datasets.isLoading ? <Notice tone="warn" title="This chatbot has no dataset yet">Add one on the Datasets page first.</Notice> : (
              <Field label="Into which dataset?">
                <Select value={ds?.id ?? ''} onChange={(e) => setDsId(Number(e.target.value))} aria-label="Dataset for the failure">
                  {own.map((d) => <option key={d.id} value={d.id}>{d.name} (v{d.latest?.version}, {plural(d.latest?.case_count ?? 0, 'question')})</option>)}
                </Select>
              </Field>
            )}
            <Field label="What should it have said?"><Textarea rows={2} className="font-sans text-sm" value={should} onChange={(e) => setShould(e.target.value)} /></Field>
            <TermChips text={should} picked={chips} onToggle={(t) => setChips((c) => (c.includes(t) ? c.filter((x) => x !== t) : [...c, t]))} />
            <div className="flex gap-2">
              <Button variant="primary" disabled={!ds?.latest || (!should.trim() && !chips.length)} loading={add.isPending} onClick={() => add.mutate()}><Check className="size-3.5" />Add question</Button>
              <Button variant="ghost" onClick={() => setOpen(false)}><X className="size-3.5" />Cancel</Button>
            </div>
            {add.isError && <ErrorState error={add.error} />}
          </div>
        )}
      </Dialog>
    </>
  )
}


/** Copies of a question asked differently; they keep its expectations and go to the review queue. */
export function AddVariations({ versionId, caseId }: { versionId: number; caseId: string }) {
  const qc = useQueryClient()
  const [open, setOpen] = useState(false)
  const [kinds, setKinds] = useState<string[]>(['typo'])
  const make = useMutation({
    mutationFn: () => api.post<{ created: number; errors: string[] }>(`/api/dataset-versions/${versionId}/cases/${encodeURIComponent(caseId)}/variations`, { kinds }),
    onSuccess: () => { qc.invalidateQueries({ queryKey: ['candidates'] }); qc.invalidateQueries({ queryKey: ['dataset'] }) },
  })
  const KINDS: [string, string][] = [['typo', 'With a typo (no model needed)'], ['paraphrase', 'In other words'], ['zh', 'In Chinese (中文)'], ['ja', 'In Japanese (日本語)']]
  return (
    <>
      <Button size="sm" variant="ghost" onClick={() => setOpen(true)} title="Ask the same thing differently">Variations</Button>
      <Dialog open={open} onClose={() => { setOpen(false); make.reset() }} title={`Variations of ${caseId}`} width={480}>
        <p className="mb-3 text-sm text-ink-2">Does the bot still get it right when the question is asked differently? Each variation keeps this question’s expectations and goes to the review queue (a translation can change what must be mentioned).</p>
        <div className="space-y-1.5">
          {KINDS.map(([k, label]) => (
            <Checkbox key={k} checked={kinds.includes(k)} onChange={() => setKinds((x) => (x.includes(k) ? x.filter((y) => y !== k) : [...x, k]))} label={label} />
          ))}
        </div>
        <p className="mt-2 text-xs text-ink-2">Other words and translations use the drafting model from Settings &gt; Defaults.</p>
        <Button className="mt-3" variant="primary" disabled={!kinds.length} loading={make.isPending} onClick={() => make.mutate()}>Add {plural(kinds.length, 'variation')}</Button>
        {make.data && <div className="mt-3"><Notice tone="good" title={`${plural(make.data.created, 'variation')} in the review queue`}>{make.data.errors.length ? `Not created: ${make.data.errors.join('; ')}` : 'Open Generate & review to approve them.'}</Notice></div>}
        {make.isError && <div className="mt-3"><ErrorState error={make.error} /></div>}
      </Dialog>
    </>
  )
}

/** Does a question say anything about a correct answer yet? (A typed or real question may not.) */
export function hasExpectations(c: TestCase): boolean {
  const e = c.expected
  const a = e.answer
  return !!(a.reference || a.exact || a.must_mention.length || a.must_not_claim.length || a.regex.length || e.relevant_documents.length
    || e.required_tools.length || e.tool_calls.length || e.refusal_expected != null || e.min_citations != null || e.required_citations.length)
}
