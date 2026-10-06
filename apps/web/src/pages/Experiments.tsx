import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { Play, Plus } from 'lucide-react'
import { useMemo, useState } from 'react'
import { Link, useNavigate } from 'react-router-dom'
import { RunsTable } from '../components/RunsTable'
import { Badge, Button, Card, Empty, ErrorState, Field, Input, Loading, Notice, PageHeader, Select, Textarea } from '../components/ui'
import { api } from '../lib/api'
import { type SetupState, validateSetup } from '../lib/compare'
import { usd } from '../lib/format'
import type { Dataset, EvaluatorInfo, Experiment, Gate, Project, ProviderConfig, RunHeader, Target } from '../lib/types'

export function ExperimentsPage() {
  const runs = useQuery({
    queryKey: ['runs'],
    queryFn: () => api.get<RunHeader[]>('/api/runs'),
    refetchInterval: (q) => (q.state.data?.some((r) => r.status === 'running' || r.status === 'queued') ? 2000 : false),
  })
  return (
    <>
      <PageHeader
        title="Experiments"
        description="An experiment binds a target version, a dataset version, evaluators, a judge and a trial count. Each launch is a run with a full snapshot of what it used."
        actions={<Link to="/experiments/new" className="inline-flex h-8 items-center gap-1.5 rounded-md bg-ink px-3 text-[13px] font-medium text-surface hover:bg-ink/85"><Plus className="size-3.5" /> New experiment</Link>}
      />
      <div className="space-y-5">
        <Card title="Runs" padded={false}>
          {runs.isLoading ? <Loading /> : runs.isError ? <ErrorState error={runs.error} /> : runs.data!.length === 0 ? (
            <div className="p-4"><Empty title="No runs yet">Create an experiment, or run <code>gaugelab seed --run</code> for a baseline and a candidate run of the Acme demo.</Empty></div>
          ) : <RunsTable runs={runs.data!} />}
        </Card>
        <GatesCard />
      </div>
    </>
  )
}

const KIND_ORDER: EvaluatorInfo['kind'][] = ['deterministic', 'retrieval', 'agent', 'performance', 'llm_judge']
const KIND_LABEL: Record<string, string> = {
  deterministic: 'Deterministic checks', retrieval: 'Retrieval (needs labelled documents)', agent: 'Agent / tool use',
  performance: 'Latency and cost', llm_judge: 'LLM judge (semantic; needs a judge)',
}

