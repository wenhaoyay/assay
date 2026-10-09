import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { Plus, ShieldCheck, Trash2 } from 'lucide-react'
import { AnimatePresence, motion } from 'motion/react'
import { useState } from 'react'
import { ReleaseReceipt } from '../components/ReleaseReceipt'
import { GateSentence, type Rule } from '../components/setup/gateText'
import { GateWhatIf, type WhatIfRun } from '../components/setup/GateWhatIf'
import { SetupField } from '../components/setup/SetupField'
import { Button, Card, Empty, ErrorState, Input, Loading, PageHeader, Segmented, Select, Textarea } from '../components/ui'
import { api } from '../lib/api'
import { useCrumbs } from '../lib/crumbs'
import { plural } from '../lib/format'
import { projectOption, useProjects } from '../lib/projects'
import type { EvaluatorInfo, Gate, ProjectHome, RunDetail, RunHeader } from '../lib/types'

const BUILTIN = [
  { id: 'overall_pass_rate', label: 'Overall pass rate', unit: 'rate' },
  { id: 'tool_accuracy', label: 'Tool accuracy', unit: 'rate' },
  { id: 'p95_latency_ms', label: 'p95 latency (ms)', unit: 'ms' },
  { id: 'p50_latency_ms', label: 'p50 latency (ms)', unit: 'ms' },
  { id: 'average_cost_usd', label: 'Cost per question (USD)', unit: 'usd' },
  { id: 'average_total_tokens', label: 'Tokens per question', unit: 'n' },
]

export function gateToRules(config: Record<string, unknown>): Rule[] {
  const rules: Rule[] = []
  for (const [k, v] of Object.entries(config)) {
    if (k === 'regression') {
      for (const [m, r] of Object.entries(v as Record<string, { maximum_drop: number }>)) rules.push({ metric: m, kind: 'drop', value: String(r.maximum_drop) })
    } else {
      for (const [op, lim] of Object.entries(v as Record<string, number>)) rules.push({ metric: k, kind: op === 'min' ? 'min' : 'max', value: String(lim) })
    }
  }
  return rules
}

export function rulesToGate(rules: Rule[]): Record<string, unknown> {
  const out: Record<string, Record<string, unknown>> = {}
  for (const r of rules) {
    if (!r.metric || r.value === '') continue
    if (r.kind === 'drop') out.regression = { ...(out.regression ?? {}), [r.metric]: { maximum_drop: Number(r.value) } }
    else out[r.metric] = { ...(out[r.metric] ?? {}), [r.kind]: Number(r.value) }
  }
  return out
}

const PAGE_HELP = (
  <>
    <p>Rules a run must meet before you ship: minimum scores, maximum latency or cost, and how far a metric may drop against a baseline. Each rule is PASS, FAIL or not evaluated - there is no blended score.</p>
    <p>A gate turns "is it good enough to ship?" into explicit rules. Runs started with a gate show a PASS or FAIL stamp.</p>
  </>
)

