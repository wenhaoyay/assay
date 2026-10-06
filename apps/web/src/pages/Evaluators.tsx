import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { useState } from 'react'
import { useSearchParams } from 'react-router-dom'
import { Badge, Button, Card, ErrorState, Field, Input, Json, Loading, Notice, PageHeader, Select, Table, Tabs } from '../components/ui'
import { api } from '../lib/api'
import type { EvaluatorInfo, Project, ProviderConfig } from '../lib/types'

type ETab = 'evaluators' | 'providers' | 'pricing'
const KINDS: [EvaluatorInfo['kind'], string, string][] = [
  ['deterministic', 'Deterministic', 'Decided by code. Preferred whenever the answer can be checked objectively.'],
  ['retrieval', 'Retrieval', 'IR metrics over labelled relevant documents. Retrieval quality is not answer quality.'],
  ['agent', 'Agent / tool use', 'Required behaviour and outcomes, not one fixed trajectory.'],
  ['performance', 'Performance and cost', 'Latency and token/cost budgets per trial.'],
  ['llm_judge', 'LLM judge', 'Only where meaning must be judged. Versioned PASS/FAIL/UNKNOWN rubrics, strict JSON output, untrusted-content fencing.'],
]

export function EvaluatorsPage() {
  const [params, setParams] = useSearchParams()
  const tab = (params.get('tab') as ETab) ?? 'evaluators'
  return (
    <>
      <PageHeader title="Evaluators" description="Every score names the evaluator and version that produced it. Judges are pluggable and bring-your-own-key; nothing requires a paid API." />
      <Tabs tabs={[{ id: 'evaluators', label: 'Evaluators' }, { id: 'providers', label: 'Judge providers' }, { id: 'pricing', label: 'Pricing' }]} value={tab} onChange={(t) => setParams({ tab: t })} />
      <div className="mt-4">
        {tab === 'evaluators' && <EvaluatorList />}
        {tab === 'providers' && <Providers />}
        {tab === 'pricing' && <Pricing />}
      </div>
    </>
  )
}

function EvaluatorList() {
  const q = useQuery({ queryKey: ['evaluators'], queryFn: () => api.get<{ evaluators: EvaluatorInfo[] }>('/api/evaluators') })
  const [open, setOpen] = useState<string | null>(null)
  if (q.isLoading) return <Loading />
  if (q.isError) return <ErrorState error={q.error} />
  return (
    <div className="space-y-5">
      {KINDS.map(([kind, title, desc]) => (
        <Card key={kind} title={title} padded={false}>
          <p className="border-b border-line px-4 py-2 text-xs text-ink-2">{desc}</p>
          <Table>
            <tbody>
              {q.data!.evaluators.filter((e) => e.kind === kind).map((e) => (
                <tr key={e.id} className="align-top">
                  <td className="w-56"><div className="font-medium">{e.name}</div><code className="text-xs text-ink-3">{e.id}</code></td>
                  <td className="text-ink-2">{e.description}
                    {e.rubric && open === e.id && (
                      <div className="mt-2 space-y-2">
                        <dl className="space-y-1 text-xs">{Object.entries(e.rubric.labels).map(([l, d]) => <div key={l}><dt className="inline font-semibold">{l}: </dt><dd className="inline">{d}</dd></div>)}</dl>
                        {e.rubric.notes && <p className="text-xs italic">{e.rubric.notes}</p>}
                        <Json value={e.rubric.system_prompt} maxHeight={240} />
                      </div>
                    )}
                  </td>
                  <td className="w-60 space-y-1 text-right">
                    <div className="flex flex-wrap justify-end gap-1">
                      <Badge className="font-mono">v{e.version}</Badge>
                      {e.gating ? <Badge>gating</Badge> : <Badge tone="info">diagnostic</Badge>}
                      {e.calibration && <Badge tone={e.calibration.n ? 'good' : 'warn'}>{e.calibration.status}</Badge>}
                    </div>
                    {e.rubric && <div className="font-mono text-[11px] text-ink-3">prompt {e.rubric.prompt_hash}</div>}
                    {e.rubric && <button className="text-xs text-accent-ink hover:underline" onClick={() => setOpen(open === e.id ? null : e.id)}>{open === e.id ? 'Hide rubric' : 'Show rubric and prompt'}</button>}
                  </td>
                </tr>
              ))}
            </tbody>
          </Table>
        </Card>
      ))}
    </div>
  )
}

