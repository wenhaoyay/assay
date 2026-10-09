import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import clsx from 'clsx'
import { Check, ChevronRight, Crown, HelpCircle, Pencil, Play, Scale, X } from 'lucide-react'
import { AnimatePresence, motion } from 'motion/react'
import { useEffect, useState } from 'react'
import { createPortal } from 'react-dom'
import { Link, useSearchParams } from 'react-router-dom'
import { Chip } from '../components/form'
import { Confetti } from '../components/viz'
import { AgreementGauge, TwoByTwo } from '../components/setup/Agreement'
import { BakeoffScatter, hasPerItem } from '../components/setup/BakeoffScatter'
import { SetupField } from '../components/setup/SetupField'
import { Badge, Button, Card, DUR, Dialog, Empty, ErrorState, Figs, Input, Kbd, Loading, Notice, PageHeader, Panel, ProgressBar, SectionHead, Select, Stat, Table, Tabs, Term, useLongWork } from '../components/ui'
import { LabelHelp } from '../components/LabelHelp'
import { api, qs } from '../lib/api'
import { whereLabel } from '../lib/models'
import { useCrumbs } from '../lib/crumbs'
import { fmtDate, ms, pct, plural, usd } from '../lib/format'
import { useHotkey } from '../lib/hotkeys'
import { useMotionOn, usePrefs } from '../lib/prefs'
import type { Agreement, Bakeoff, CalibrationItem, CalibrationStats, ProviderConfig, RunHeader } from '../lib/types'
import { HighlightedAnswer } from './Trial'

const DIMENSIONS = ['correctness', 'groundedness', 'relevance', 'completeness', 'instruction_adherence', 'appropriate_refusal']
const SAMPLE = 30 // labels per dimension for a judgement that is more than anecdote

/** You (rows) against the grading model (columns), one tile per pair, one dot per label. */
export function ConfusionMatrix({ a }: { a: Agreement }) {
  return <TwoByTwo a={a} />
}

const KAPPA_HELP = (
  <>
    <p>Kappa corrects accuracy for agreement expected by chance: around 0.4 is moderate, above 0.6 substantial, above 0.8 near-perfect. With few samples the estimate is unstable: the ± is a rough 95% interval.</p>
    <p>Above the trust line (0.6), and sure of it, the grading model’s grades can run unattended. Below it, keep a person in the loop.</p>
  </>
)

export function AgreementPanel({ s }: { s: CalibrationStats }) {
  const a = s.agreement
  if (a.n === 0) return <Empty title="Uncalibrated">No labels from you yet for {s.dimension.replace(/_/g, ' ')}{s.judge_filter ? ` with ${s.judge_filter}` : ''}. Until there are, treat this grading model’s verdicts as unvalidated.</Empty>
  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-center gap-2"><Badge tone="pass">{s.status}</Badge>{s.small_sample && <Badge tone="flaky">Small sample: indicative only</Badge>}</div>
      <AgreementGauge a={a} small={s.small_sample} sampleNote={false} />
      <Figs>
        <Stat label="Samples" value={a.n} />
        <Stat label="Accuracy" value={pct(a.accuracy)} help={<p>The share of answers where the grading model gave the same verdict as you, before correcting for chance.</p>} />
        <Stat label="F1 (fail class)" value={pct(a.f1)} sub={`precision ${pct(a.precision)}, recall ${pct(a.recall)}`}
          help={<p>Fail is the class that matters: did the grading model catch the bad answers you caught? Precision: of the answers it failed, how many you failed too. Recall: of the answers you failed, how many it caught.</p>} />
        <Stat label="Disagreements" value={s.disagreements.length} />
      </Figs>
      <TwoByTwo a={a} />
    </div>
  )
}

