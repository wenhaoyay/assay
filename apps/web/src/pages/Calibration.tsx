import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import clsx from 'clsx'
import { useState } from 'react'
import { Link } from 'react-router-dom'
import { Badge, Button, Card, Empty, ErrorState, Field, Input, Loading, Notice, PageHeader, Select, Stat } from '../components/ui'
import { api, qs } from '../lib/api'
import { pct } from '../lib/format'
import type { Agreement, CalibrationItem, CalibrationStats, RunHeader } from '../lib/types'

const DIMENSIONS = ['correctness', 'groundedness', 'relevance', 'completeness', 'instruction_adherence', 'appropriate_refusal']
const LABELS = ['PASS', 'FAIL', 'UNKNOWN'] as const

export function ConfusionMatrix({ a }: { a: Agreement }) {
  const rows = LABELS.filter((h) => Object.values(a.confusion[h] ?? {}).some((v) => v > 0) || h !== 'UNKNOWN')
  const cols = LABELS.filter((j) => rows.some((h) => (a.confusion[h]?.[j] ?? 0) > 0) || j !== 'UNKNOWN')
  const max = Math.max(1, ...rows.flatMap((h) => cols.map((j) => a.confusion[h]?.[j] ?? 0)))
  return (
    <table className="text-[13px]" aria-label="Confusion matrix (rows: human, columns: judge)">
      <thead>
        <tr><th className="p-2 text-left text-xs font-normal text-ink-3">Human \ Judge</th>{cols.map((j) => <th key={j} className="p-2 text-xs font-medium text-ink-2">{j}</th>)}</tr>
      </thead>
      <tbody>
        {rows.map((h) => (
          <tr key={h}>
            <th className="p-2 text-left text-xs font-medium text-ink-2">{h}</th>
            {cols.map((j) => {
              const v = a.confusion[h]?.[j] ?? 0
              return (
                <td key={j} className={clsx('num h-12 w-16 rounded border border-surface text-center font-medium', h === j ? 'text-good-ink' : v ? 'text-bad-ink' : 'text-ink-3')}
                  style={{ background: v ? `color-mix(in srgb, var(--series-1) ${Math.round((v / max) * 35)}%, var(--surface))` : 'var(--surface-2)' }}
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
  if (a.n === 0) return <Empty title="Uncalibrated">No human labels yet for {s.dimension}. Until there are, treat this judge's verdicts as unvalidated.</Empty>
  return (
    <div className="space-y-4">
      <div className="flex items-center gap-2"><Badge tone="good">{s.status}</Badge>{s.small_sample && <Badge tone="warn">small sample - indicative only</Badge>}</div>
      <div className="grid grid-cols-2 gap-3 lg:grid-cols-5">
        <Stat label="Samples" value={a.n} />
        <Stat label="Accuracy" value={pct(a.accuracy)} />
        <Stat label="F1 (FAIL class)" value={pct(a.f1)} sub={`precision ${pct(a.precision)}, recall ${pct(a.recall)}`} title="FAIL is the class that matters: did the judge catch the bad answers a human caught?" />
        <Stat label="Cohen's kappa" value={a.kappa === null ? 'n/a' : a.kappa.toFixed(2)} sub="agreement beyond chance" />
        <Stat label="Disagreements" value={s.disagreements.length} />
      </div>
      <ConfusionMatrix a={a} />
      <p className="text-xs text-ink-3">Kappa corrects accuracy for agreement expected by chance: around 0.4 is moderate, above 0.6 substantial, above 0.8 near-perfect. With few samples the estimate is unstable.</p>
    </div>
  )
}

export function CalibrationPage() {
  const qc = useQueryClient()
  const [dimension, setDimension] = useState('correctness')
  const [runId, setRunId] = useState<number | ''>('')
  const [annotator, setAnnotator] = useState(() => { try { return localStorage.getItem('gl-reviewer') ?? '' } catch { return '' } })
  const [note, setNote] = useState('')
  const [onlyUnlabelled, setOnlyUnlabelled] = useState(true)
  const runs = useQuery({ queryKey: ['runs'], queryFn: () => api.get<RunHeader[]>('/api/runs') })
  const items = useQuery({
    queryKey: ['calib-items', dimension, runId, annotator],
    queryFn: () => api.get<CalibrationItem[]>(`/api/calibration/${dimension}/items${qs({ run_id: runId || undefined, annotator: annotator || undefined, blind: true })}`),
  })
  const stats = useQuery({ queryKey: ['calib-stats', dimension, runId], queryFn: () => api.get<CalibrationStats>(`/api/calibration/${dimension}/stats${qs({ run_id: runId || undefined })}`) })
  const queue = (items.data ?? []).filter((i) => !onlyUnlabelled || !i.human)
  const current = queue[0]
  const label = useMutation({
    mutationFn: (l: string) => {
      try { localStorage.setItem('gl-reviewer', annotator) } catch { /* ignore */ }
      return api.post('/api/calibration/annotations', { trial_id: current!.trial_id, dimension, label: l, annotator, note })
    },
    onSuccess: () => { setNote(''); qc.invalidateQueries({ queryKey: ['calib-items'] }); qc.invalidateQueries({ queryKey: ['calib-stats'] }); qc.invalidateQueries({ queryKey: ['evaluators'] }) },
  })

  return (
    <>
      <PageHeader
        title="Calibration"
        description="Is the LLM judge right? Label a sample of answers yourself; GaugeLab compares your labels with the judge's. A judge is shown as validated only once human labels exist."
        actions={
          <>
            <Select className="w-52" value={dimension} onChange={(e) => setDimension(e.target.value)} aria-label="Dimension">{DIMENSIONS.map((d) => <option key={d}>{d}</option>)}</Select>
            <Select className="w-64" value={runId} onChange={(e) => setRunId(e.target.value ? Number(e.target.value) : '')} aria-label="Run">
              <option value="">All runs</option>{(runs.data ?? []).map((r) => <option key={r.id} value={r.id}>#{r.id} {r.experiment}</option>)}
            </Select>
          </>
        }
      />
      <div className="grid gap-5 xl:grid-cols-[minmax(0,1fr)_520px]">
        <Card
          title="Label (blind)"
          actions={<><label className="flex items-center gap-1.5 text-xs text-ink-2"><input type="checkbox" checked={onlyUnlabelled} onChange={(e) => setOnlyUnlabelled(e.target.checked)} />unlabelled only</label><span className="text-xs text-ink-3">{queue.length} in queue</span></>}
        >
          <div className="mb-3"><Field label="Your name" hint="Labels are stored per annotator."><Input value={annotator} onChange={(e) => setAnnotator(e.target.value)} className="max-w-60" /></Field></div>
          {items.isLoading ? <Loading /> : items.isError ? <ErrorState error={items.error} /> : !current ? (
            <Empty title="Nothing to label">Run an experiment with the <b>{dimension}</b> judge enabled (any judge, including the heuristic), then come back.</Empty>
          ) : (
            <div className="space-y-3 text-[13px]">
              <Notice>The judge's verdict is hidden until you label, so it cannot anchor your judgement.</Notice>
              <div className="text-xs text-ink-3">Case <span className="font-mono">{current.case_id}</span> - run <Link className="underline" to={`/runs/${current.run_id}`}>#{current.run_id}</Link> - trial {current.trial_index + 1}</div>
              <div><div className="text-xs text-ink-3">Question</div><div>{current.question}</div></div>
              {current.reference && <div><div className="text-xs text-ink-3">Reference answer</div><div>{current.reference}</div></div>}
              <div><div className="text-xs text-ink-3">Answer to grade</div><div className="whitespace-pre-wrap rounded-md border border-line bg-surface-2/50 px-3 py-2">{current.answer}</div></div>
              {current.context.length > 0 && (
                <details><summary className="cursor-pointer text-xs text-accent-ink">Retrieved context ({current.context.length})</summary>
                  <ul className="mt-2 space-y-2">{current.context.map((c) => <li key={c.id} className="rounded border border-line p-2 text-xs"><div className="font-mono">{c.id}</div><div className="text-ink-2">{c.text}</div></li>)}</ul>
                </details>
              )}
              {current.tool_calls && current.tool_calls.length > 0 && <div className="font-mono text-xs text-ink-2">{current.tool_calls.map((t, i) => <div key={i}>{t.name}({JSON.stringify(t.arguments)}) {'->'} {JSON.stringify(t.result)}</div>)}</div>}
              <Field label="Note (optional)"><Input value={note} onChange={(e) => setNote(e.target.value)} /></Field>
              {!annotator && <p className="text-xs text-warn-ink">Enter your name to label.</p>}
              {label.isError && <ErrorState error={label.error} />}
              <div className="flex gap-2">
                <Button variant="primary" className="bg-good text-white hover:bg-good/85" disabled={!annotator} loading={label.isPending} onClick={() => label.mutate('PASS')}>PASS</Button>
                <Button variant="danger" disabled={!annotator} onClick={() => label.mutate('FAIL')}>FAIL</Button>
                <Button disabled={!annotator} onClick={() => label.mutate('UNKNOWN')}>UNKNOWN</Button>
              </div>
            </div>
          )}
        </Card>
        <div className="space-y-5">
          <Card title={`Human vs judge - ${dimension}`}>
            {stats.isLoading ? <Loading /> : stats.isError ? <ErrorState error={stats.error} /> : <AgreementPanel s={stats.data!} />}
          </Card>
          {stats.data && stats.data.disagreements.length > 0 && (
            <Card title="Where you and the judge disagree">
              <ul className="space-y-3">
                {stats.data.disagreements.map((d) => (
                  <li key={d.trial_id} className="text-[13px]">
                    <div className="flex items-center gap-2"><Link className="font-mono text-xs text-accent-ink hover:underline" to={`/trials/${d.trial_id}`}>{d.case_id}</Link><Badge tone={d.human === 'PASS' ? 'good' : 'bad'}>human {d.human}</Badge><Badge tone={d.judge === 'PASS' ? 'good' : 'bad'}>judge {d.judge}</Badge></div>
                    <div className="mt-1 text-xs text-ink-2">Judge: {d.judge_reason}</div>
                    {d.note && <div className="text-xs text-ink-3">You: {d.note}</div>}
                  </li>
                ))}
              </ul>
            </Card>
          )}
          {stats.data && stats.data.judges.length > 0 && (
            <p className="text-xs text-ink-3">Judges in this sample: {stats.data.judges.map((j) => `${j.provider}/${j.model} (prompt ${j.prompt_hash})`).join('; ')}. Agreement is specific to a judge model and rubric version.</p>
          )}
        </div>
      </div>
    </>
  )
}