export function GatesPage() {
  const qc = useQueryClient()
  const gates = useQuery({ queryKey: ['gates'], queryFn: () => api.get<Gate[]>('/api/gates') })
  const projects = useProjects()
  const evs = useQuery({ queryKey: ['evaluators'], queryFn: () => api.get<{ evaluators: EvaluatorInfo[] }>('/api/evaluators') })
  const [editing, setEditing] = useState<Gate | 'new' | null>(null)
  const [name, setName] = useState('')
  const [projectId, setProjectId] = useState<number | ''>('')
  const [rules, setRules] = useState<Rule[]>([])
  const [mode, setMode] = useState<'form' | 'json'>('form')
  const [text, setText] = useState('')
  const [pickedGate, setPickedGate] = useState<number | null>(null)
  const metrics = [...BUILTIN, ...(evs.data?.evaluators ?? []).map((e) => ({ id: e.id, label: `${e.name} (pass rate)`, unit: 'rate' }))]

  const list = gates.data ?? []
  const gate = list.find((g) => g.id === pickedGate) ?? list[0]
  const chatbot = gate ? projects.all.find((p) => p.id === gate.project_id)?.name : undefined
  useCrumbs([{ label: 'Setup' }, { label: 'Gates' }], 'gates')

  const save = useMutation({
    mutationFn: () => {
      const config = mode === 'json' ? JSON.parse(text) : rulesToGate(rules)
      const body = { project_id: projectId || projects.visible[0]?.id || 1, name, config }
      return editing === 'new' ? api.post<Gate>('/api/gates', body) : api.put<Gate>(`/api/gates/${(editing as Gate).id}`, body)
    },
    // Show the saved gate at once (no wait for the refetch), then confirm with the server.
    onSuccess: (g) => {
      qc.setQueryData<Gate[]>(['gates'], (old) => {
        const l = old ?? []
        return l.some((x) => x.id === g.id) ? l.map((x) => (x.id === g.id ? g : x)) : [...l, g]
      })
      qc.invalidateQueries({ queryKey: ['gates'] })
      qc.invalidateQueries({ queryKey: ['home'] })
      setEditing(null)
    },
  })
  const start = (g: Gate | 'new') => {
    setEditing(g)
    setName(g === 'new' ? 'Release gate' : g.name)
    setProjectId(g === 'new' ? (projects.visible.find((p) => !p.is_demo) ?? projects.visible[0])?.id ?? '' : g.project_id)
    const cfg = g === 'new' ? { overall_pass_rate: { min: 0.85 }, p95_latency_ms: { max: 3000 }, regression: { overall_pass_rate: { maximum_drop: 0.03 } } } : g.config
    setRules(gateToRules(cfg))
    setText(JSON.stringify(cfg, null, 2))
    setMode('form')
  }
  const setRule = (i: number, patch: Partial<Rule>) => setRules((rs) => rs.map((r, k) => (k === i ? { ...r, ...patch } : r)))

  const title = list.length === 1 && gate ? gate.name : 'Release gates'
  return (
    <>
      <PageHeader eyebrow={gate && chatbot ? `Release gate · ${chatbot}` : 'Release gates'} title={title} help={PAGE_HELP}
        actions={<Button variant="primary" onClick={() => start('new')}><Plus className="size-3.5" /> New gate</Button>}>
        {gate && (
          <div className="mt-3 max-w-4xl space-y-3">
            {list.length > 1 && (
              <Segmented size="sm" value={String(gate.id)} onChange={(v) => setPickedGate(Number(v))} label="Gate"
                options={list.map((g) => ({ id: String(g.id), label: g.name }))} />
            )}
            <p className="text-lead text-ink-2" data-testid="gate-sentence"><GateSentence rules={gateToRules(gate.config)} /></p>
          </div>
        )}
      </PageHeader>

      <AnimatePresence>
        {editing && (
          <motion.div initial={{ opacity: 0, height: 0 }} animate={{ opacity: 1, height: 'auto' }} exit={{ opacity: 0, height: 0 }} className="mb-10 overflow-hidden">
            <Card boxed title={editing === 'new' ? 'New gate' : `Edit ${editing.name}`}
              help={<>
                <p>Each rule names a metric, how it is judged and a limit. Absolute rules hold for any run; "may drop at most" compares the run with the baseline it is checked against.</p>
                <p>Rates are fractions: 0.85 means 85%. "May drop at most 0.03" means at most 3 percentage points below the baseline run.</p>
                <p>JSON shows the same rules as the gate's raw configuration, for copying between gates.</p>
              </>}
              actions={<Segmented size="sm" value={mode} onChange={(md) => { if (md === 'json') setText(JSON.stringify(rulesToGate(rules), null, 2)); else { try { setRules(gateToRules(JSON.parse(text))) } catch { /* keep */ } } setMode(md) }} options={[{ id: 'form', label: 'Rules' }, { id: 'json', label: 'JSON' }]} />}>
              <div className="grid gap-4 md:grid-cols-2">
                <SetupField label="Name"><Input value={name} onChange={(e) => setName(e.target.value)} /></SetupField>
                <SetupField label="Chatbot"><Select value={projectId} onChange={(e) => setProjectId(Number(e.target.value))} aria-label="Gate chatbot">{projects.visible.map((p) => <option key={p.id} value={p.id}>{projectOption(p)}</option>)}</Select></SetupField>
              </div>
              {mode === 'form' ? (
                <div className="mt-5 space-y-2">
                  <div className="t-label">Rules</div>
                  {rules.map((r, i) => (
                    <motion.div key={i} layout initial={{ opacity: 0, x: -6 }} animate={{ opacity: 1, x: 0 }} className="grid grid-cols-[minmax(0,1fr)_170px_120px_auto] items-center gap-2">
                      <Select value={r.metric} onChange={(e) => setRule(i, { metric: e.target.value })} aria-label="Metric">
                        {metrics.map((m) => <option key={m.id} value={m.id}>{m.label}</option>)}
                        {!metrics.some((m) => m.id === r.metric) && <option value={r.metric}>{r.metric}</option>}
                      </Select>
                      <Select value={r.kind} onChange={(e) => setRule(i, { kind: e.target.value as Rule['kind'] })} aria-label="Rule">
                        <option value="min">must be at least</option><option value="max">must be at most</option><option value="drop">may drop at most</option>
                      </Select>
                      <Input value={r.value} onChange={(e) => setRule(i, { value: e.target.value })} aria-label="Limit" className="font-mono" />
                      <Button variant="ghost" size="sm" onClick={() => setRules((rs) => rs.filter((_, k) => k !== i))} aria-label="Remove rule"><Trash2 className="size-3.5" /></Button>
                    </motion.div>
                  ))}
                  <div className="pt-1">
                    <Button size="sm" onClick={() => setRules((rs) => [...rs, { metric: 'overall_pass_rate', kind: 'min', value: '0.8' }])}><Plus className="size-3.5" />Add rule</Button>
                  </div>
                  <p className="pt-2 text-base text-ink-2" data-testid="draft-sentence"><GateSentence rules={rules} /></p>
                </div>
              ) : <div className="mt-5"><Textarea rows={10} value={text} onChange={(e) => setText(e.target.value)} spellCheck={false} aria-label="Gate JSON" className="font-mono" /></div>}
              {save.isError && <div className="mt-3"><ErrorState error={save.error} /></div>}
              <div className="mt-5 flex gap-2"><Button variant="primary" loading={save.isPending} onClick={() => save.mutate()}>Save gate</Button><Button variant="ghost" onClick={() => setEditing(null)}>Cancel</Button></div>
            </Card>
          </motion.div>
        )}
      </AnimatePresence>

      {gates.isLoading ? <Loading /> : gates.isError ? <ErrorState error={gates.error} /> : list.length === 0 ? (
        <Empty title="No gates yet" icon={<ShieldCheck className="size-6" />} action={<Button variant="primary" onClick={() => start('new')}>Create a gate</Button>}>A gate turns "is it good enough to ship?" into explicit rules. Runs started with a gate show a PASS or FAIL stamp.</Empty>
      ) : (
        <div className="space-y-12">
          {gate && <WhatIf key={gate.id} gate={gate} />}
          {gate && <LatestReceipt gate={gate} />}
          <Card title="Every gate" meta={list.length} help={<p>One gate per line, said as its rules. Edit changes the rules for every run checked against the gate from now on; past verdicts stay as they were.</p>}>
            <ul className="divide-y divide-line">
              {list.map((g) => (
                <li key={g.id} className="flex items-start gap-3 py-3.5">
                  <ShieldCheck className="mt-0.5 size-4 shrink-0 text-accent" aria-hidden />
                  <div className="min-w-0 flex-1">
                    <div className="flex flex-wrap items-baseline gap-x-2">
                      <span className="text-base font-semibold">{g.name}</span>
                      <span className="text-sm text-ink-2">{projects.all.find((p) => p.id === g.project_id)?.name}</span>
                    </div>
                    <p className="mt-0.5 text-sm text-ink-2"><GateSentence rules={gateToRules(g.config)} /></p>
                  </div>
                  <Button size="sm" variant="ghost" onClick={() => start(g)}>Edit</Button>
                </li>
              ))}
            </ul>
          </Card>
        </div>
      )}
    </>
  )
}

