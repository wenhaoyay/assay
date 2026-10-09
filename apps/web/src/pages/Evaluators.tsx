import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { useState } from 'react'
import { Link } from 'react-router-dom'
import { Badge, Button, Card, Empty, ErrorState, Field, Input, Json, Loading, Notice, PageHeader } from '../components/ui'
import { TextLink } from '../components/form'
import { ScrollTable } from '../components/Layout'
import { api } from '../lib/api'
import { useCrumbs } from '../lib/crumbs'
import type { EvaluatorInfo } from '../lib/types'

const KINDS: [EvaluatorInfo['kind'], string, string][] = [
  ['deterministic', 'Objective checks', 'Decided by code. Preferred whenever the answer can be checked objectively.'],
  ['retrieval', 'Search', 'Search measures (such as recall) over the documents a person marked as relevant. Search quality is not answer quality.'],
  ['agent', 'Tools and agents', 'Required behaviour and outcomes, not one fixed sequence of steps.'],
  ['performance', 'Speed and cost', 'Speed, token and cost limits for each try.'],
  ['llm_judge', 'Meaning (needs a grading model)', 'Only where meaning must be judged. Each check has a versioned rubric (pass, fail or not sure) and asks for a strictly formatted reply; the answer being graded is fenced off so it cannot give the grading model instructions.'],
]

export function EvaluatorsPage() {
  useCrumbs([{ label: 'Grading' }, { label: 'Checks' }], 'evaluators')
  return (
    <>
      <PageHeader title="Checks" help={<>
        <p>The checks Assay can run, grouped by how they decide. Every score names the check and version that produced it.</p>
        <p>Gating checks count toward the pass rate; diagnostic ones are shown but never fail a run. Checks that use a grading model show their rubric and prompt.</p>
        <p>Grading models are set up in <Link className="text-accent-ink underline" to="/settings?tab=models">Settings &gt; Models &amp; keys</Link>.</p>
      </>} />
      <EvaluatorList />
    </>
  )
}

function EvaluatorList() {
  const q = useQuery({ queryKey: ['evaluators'], queryFn: () => api.get<{ evaluators: EvaluatorInfo[] }>('/api/evaluators') })
  const [open, setOpen] = useState<string | null>(null)
  if (q.isLoading) return <Loading />
  if (q.isError) return <ErrorState error={q.error} />
  return (
    <div className="space-y-12">
      {KINDS.map(([kind, title, desc]) => {
        const list = q.data!.evaluators.filter((e) => e.kind === kind)
        return (
        <Card key={kind} title={title} help={<p>{desc}</p>} meta={`${list.length}`} padded={false}>
          {list.length === 0 ? <div className="py-4"><Empty title="No checks of this kind yet" /></div> : (
          <ScrollTable className="[&_table]:min-w-[860px] [&_table]:table-fixed">
            <colgroup><col className="w-64" /><col /><col className="w-20" /><col className="w-28" /><col className="w-36" /></colgroup>
            <thead><tr><th className="t-label">Check</th><th className="t-label">What it does</th><th className="t-label">Version</th><th className="t-label">Counts</th><th className="t-label">Calibration</th></tr></thead>
            <tbody>
              {list.map((e) => (
                <tr key={e.id} className="align-top">
                  <td><div className="font-medium text-ink">{e.name}</div><code className="break-all font-mono text-xs text-ink-3">{e.id}</code></td>
                  <td className="text-ink-2">{e.description}
                    {e.rubric && (
                      <div className="mt-1 flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-ink-3">
                        <span className="font-mono">Prompt version {e.rubric.prompt_hash}</span>
                        <TextLink size="sm" onClick={() => setOpen(open === e.id ? null : e.id)}>{open === e.id ? 'Hide rubric' : 'Show rubric and prompt'}</TextLink>
                      </div>
                    )}
                    {e.rubric && open === e.id && (
                      <div className="mt-2 space-y-2">
                        <dl className="space-y-1 text-xs">{Object.entries(e.rubric.labels).map(([l, d]) => <div key={l}><dt className="inline font-mono font-semibold text-ink">{l}: </dt><dd className="inline">{d}</dd></div>)}</dl>
                        {e.rubric.notes && <p className="text-xs italic">{e.rubric.notes}</p>}
                        <Json value={e.rubric.system_prompt} maxHeight={240} />
                      </div>
                    )}
                  </td>
                  <td><Badge className="font-mono">v{e.version}</Badge></td>
                  <td>{e.gating ? <Badge tone="accent">Gating</Badge> : <Badge>Diagnostic</Badge>}</td>
                  <td>{e.calibration && <Badge tone={e.calibration.sufficient ? 'pass' : 'unmeasured'}>{e.calibration.status}</Badge>}</td>
                </tr>
              ))}
            </tbody>
          </ScrollTable>
          )}
        </Card>
        )
      })}
    </div>
  )
}