export function NewExperimentPage() {
  const nav = useNavigate()
  const qc = useQueryClient()
  const targets = useQuery({ queryKey: ['targets'], queryFn: () => api.get<Target[]>('/api/targets') })
  const datasets = useQuery({ queryKey: ['datasets'], queryFn: () => api.get<Dataset[]>('/api/datasets') })
  const evs = useQuery({ queryKey: ['evaluators'], queryFn: () => api.get<{ evaluators: EvaluatorInfo[]; defaults: string[]; judges: string[] }>('/api/evaluators') })
  const providers = useQuery({ queryKey: ['providers'], queryFn: () => api.get<ProviderConfig[]>('/api/providers') })
  const gates = useQuery({ queryKey: ['gates'], queryFn: () => api.get<Gate[]>('/api/gates') })
  const projects = useQuery({ queryKey: ['projects'], queryFn: () => api.get<Project[]>('/api/projects') })

  const [name, setName] = useState('')
  const [form, setSetup] = useState<Omit<SetupState, 'evaluators'> & { evaluators: string[] | null }>({ targetVersionId: '', datasetVersionId: '', evaluators: null, judge: '' })
  const [trials, setTrials] = useState(3)
  const [concurrency, setConcurrency] = useState(4)
  const [budget, setBudget] = useState('')
  const [gateId, setGateId] = useState<number | ''>('')
  const [maxLatency, setMaxLatency] = useState('')
  const [created, setCreated] = useState<Experiment | null>(null)
  const [touched, setTouched] = useState(false)
  const evaluators = evs.data?.evaluators ?? []
  const judgeIds = evs.data?.judges ?? []
  // Until the user picks, the default set applies; each evaluator only runs where a case asks for it.
  const setup: SetupState = { ...form, evaluators: form.evaluators ?? evs.data?.defaults ?? [] }
  const errors = validateSetup(setup, judgeIds)

  const datasetVersions = useMemo(() => (datasets.data ?? []).flatMap((d) => d.versions.map((v) => ({ d, v }))), [datasets.data])

  const create = useMutation({
    mutationFn: () => {
      const tv = (targets.data ?? []).find((t) => t.versions?.some((v) => v.id === setup.targetVersionId) || t.latest_version.id === setup.targetVersionId)
      return api.post<Experiment>('/api/experiments', {
        project_id: tv?.project_id ?? projects.data?.[0]?.id,
        name: name || 'experiment',
        target_version_id: setup.targetVersionId,
        dataset_version_id: setup.datasetVersionId,
        evaluators: setup.evaluators,
        judge: setup.judge === '' ? null : setup.judge === 'heuristic' ? { provider: 'heuristic' } : { provider_config_id: Number(setup.judge) },
        trials, concurrency,
        budget_usd: budget ? Number(budget) : null,
        gate_id: gateId || null,
        options: maxLatency ? { max_latency_ms: Number(maxLatency) } : {},
      })
    },
    onSuccess: setCreated,
  })
  const estimate = useQuery({
    queryKey: ['estimate', created?.id],
    queryFn: () => api.get<{ judge_calls: number; estimated_cost_usd: number | null; input_tokens?: number; note: string }>(`/api/experiments/${created!.id}/estimate`),
    enabled: !!created,
  })
  const launch = useMutation({
    mutationFn: () => api.post<RunHeader>(`/api/experiments/${created!.id}/run`),
    onSuccess: (r) => { qc.invalidateQueries({ queryKey: ['runs'] }); nav(`/runs/${r.id}`) },
  })

  if (targets.isLoading || datasets.isLoading || evs.isLoading) return <Loading />
  const toggle = (id: string) => {
    setTouched(true)
    const cur = setup.evaluators
    setSetup((s) => ({ ...s, evaluators: cur.includes(id) ? cur.filter((x) => x !== id) : [...cur, id] }))
  }

  return (
    <>
      <PageHeader title="New experiment" description="Objective checks run on every case where the case defines what to check. LLM judges are optional and only used where meaning must be judged." />
      <div className="grid gap-5 xl:grid-cols-[minmax(0,1fr)_380px]">
        <div className="space-y-5">
          <Card title="What to test">
            <div className="grid gap-3 md:grid-cols-2">
              <Field label="Experiment name"><Input value={name} onChange={(e) => setName(e.target.value)} placeholder="hybrid-retrieval-v2" /></Field>
              <Field label="Target (version)">
                <Select value={setup.targetVersionId} onChange={(e) => setSetup({ ...form, targetVersionId: e.target.value ? Number(e.target.value) : '' })} aria-label="Target">
                  <option value="">Choose...</option>
                  {(targets.data ?? []).map((t) => <option key={t.id} value={t.latest_version.id}>{t.name} - v{t.latest_version.version}{t.latest_version.variant_label ? ` (${t.latest_version.variant_label})` : ''}</option>)}
                </Select>
              </Field>
              <Field label="Dataset version" hint="Running freezes this version; later edits create a new one.">
                <Select value={setup.datasetVersionId} onChange={(e) => setSetup({ ...form, datasetVersionId: e.target.value ? Number(e.target.value) : '' })} aria-label="Dataset version">
                  <option value="">Choose...</option>
                  {datasetVersions.map(({ d, v }) => <option key={v.id} value={v.id}>{d.name} v{v.version} ({v.case_count} cases, {v.status})</option>)}
                </Select>
              </Field>
              <Field label="Regression gate (optional)">
                <Select value={gateId} onChange={(e) => setGateId(e.target.value ? Number(e.target.value) : '')}>
                  <option value="">None</option>
                  {(gates.data ?? []).map((g) => <option key={g.id} value={g.id}>{g.name}</option>)}
                </Select>
              </Field>
            </div>
          </Card>
          <Card title={`Evaluators (${setup.evaluators.length} selected)`}>
            <div className="grid gap-5 md:grid-cols-2">
              {KIND_ORDER.map((kind) => (
                <fieldset key={kind}>
                  <legend className="mb-1.5 text-xs font-semibold text-ink-2">{KIND_LABEL[kind]}</legend>
                  <div className="space-y-1">
                    {evaluators.filter((e) => e.kind === kind).map((e) => (
                      <label key={e.id} className="flex items-start gap-2 text-[13px]" title={e.description}>
                        <input type="checkbox" className="mt-0.5" checked={setup.evaluators.includes(e.id)} onChange={() => toggle(e.id)} />
                        <span>
                          {e.name}
                          {!e.gating && <span className="ml-1 text-xs text-ink-3">(diagnostic)</span>}
                          {e.calibration && <span className="ml-1 text-xs text-ink-3">- {e.calibration.status}</span>}
                        </span>
                      </label>
                    ))}
                  </div>
                </fieldset>
              ))}
            </div>
          </Card>
        </div>
        <div className="space-y-5">
          <Card title="Judge and trials">
            <div className="space-y-3">
              <Field label="Judge" hint="Heuristic = word overlap, free and offline, never fails a trial on its own. A real judge (BYOK or local Ollama) is needed for semantic checks.">
                <Select value={setup.judge} onChange={(e) => setSetup({ ...form, judge: e.target.value })} aria-label="Judge">
                  <option value="">No judge</option>
                  <option value="heuristic">Heuristic (zero cost, not an LLM)</option>
                  {(providers.data ?? []).map((p) => <option key={p.id} value={p.id}>{p.name}{p.key_status === 'missing' ? ' - key missing' : ''}</option>)}
                </Select>
              </Field>
              <div className="grid grid-cols-2 gap-3">
                <Field label="Trials per case" hint="Repeats expose flakiness (pass@k vs pass^k)."><Select value={trials} onChange={(e) => setTrials(Number(e.target.value))}>{[1, 2, 3, 5, 10].map((n) => <option key={n}>{n}</option>)}</Select></Field>
                <Field label="Concurrency"><Select value={concurrency} onChange={(e) => setConcurrency(Number(e.target.value))}>{[1, 2, 4, 8, 16].map((n) => <option key={n}>{n}</option>)}</Select></Field>
                <Field label="Cost budget (USD)" hint="Stops scheduling when reached."><Input type="number" min={0} step="0.01" value={budget} onChange={(e) => setBudget(e.target.value)} placeholder="none" /></Field>
                <Field label="Latency limit (ms)"><Input type="number" min={0} value={maxLatency} onChange={(e) => setMaxLatency(e.target.value)} placeholder="none" /></Field>
              </div>
              {touched && errors.length > 0 && (
                <Notice tone="warn" title="Before creating">
                  <ul className="list-disc pl-4">{errors.map((e) => <li key={e}>{e}</li>)}</ul>
                </Notice>
              )}
              {create.isError && <ErrorState error={create.error} />}
              {!created ? (
                <Button variant="primary" className="w-full" loading={create.isPending} onClick={() => { setTouched(true); if (!errors.length) create.mutate() }}>
                  Create experiment
                </Button>
              ) : (
                <div className="space-y-3">
                  <Notice tone="good" title={`Experiment #${created.id} created`}>
                    {estimate.isLoading ? 'Estimating judge cost...' : estimate.data && (
                      <>
                        {estimate.data.judge_calls} judge call(s). Estimated judge cost: <b>{usd(estimate.data.estimated_cost_usd)}</b>.
                        <div className="mt-1 text-xs">{estimate.data.note}</div>
                      </>
                    )}
                  </Notice>
                  {launch.isError && <ErrorState error={launch.error} />}
                  <Button variant="primary" className="w-full" loading={launch.isPending} onClick={() => launch.mutate()}><Play className="size-3.5" /> Start run</Button>
                </div>
              )}
            </div>
          </Card>
        </div>
      </div>
    </>
  )
}