/** The chosen gate's chatbot: every comparable past run, re-judged against a limit you drag. */
function WhatIf({ gate }: { gate: Gate }) {
  const home = useQuery({ queryKey: ['project-home', gate.project_id], queryFn: () => api.get<ProjectHome>(`/api/projects/${gate.project_id}/home`) })
  const cfg = gate.config as Record<string, { min?: number; max?: number }>
  const passMin = cfg.overall_pass_rate?.min ?? null
  const p95Max = cfg.p95_latency_ms?.max ?? null
  // The longest line of comparable runs that asked this chatbot's own questions.
  const lineage = [...(home.data?.lineages ?? [])]
    .map((l) => ({ ...l, points: l.points.filter((p) => !p.off_topic && p.pass_rate !== null) }))
    .sort((a, b) => b.points.length - a.points.length)[0]
  const runs: WhatIfRun[] = (lineage?.points ?? [])
    .map((p) => ({ run_id: p.run_id, pass_rate: p.pass_rate as number, p95_latency_ms: p.p95_latency_ms, variant: p.variant }))
    .sort((a, b) => a.run_id - b.run_id)
  return (
    <Card title="What if the gate were stricter?" meta={runs.length ? plural(runs.length, 'run') : undefined} help={<>
      <p>Every comparable past run of this chatbot (same questions, same checks), re-judged against a gate you set. Each bar is a run's pass rate.</p>
      <p>Drag the dashed line (or focus it and use the arrow keys) to move the pass-rate limit; the slider under the chart sets the p95 limit. The stamps flip as runs cross the line, and the count says how many would have shipped.</p>
      <p>Only the pass-rate and p95 rules are re-judged here; the gate's other rules are not. Nothing is saved: edit the gate to change it.</p>
    </>}>
      {home.isLoading ? <Loading rows={6} /> : home.isError ? <ErrorState error={home.error} /> : runs.length === 0 ? (
        <Empty title="No past runs to re-judge">Run this chatbot a few times with the same questions; each run appears here as a bar.</Empty>
      ) : <GateWhatIf runs={runs} passMin={passMin} p95Max={p95Max} />}
    </Card>
  )
}