function Providers() {
  const qc = useQueryClient()
  const q = useQuery({ queryKey: ['providers'], queryFn: () => api.get<ProviderConfig[]>('/api/providers') })
  const projects = useQuery({ queryKey: ['projects'], queryFn: () => api.get<Project[]>('/api/projects') })
  const [form, setForm] = useState({ name: '', provider: 'openai', model: '', base_url: '', api_key_ref: 'env:OPENAI_API_KEY' })
  const [tests, setTests] = useState<Record<number, { ok: boolean; error?: string; elapsed_ms?: number; reply?: string }>>({})
  const create = useMutation({
    mutationFn: () => api.post('/api/providers', { ...form, project_id: projects.data?.[0]?.id ?? 1, base_url: form.base_url || null, api_key_ref: form.provider === 'ollama' ? null : form.api_key_ref || null }),
    onSuccess: () => { qc.invalidateQueries({ queryKey: ['providers'] }); setForm((f) => ({ ...f, name: '', model: '' })) },
  })
  const del = useMutation({ mutationFn: (id: number) => api.del(`/api/providers/${id}`), onSuccess: () => qc.invalidateQueries({ queryKey: ['providers'] }) })
  const test = useMutation({ mutationFn: (id: number) => api.post<{ ok: boolean }>(`/api/providers/${id}/test`), onSuccess: (r, id) => setTests((t) => ({ ...t, [id]: r })) })
  const setP = (provider: string) => setForm((f) => ({ ...f, provider, api_key_ref: provider === 'anthropic' ? 'env:ANTHROPIC_API_KEY' : provider === 'openai' ? 'env:OPENAI_API_KEY' : '', base_url: provider === 'ollama' ? 'http://localhost:11434' : '' }))

  return (
    <div className="grid gap-5 lg:grid-cols-[minmax(0,1fr)_380px]">
      <Card title="Configured providers" padded={false}>
        {q.isLoading ? <Loading /> : (
          <Table>
            <thead><tr><th>Name</th><th>Provider / model</th><th>Key</th><th></th></tr></thead>
            <tbody>
              {(q.data ?? []).map((p) => (
                <tr key={p.id} className="align-top">
                  <td className="font-medium">{p.name}</td>
                  <td><Badge>{p.provider}</Badge> <span className="font-mono text-xs">{p.model}</span>{p.base_url && <div className="font-mono text-xs text-ink-3">{p.base_url}</div>}</td>
                  <td>{p.api_key_ref ? <><code className="text-xs">{p.api_key_ref}</code> <Badge tone={p.key_status === 'set' ? 'good' : 'bad'}>{p.key_status === 'set' ? 'set on server' : 'missing'}</Badge></> : <span className="text-xs text-ink-3">none (local)</span>}</td>
                  <td className="space-y-1 text-right">
                    <div className="flex justify-end gap-1"><Button size="sm" loading={test.isPending && test.variables === p.id} onClick={() => test.mutate(p.id)}>Test</Button><Button size="sm" variant="ghost" onClick={() => del.mutate(p.id)}>Remove</Button></div>
                    {tests[p.id] && <div className={tests[p.id].ok ? 'text-xs text-good-ink' : 'text-xs text-bad-ink'}>{tests[p.id].ok ? `OK in ${tests[p.id].elapsed_ms} ms` : tests[p.id].error}</div>}
                  </td>
                </tr>
              ))}
            </tbody>
          </Table>
        )}
        {del.isError && <div className="p-3"><ErrorState error={del.error} /></div>}
      </Card>
      <div className="space-y-4">
        <Card title="Add a provider">
          <div className="space-y-3">
            <Field label="Name"><Input value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} placeholder="Cloud judge" /></Field>
            <Field label="Provider">
              <Select value={form.provider} onChange={(e) => setP(e.target.value)}>
                <option value="openai">OpenAI-compatible (OpenAI, Azure, vLLM, LM Studio...)</option>
                <option value="anthropic">Anthropic</option>
                <option value="ollama">Ollama (local)</option>
              </Select>
            </Field>
            <Field label="Model id"><Input value={form.model} onChange={(e) => setForm({ ...form, model: e.target.value })} placeholder={form.provider === 'ollama' ? 'llama3.1:8b' : 'model id'} /></Field>
            <Field label="Base URL (optional)"><Input value={form.base_url} onChange={(e) => setForm({ ...form, base_url: e.target.value })} /></Field>
            {form.provider !== 'ollama' && (
              <Field label="API key reference" hint="The NAME of a server environment variable, never the key itself.">
                <Input value={form.api_key_ref} onChange={(e) => setForm({ ...form, api_key_ref: e.target.value })} />
              </Field>
            )}
            {create.isError && <ErrorState error={create.error} />}
            <Button variant="primary" disabled={!form.name || !form.model} loading={create.isPending} onClick={() => create.mutate()}>Add provider</Button>
          </div>
        </Card>
        <Notice title="Bring your own key">
          Set the key in the API server's environment (for example in <code>.env</code>), then reference it here as <code>env:NAME</code>. Keys never reach the browser, the database or the logs. Ollama runs on this machine, so nothing is sent out.
        </Notice>
      </div>
    </div>
  )
}

