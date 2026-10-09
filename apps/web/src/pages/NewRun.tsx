import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import clsx from 'clsx'
import { ChevronDown, Gauge, Play, ScanSearch, ShieldCheck, Sparkles, Zap } from 'lucide-react'
import { AnimatePresence, motion } from 'motion/react'
import { useState } from 'react'
import { Link, useNavigate, useSearchParams } from 'react-router-dom'
import { DatasetAdd } from '../components/DatasetAdd'
import { ParallelHelp } from '../components/helpTexts'
import { QueueViz } from '../components/QueueViz'
import { RunReceipt, duration, type Estimate } from '../components/setup/RunReceipt'
import { SetupField } from '../components/setup/SetupField'
import { Checkbox, SelectCard } from '../components/form'
import { Badge, Button, Card, Dialog, ErrorState, Input, Notice, PageHeader, PageSkeleton, Panel, Segmented, Select, Term, useLongWork } from '../components/ui'
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

type Preset = 'quick' | 'smoke' | 'release' | 'full' | 'search' | 'custom'
const PRESETS: { id: Preset; title: string; body: string; icon: typeof Zap }[] = [
  { id: 'quick', title: 'Quick check', body: '30 questions across the categories, the same 30 each time, 1 try. Objective checks plus correctness.', icon: Zap },
  { id: 'smoke', title: 'Quick smoke', body: 'Objective checks only, 1 try per question. Free and fast.', icon: Zap },
  { id: 'release', title: 'Release gate', body: 'Default checks, 3 tries (shows flakiness), the release gate.', icon: ShieldCheck },
  { id: 'full', title: 'Full + grading model', body: 'Everything, including meaning checks by the default judge.', icon: Sparkles },
  { id: 'search', title: 'Search only', body: 'Did search find what a correct answer needs? With a search-only connection, no answer is paid for.', icon: ScanSearch },
  { id: 'custom', title: 'Custom', body: 'Pick each check yourself.', icon: Gauge },
]

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
  const [allowOther, setAllowOther] = useState(false)
  const [typedName, setName] = useState<string | null>(null)
  const [preset, setPreset] = useState<Preset>('quick')
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
    preset === 'quick' ? [...evaluators.filter((e) => ['deterministic', 'retrieval', 'agent', 'performance'].includes(e.kind) && e.gating).map((e) => e.id), ...(judgeIds.includes('correctness') ? ['correctness'] : [])]
    : preset === 'smoke' ? evaluators.filter((e) => ['deterministic', 'retrieval', 'agent', 'performance'].includes(e.kind) && e.gating).map((e) => e.id)
    : preset === 'release' ? defaults.filter((e) => !judgeIds.includes(e) || judgeValue)
    : preset === 'full' ? [...evaluators.filter((e) => e.kind !== 'llm_judge').map((e) => e.id), ...judgeIds]
    : preset === 'search' ? evaluators.filter((e) => e.kind === 'retrieval').map((e) => e.id)
    : custom ?? defaults
  const checks = preset === 'custom' ? (custom ?? presetChecks) : presetChecks
  const choosePreset = (p: Preset) => {
    setPreset(p)
    if (p === 'quick' || p === 'smoke' || p === 'search') setTrials(1)
    if (p === 'release' || p === 'full') setTrials(3)
  }

  const projectTargets = (targets.data ?? []).filter((t) => !project || t.project_id === project)
  // Until you pick, the version used by the most recent run, and the chatbot's first dataset.
  const lastLive = (recent.data ?? []).find((r) => r.source === 'live' && projectTargets.some((t) => t.id === r.target_id))
  const defaultTarget = (projectTargets.find((t) => t.id === lastLive?.target_id) ?? projectTargets[0])?.latest_version.id ?? ''
  const targetVersionId = pickedTarget || defaultTarget
  const tv = (targets.data ?? []).find((t) => t.latest_version.id === targetVersionId)
  const name = typedName ?? (tv ? `${tv.name.toLowerCase().replace(/[^a-z0-9]+/g, '-')}-${TODAY}` : '')
  const effectiveProject = project || tv?.project_id || ''
  // The questions belong to the chatbot of the chosen connection; another chatbot's are off-topic for it.
  const projectDatasets = (datasets.data ?? []).filter((d) => !effectiveProject || d.project_id === effectiveProject)
  const otherDatasets = effectiveProject ? (datasets.data ?? []).filter((d) => d.project_id !== effectiveProject) : []
  const datasetVersionId = pickedDataset || (projectDatasets[0]?.latest?.id ?? '')
  const otherPicked = otherDatasets.find((d) => d.versions.some((v) => v.id === datasetVersionId))
  const ownerName = (id: number) => projects.all.find((p) => p.id === id)?.name ?? 'another chatbot'
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
    queryKey: ['estimate', targetVersionId, datasetVersionId, effectiveChecks.join(','), judgeValue, trials, concurrency, preset === 'quick'],
    queryFn: () => api.post<Estimate>('/api/estimate', { target_version_id: targetVersionId, dataset_version_id: datasetVersionId, evaluators: effectiveChecks, judge: judgeBody, trials, concurrency, ...(preset === 'quick' ? { case_filter: { sample: 30, seed: 7 } } : {}) }),
    enabled: !!targetVersionId && !!datasetVersionId,
    placeholderData: (prev) => prev,
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
      allow_other_chatbot: !!otherPicked && allowOther,
      ...(preset === 'quick' ? { case_filter: { sample: 30, seed: 7 } } : {}),
    }),
    meta: { silent: true },
    onSuccess: (r) => { qc.invalidateQueries({ queryKey: ['runs'] }); qc.invalidateQueries({ queryKey: ['activity'] }); nav(`/runs/${r.id}`, { viewTransition: true }) },
  })

  const long = useLongWork()
  const ready = !!targetVersionId && !!datasetVersionId
  const e = ready ? est.data : undefined
  const answers = (e?.cases ?? 0) * trials
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
  const datasetOption = (d: Dataset, v: Dataset['versions'][number]) => <option key={v.id} value={v.id}>{d.name} v{v.version} ({v.case_count} cases{v.status === 'draft' ? ', draft' : ''})</option>
  const judgeReadout = e && e.judge_calls > 0 && e.judge_ms_per_call ? (
    e.judge_local
      ? <><b className="num font-mono font-medium">{e.judge_calls}</b> grading calls on this PC: about {duration(Math.round((e.judge_calls * e.judge_ms_per_call) / 1000))}, free.</>
      : <><b className="num font-mono font-medium">{e.judge_calls}</b> grading calls: about {duration(Math.round((e.judge_calls * e.judge_ms_per_call) / 1000 / concurrency))}, {e.judge_cost_usd !== null ? usd(e.judge_cost_usd) : 'price unknown'}.</>
  ) : judge === null && defaultJudge ? 'Your default (Settings).' : undefined

  return (
    <>
      <PageHeader eyebrow="New run" title={<>Ask a version <em>every question</em>.</>}
        help={<>
          <p>Ask one chatbot version every question in a dataset and grade the answers. Objective checks run where a question defines them; a grading model only where meaning must be judged.</p>
          <p>Pick what to test and how thoroughly. The receipt on the right updates as you choose; changed lines reprint. Nothing is asked until you press the button under it.</p>
        </>} />
      <div className="grid items-start gap-8 xl:grid-cols-[minmax(0,1fr)_380px]">
        <div className="min-w-0 space-y-12">
          <Card title="1 · What to test" help={<>
            <p>Which chatbot version to ask, which questions to ask it, and what to call the run.</p>
            <p>The connection decides who answers; the questions are a dataset version, frozen when the run starts. The badges under the connection say how it is reached and whether other people use it.</p>
          </>}>
            <div className="grid gap-x-4 gap-y-4 md:grid-cols-2">
              <SetupField label="Chatbot">
                <Select value={project} onChange={(ev) => { setProject(ev.target.value ? Number(ev.target.value) : ''); setTargetVersionId(''); setDatasetVersionId('') }} aria-label="Chatbot">
                  <option value="">All chatbots</option>{projects.visible.map((p) => <option key={p.id} value={p.id}>{projectOption(p)}</option>)}
                </Select>
              </SetupField>
              <SetupField label="Connection · version" readout={tv && (
                <span className="flex flex-wrap items-center gap-1.5 pt-0.5">
                  <Badge>{tv.adapter}</Badge>
                  {tv.latest_version.variant_label && <Badge>{tv.latest_version.variant_label}</Badge>}
                  {tv.shared && <Badge tone="warn">shared with other people</Badge>}
                  {tv.local_judges_only && <Badge tone="accent">local grading models only</Badge>}
                </span>
              )}>
                <Select value={targetVersionId} onChange={(ev) => setTargetVersionId(ev.target.value ? Number(ev.target.value) : '')} aria-label="Connection">
                  <option value="">Choose...</option>
                  {projectTargets.map((t) => <option key={t.id} value={t.latest_version.id}>{t.name} - v{t.latest_version.version}{t.latest_version.variant_label ? ` (${t.latest_version.variant_label})` : ''}</option>)}
                </Select>
              </SetupField>
              <SetupField label="Questions" helpTitle="Questions (dataset version)" help={<>
                <p>The dataset version this run asks. Running freezes this version; later edits create a new one.</p>
                <p>Another chatbot's questions are listed separately: they are off-topic for this one. The last entry imports a file or lets you type questions without leaving this page.</p>
              </>}>
                <Select value={datasetVersionId} onChange={(ev) => { if (ev.target.value === '__add') { setAdding(true); return } setDatasetVersionId(ev.target.value ? Number(ev.target.value) : '') }} aria-label="Dataset version">
                  <option value="">{projectDatasets.length ? 'Choose...' : effectiveProject ? 'No questions for this chatbot yet' : 'Choose...'}</option>
                  {otherDatasets.length > 0 ? (
                    <optgroup label="This chatbot's questions">
                      {projectDatasets.flatMap((d) => d.versions.map((v) => datasetOption(d, v)))}
                    </optgroup>
                  ) : projectDatasets.flatMap((d) => d.versions.map((v) => datasetOption(d, v)))}
                  {otherDatasets.length > 0 && (
                    <optgroup label="Other chatbots' questions (off-topic for this one)">
                      {otherDatasets.flatMap((d) => d.versions.map((v) => <option key={v.id} value={v.id}>{d.name} v{v.version} - {ownerName(d.project_id)}</option>))}
                    </optgroup>
                  )}
                  {effectiveProject && <option value="__add">+ Import or type questions...</option>}
                </Select>
              </SetupField>
              <SetupField label="Run name"><Input value={name} onChange={(ev) => setName(ev.target.value)} aria-label="Run name" /></SetupField>
            </div>
            {otherPicked && (
              <div className="mt-4" data-testid="other-chatbot-warning">
                <Notice tone="warn" title={`These questions were written for ${ownerName(otherPicked.project_id)}`}>
                  {tv?.name ?? 'This connection'} belongs to {ownerName(Number(effectiveProject))}: it will answer them off-topic, and each answer may be billed. Their failures say nothing about this bot.
                  <Checkbox className="mt-2 font-medium text-ink" checked={allowOther} onChange={setAllowOther}
                    label="I mean to use them (say, a successor bot or a shared safety set)" />
                </Notice>
              </div>
            )}
            {effectiveProject && !projectDatasets.length && !datasets.isLoading && (
              <div className="mt-4"><Notice tone="info" title="This chatbot has no questions yet" action={<Button size="sm" variant="primary" onClick={() => setAdding(true)}>Add questions</Button>}>
                Import a file (YAML, JSON or a spreadsheet CSV), or type a few questions, without leaving this page.
              </Notice></div>
            )}
            <Dialog open={adding} onClose={() => setAdding(false)} title={`Add questions for ${projects.all.find((p) => p.id === effectiveProject)?.name ?? 'this chatbot'}`}>
              <DatasetAdd projectId={effectiveProject} onDone={(d) => { setAdding(false); if (!project && effectiveProject) setProject(effectiveProject); if (d.latest) setDatasetVersionId(d.latest.id) }} />
            </Dialog>
          </Card>

          <Card title="2 · How thoroughly" help={<>
            <p>A preset sets the checks, the tries per question and the release gate. Pick Custom (or tick a check below) to choose each check yourself.</p>
            <p>Meaning checks need a grading model (section 3); without one they are skipped.</p>
            <p>Quick check is the default: 30 questions spread across the categories, the same 30 each time so runs can be compared, 1 try, the objective checks plus correctness{preset === 'quick' && e?.estimated_seconds ? <>. About {duration(e.estimated_seconds).replace('~', '')} with the default grading model</> : ''}. Pick Release gate or Full for every question.</p>
          </>}>
            <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-3" role="radiogroup" aria-label="Preset">
              {PRESETS.map((p) => (
                <SelectCard key={p.id} selected={preset === p.id} icon={<p.icon className="size-4" aria-hidden />} title={p.title}
                  onSelect={() => { choosePreset(p.id); if (p.id === 'custom') { setCustom(checks); setShowChecks(true) } }}>
                  {p.body}
                </SelectCard>
              ))}
            </div>
            <div className="mt-4 flex flex-wrap items-center gap-x-4 gap-y-1">
              <button type="button" onClick={() => setShowChecks((v) => !v)} className="flex items-center gap-1 text-sm font-medium text-accent-ink" aria-expanded={showChecks}>
                <ChevronDown className={clsx('size-4 transition-transform', showChecks && 'rotate-180')} />{showChecks ? 'Hide' : 'Show'} the <span className="num font-mono">{effectiveChecks.length}</span> checks
              </button>
              {!judgeBody && needsJudge.length > 0 && <span className="text-xs text-warn-ink"><span className="num font-mono">{needsJudge.length}</span> meaning {needsJudge.length === 1 ? 'check' : 'checks'} skipped: no grading model chosen.</span>}
            </div>
            <AnimatePresence initial={false}>
              {showChecks && (
                <motion.div initial={{ height: 0, opacity: 0 }} animate={{ height: 'auto', opacity: 1 }} exit={{ height: 0, opacity: 0 }} className="overflow-hidden">
                  <div className="mt-4 grid gap-6 md:grid-cols-2">
                    {KIND_ORDER.map((kind) => (
                      <fieldset key={kind}>
                        <legend className="t-label mb-2">{KIND_LABEL[kind]}</legend>
                        <div className="space-y-1.5">
                          {evaluators.filter((ev) => ev.kind === kind).map((ev) => (
                            <Checkbox key={ev.id} title={ev.description} checked={checks.includes(ev.id)} onChange={() => toggle(ev.id)}
                              label={<>
                                {ev.name}
                                {!ev.gating && <span className="ml-1 text-xs text-ink-3">(diagnostic)</span>}
                                {ev.calibration && <span className="ml-1 text-xs text-ink-3">- {ev.calibration.status}</span>}
                              </>} />
                          ))}
                        </div>
                      </fieldset>
                    ))}
                  </div>
                </motion.div>
              )}
            </AnimatePresence>
          </Card>

          <Card title="3 · Grading and load">
            <div className="grid gap-x-4 gap-y-5 md:grid-cols-3">
              <SetupField label="Grading model" helpTitle="Grading model (judge)" readout={judgeReadout} help={<>
                <p>Only for meaning checks: a model that reads each answer and judges whether it means the right thing. Objective checks need none.</p>
                <p>The heuristic compares words with the reference: free, fast, not an LLM. A local model runs on this PC (free, slow on a CPU); a cloud model is fast and paid.</p>
              </>}>
                <Select value={judgeValue} onChange={(ev) => setJudge(ev.target.value)} aria-label="Judge">
                  <option value="">None</option>
                  <option value="heuristic">Heuristic (word overlap, free, not an LLM)</option>
                  {(models.data ?? []).map((m) => <option key={m.id} value={m.id}>{m.name} ({whereLabel(m)}){m.key_status === 'missing' ? ' - key missing' : ''}</option>)}
                </Select>
                {!(models.data ?? []).length && <span className="text-xs text-ink-2">No grading model yet: <Link className="text-accent-ink underline" to="/settings?tab=models">connect one</Link> for meaning checks.</span>}
              </SetupField>
              <SetupField group label={<>Tries per question <Term k="flaky">(flakiness)</Term></>}>
                <div><Segmented size="md" value={String(trials)} onChange={(v) => setTrials(Number(v))} label="Tries per question"
                  options={[1, 2, 3, 5, 10].map((n) => ({ id: String(n), label: <span className="num font-mono">{n}</span> }))} /></div>
              </SetupField>
              <SetupField label={<span className="inline-flex items-center gap-1.5">In parallel<ParallelHelp /></span>}
                readout={pickedConcurrency === null && !purpose && defaultConcurrency === 2 ? (tv?.shared ? 'Default 2: other people use this bot.' : 'Default 2: this run judges speed.') : undefined}>
                <Select value={concurrency} onChange={(ev) => { setConcurrency(Number(ev.target.value)); setPurpose(null) }} aria-label="In parallel">{[1, 2, 4, 8, 16].map((n) => <option key={n}>{n}</option>)}</Select>
              </SetupField>
              <SetupField label="Spend cap (USD)" help={<>
                <p>Stops sending new questions when the cost so far reaches this. Questions already sent are still answered (and paid for), so with several in parallel it can overshoot by that many answers.</p>
                <p>The cap only sees costs Assay can price: a bot that reports no token counts and has no per-answer cost on its connection counts as $0. Use Max answers for that.</p>
              </>}>
                <Input type="number" min={0} step="0.01" value={budget} onChange={(ev) => setBudget(ev.target.value)} placeholder={e?.spend_cap_usd != null ? `default ${e.spend_cap_usd}` : 'no cap'} aria-label="Spend cap" />
              </SetupField>
              <SetupField label="Max answers" help={<p>Stops after this many questions were sent: works even when the price is unknown.</p>}>
                <Input type="number" min={1} step={1} value={maxAnswers} onChange={(ev) => setMaxAnswers(ev.target.value)} placeholder={e ? `no limit (${answers} planned)` : 'no limit'} aria-label="Max answers" />
              </SetupField>
              <SetupField label="Latency limit (ms)" help={<p>Each answer slower than this fails the latency check. A run with a limit defaults to 2 in parallel, because waiting in a queue would count against the bot.</p>}>
                <Input type="number" min={0} value={maxLatency} onChange={(ev) => setMaxLatency(ev.target.value)} placeholder="no limit" aria-label="Latency limit" />
              </SetupField>
              <SetupField label={<Term k="gate">Release gate</Term>}
                readout={effectiveProject && !projectGates.length ? <>No gate for this chatbot yet (<Link className="text-accent-ink underline" to="/gates">Setup › Gates</Link>).</> : undefined}>
                <Select value={gateValue} onChange={(ev) => setGateId(ev.target.value ? Number(ev.target.value) : '')} aria-label="Release gate">
                  <option value="">None</option>{projectGates.map((g) => <option key={g.id} value={g.id}>{g.name}</option>)}
                </Select>
              </SetupField>
            </div>
          </Card>

          <Card title="4 · What is this run for?"
            help={<p>Sets how many questions go out at once to suit the run: 1 when speed is judged (nothing waits, so timings are the bot's own), 4 for right-or-wrong runs, 8 for a large set on a bot built for load. Picking a number under In parallel overrides it.</p>}
            actions={<Segmented value={purpose ?? ('' as Purpose)} onChange={(p) => { setPurpose(p); setConcurrency(null) }} options={PURPOSES.map((p) => ({ id: p.id, label: p.label }))} label="Run purpose" />}>
            <div className="space-y-6">
              <Panel>
                <p className={clsx('text-lead font-medium', reliability.tone === 'good' ? 'text-good-ink' : reliability.tone === 'warn' ? 'text-warn-ink' : 'text-bad-ink')} data-testid="parallel-line">
                  {e ? <><span className="num font-mono">{answers}</span> answers</> : 'Each question'}, <span className="num font-mono">{concurrency}</span> at a time
                  {e?.per_call_ms ? <> → about <span className="num font-mono">{duration(Math.round((answers * e.per_call_ms) / 1000 / concurrency))}</span></> : null}
                  {' '}· speed figures: <b className="font-semibold">{reliability.text}</b>
                  {(budget || e?.spend_cap_usd != null) && concurrency > 1 ? <> · the first <span className="num font-mono">{concurrency}</span> answers start before their cost is known, so they can pass the cap</> : null}
                </p>
                <QueueViz atOnce={concurrency} />
              </Panel>
              {warnings.length > 0 && <div className="space-y-2">{warnings.map((w) => <Notice key={w.title} tone="warn" title={w.title}>{w.body}</Notice>)}</div>}
            </div>
          </Card>
        </div>

        <aside className="space-y-4 xl:sticky xl:top-20 xl:self-start" data-testid="run-receipt">
          <RunReceipt e={e} trials={trials} concurrency={concurrency} gateName={gate?.name ?? null} judgeLabel={judgeValue}
            targetId={tv?.id ?? null} loading={ready && est.isLoading}>
            {e?.blocked && <div className="mt-3 font-sans"><Notice tone="bad" title="This grading model is not allowed here">{e.blocked}</Notice></div>}
          </RunReceipt>
          {touched && errors.length > 0 && <Notice tone="warn" title="Before starting"><ul className="list-disc pl-4">{errors.map((x) => <li key={x}>{x}</li>)}</ul></Notice>}
          {start.isError && <ErrorState error={start.error} />}
          <Button variant="primary" size="lg" className="w-full" loading={start.isPending} disabled={!!e?.blocked || (!!otherPicked && !allowOther)}
            onClick={() => { setTouched(true); if (!errors.length) long.run(async () => ({ seconds: e?.estimated_seconds }), () => start.mutate()) }}>
            <Play className="size-4" /> Create and run
          </Button>
        </aside>
        {long.dialog}
      </div>
    </>
  )
}