/** The latest run this gate checked, as the slip it handed out. */
function LatestReceipt({ gate }: { gate: Gate }) {
  const runs = useQuery({ queryKey: ['runs'], queryFn: () => api.get<RunHeader[]>('/api/runs?limit=300') })
  const latest = (runs.data ?? []).filter((r) => r.project_id === gate.project_id && r.gate_status).sort((a, b) => b.id - a.id)[0]
  const run = useQuery({ queryKey: ['run', latest?.id], queryFn: () => api.get<RunDetail>(`/api/runs/${latest!.id}`), enabled: !!latest })
  const checked = !!run.data?.gate_results?.some((g) => g.gate_id === gate.id || g.gate_id === null)
  return (
    <Card title="The receipt" meta={latest && checked ? `run #${latest.id}` : undefined} help={<>
      <p>What a gate hands you when it checks a run: the rules, the figures, the run's fingerprint (one dot per question) and the stamp. This is the latest run checked against this gate.</p>
      <p>Each line is one rule: the run's figure, then ✓ when it met the rule or ✕ when it did not. Lines marked "vs baseline" compare the run with the baseline run named at the top.</p>
      <p>Copy the link or print it for whoever signs off.</p>
    </>}>
      {runs.isLoading || (latest && run.isLoading) ? <Loading rows={6} /> : !latest || !run.data || !checked ? (
        <Empty title="No run has met this gate yet">Start a run with this gate (New run › Release gate) and its receipt appears here.</Empty>
      ) : <ReleaseReceipt run={run.data} className="w-full max-w-[400px]" />}
    </Card>
  )
}