export function CalibrationPage() {
  const [params, setParams] = useSearchParams()
  const tab = (params.get('tab') as 'label' | 'agreement' | 'bakeoff') ?? 'label'
  useCrumbs([{ label: 'Grading' }, { label: 'Calibration' }], 'calibration')
  const [dimension, setDimension] = useState('correctness')
  const [judge, setJudge] = useState('')
  const stats = useQuery({ queryKey: ['calib-stats', dimension, judge], queryFn: () => api.get<CalibrationStats>(`/api/calibration/${dimension}/stats${qs({ judge: judge || undefined })}`) })
  return (
    <>
      <PageHeader eyebrow="Grading" title={<>Can you trust <em>the grading model</em>?</>}
        help={<>
          <p>Label answers yourself; Assay measures how often each grading model agrees with you, beyond what chance would give (Cohen’s kappa).</p>
          <p>A model is shown as validated only once your labels exist: per model, so a new one starts uncalibrated. Above the trust line its grades can run unattended; below it, keep a person in the loop.</p>
          <p>The dimension picks which kind of grade you are checking (correctness, groundedness and so on); the second list narrows the figures to one grading model.</p>
        </>}
        />
      <div className="space-y-6">
        <div className="flex flex-wrap items-end">
          <Tabs className="min-w-0 flex-1 basis-80" tabs={[{ id: 'label', label: 'Label answers' }, { id: 'agreement', label: 'Agreement' }, { id: 'bakeoff', label: 'Bake-off' }]} value={tab} onChange={(t) => setParams({ tab: t })} />
          <div className="flex flex-wrap items-center gap-2 border-b border-line pb-1.5 pl-6 max-sm:pl-0 max-sm:pt-3">
            <Select className="w-44" value={dimension} onChange={(e) => setDimension(e.target.value)} aria-label="Dimension">{DIMENSIONS.map((d) => <option key={d} value={d}>{d.replace(/_/g, ' ')}</option>)}</Select>
            <Select className="w-60" value={judge} onChange={(e) => setJudge(e.target.value)} aria-label="Grading model">
              <option value="">All grading models</option>
              {Object.entries(stats.data?.by_judge ?? {}).map(([j, n]) => <option key={j} value={j}>{j} ({n} labelled)</option>)}
            </Select>
          </div>
        </div>
        {tab === 'label' && <LabelTab dimension={dimension} stats={stats.data} />}
        {tab === 'agreement' && (stats.isLoading ? <Loading /> : stats.isError ? <ErrorState error={stats.error} /> : <AgreementTab s={stats.data!} />)}
        {tab === 'bakeoff' && <BakeoffTab dimension={dimension} />}
      </div>
    </>
  )
}

type Verdict = 'PASS' | 'FAIL' | 'UNKNOWN'