function Pricing() {
  const qc = useQueryClient()
  const q = useQuery({ queryKey: ['pricing'], queryFn: () => api.get<{ provider: string; model: string; input_per_1m: number; output_per_1m: number; effective_from: string; source_note: string }[]>('/api/pricing') })
  const [f, setF] = useState({ provider: '', model: '', input_per_1m: '', output_per_1m: '', effective_from: new Date().toISOString().slice(0, 10), source_note: '' })
  const add = useMutation({ mutationFn: () => api.post('/api/pricing', { ...f, input_per_1m: Number(f.input_per_1m), output_per_1m: Number(f.output_per_1m) }), onSuccess: () => qc.invalidateQueries({ queryKey: ['pricing'] }) })
  return (
    <div className="space-y-4">
      <Notice tone="warn" title="Costs are estimates">GaugeLab multiplies reported token counts by this table. A model that is not listed shows cost as <b>unknown</b>, never as zero. Prices change: every row records when it took effect and where it came from.</Notice>
      <Card padded={false}>
        <Table>
          <thead><tr><th>Provider</th><th>Model</th><th className="text-right">Input / 1M</th><th className="text-right">Output / 1M</th><th>From</th><th>Source</th></tr></thead>
          <tbody>{(q.data ?? []).map((p, i) => <tr key={i}><td>{p.provider}</td><td className="font-mono text-xs">{p.model}</td><td className="num text-right">${p.input_per_1m}</td><td className="num text-right">${p.output_per_1m}</td><td className="num text-xs">{p.effective_from}</td><td className="text-xs text-ink-2">{p.source_note}</td></tr>)}</tbody>
        </Table>
      </Card>
      <Card title="Add or override a price">
        <div className="grid grid-cols-2 gap-3 md:grid-cols-6">
          {(['provider', 'model', 'input_per_1m', 'output_per_1m', 'effective_from', 'source_note'] as const).map((k) => (
            <Field key={k} label={k.replace(/_/g, ' ')}><Input value={f[k]} onChange={(e) => setF({ ...f, [k]: e.target.value })} /></Field>
          ))}
        </div>
        {add.isError && <div className="mt-2"><ErrorState error={add.error} /></div>}
        <Button className="mt-3" variant="primary" disabled={!f.provider || !f.model || !f.source_note} loading={add.isPending} onClick={() => add.mutate()}>Save price</Button>
      </Card>
    </div>
  )
}
