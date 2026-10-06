import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import clsx from 'clsx'
import { Check, ChevronRight, Crown, HelpCircle, Pencil, Play, X } from 'lucide-react'
import { AnimatePresence, motion } from 'motion/react'
import { useEffect, useState } from 'react'
import { Link, useSearchParams } from 'react-router-dom'
import { Confetti } from '../components/viz'
import { Badge, Button, Card, Empty, ErrorState, Explain, Field, Input, Kbd, Loading, Notice, PageHeader, ProgressBar, Select, Stat, Table, Tabs, Term } from '../components/ui'
import { api, qs } from '../lib/api'
import { whereLabel } from '../lib/models'
import { useCrumbs } from '../lib/crumbs'
import { ms, pct, usd } from '../lib/format'
import { useHotkey } from '../lib/hotkeys'
import { usePrefs } from '../lib/prefs'
import type { Agreement, Bakeoff, CalibrationItem, CalibrationStats, ProviderConfig, RunHeader } from '../lib/types'
import { HighlightedAnswer } from './Trial'

const DIMENSIONS = ['correctness', 'groundedness', 'relevance', 'completeness', 'instruction_adherence', 'appropriate_refusal']
const LABELS = ['PASS', 'FAIL', 'UNKNOWN'] as const
const SAMPLE = 30 // labels per dimension for a judgement that is more than anecdote

export function ConfusionMatrix({ a }: { a: Agreement }) {
  const rows = LABELS.filter((h) => Object.values(a.confusion[h] ?? {}).some((v) => v > 0) || h !== 'UNKNOWN')
  const cols = LABELS.filter((j) => rows.some((h) => (a.confusion[h]?.[j] ?? 0) > 0) || j !== 'UNKNOWN')
  const max = Math.max(1, ...rows.flatMap((h) => cols.map((j) => a.confusion[h]?.[j] ?? 0)))
  return (
    <table className="text-[13px]" aria-label="Confusion matrix (rows: you, columns: judge)">
      <thead>
        <tr><th className="p-2 text-left text-xs font-normal text-ink-3">You \ Judge</th>{cols.map((j) => <th key={j} className="p-2 text-xs font-medium text-ink-2">{j}</th>)}</tr>
      </thead>
      <tbody>
        {rows.map((h) => (
          <tr key={h}>
            <th className="p-2 text-left text-xs font-medium text-ink-2">{h}</th>
            {cols.map((j) => {
              const v = a.confusion[h]?.[j] ?? 0
              return (
                <td key={j} className={clsx('num h-12 w-16 rounded border border-surface text-center font-medium', h === j ? 'text-good-ink' : v ? 'text-bad-ink' : 'text-ink-3')}
                  style={{ background: v ? `color-mix(in srgb, ${h === j ? 'var(--good)' : 'var(--bad)'} ${Math.round((v / max) * 30)}%, var(--surface))` : 'var(--surface-2)' }}
                  data-testid={`cell-${h}-${j}`}>
                  {v}
                </td>
              )
            })}
          </tr>
        ))}
      </tbody>
    </table>
  )
}