const PRICE_FIELDS = { provider: 'Provider', model: 'Model', input_per_1m: 'Input per 1M tokens', output_per_1m: 'Output per 1M tokens', effective_from: 'Effective from', source_note: 'Source note' } as const

export function Pricing() {
  const qc = useQueryClient()
  const q = useQuery({ queryKey: ['pricing'], queryFn: () => api.get<{ provider: string; model: string; input_per_1m: number; output_per_1m: number; effective_from: string; source_note: string }[]>('/api/pricing') })
  const [f, setF] = useState(() => ({ provider: '', model: '', input_per_1m: '', output_per_1m: '', effective_from: new Date().toISOString().slice(0, 10), source_note: '' }))
  const add = useMutation({ mutationFn: () => api.post('/api/pricing', { ...f, input_per_1m: Number(f.input_per_1m), output_per_1m: Number(f.output_per_1m) }), onSuccess: () => qc.invalidateQueries({ queryKey: ['pricing'] }) })
  return (
    <div className="space-y-12">
      <Notice tone="warn" title="Costs are estimates">Assay multiplies reported token counts by this table. A model that is not listed shows cost as <span className="font-semibold">unknown</span>, never as zero. Prices change: every row records when it took effect and where it came from.</Notice>
      <Card title="Prices" meta={`${(q.data ?? []).length}`} padded={false}>
        <ScrollTable>
          <thead><tr className="whitespace-nowrap"><th className="t-label">Provider</th><th className="t-label">Model</th><th className="t-label text-right">Input / 1M</th><th className="t-label text-right">Output / 1M</th><th className="t-label">From</th><th className="t-label">Source</th></tr></thead>
          <tbody>{(q.data ?? []).map((p, i) => <tr key={i}><td>{p.provider}</td><td className="font-mono text-xs">{p.model}</td><td className="num text-right font-mono">${p.input_per_1m}</td><td className="num text-right font-mono">${p.output_per_1m}</td><td className="num font-mono text-xs">{p.effective_from}</td><td className="text-xs text-ink-2">{p.source_note}</td></tr>)}</tbody>
        </ScrollTable>
      </Card>
      <Card title="Add or override a price" boxed help={<p>A new row for a provider and model takes effect from its date; older runs keep the price that applied then. Say where the price came from.</p>}>
        <div className="grid grid-cols-2 gap-3 md:grid-cols-6">
          {(['provider', 'model', 'input_per_1m', 'output_per_1m', 'effective_from', 'source_note'] as const).map((k) => (
            <Field key={k} label={PRICE_FIELDS[k]}><Input value={f[k]} onChange={(e) => setF({ ...f, [k]: e.target.value })} /></Field>
          ))}
        </div>
        {add.isError && <div className="mt-2"><ErrorState error={add.error} /></div>}
        <Button className="mt-3" variant="primary" disabled={!f.provider || !f.model || !f.source_note} loading={add.isPending} onClick={() => add.mutate()}>Save price</Button>
      </Card>
    </div>
  )
}