function LabelTab({ dimension, stats }: { dimension: string; stats?: CalibrationStats }) {
  const qc = useQueryClient()
  const prefs = usePrefs()
  const motionOn = useMotionOn()
  const [editingName, setEditingName] = useState(!prefs.annotator)
  const [nameDraft, setNameDraft] = useState(prefs.annotator)
  const [runId, setRunId] = useState<number | ''>('')
  const [note, setNote] = useState('')
  const [exitDir, setExitDir] = useState<Verdict>('PASS')
  const [gone, setGone] = useState<number[]>([]) // labelled here: off the deck at once, before the refetch
  const [reveal, setReveal] = useState<{ trial: number; human: string } | null>(null)
  const [celebrate, setCelebrate] = useState(false)
  const runs = useQuery({ queryKey: ['runs'], queryFn: () => api.get<RunHeader[]>('/api/runs?limit=300') })
  const annotator = prefs.annotator
  const items = useQuery({
    queryKey: ['calib-items', dimension, runId, annotator],
    queryFn: () => api.get<CalibrationItem[]>(`/api/calibration/${dimension}/items${qs({ run_id: runId || undefined, annotator: annotator || undefined, blind: true })}`),
  })
  const all = items.data ?? []
  const queue = all.filter((i) => !i.human && !gone.includes(i.trial_id))
  const current = queue[0]
  const total = stats?.agreement.n ?? all.length - queue.length
  const label = useMutation({
    mutationFn: ({ item, l }: { item: CalibrationItem; l: Verdict }) =>
      api.post('/api/calibration/annotations', { trial_id: item.trial_id, dimension, label: l, annotator, note }),
    onMutate: ({ item, l }) => { setExitDir(l); setGone((g) => [...g, item.trial_id]) },
    onError: (_e, { item }) => setGone((g) => g.filter((x) => x !== item.trial_id)),
    onSuccess: (_d, { item, l }) => {
      setReveal({ trial: item.trial_id, human: l })
      setNote('')
      if (total + 1 === SAMPLE) setCelebrate(true)
      qc.invalidateQueries({ queryKey: ['calib-items'] }); qc.invalidateQueries({ queryKey: ['calib-stats'] }); qc.invalidateQueries({ queryKey: ['evaluators'] }); qc.invalidateQueries({ queryKey: ['models'] })
    },
  })
  const give = (l: Verdict) => { if (current) label.mutate({ item: current, l }) }
  const can = !!annotator && !editingName && !!current && !label.isPending
  useHotkey('p', () => give('PASS'), can)
  useHotkey('f', () => give('FAIL'), can)
  useHotkey('u', () => give('UNKNOWN'), can)
  const revealed = reveal ? all.find((i) => i.trial_id === reveal.trial) : null
  useEffect(() => { const t = setTimeout(() => setReveal(null), 4500); return () => clearTimeout(t) }, [reveal])
  const saveName = () => { if (!nameDraft.trim()) return; prefs.set('annotator', nameDraft.trim()); setEditingName(false) }

  const card = (it: CalibrationItem) => (
    <div className="space-y-4">
      <div className="flex items-center justify-between gap-3">
        <span className="t-label">Question <span className="font-mono normal-case tracking-normal" data-case={it.case_id}>{it.case_id}</span> · run <Link className="font-mono underline" to={`/runs/${it.run_id}`}>#{it.run_id}</Link> · try <span className="font-mono">{it.trial_index + 1}</span></span>
        <span className="text-xs text-ink-2"><span className="num font-mono">{queue.length}</span> left</span>
      </div>
      <div className="text-lead font-medium text-ink">{it.question}</div>
      <div>
        <div className="t-label">The bot answered</div>
        <div className="mt-1 whitespace-pre-wrap rounded-lg border border-line bg-surface-2/50 px-3 py-2.5 text-base leading-relaxed"><HighlightedAnswer text={it.answer} good={[]} bad={[]} /></div>
      </div>
      {it.reference && <div><div className="t-label">Reference answer</div><div className="mt-1 rounded-lg bg-good-wash/50 px-3 py-2 text-sm">{it.reference}</div></div>}
      {it.context.length > 0 && (
        <details className="group"><summary className="flex cursor-pointer items-center gap-1 text-xs font-medium text-accent-ink"><ChevronRight className="size-3.5 transition-transform group-open:rotate-90" />Passages the bot read (<span className="font-mono">{it.context.length}</span>)</summary>
          <ul className="mt-2 space-y-2">{it.context.map((c) => <li key={c.id} className="rounded-lg border border-line p-2 text-xs"><div className="font-mono">{c.id}</div><div className="text-ink-2">{c.text}</div></li>)}</ul>
        </details>
      )}
      {it.tool_calls && it.tool_calls.length > 0 && <div className="font-mono text-xs text-ink-2">{it.tool_calls.map((t, i) => <div key={i}>{t.name}({JSON.stringify(t.arguments)}) {'→'} {JSON.stringify(t.result)}</div>)}</div>}
    </div>
  )

  const veiled = editingName || !annotator
  const deck = items.isLoading ? <Loading rows={8} /> : items.isError ? <ErrorState error={items.error} /> : !current && !veiled ? (
    <Empty title={all.length ? 'All caught up' : 'Nothing to label'} icon={<Check className="size-6" />}>
      {all.length ? `You have labelled every ${dimension.replace(/_/g, ' ')} answer in this selection.` : <>Run something with the <b>{dimension}</b> check and a grading model (even the heuristic one), then come back.</>}
    </Empty>
  ) : (
    <div className="relative min-h-[360px]" data-testid="label-deck">
      {queue.length > 2 && <Panel aria-hidden padded={false} className="absolute inset-0" style={{ transform: 'translateY(20px) scale(0.94)', opacity: 0.4 }} />}
      {queue.length > 1 && <Panel aria-hidden padded={false} className="absolute inset-0" style={{ transform: 'translateY(10px) scale(0.97)', opacity: 0.7 }} />}
      <AnimatePresence mode="popLayout" initial={false}>
        {current ? (
          <motion.div key={current.trial_id}
            initial={motionOn ? { opacity: 0, y: 10, scale: 0.97 } : false} animate={{ opacity: 1, y: 0, scale: 1, x: 0, rotate: 0 }}
            exit={motionOn ? { opacity: 0, x: exitDir === 'PASS' ? '120%' : exitDir === 'FAIL' ? '-120%' : 0, y: exitDir === 'UNKNOWN' ? -80 : 0, rotate: exitDir === 'PASS' ? 10 : exitDir === 'FAIL' ? -10 : 0 } : { opacity: 0 }}
            transition={{ type: 'spring', stiffness: 320, damping: 30 }}
            className="relative" data-testid="label-card">
            <Panel className="min-h-[360px]">{card(current)}</Panel>
          </motion.div>
        ) : <Panel className="min-h-[360px]" />}
      </AnimatePresence>
      <Dialog open={veiled} onClose={() => { if (annotator) setEditingName(false) }} width={400}
        title={<LabelHelp label="Who is labelling?"><p>Labels are stored per person, so two people’s judgements can be compared later. You only enter this once.</p></LabelHelp>}>
        <div className="flex gap-2" data-testid="name-veil">
          <Input value={nameDraft} onChange={(e) => setNameDraft(e.target.value)} placeholder="Your name" aria-label="Your name" data-autofocus className="min-w-0 flex-1"
            onKeyDown={(e) => { if (e.key === 'Enter') saveName() }} />
          <Button variant="primary" className="shrink-0 whitespace-nowrap" disabled={!nameDraft.trim()} onClick={saveName}>Start</Button>
        </div>
      </Dialog>
    </div>
  )

  const judged = revealed?.judge
  return (
    <div className="grid items-start gap-x-10 gap-y-12 xl:grid-cols-[minmax(0,7fr)_minmax(0,5fr)]">
      <Confetti fire={celebrate} />
      <div className="min-w-0 space-y-6" data-tour="flashcard">
        <div className="space-y-3">
        <SectionHead rule title="Label answers" help={<>
          <p>Real answers from your runs, graded by a grading model. Decide each one yourself: <Kbd>P</Kbd> pass, <Kbd>F</Kbd> fail, <Kbd>U</Kbd> not sure. After each label you see what the grading model said.</p>
          <p>The grading model’s verdict stays hidden until you label, so it cannot anchor your judgement.</p>
          <p>Label what a careful expert would say, not what you think the grading model will say. Disagreements are the useful part: they show where the grading model cannot be trusted.</p>
          <p>{SAMPLE} labels per dimension make a sample worth reading; fewer are a hint.</p>
        </>}
          actions={<>
            {annotator && !editingName && (
              <span className="flex items-center gap-1 text-xs text-ink-2">as <b className="font-medium text-ink">{annotator}</b>
                <button type="button" onClick={() => setEditingName(true)} className="text-accent-ink hover:underline" aria-label="Change name"><Pencil className="inline size-3" /></button>
              </span>
            )}
            <Select className="w-56" value={runId} onChange={(e) => setRunId(e.target.value ? Number(e.target.value) : '')} aria-label="Run">
              <option value="">Answers from all runs</option>{(runs.data ?? []).map((r) => <option key={r.id} value={r.id}>#{r.id} {r.experiment}</option>)}
            </Select>
            <span className="text-sm text-ink-2" data-testid="label-progress"><span className="num font-mono font-medium text-ink">{Math.min(total, SAMPLE)}</span> of <span className="num font-mono">{SAMPLE}</span></span>
          </>} />
        <ProgressBar value={Math.min(1, total / SAMPLE)} tone={total >= SAMPLE ? 'good' : 'accent'} />
        </div>
        {deck}
        {(current || veiled) && (
          <div className="space-y-3">
            <SetupField label="Note (optional)" help={<p>Why you labelled it so. It shows beside the grading model’s reason wherever you two disagree.</p>}>
              <Input value={note} onChange={(e) => setNote(e.target.value)} placeholder="Why (helps when you look at disagreements)" disabled={!can} />
            </SetupField>
            {label.isError && <ErrorState error={label.error} />}
            <div className="flex flex-wrap justify-center gap-2">
              <Button size="lg" className="min-w-32" disabled={!can} onClick={() => give('PASS')}><Check className="size-4 text-good-ink" />Pass <Kbd>P</Kbd></Button>
              <Button size="lg" className="min-w-32" disabled={!can} onClick={() => give('FAIL')}><X className="size-4 text-bad-ink" />Fail <Kbd>F</Kbd></Button>
              <Button size="lg" variant="ghost" disabled={!can} onClick={() => give('UNKNOWN')}><HelpCircle className="size-4" />Not sure <Kbd>U</Kbd></Button>
            </div>
          </div>
        )}
      </div>
      <div className="min-w-0 space-y-6" data-testid="live-agreement">
        <SectionHead rule title="Agreement" help={KAPPA_HELP} meta={stats?.judge_filter || undefined} />
        {stats ? <AgreementGauge a={stats.agreement} small={stats.small_sample} /> : <Loading rows={3} />}
        {stats && <TwoByTwo a={stats.agreement} testPrefix="live" />}
      </div>
      {createPortal(
        <AnimatePresence>
          {reveal && judged && (
            <motion.div initial={{ opacity: 0, y: 24, x: '-50%' }} animate={{ opacity: 1, y: 0, x: '-50%' }} exit={{ opacity: 0, y: 24, x: '-50%' }} transition={{ duration: DUR.slow }}
              className="fixed bottom-6 left-1/2 z-(--z-toast) max-w-[min(560px,calc(100vw-32px))] rounded-xl bg-ink px-4 py-2.5 text-sm text-page shadow-pop" role="status" data-testid="judge-toast">
              {judged.label === reveal.human
                ? <>Grading model agreed: <b className="font-semibold">{judged.label.toLowerCase()}</b></>
                : <>Grading model said <b className={clsx('font-semibold')}>{judged.label.toLowerCase()}</b>{judged.reason ? <>: “{judged.reason.length > 110 ? `${judged.reason.slice(0, 110)}…` : judged.reason}”</> : null}</>}
            </motion.div>
          )}
        </AnimatePresence>,
        document.body,
      )}
    </div>
  )
}

function AgreementTab({ s }: { s: CalibrationStats }) {
  return (
    <div className="grid items-start gap-x-10 gap-y-12 xl:grid-cols-[minmax(0,1fr)_480px]">
      <Card title={`You vs the grading model · ${s.dimension.replace(/_/g, ' ')}${s.judge_filter ? ` · ${s.judge_filter}` : ''}`} help={KAPPA_HELP}><AgreementPanel s={s} /></Card>
      <Card title="Where you and the grading model disagree" meta={s.disagreements.length || undefined} padded={false}
        help={<>
          <p>Every answer where your label and the grading model’s verdict differ, with the grading model’s reason and your note. These are the answers to read first: they show where the grading model cannot be trusted.</p>
          <p>Agreement is specific to a grading model and rubric version.{s.judges.length > 0 ? ` Grading models in this sample: ${s.judges.map((j) => `${j.provider}/${j.model}`).join('; ')}.` : ''}</p>
        </>}>
        {s.disagreements.length === 0 ? <p className="py-4 text-sm text-ink-2">No disagreements yet.</p> : (
          <ul className="divide-y divide-line">
            {s.disagreements.map((d) => (
              <li key={d.trial_id} className="py-3 text-sm" data-case={d.case_id}>
                <div className="flex flex-wrap items-center gap-2"><Link className="font-mono text-xs text-accent-ink hover:underline" to={`/trials/${d.trial_id}`}>{d.case_id}</Link><Badge tone={d.human === 'PASS' ? 'pass' : 'fail'}>you: {d.human.toLowerCase()}</Badge><Badge tone={d.judge === 'PASS' ? 'pass' : 'fail'}>grading model: {d.judge.toLowerCase()}</Badge></div>
                <div className="mt-1 text-ink-2">Grading model: {d.judge_reason}</div>
                {d.note && <div className="text-ink-2">You: {d.note}</div>}
              </li>
            ))}
          </ul>
        )}
        {s.judges.length > 0 && (
          <div className="flex flex-wrap gap-1.5 border-t border-line pt-3">
            {s.judges.map((j) => <Badge key={`${j.provider}/${j.model}/${j.prompt_hash}`}>{j.provider}/{j.model}</Badge>)}
          </div>
        )}
      </Card>
    </div>
  )
}

function BakeoffTab({ dimension }: { dimension: string }) {
  const qc = useQueryClient()
  const models = useQuery({ queryKey: ['models'], queryFn: () => api.get<ProviderConfig[]>('/api/models') })
  const count = useQuery({ queryKey: ['labelled-count', dimension], queryFn: () => api.get<{ n: number }>(`/api/calibration/${dimension}/labelled-count`) })
  const past = useQuery({ queryKey: ['bakeoffs', dimension], queryFn: () => api.get<Bakeoff[]>(`/api/bakeoffs?dimension=${dimension}`) })
  const [picked, setPicked] = useState<string[]>(['heuristic'])
  const [active, setActive] = useState<number | null>(null)
  const latestId = active ?? past.data?.[0]?.id ?? null
  const current = useQuery({
    queryKey: ['bakeoff', latestId], queryFn: () => api.get<Bakeoff>(`/api/bakeoffs/${latestId}`), enabled: latestId !== null,
    refetchInterval: (q) => (q.state.data?.status === 'running' || q.state.data?.status === 'cancelling' ? 1000 : false),
  })
  const shown = current.data ?? past.data?.[0] ?? null
  const bakeBody = () => ({ dimension, judges: picked.map((p) => (p === 'heuristic' ? { provider: 'heuristic' } : { provider_config_id: Number(p) })) })
  const long = useLongWork()
  const start = useMutation({
    mutationFn: () => api.post<Bakeoff>('/api/bakeoffs', bakeBody()),
    onSuccess: (b) => { setActive(b.id); qc.invalidateQueries({ queryKey: ['bakeoffs'] }) },
  })
  const toggle = (id: string) => setPicked((p) => (p.includes(id) ? p.filter((x) => x !== id) : p.length >= 4 ? p : [...p, id]))
  const n = count.data?.n ?? 0
  const winner = shown?.results?.winner
  const dim = dimension.replace(/_/g, ' ')
  return (
    <div className="space-y-12">
      <Card title="Which grading model agrees with you most?" meta={n ? `${n} labelled` : undefined} help={<>
        <p>Each grading model grades the {plural(n, `${dim} answer`)} you labelled; Assay compares their verdicts with yours, and with each other.</p>
        <p>A local model on a CPU takes about 30 s per answer; cloud models cost money (see Settings for the per-100 price). Pick up to four.</p>
        <p>Pick the cheapest grading model whose agreement with you is close to the best. A grading model that agrees with you no better than chance (kappa near 0) should not gate a release.</p>
      </>}>
        {n === 0 ? <Notice tone="warn" title="Label some answers first">The bake-off needs your pass and fail labels. Label a few on the first tab.</Notice> : (
          <>
            <div className="flex flex-wrap gap-2">
              {[{ id: 'heuristic', name: 'Heuristic (word overlap)', local: true }, ...(models.data ?? []).map((m) => ({ id: String(m.id), name: m.name, local: !!m.local, where: whereLabel(m) }))].map((m) => (
                <Chip key={m.id} selected={picked.includes(m.id)} onClick={() => toggle(m.id)} count={'where' in m ? m.where : 'local'} icon={picked.includes(m.id) ? <Check className="size-3.5" /> : undefined}>
                  {m.name}
                </Chip>
              ))}
            </div>
            <div className="mt-4">
              <Button variant="primary" loading={start.isPending || long.checking} disabled={!picked.length || shown?.status === 'running'} onClick={() => long.run(() => api.post<{ seconds?: number }>('/api/bakeoffs', { ...bakeBody(), estimate_only: true }), () => start.mutate())}>
                <Play className="size-3.5" />Run the bake-off ({plural(picked.length, 'grading model')} × {plural(n, 'answer')})
              </Button>
            </div>
            {start.isError && <div className="mt-2"><ErrorState error={start.error} /></div>}
            {long.dialog}
          </>
        )}
      </Card>

      {!shown ? (
        past.isLoading ? <Loading /> : (
          <Empty title="No bake-off yet" icon={<Scale className="size-6" />}>
            <ol className="list-decimal space-y-1 pl-4">
              <li>Label a few {dim} answers on the first tab (P pass, F fail). Thirty make a fair test.</li>
              <li>Tick the grading models to compare above: the free heuristic, a local model, a cloud one.</li>
              <li>Run the bake-off. Each grading model grades the answers you labelled; the table ranks them by agreement with you, and the chart shows where two grading models split.</li>
            </ol>
          </Empty>
        )
      ) : (
        <>
          <Card title={`Results · ${shown.dimension.replace(/_/g, ' ')}`} meta={fmtDate(shown.created_at)} help={<>
            <p>One row per grading model, best agreement with you first. The crown marks the winner: highest kappa, cheapest on a tie. Heuristic (word-overlap) rows are hatched: no model is involved.</p>
            <p>No verdict: answers the grading model could not grade. Speed is the median time per answer; cost is the whole bake-off.</p>
          </>}>
            {shown.status === 'running' && <div className="mb-4"><div className="mb-1 text-xs text-ink-2">Grading <span className="num font-mono">{shown.progress_done}</span> of <span className="num font-mono">{shown.progress_total}</span></div><ProgressBar value={shown.progress_total ? shown.progress_done / shown.progress_total : 0} /></div>}
            {shown.status === 'failed' && <Notice tone="bad" title="The bake-off failed">{shown.error}</Notice>}
            {shown.results && (
              <>
                <Table>
                  <thead><tr><th className="t-label">Grading model</th><th className="t-label"><Term k="kappa">Agreement (kappa)</Term></th><th className="t-label text-right">Accuracy</th><th className="t-label text-right">F1 (fail)</th><th className="t-label text-right">No verdict</th><th className="t-label text-right">Speed</th><th className="t-label text-right">Cost</th></tr></thead>
                  <tbody>
                    {[...shown.results.judges].sort((a, b) => (b.agreement.kappa ?? -2) - (a.agreement.kappa ?? -2)).map((j, i) => (
                      <motion.tr key={j.name} initial={{ opacity: 0, x: -8 }} animate={{ opacity: 1, x: 0 }} transition={{ delay: i * 0.08 }} className={clsx(j.name.startsWith('heuristic') && 'hatched')}>
                        <td className="font-medium">{winner === j.name && <Crown className="mr-1 inline size-4 text-warn" aria-label="winner" />}{j.name}</td>
                        <td className="w-56">
                          <div className="flex items-center gap-2">
                            <div className="relative h-2 flex-1 rounded-full bg-surface-2">
                              <motion.div className="h-full rounded-full bg-accent" initial={{ width: 0 }} animate={{ width: `${Math.max(0, (j.agreement.kappa ?? 0)) * 100}%` }} transition={{ delay: 0.2 + i * 0.08, type: 'spring', stiffness: 90, damping: 18 }} />
                              <span className="absolute -top-0.5 h-3 w-0.5 bg-ink" style={{ left: '60%' }} title="trust line (0.6)" />
                            </div>
                            <span className="num w-10 text-right font-mono text-xs">{j.agreement.kappa === null ? 'n/a' : j.agreement.kappa.toFixed(2)}</span>
                          </div>
                        </td>
                        <td className="num text-right font-mono">{pct(j.agreement.accuracy)}</td>
                        <td className="num text-right font-mono">{pct(j.agreement.f1)}</td>
                        <td className="num text-right font-mono">{j.unknown}</td>
                        <td className="num text-right font-mono">{ms(j.median_ms)}</td>
                        <td className="num text-right font-mono">{usd(j.cost_usd)}</td>
                      </motion.tr>
                    ))}
                  </tbody>
                </Table>
                {shown.results.pairwise.length > 0 && (
                  <div className="mt-4 flex flex-wrap items-center gap-2 text-sm text-ink-2">
                    <span className="t-label">Grading models agreeing with each other</span>
                    {shown.results.pairwise.map((p) => <Badge key={`${p.a}-${p.b}`}>{p.a} vs {p.b}: κ <span className="font-mono">{p.kappa === null ? 'n/a' : p.kappa.toFixed(2)}</span></Badge>)}
                  </div>
                )}
              </>
            )}
          </Card>
          {shown.results && (
            <Card title="Where two grading models split" help={<>
              <p>The same answers, graded twice: one grading model across, the other up (you can be one of them). Dots off the diagonal are where they disagree; amber means they disagree on pass or fail.</p>
              <p>Click a dot to read the answer and every verdict on it; the first disagreement opens by default. Disagreements are the first answers worth labelling yourself.</p>
              <p>A bake-off stores each grading model’s verdict per answer, not a score or a reason, so the axes are verdict bands with a little jitter. The note under the verdicts is how the answer was graded when its run ran.</p>
            </>}>
              {hasPerItem(shown) ? <BakeoffScatter bakeoff={shown} dimension={dimension} />
                : <p className="text-sm text-ink-2">This bake-off was saved before per-answer verdicts were kept. Run it again to see where the grading models split.</p>}
            </Card>
          )}
        </>
      )}
    </div>
  )
}