function GatesCard() {
  const qc = useQueryClient()
  const gates = useQuery({ queryKey: ['gates'], queryFn: () => api.get<Gate[]>('/api/gates') })
  const projects = useQuery({ queryKey: ['projects'], queryFn: () => api.get<Project[]>('/api/projects') })
  const [editing, setEditing] = useState<Gate | 'new' | null>(null)
  const [name, setName] = useState('')
  const [text, setText] = useState('')
  const save = useMutation({
    mutationFn: () => {
      const body = { project_id: projects.data?.[0]?.id ?? 1, name, config: JSON.parse(text) }
      return editing === 'new' ? api.post('/api/gates', body) : api.put(`/api/gates/${(editing as Gate).id}`, body)
    },
    onSuccess: () => { qc.invalidateQueries({ queryKey: ['gates'] }); setEditing(null) },
  })
  const start = (g: Gate | 'new') => {
    setEditing(g)
    setName(g === 'new' ? 'Release gate' : g.name)
    setText(JSON.stringify(g === 'new' ? { overall_pass_rate: { min: 0.85 }, p95_latency_ms: { max: 3000 }, regression: { overall_pass_rate: { maximum_drop: 0.03 } } } : g.config, null, 2))
  }
  return (
    <Card title="Regression gates" actions={<Button size="sm" onClick={() => start('new')}><Plus className="size-3.5" /> New gate</Button>}>
      <p className="mb-3 text-[13px] text-ink-2">Explicit thresholds on named metrics (any evaluator id, <code>overall_pass_rate</code>, <code>tool_accuracy</code>, <code>p95_latency_ms</code>, <code>average_cost_usd</code>, <code>&lt;evaluator&gt;.mean</code>), plus maximum drops relative to a baseline run. Each gate is PASS, FAIL or NOT EVALUATED; there is no combined score.</p>
      {editing && (
        <div className="mb-4 space-y-2 rounded-md border border-line p-3">
          <Field label="Name"><Input value={name} onChange={(e) => setName(e.target.value)} /></Field>
          <Field label="Thresholds (JSON)"><Textarea rows={9} value={text} onChange={(e) => setText(e.target.value)} spellCheck={false} /></Field>
          {save.isError && <ErrorState error={save.error} />}
          <div className="flex gap-2"><Button size="sm" variant="primary" loading={save.isPending} onClick={() => save.mutate()}>Save gate</Button><Button size="sm" variant="ghost" onClick={() => setEditing(null)}>Cancel</Button></div>
        </div>
      )}
      {(gates.data ?? []).length === 0 ? <p className="text-[13px] text-ink-3">No gates yet.</p> : (
        <ul className="space-y-2">
          {gates.data!.map((g) => (
            <li key={g.id} className="flex items-start justify-between gap-3 rounded-md border border-line p-3">
              <div>
                <div className="text-[13px] font-medium">{g.name}</div>
                <div className="mt-1 flex flex-wrap gap-1">
                  {Object.entries(g.config).flatMap(([k, v]) =>
                    k === 'regression' ? Object.entries(v as Record<string, { maximum_drop: number }>).map(([m, r]) => <Badge key={k + m}>{m}: drop at most {r.maximum_drop}</Badge>)
                      : Object.entries(v as Record<string, number>).map(([op, lim]) => <Badge key={k + op}>{k} {op === 'min' ? '>=' : '<='} {lim}</Badge>))}
                </div>
              </div>
              <Button size="sm" variant="ghost" onClick={() => start(g)}>Edit</Button>
            </li>
          ))}
        </ul>
      )}
    </Card>
  )
}
