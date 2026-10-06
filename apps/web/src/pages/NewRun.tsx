import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import clsx from 'clsx'
import { ChevronDown, Clock, Coins, Gauge, Play, Rocket, ShieldCheck, Sparkles, Zap } from 'lucide-react'
import { AnimatePresence, motion } from 'motion/react'
import { useState } from 'react'
import { Link, useNavigate, useSearchParams } from 'react-router-dom'
import { DatasetAdd } from '../components/DatasetAdd'
import { ParallelHelp } from '../components/helpTexts'
import { QueueViz } from '../components/QueueViz'
import { Badge, Button, Card, Dialog, ErrorState, Explain, Field, Input, Notice, PageHeader, PageSkeleton, Segmented, Select, Term } from '../components/ui'
import { api } from '../lib/api'
import { whereLabel } from '../lib/models'
import { validateSetup } from '../lib/compare'
import { projectOption, useProjects } from '../lib/projects'
import { useCrumbs } from '../lib/crumbs'
import { usd } from '../lib/format'
import type { Dataset, EvaluatorInfo, Gate, ProviderConfig, RunHeader, Settings, Target } from '../lib/types'

const KIND_ORDER: EvaluatorInfo['kind'][] = ['deterministic', 'retrieval', 'agent', 'performance', 'llm_judge']
const KIND_LABEL: Record<string, string> = {
  deterministic: 'Objective checks', retrieval: 'Retrieval (needs labelled documents)', agent: 'Agent / tool use',
  performance: 'Latency and cost', llm_judge: 'Meaning (needs a grading model)',
}

// Used in default run names (month-day); fixed at load so a render never reads the clock.
const TODAY = new Date().toISOString().slice(5, 10)

type Preset = 'smoke' | 'release' | 'full' | 'custom'
const PRESETS: { id: Preset; title: string; body: string; icon: typeof Zap }[] = [
  { id: 'smoke', title: 'Quick smoke', body: 'Objective checks only, 1 try per question. Free and fast.', icon: Zap },
  { id: 'release', title: 'Release gate', body: 'Default checks, 3 tries (shows flakiness), the release gate.', icon: ShieldCheck },
  { id: 'full', title: 'Full + grading model', body: 'Everything, including meaning checks by the default judge.', icon: Sparkles },
  { id: 'custom', title: 'Custom', body: 'Pick each check yourself.', icon: Gauge },
]

interface Estimate {
  cases: number
  target_calls: number
  per_call_ms: number | null
  based_on_runs: number
  target_cost_usd: number | null
  judge_calls: number
  judge_cost_usd: number | null
  estimated_seconds: number | null
  note: string
  blocked: string | null
  spend_cap_usd: number | null
  target_cost_visible?: boolean
  target_cost_source?: string | null
  cost_per_answer_usd?: number | null
  shared?: boolean
  judge_ms_per_call?: number | null
  judge_local?: boolean
}

type Purpose = 'correctness' | 'speed' | 'large'
const PURPOSES: { id: Purpose; label: string; atOnce: number }[] = [
  { id: 'correctness', label: 'Right or wrong only', atOnce: 4 },
  { id: 'speed', label: 'Speed matters too', atOnce: 1 },
  { id: 'large', label: 'Large set, sturdy bot', atOnce: 8 },
]

/** Does a gate judge speed? (a latency rule, absolute or against a baseline) */
const gateJudgesSpeed = (g?: Gate) => !!g && /latency/.test(JSON.stringify(g.config))

function speedReliability(c: number): { text: string; tone: 'good' | 'warn' | 'bad' } {
  if (c <= 1) return { text: 'reliable', tone: 'good' }
  if (c <= 4) return { text: 'a little slow (some waiting)', tone: 'warn' }
  return { text: 'likely inflated; rate-limit errors possible', tone: 'bad' }
}

function duration(s: number | null): string {
  if (s === null) return 'unknown'
  if (s < 60) return `~${Math.max(1, s)} s`
  if (s < 3600) return `~${Math.round(s / 60)} min`
  return `~${(s / 3600).toFixed(1)} h`
}