export function AgreementPanel({ s }: { s: CalibrationStats }) {
  const a = s.agreement
  if (a.n === 0) return <Empty title="Uncalibrated">No labels from you yet for {s.dimension}{s.judge_filter ? ` with ${s.judge_filter}` : ''}. Until there are, treat this judge's verdicts as unvalidated.</Empty>
  return (
    <div className="space-y-4">
      <div className="flex items-center gap-2"><Badge tone="good">{s.status}</Badge>{s.small_sample && <Badge tone="warn">small sample - indicative only</Badge>}</div>
      <div className="grid grid-cols-2 gap-3 lg:grid-cols-5">
        <Stat label="Samples" value={a.n} />
        <Stat label="Accuracy" value={pct(a.accuracy)} />
        <Stat label="F1 (FAIL class)" value={pct(a.f1)} sub={`precision ${pct(a.precision)}, recall ${pct(a.recall)}`} title="FAIL is the class that matters: did the judge catch the bad answers you caught?" />
        <Stat label={<Term k="kappa">Cohen's kappa</Term>} value={a.kappa === null ? 'n/a' : a.kappa.toFixed(2)} sub="agreement beyond chance" />
        <Stat label="Disagreements" value={s.disagreements.length} />
      </div>
      <ConfusionMatrix a={a} />
      <p className="text-xs text-ink-3">Kappa corrects accuracy for agreement expected by chance: around 0.4 is moderate, above 0.6 substantial, above 0.8 near-perfect. With few samples the estimate is unstable.</p>
    </div>
  )
}

/** A bar for kappa from -0.2 to 1 with the usual reading bands. */
function KappaMeter({ kappa, n }: { kappa: number | null; n: number }) {
  const v = kappa === null ? 0 : Math.max(-0.2, Math.min(1, kappa))
  const pos = ((v + 0.2) / 1.2) * 100
  const word = kappa === null ? 'no data yet' : kappa >= 0.8 ? 'near-perfect' : kappa >= 0.6 ? 'substantial' : kappa >= 0.4 ? 'moderate' : kappa >= 0.2 ? 'fair' : 'poor'
  return (
    <div>
      <div className="mb-1 flex items-baseline justify-between text-xs"><span className="text-ink-3"><Term k="kappa">Agreement with you</Term></span><span className="num font-medium">{kappa === null ? '-' : kappa.toFixed(2)} <span className="text-ink-3">{word}{n ? `, ${n} labels` : ''}</span></span></div>
      <div className="relative h-2.5 overflow-hidden rounded-full" style={{ background: 'linear-gradient(90deg, var(--bad-wash), var(--warn-wash) 45%, var(--good-wash))' }}>
        <motion.div className="absolute inset-y-0 left-0 rounded-full bg-accent/70" initial={{ width: 0 }} animate={{ width: `${pos}%` }} transition={{ type: 'spring', stiffness: 90, damping: 18 }} />
      </div>
      <div className="mt-0.5 flex justify-between text-[9px] text-ink-3"><span>poor</span><span>moderate 0.4</span><span>substantial 0.6</span><span>1.0</span></div>
    </div>
  )
}

export function CalibrationPage() {
  const [params, setParams] = useSearchParams()
  const tab = (params.get('tab') as 'label' | 'agreement' | 'bakeoff') ?? 'label'
  useCrumbs([{ label: 'Judge trust' }, { label: 'Calibration' }], 'calibration')
  const [dimension, setDimension] = useState('correctness')
  const [judge, setJudge] = useState('')
  const stats = useQuery({ queryKey: ['calib-stats', dimension, judge], queryFn: () => api.get<CalibrationStats>(`/api/calibration/${dimension}/stats${qs({ judge: judge || undefined })}`) })
  return (
    <>
      <PageHeader title="Can you trust the judge?" description="Label answers yourself; GaugeLab measures how often each grading model agrees with you. A model is shown as validated only once your labels exist - per model, so a new one starts uncalibrated."
        actions={
          <>
            <Select className="w-52" value={dimension} onChange={(e) => setDimension(e.target.value)} aria-label="Dimension">{DIMENSIONS.map((d) => <option key={d} value={d}>{d.replace(/_/g, ' ')}</option>)}</Select>
            <Select className="w-64" value={judge} onChange={(e) => setJudge(e.target.value)} aria-label="Judge model">
              <option value="">All grading models</option>
              {Object.entries(stats.data?.by_judge ?? {}).map(([j, n]) => <option key={j} value={j}>{j} ({n} labelled)</option>)}
            </Select>
          </>
        } />
      <Tabs tabs={[{ id: 'label', label: 'Label answers' }, { id: 'agreement', label: 'Agreement' }, { id: 'bakeoff', label: 'Judge bake-off' }]} value={tab} onChange={(t) => setParams({ tab: t })} />
      <div className="mt-5">
        {tab === 'label' && <LabelTab dimension={dimension} stats={stats.data} />}
        {tab === 'agreement' && (stats.isLoading ? <Loading /> : stats.isError ? <ErrorState error={stats.error} /> : <AgreementTab s={stats.data!} />)}
        {tab === 'bakeoff' && <BakeoffTab dimension={dimension} />}
      </div>
    </>
  )
}

function LabelTab({ dimension, stats }: { dimension: string; stats?: CalibrationStats }) {
  const qc = useQueryClient()
  const prefs = usePrefs()
  const [editingName, setEditingName] = useState(!prefs.annotator)
  const [nameDraft, setNameDraft] = useState(prefs.annotator)
  const [runId, setRunId] = useState<number | ''>('')
  const [note, setNote] = useState('')
  const [exitDir, setExitDir] = useState<'PASS' | 'FAIL' | 'UNKNOWN'>('PASS')
  const [reveal, setReveal] = useState<{ trial: number; human: string } | null>(null)
  const [celebrate, setCelebrate] = useState(false)
  const runs = useQuery({ queryKey: ['runs'], queryFn: () => api.get<RunHeader[]>('/api/runs?limit=300') })
  const annotator = prefs.annotator
  const items = useQuery({
    queryKey: ['calib-items', dimension, runId, annotator],
    queryFn: () => api.get<CalibrationItem[]>(`/api/calibration/${dimension}/items${qs({ run_id: runId || undefined, annotator: annotator || undefined, blind: true })}`),
  })
  const all = items.data ?? []
  const queue = all.filter((i) => !i.human)
  const current = queue[0]
  const labelled = all.length - queue.length
  const total = stats?.agreement.n ?? labelled
  const label = useMutation({
    mutationFn: (l: 'PASS' | 'FAIL' | 'UNKNOWN') => {
      setExitDir(l)
      return api.post('/api/calibration/annotations', { trial_id: current!.trial_id, dimension, label: l, annotator, note })
    },
    onSuccess: (_d, l) => {
      setReveal({ trial: current!.trial_id, human: l })
      setNote('')
      if (total + 1 === SAMPLE) setCelebrate(true)
      qc.invalidateQueries({ queryKey: ['calib-items'] }); qc.invalidateQueries({ queryKey: ['calib-stats'] }); qc.invalidateQueries({ queryKey: ['evaluators'] }); qc.invalidateQueries({ queryKey: ['models'] })
    },
  })
  const can = !!annotator && !!current && !label.isPending
  useHotkey('p', () => label.mutate('PASS'), can)
  useHotkey('f', () => label.mutate('FAIL'), can)
  useHotkey('u', () => label.mutate('UNKNOWN'), can)
  const revealed = reveal ? all.find((i) => i.trial_id === reveal.trial) : null
  useEffect(() => { const t = setTimeout(() => setReveal(null), 4500); return () => clearTimeout(t) }, [reveal])

  if (editingName) {
    return (
      <Card className="max-w-lg" title="Who is labelling?">
        <p className="mb-3 text-[13px] text-ink-2">Labels are stored per person, so two people's judgements can be compared later. You only enter this once.</p>
        <div className="flex gap-2">
          <Input value={nameDraft} onChange={(e) => setNameDraft(e.target.value)} placeholder="Your name" aria-label="Your name" autoFocus onKeyDown={(e) => { if (e.key === 'Enter' && nameDraft.trim()) { prefs.set('annotator', nameDraft.trim()); setEditingName(false) } }} />
          <Button variant="primary" disabled={!nameDraft.trim()} onClick={() => { prefs.set('annotator', nameDraft.trim()); setEditingName(false) }}>Start labelling</Button>
        </div>
      </Card>
    )
  }
  return (
    <div className="grid gap-5 xl:grid-cols-[minmax(0,1fr)_360px]">
      <Confetti fire={celebrate} />
      <div className="min-w-0" data-tour="flashcard">
        <div className="mb-3 flex flex-wrap items-center gap-2 text-xs text-ink-3">
          <span>Labelling as <b className="text-ink">{annotator}</b></span>
          <button type="button" onClick={() => setEditingName(true)} className="text-accent-ink hover:underline" aria-label="Change name"><Pencil className="inline size-3" /></button>
          <Select className="ml-auto w-64" value={runId} onChange={(e) => setRunId(e.target.value ? Number(e.target.value) : '')} aria-label="Run">
            <option value="">Answers from all runs</option>{(runs.data ?? []).map((r) => <option key={r.id} value={r.id}>#{r.id} {r.experiment}</option>)}
          </Select>
        </div>
        {items.isLoading ? <Loading rows={8} /> : items.isError ? <ErrorState error={items.error} /> : !current ? (
          <Empty title={all.length ? 'All caught up' : 'Nothing to label'} icon={<Check className="size-6" />}>
            {all.length ? `You have labelled every ${dimension} answer in this selection.` : <>Run something with the <b>{dimension}</b> check and a grading model (even the heuristic one), then come back.</>}
          </Empty>
        ) : (
          <div className="relative">
            <AnimatePresence mode="popLayout" initial={false}>
              <motion.div key={current.trial_id}
                initial={{ opacity: 0, y: 24, scale: 0.97 }} animate={{ opacity: 1, y: 0, scale: 1 }}
                exit={{ opacity: 0, x: exitDir === 'PASS' ? 260 : exitDir === 'FAIL' ? -260 : 0, y: exitDir === 'UNKNOWN' ? -80 : 0, rotate: exitDir === 'PASS' ? 8 : exitDir === 'FAIL' ? -8 : 0 }}
                transition={{ type: 'spring', stiffness: 320, damping: 30 }}
                className="rounded-2xl border border-line bg-surface p-5 shadow-pop">
                <div className="mb-3 flex items-center justify-between text-xs text-ink-3">
                  <span>Case <span className="font-mono">{current.case_id}</span> - run <Link className="underline" to={`/runs/${current.run_id}`}>#{current.run_id}</Link> - try {current.trial_index + 1}</span>
                  <span>{queue.length} left</span>
                </div>
                <div className="space-y-4 text-[13px]">
                  <div><div className="text-xs font-medium text-ink-3">Question</div><div className="mt-0.5 text-[15px]">{current.question}</div></div>
                  {current.reference && <div><div className="text-xs font-medium text-ink-3">Reference answer</div><div className="mt-0.5 rounded-lg bg-good-wash/40 px-3 py-2">{current.reference}</div></div>}
                  <div>
                    <div className="text-xs font-medium text-ink-3">Answer to grade - is it {dimension.replace(/_/g, ' ')}?</div>
                    <div className="mt-0.5 whitespace-pre-wrap rounded-lg border border-line bg-surface-2/50 px-3 py-2.5 text-[14px] leading-relaxed"><HighlightedAnswer text={current.answer} good={[]} bad={[]} /></div>
                  </div>
                  {current.context.length > 0 && (
                    <details className="group"><summary className="flex cursor-pointer items-center gap-1 text-xs font-medium text-accent-ink"><ChevronRight className="size-3.5 transition-transform group-open:rotate-90" />Retrieved context ({current.context.length})</summary>
                      <ul className="mt-2 space-y-2">{current.context.map((c) => <li key={c.id} className="rounded-lg border border-line p-2 text-xs"><div className="font-mono">{c.id}</div><div className="text-ink-2">{c.text}</div></li>)}</ul>
                    </details>
                  )}
                  {current.tool_calls && current.tool_calls.length > 0 && <div className="font-mono text-xs text-ink-2">{current.tool_calls.map((t, i) => <div key={i}>{t.name}({JSON.stringify(t.arguments)}) {'->'} {JSON.stringify(t.result)}</div>)}</div>}
                  <Field label="Note (optional)"><Input value={note} onChange={(e) => setNote(e.target.value)} placeholder="Why - helps when you look at disagreements" /></Field>
                  {label.isError && <ErrorState error={label.error} />}
                  <div className="grid grid-cols-3 gap-2">
                    <Button size="lg" variant="good" disabled={!can} onClick={() => label.mutate('PASS')}><Check className="size-4" />PASS <Kbd>P</Kbd></Button>
                    <Button size="lg" variant="bad" disabled={!can} onClick={() => label.mutate('FAIL')}><X className="size-4" />FAIL <Kbd>F</Kbd></Button>
                    <Button size="lg" disabled={!can} onClick={() => label.mutate('UNKNOWN')}><HelpCircle className="size-4" />UNKNOWN <Kbd>U</Kbd></Button>
                  </div>
                  <p className="text-center text-xs text-ink-3">The judge's verdict stays hidden until you label, so it cannot anchor your judgement.</p>
                </div>
              </motion.div>
            </AnimatePresence>
          </div>
        )}
      </div>
      <div className="space-y-4">
        <Card title="Progress">
          <div className="mb-1 flex items-baseline justify-between text-[13px]"><span>{dimension.replace(/_/g, ' ')}</span><span className="num font-semibold">{Math.min(total, SAMPLE)} / {SAMPLE}</span></div>
          <ProgressBar value={total / SAMPLE} tone={total >= SAMPLE ? 'good' : 'accent'} />
          <p className="mt-1.5 text-xs text-ink-3">{total >= SAMPLE ? 'A useful sample: the agreement figures mean something now.' : `${SAMPLE - total} more for a sample worth reading.`}</p>
          <div className="mt-4"><KappaMeter kappa={stats?.agreement.kappa ?? null} n={stats?.agreement.n ?? 0} /></div>
        </Card>
        <AnimatePresence>
          {reveal && revealed?.judge && (
            <motion.div initial={{ opacity: 0, y: 10 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0 }}
              className={clsx('rounded-xl border p-3 text-[13px]', revealed.judge.label === reveal.human ? 'border-good/40 bg-good-wash' : 'border-warn/40 bg-warn-wash')}>
              <div className="font-medium">{revealed.judge.label === reveal.human ? 'The judge agreed with you' : `The judge said ${revealed.judge.label}`}</div>
              <div className="mt-0.5 line-clamp-3 text-xs text-ink-2">{revealed.judge.reason}</div>
            </motion.div>
          )}
        </AnimatePresence>
        <Explain>Label what a careful expert would say, not what you think the judge will say. Disagreements are the useful part: they show where the judge cannot be trusted.</Explain>
      </div>
    </div>
  )
}

function AgreementTab({ s }: { s: CalibrationStats }) {
  return (
    <div className="grid gap-5 xl:grid-cols-[minmax(0,1fr)_480px]">
      <Card title={`You vs the judge - ${s.dimension.replace(/_/g, ' ')}${s.judge_filter ? ` - ${s.judge_filter}` : ''}`}><AgreementPanel s={s} /></Card>
      <Card title="Where you and the judge disagree" padded={false}>
        {s.disagreements.length === 0 ? <p className="p-4 text-[13px] text-ink-3">No disagreements yet.</p> : (
          <ul className="divide-y divide-line">
            {s.disagreements.map((d) => (
              <li key={d.trial_id} className="px-4 py-3 text-[13px]">
                <div className="flex items-center gap-2"><Link className="font-mono text-xs text-accent-ink hover:underline" to={`/trials/${d.trial_id}`}>{d.case_id}</Link><Badge tone={d.human === 'PASS' ? 'good' : 'bad'}>you: {d.human}</Badge><Badge tone={d.judge === 'PASS' ? 'good' : 'bad'}>judge: {d.judge}</Badge></div>
                <div className="mt-1 text-xs text-ink-2">Judge: {d.judge_reason}</div>
                {d.note && <div className="text-xs text-ink-3">You: {d.note}</div>}
              </li>
            ))}
          </ul>
        )}
        {s.judges.length > 0 && <p className="border-t border-line px-4 py-2 text-xs text-ink-3">Judges in this sample: {s.judges.map((j) => `${j.provider}/${j.model}`).join('; ')}. Agreement is specific to a judge model and rubric version.</p>}
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
  const current = useQuery({
    queryKey: ['bakeoff', active], queryFn: () => api.get<Bakeoff>(`/api/bakeoffs/${active}`), enabled: active !== null,
    refetchInterval: (q) => (q.state.data?.status === 'running' ? 1000 : false),
  })
  const shown = current.data ?? past.data?.[0] ?? null
  const start = useMutation({
    mutationFn: () => api.post<Bakeoff>('/api/bakeoffs', { dimension, judges: picked.map((p) => (p === 'heuristic' ? { provider: 'heuristic' } : { provider_config_id: Number(p) })) }),
    onSuccess: (b) => { setActive(b.id); qc.invalidateQueries({ queryKey: ['bakeoffs'] }) },
  })
  const toggle = (id: string) => setPicked((p) => (p.includes(id) ? p.filter((x) => x !== id) : p.length >= 4 ? p : [...p, id]))
  const n = count.data?.n ?? 0
  const winner = shown?.results?.winner
  return (
    <div className="space-y-5">
      <Card title="Which grading model agrees with you most?" subtitle={`Each judge grades the ${n} ${dimension.replace(/_/g, ' ')} answer(s) you labelled; GaugeLab compares their verdicts with yours.`}>
        {n === 0 ? <Notice tone="warn" title="Label some answers first">The bake-off needs your PASS/FAIL labels. Label a few on the first tab.</Notice> : (
          <>
            <div className="flex flex-wrap gap-2">
              {[{ id: 'heuristic', name: 'Heuristic (word overlap)', local: true }, ...(models.data ?? []).map((m) => ({ id: String(m.id), name: m.name, local: !!m.local, where: whereLabel(m) }))].map((m) => (
                <button key={m.id} type="button" onClick={() => toggle(m.id)} aria-pressed={picked.includes(m.id)}
                  className={clsx('flex items-center gap-2 rounded-lg border px-3 py-2 text-[13px] transition-colors', picked.includes(m.id) ? 'border-accent bg-accent-wash text-accent-ink' : 'border-line hover:bg-surface-2')}>
                  {picked.includes(m.id) ? <Check className="size-3.5" /> : <span className="size-3.5" />}{m.name}<Badge>{'where' in m ? m.where : 'local'}</Badge>
                </button>
              ))}
            </div>
            <div className="mt-3 flex items-center gap-3">
              <Button variant="primary" loading={start.isPending} disabled={!picked.length || shown?.status === 'running'} onClick={() => start.mutate()}><Play className="size-3.5" />Run the bake-off ({picked.length} judge{picked.length === 1 ? '' : 's'} x {n} answers)</Button>
              <span className="text-xs text-ink-3">A local model on a CPU takes ~30 s per answer; cloud models cost money (see Settings for the per-100 price).</span>
            </div>
            {start.isError && <div className="mt-2"><ErrorState error={start.error} /></div>}
          </>
        )}
      </Card>
      {shown && (
        <Card title={`Results - ${shown.dimension.replace(/_/g, ' ')}`} subtitle={new Date(shown.created_at).toLocaleString()}>
          {shown.status === 'running' && <div className="mb-3"><div className="mb-1 text-xs text-ink-3">Grading {shown.progress_done} of {shown.progress_total}</div><ProgressBar value={shown.progress_total ? shown.progress_done / shown.progress_total : 0} /></div>}
          {shown.status === 'failed' && <Notice tone="bad" title="The bake-off failed">{shown.error}</Notice>}
          {shown.results && (
            <>
              <Table>
                <thead><tr><th>Judge</th><th><Term k="kappa">Agreement (kappa)</Term></th><th className="text-right">Accuracy</th><th className="text-right">F1 (FAIL)</th><th className="text-right">No verdict</th><th className="text-right">Speed</th><th className="text-right">Cost</th></tr></thead>
                <tbody>
                  {[...shown.results.judges].sort((a, b) => (b.agreement.kappa ?? -2) - (a.agreement.kappa ?? -2)).map((j, i) => (
                    <motion.tr key={j.name} initial={{ opacity: 0, x: -8 }} animate={{ opacity: 1, x: 0 }} transition={{ delay: i * 0.08 }} className={clsx(j.name.startsWith('heuristic') && 'hatched')}>
                      <td className="font-medium">{winner === j.name && <Crown className="mr-1 inline size-4 text-warn" />}{j.name}</td>
                      <td className="w-56">
                        <div className="flex items-center gap-2">
                          <div className="h-2 flex-1 rounded-full bg-surface-2"><motion.div className="h-full rounded-full bg-accent" initial={{ width: 0 }} animate={{ width: `${Math.max(0, (j.agreement.kappa ?? 0)) * 100}%` }} transition={{ delay: 0.2 + i * 0.08, type: 'spring', stiffness: 90, damping: 18 }} /></div>
                          <span className="num w-10 text-right text-xs">{j.agreement.kappa === null ? 'n/a' : j.agreement.kappa.toFixed(2)}</span>
                        </div>
                      </td>
                      <td className="num text-right">{pct(j.agreement.accuracy)}</td>
                      <td className="num text-right">{pct(j.agreement.f1)}</td>
                      <td className="num text-right">{j.unknown}</td>
                      <td className="num text-right">{ms(j.median_ms)}</td>
                      <td className="num text-right">{usd(j.cost_usd)}</td>
                    </motion.tr>
                  ))}
                </tbody>
              </Table>
              {shown.results.pairwise.length > 0 && <p className="mt-3 text-xs text-ink-3">Judges agreeing with each other: {shown.results.pairwise.map((p) => `${p.a} vs ${p.b}: kappa ${p.kappa === null ? 'n/a' : p.kappa.toFixed(2)}`).join('; ')}.</p>}
              <Explain className="mt-2">Pick the cheapest judge whose agreement with you is close to the best. A judge that agrees with you no better than chance (kappa near 0) should not gate a release.</Explain>
            </>
          )}
        </Card>
      )}
    </div>
  )
}