export function NewRunPage() {
  useCrumbs([{ label: 'Runs', to: '/runs' }, { label: 'New run' }], 'new-run')
  const nav = useNavigate()
  const qc = useQueryClient()
  const [params] = useSearchParams()
  const targets = useQuery({ queryKey: ['targets'], queryFn: () => api.get<Target[]>('/api/targets') })
  const datasets = useQuery({ queryKey: ['datasets'], queryFn: () => api.get<Dataset[]>('/api/datasets') })
  const evs = useQuery({ queryKey: ['evaluators'], queryFn: () => api.get<{ evaluators: EvaluatorInfo[]; defaults: string[]; judges: string[] }>('/api/evaluators') })
  const models = useQuery({ queryKey: ['models'], queryFn: () => api.get<ProviderConfig[]>('/api/models') })
  const gates = useQuery({ queryKey: ['gates'], queryFn: () => api.get<Gate[]>('/api/gates') })
  const projects = useProjects()
  const settings = useQuery({ queryKey: ['settings'], queryFn: () => api.get<{ values: Settings }>('/api/settings') })
  const recent = useQuery({ queryKey: ['runs'], queryFn: () => api.get<RunHeader[]>('/api/runs?limit=300') })

  const [project, setProject] = useState<number | ''>(Number(params.get('project')) || '')
  const [pickedTarget, setTargetVersionId] = useState<number | ''>('')
  const [pickedDataset, setDatasetVersionId] = useState<number | ''>('')
  const [typedName, setName] = useState<string | null>(null)
  const [preset, setPreset] = useState<Preset>('release')
  const [custom, setCustom] = useState<string[] | null>(null)
  const [showChecks, setShowChecks] = useState(false)
  const [judge, setJudge] = useState<string | null>(null) // null = use default
  const [trials, setTrials] = useState(3)
  const [pickedConcurrency, setConcurrency] = useState<number | null>(null)
  const [purpose, setPurpose] = useState<Purpose | null>(null)
  const [budget, setBudget] = useState('')
  const [maxAnswers, setMaxAnswers] = useState('')
  const [adding, setAdding] = useState(false)
  const [gateId, setGateId] = useState<number | '' | null>(null)
  const [maxLatency, setMaxLatency] = useState('')
  const [touched, setTouched] = useState(false)

  const evaluators = evs.data?.evaluators ?? []
  const judgeIds = evs.data?.judges ?? []
  const def = settings.data?.values.default_judge
  const defaultJudge = def ? (def.provider === 'heuristic' ? 'heuristic' : String(def.provider_config_id)) : ''
  const judgeValue = judge ?? defaultJudge

  // Presets set the checks, tries and gate; "custom" keeps whatever is ticked.
  const defaults = evs.data?.defaults ?? []
  const presetChecks =
    preset === 'smoke' ? evaluators.filter((e) => ['deterministic', 'retrieval', 'agent', 'performance'].includes(e.kind) && e.gating).map((e) => e.id)
    : preset === 'release' ? defaults.filter((e) => !judgeIds.includes(e) || judgeValue)
    : preset === 'full' ? [...evaluators.filter((e) => e.kind !== 'llm_judge').map((e) => e.id), ...judgeIds]
    : custom ?? defaults
  const checks = preset === 'custom' ? (custom ?? presetChecks) : presetChecks
  const choosePreset = (p: Preset) => {
    setPreset(p)
    if (p === 'smoke') setTrials(1)
    if (p === 'release' || p === 'full') setTrials(3)
  }

  const projectTargets = (targets.data ?? []).filter((t) => !project || t.project_id === project)
  const projectDatasets = (datasets.data ?? []).filter((d) => !project || d.project_id === project)
  // Until you pick, the version used by the most recent run, and the chatbot's first dataset.
  const lastLive = (recent.data ?? []).find((r) => r.source === 'live' && projectTargets.some((t) => t.id === r.target_id))
  const defaultTarget = (projectTargets.find((t) => t.id === lastLive?.target_id) ?? projectTargets[0])?.latest_version.id ?? ''
  const targetVersionId = pickedTarget || defaultTarget
  const datasetVersionId = pickedDataset || (projectDatasets[0]?.latest?.id ?? '')
  const tv = (targets.data ?? []).find((t) => t.latest_version.id === targetVersionId)
  const name = typedName ?? (tv ? `${tv.name.toLowerCase().replace(/[^a-z0-9]+/g, '-')}-${TODAY}` : '')
  const effectiveProject = project || tv?.project_id || ''
  const projectGates = (gates.data ?? []).filter((g) => !effectiveProject || g.project_id === effectiveProject)
  const gateValue = gateId === null ? (preset === 'release' ? projectGates[0]?.id ?? '' : '') : gateId
  const gate = projectGates.find((g) => g.id === gateValue)
  // Questions at a time: what you picked, else what the purpose implies, else a safe default
  // (2 for a bot others use or a gate that judges speed).
  const defaultConcurrency = tv?.shared || gateJudgesSpeed(gate) || maxLatency ? 2 : 4
  const concurrency = pickedConcurrency ?? PURPOSES.find((p) => p.id === purpose)?.atOnce ?? defaultConcurrency


  const judgeBody = judgeValue === '' ? null : judgeValue === 'heuristic' ? { provider: 'heuristic' } : { provider_config_id: Number(judgeValue) }
  const needsJudge = checks.filter((c) => judgeIds.includes(c))
  const effectiveChecks = judgeBody ? checks : checks.filter((c) => !judgeIds.includes(c))
  const errors = validateSetup({ targetVersionId, datasetVersionId, evaluators: effectiveChecks, judge: judgeValue }, judgeIds)

  const est = useQuery({
    queryKey: ['estimate', targetVersionId, datasetVersionId, effectiveChecks.join(','), judgeValue, trials, concurrency],
    queryFn: () => api.post<Estimate>('/api/estimate', { target_version_id: targetVersionId, dataset_version_id: datasetVersionId, evaluators: effectiveChecks, judge: judgeBody, trials, concurrency }),
    enabled: !!targetVersionId && !!datasetVersionId,
  })

  const start = useMutation({
    mutationFn: () => api.post<RunHeader>('/api/runs/start', {
      project_id: tv?.project_id ?? projects.visible[0]?.id,
      name: name || 'run',
      target_version_id: targetVersionId,
      dataset_version_id: datasetVersionId,
      evaluators: effectiveChecks,
      judge: judgeBody,
      trials, concurrency,
      budget_usd: budget ? Number(budget) : null,
      max_answers: maxAnswers ? Number(maxAnswers) : null,
      gate_id: gateValue || null,
      options: maxLatency ? { max_latency_ms: Number(maxLatency) } : {},
    }),
    onSuccess: (r) => { qc.invalidateQueries({ queryKey: ['runs'] }); qc.invalidateQueries({ queryKey: ['activity'] }); nav(`/runs/${r.id}`, { viewTransition: true }) },
  })

  const answers = (est.data?.cases ?? 0) * trials
  const reliability = speedReliability(concurrency)
  const warnings: { title: string; body: string }[] = []
  if (concurrency >= 8 && (gateJudgesSpeed(gate) || maxLatency)) {
    warnings.push({ title: `${gate && gateJudgesSpeed(gate) ? `"${gate.name}" judges speed` : 'This run has a latency limit'}, but ${concurrency} at a time inflates speed`,
      body: 'Answers wait for each other, so a latency FAIL here may not be the bot\'s fault. Use 1-2 at a time for a run that judges speed.' })
  }
  if (tv?.shared && concurrency > 2) {
    warnings.push({ title: `Other people use this bot: ${concurrency} test questions at once slow their answers`, body: 'The connection is marked as shared. 2 at a time keeps the load gentle; 1 when speed matters.' })
  }

  if (targets.isLoading || datasets.isLoading || evs.isLoading) return <PageSkeleton />
  const toggle = (id: string) => { setPreset('custom'); setCustom(checks.includes(id) ? checks.filter((x) => x !== id) : [...checks, id]) }
  const e = est.data

  return (
    <>
      <PageHeader title="New run" description="Ask one chatbot version every question in a dataset and grade the answers. Objective checks run where a question defines them; a grading model only where meaning must be judged." />
      <div className="grid gap-5 xl:grid-cols-[minmax(0,1fr)_380px]">
        <div className="space-y-5">
          <Card title="1. What to test">
            <div className="grid gap-3 md:grid-cols-2">
              <Field label="Chatbot">
                <Select value={project} onChange={(ev) => { setProject(ev.target.value ? Number(ev.target.value) : ''); setTargetVersionId(''); setDatasetVersionId('') }} aria-label="Chatbot">
                  <option value="">All chatbots</option>{projects.visible.map((p) => <option key={p.id} value={p.id}>{projectOption(p)}</option>)}
                </Select>
              </Field>
              <Field label="Connection and version">
                <Select value={targetVersionId} onChange={(ev) => setTargetVersionId(ev.target.value ? Number(ev.target.value) : '')} aria-label="Connection">
                  <option value="">Choose...</option>
                  {projectTargets.map((t) => <option key={t.id} value={t.latest_version.id}>{t.name} - v{t.latest_version.version}{t.latest_version.variant_label ? ` (${t.latest_version.variant_label})` : ''}</option>)}
                </Select>
              </Field>
              <Field label="Questions (dataset version)" hint="Running freezes this version; later edits create a new one.">
                <Select value={datasetVersionId} onChange={(ev) => { if (ev.target.value === '__add') { setAdding(true); return } setDatasetVersionId(ev.target.value ? Number(ev.target.value) : '') }} aria-label="Dataset version">
                  <option value="">{projectDatasets.length ? 'Choose...' : effectiveProject ? 'No questions for this chatbot yet' : 'Choose...'}</option>
                  {projectDatasets.flatMap((d) => d.versions.map((v) => <option key={v.id} value={v.id}>{d.name} v{v.version} ({v.case_count} cases{v.status === 'draft' ? ', draft' : ''})</option>))}
                  {effectiveProject && <option value="__add">+ Import or type questions...</option>}
                </Select>
              </Field>
              <Field label="Run name"><Input value={name} onChange={(ev) => setName(ev.target.value)} aria-label="Run name" /></Field>
            </div>
            {effectiveProject && !projectDatasets.length && !datasets.isLoading && (
              <div className="mt-3"><Notice tone="info" title="This chatbot has no questions yet" action={<Button size="sm" variant="primary" onClick={() => setAdding(true)}>Add questions</Button>}>
                Import a file (YAML, JSON or a spreadsheet CSV), or type a few questions, without leaving this page.
              </Notice></div>
            )}
            {tv?.local_judges_only && <p className="mt-2 text-xs text-accent-ink">This connection is set to local grading models only.</p>}
            <Dialog open={adding} onClose={() => setAdding(false)} title={`Add questions for ${projects.all.find((p) => p.id === effectiveProject)?.name ?? 'this chatbot'}`}>
              <DatasetAdd projectId={effectiveProject} onDone={(d) => { setAdding(false); if (!project && effectiveProject) setProject(effectiveProject); if (d.latest) setDatasetVersionId(d.latest.id) }} />
            </Dialog>
          </Card>

          <Card title="2. How thoroughly">
            <div className="grid gap-2 sm:grid-cols-2 lg:grid-cols-4" role="radiogroup" aria-label="Preset">
              {PRESETS.map((p) => (
                <button key={p.id} type="button" role="radio" aria-checked={preset === p.id} onClick={() => { choosePreset(p.id); if (p.id === 'custom') { setCustom(checks); setShowChecks(true) } }}
                  className={clsx('relative rounded-xl border p-3 text-left transition-colors', preset === p.id ? 'border-accent bg-accent-wash/60' : 'border-line hover:border-line-strong')}>
                  {preset === p.id && <motion.span layoutId="preset-ring" className="absolute inset-0 rounded-xl ring-2 ring-accent" transition={{ type: 'spring', stiffness: 500, damping: 40 }} />}
                  <p.icon className={clsx('size-4', preset === p.id ? 'text-accent-ink' : 'text-ink-3')} />
                  <div className="mt-1.5 text-[13px] font-semibold">{p.title}</div>
                  <div className="text-xs text-ink-3">{p.body}</div>
                </button>
              ))}
            </div>
            <button type="button" onClick={() => setShowChecks((v) => !v)} className="mt-3 flex items-center gap-1 text-[13px] font-medium text-accent-ink">
              <ChevronDown className={clsx('size-4 transition-transform', showChecks && 'rotate-180')} />{showChecks ? 'Hide' : 'Show'} the {effectiveChecks.length} checks
            </button>
            {!judgeBody && needsJudge.length > 0 && <p className="mt-1 text-xs text-warn-ink">{needsJudge.length} meaning check(s) skipped: no grading model chosen.</p>}
            <AnimatePresence initial={false}>
              {showChecks && (
                <motion.div initial={{ height: 0, opacity: 0 }} animate={{ height: 'auto', opacity: 1 }} exit={{ height: 0, opacity: 0 }} className="overflow-hidden">
                  <div className="mt-3 grid gap-5 md:grid-cols-2">
                    {KIND_ORDER.map((kind) => (
                      <fieldset key={kind}>
                        <legend className="mb-1.5 text-xs font-semibold text-ink-2">{KIND_LABEL[kind]}</legend>
                        <div className="space-y-1">
                          {evaluators.filter((ev) => ev.kind === kind).map((ev) => (
                            <label key={ev.id} className="flex items-start gap-2 text-[13px]" title={ev.description}>
                              <input type="checkbox" className="mt-0.5 accent-[var(--accent)]" checked={checks.includes(ev.id)} onChange={() => toggle(ev.id)} />
                              <span>
                                {ev.name}
                                {!ev.gating && <span className="ml-1 text-xs text-ink-3">(diagnostic)</span>}
                                {ev.calibration && <span className="ml-1 text-xs text-ink-3">- {ev.calibration.status}</span>}
                              </span>
                            </label>
                          ))}
                        </div>
                      </fieldset>
                    ))}
                  </div>
                </motion.div>
              )}
            </AnimatePresence>
          </Card>

          <Card title="3. Grading and limits">
            <div className="grid gap-3 md:grid-cols-3">
              <Field label="Grading model (judge)" hint={e && e.judge_calls > 0 && e.judge_ms_per_call ? (
                e.judge_local
                  ? <>{e.judge_calls} grading calls on this PC: about {duration(Math.round((e.judge_calls * e.judge_ms_per_call) / 1000))}, free.</>
                  : <>{e.judge_calls} grading calls: about {duration(Math.round((e.judge_calls * e.judge_ms_per_call) / 1000 / concurrency))}, {e.judge_cost_usd !== null ? usd(e.judge_cost_usd) : 'price unknown'}.</>
              ) : judge === null && defaultJudge ? 'Your default (Settings).' : 'Only for meaning checks.'}>
                <Select value={judgeValue} onChange={(ev) => setJudge(ev.target.value)} aria-label="Judge">
                  <option value="">None</option>
                  <option value="heuristic">Heuristic (word overlap, free, not an LLM)</option>
                  {(models.data ?? []).map((m) => <option key={m.id} value={m.id}>{m.name} ({whereLabel(m)}){m.key_status === 'missing' ? ' - key missing' : ''}</option>)}
                </Select>
              </Field>
              <Field label={<>Tries per question <Term k="flaky">(flakiness)</Term></>}
                hint={e ? <><b className="num">{e.cases} x {trials} = {answers} answers</b> from the bot{e.target_cost_visible === false ? ' (each one billed by the bot)' : ''}</> : undefined}>
                <Select value={trials} onChange={(ev) => setTrials(Number(ev.target.value))} aria-label="Tries per question">{[1, 2, 3, 5, 10].map((n) => <option key={n}>{n}</option>)}</Select>
              </Field>
              <Field label={<>In parallel<ParallelHelp /></>} hint={pickedConcurrency === null && !purpose && defaultConcurrency === 2 ? (tv?.shared ? 'Default 2: other people use this bot.' : 'Default 2: this run judges speed.') : undefined}>
                <Select value={concurrency} onChange={(ev) => { setConcurrency(Number(ev.target.value)); setPurpose(null) }} aria-label="In parallel">{[1, 2, 4, 8, 16].map((n) => <option key={n}>{n}</option>)}</Select>
              </Field>
              <Field label="Spend cap (USD)" hint={e?.target_cost_visible === false ? undefined : 'Stops sending new questions when reached.'}>
                <Input type="number" min={0} step="0.01" value={budget} onChange={(ev) => setBudget(ev.target.value)} placeholder={e?.spend_cap_usd != null ? `default ${e.spend_cap_usd}` : 'no cap'} aria-label="Spend cap" />
              </Field>
              <Field label="Max answers" hint="Stops after this many questions were sent: works even when the price is unknown.">
                <Input type="number" min={1} step={1} value={maxAnswers} onChange={(ev) => setMaxAnswers(ev.target.value)} placeholder={e ? `no limit (${answers} planned)` : 'no limit'} aria-label="Max answers" />
              </Field>
              <Field label="Latency limit (ms)"><Input type="number" min={0} value={maxLatency} onChange={(ev) => setMaxLatency(ev.target.value)} placeholder="no limit" /></Field>
              <Field label={<Term k="gate">Release gate</Term>} hint={effectiveProject && !projectGates.length ? 'No gate for this chatbot yet (Setup > Gates).' : undefined}>
                <Select value={gateValue} onChange={(ev) => setGateId(ev.target.value ? Number(ev.target.value) : '')}>
                  <option value="">None</option>{projectGates.map((g) => <option key={g.id} value={g.id}>{g.name}</option>)}
                </Select>
              </Field>
            </div>
            <div className="mt-4 rounded-xl border border-line bg-surface-2/40 p-3">
              <div className="flex flex-wrap items-center gap-2">
                <span className="text-xs font-medium text-ink-2">What is this run for?</span>
                <Segmented size="sm" value={purpose ?? ('' as Purpose)} onChange={(p) => { setPurpose(p); setConcurrency(null) }} options={PURPOSES.map((p) => ({ id: p.id, label: p.label }))} label="Run purpose" />
              </div>
              <p className={clsx('mt-2 text-[13px]', reliability.tone === 'good' ? 'text-good-ink' : reliability.tone === 'warn' ? 'text-warn-ink' : 'text-bad-ink')} data-testid="parallel-line">
                <b className="num">{e ? `${answers} answers` : 'Each question'}, {concurrency} at a time</b>
                {e?.per_call_ms ? <> → about {duration(Math.round((answers * e.per_call_ms) / 1000 / concurrency))}</> : null}
                {' '}· speed figures: <b>{reliability.text}</b>
                {(budget || e?.spend_cap_usd != null) && concurrency > 1 ? <> · up to {concurrency} more paid answers past the cap</> : null}
              </p>
              <QueueViz atOnce={concurrency} />
            </div>
            {warnings.length > 0 && <div className="mt-3 space-y-2">{warnings.map((w) => <Notice key={w.title} tone="warn" title={w.title}>{w.body}</Notice>)}</div>}
            {e?.target_cost_visible === false && (
              <div className="mt-3"><Notice tone="warn" title="This bot's cost is not visible: the spend cap cannot limit it">
                It reports no token counts, so GaugeLab cannot price its answers and counts them as $0. The cap only stops grading-model costs. To limit spending, set <b>Max answers</b>, or {tv ? <Link className="text-accent-ink underline" to={`/targets/${tv.id}`}>enter a cost per answer on the connection</Link> : 'enter a cost per answer on the connection'}.
              </Notice></div>
            )}
          </Card>
        </div>

        <div className="space-y-5 xl:sticky xl:top-16 xl:self-start">
          <Card title="Before you start">
            {!targetVersionId || !datasetVersionId ? <p className="text-[13px] text-ink-3">Pick a version and a dataset to see the estimate.</p> : est.isLoading ? <div className="skeleton h-24" /> : e && (
              <div className="space-y-3">
                <div className="grid grid-cols-2 gap-3">
                  <EstimateTile icon={Clock} label="Time" value={duration(e.estimated_seconds)} sub={e.per_call_ms ? `${(e.per_call_ms / 1000).toFixed(1)} s per answer` : 'no past runs'} />
                  <EstimateTile icon={Rocket} label="Questions asked" value={String(e.target_calls)} sub={`${e.cases} cases x ${trials}`} />
                  <EstimateTile icon={Sparkles} label="Grading calls" value={String(e.judge_calls)} sub={judgeValue === 'heuristic' ? 'heuristic: free' : judgeValue ? 'by the judge' : 'no judge'} />
                  <EstimateTile icon={Coins} label="Estimated cost" value={e.target_cost_visible === false ? (e.judge_cost_usd ? `${usd(e.judge_cost_usd)} + bot` : 'bot: unknown') : usd((e.target_cost_usd ?? 0) + (e.judge_cost_usd ?? 0))}
                    sub={e.target_cost_visible === false ? `${e.target_calls} billed bot answers, price unknown` : e.target_cost_source === 'per answer (set on the connection)' ? 'bot at your per-answer cost + judge' : e.judge_cost_usd === null && e.judge_calls ? 'judge price unknown' : 'bot + judge'} />
                </div>
                <p className="text-xs text-ink-3">{e.note}</p>
                {e.blocked && <Notice tone="bad" title="This grading model is not allowed here">{e.blocked}</Notice>}
              </div>
            )}
            <Explain className="mt-3">Estimates come from how long earlier runs of this version took. A local grading model on a CPU is slow (tens of seconds per call).</Explain>
            {touched && errors.length > 0 && <div className="mt-3"><Notice tone="warn" title="Before starting"><ul className="list-disc pl-4">{errors.map((x) => <li key={x}>{x}</li>)}</ul></Notice></div>}
            {start.isError && <div className="mt-3"><ErrorState error={start.error} /></div>}
            <Button variant="primary" size="lg" className="mt-4 w-full" loading={start.isPending} disabled={!!e?.blocked}
              onClick={() => { setTouched(true); if (!errors.length) start.mutate() }}>
              <Play className="size-4" /> Create and run
            </Button>
            {!(models.data ?? []).length && <p className="mt-2 text-xs text-ink-3">No grading model yet: <Link className="text-accent-ink underline" to="/settings?tab=models">connect one</Link> for meaning checks.</p>}
            {tv && <div className="mt-3 flex flex-wrap gap-1"><Badge>{tv.adapter}</Badge>{tv.latest_version.variant_label && <Badge>{tv.latest_version.variant_label}</Badge>}</div>}
          </Card>
        </div>
      </div>
    </>
  )
}

function EstimateTile({ icon: Icon, label, value, sub }: { icon: typeof Clock; label: string; value: string; sub: string }) {
  return (
    <div className="rounded-lg border border-line bg-surface-2/50 p-2.5">
      <div className="flex items-center gap-1.5 text-xs text-ink-3"><Icon className="size-3.5" />{label}</div>
      <div className="num mt-0.5 text-lg font-semibold">{value}</div>
      <div className="text-[11px] text-ink-3">{sub}</div>
    </div>
  )
}
