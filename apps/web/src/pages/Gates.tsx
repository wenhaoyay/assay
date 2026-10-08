import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { Plus, ShieldCheck, Trash2 } from 'lucide-react'
import { AnimatePresence, motion } from 'motion/react'
import { useState } from 'react'
import { Badge, Button, Card, Empty, ErrorState, Explain, Field, Input, Loading, PageHeader, Segmented, Select, Textarea } from '../components/ui'
import { api } from '../lib/api'
import { useCrumbs } from '../lib/crumbs'
import { projectOption, useProjects } from '../lib/projects'
import type { EvaluatorInfo, Gate } from '../lib/types'

type Rule = { metric: string; kind: 'min' | 'max' | 'drop'; value: string }

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

function describe(r: Rule): string {
  const isRate = r.metric.includes('rate') || r.metric.includes('accuracy') || !BUILTIN.some((b) => b.id === r.metric)
  const v = Number(r.value)
  const shown = isRate && !r.metric.includes('latency') && !r.metric.includes('cost') && !r.metric.includes('tokens') ? `${(v * 100).toFixed(0)}%` : String(v)
  if (r.kind === 'drop') return `${r.metric}: may drop at most ${isRate ? `${(v * 100).toFixed(1)}pp` : v} vs the baseline`
  return `${r.metric} ${r.kind === 'min' ? 'at least' : 'at most'} ${shown}`
}

export function GatesPage() {
  useCrumbs([{ label: 'Setup' }, { label: 'Gates' }], 'gates')
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
  const metrics = [...BUILTIN, ...(evs.data?.evaluators ?? []).map((e) => ({ id: e.id, label: `${e.name} (pass rate)`, unit: 'rate' }))]

  const save = useMutation({
    mutationFn: () => {
      const config = mode === 'json' ? JSON.parse(text) : rulesToGate(rules)
      const body = { project_id: projectId || projects.visible[0]?.id || 1, name, config }
      return editing === 'new' ? api.post<Gate>('/api/gates', body) : api.put<Gate>(`/api/gates/${(editing as Gate).id}`, body)
    },
    // Show the saved gate at once (no wait for the refetch), then confirm with the server.
    onSuccess: (g) => {
      qc.setQueryData<Gate[]>(['gates'], (old) => {
        const list = old ?? []
        return list.some((x) => x.id === g.id) ? list.map((x) => (x.id === g.id ? g : x)) : [...list, g]
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

  return (
    <>
      <PageHeader title="Release gates" description="Rules a run must meet before you ship: minimum scores, maximum latency or cost, and how far a metric may drop against a baseline. Each rule is PASS, FAIL or not evaluated - there is no blended score."
        actions={<Button variant="primary" onClick={() => start('new')}><Plus className="size-3.5" /> New gate</Button>} />
      <AnimatePresence>
        {editing && (
          <motion.div initial={{ opacity: 0, height: 0 }} animate={{ opacity: 1, height: 'auto' }} exit={{ opacity: 0, height: 0 }} className="mb-5 overflow-hidden">
            <Card title={editing === 'new' ? 'New gate' : `Edit ${editing.name}`} actions={<Segmented size="sm" value={mode} onChange={(m) => { if (m === 'json') setText(JSON.stringify(rulesToGate(rules), null, 2)); else { try { setRules(gateToRules(JSON.parse(text))) } catch { /* keep */ } } setMode(m) }} options={[{ id: 'form', label: 'Rules' }, { id: 'json', label: 'JSON' }]} />}>
              <div className="grid gap-3 md:grid-cols-2">
                <Field label="Name"><Input value={name} onChange={(e) => setName(e.target.value)} /></Field>
                <Field label="Chatbot"><Select value={projectId} onChange={(e) => setProjectId(Number(e.target.value))} aria-label="Gate chatbot">{projects.visible.map((p) => <option key={p.id} value={p.id}>{projectOption(p)}</option>)}</Select></Field>
              </div>
              {mode === 'form' ? (
                <div className="mt-4 space-y-2">
                  {rules.map((r, i) => (
                    <motion.div key={i} layout initial={{ opacity: 0, x: -6 }} animate={{ opacity: 1, x: 0 }} className="grid grid-cols-[minmax(0,1fr)_170px_120px_auto] items-center gap-2">
                      <Select value={r.metric} onChange={(e) => setRule(i, { metric: e.target.value })} aria-label="Metric">
                        {metrics.map((m) => <option key={m.id} value={m.id}>{m.label}</option>)}
                      </Select>
                      <Select value={r.kind} onChange={(e) => setRule(i, { kind: e.target.value as Rule['kind'] })} aria-label="Rule">
                        <option value="min">must be at least</option><option value="max">must be at most</option><option value="drop">may drop at most</option>
                      </Select>
                      <Input value={r.value} onChange={(e) => setRule(i, { value: e.target.value })} aria-label="Limit" />
                      <Button variant="ghost" size="sm" onClick={() => setRules((rs) => rs.filter((_, k) => k !== i))} aria-label="Remove rule"><Trash2 className="size-3.5" /></Button>
                    </motion.div>
                  ))}
                  <Button size="sm" onClick={() => setRules((rs) => [...rs, { metric: 'overall_pass_rate', kind: 'min', value: '0.8' }])}><Plus className="size-3.5" />Add rule</Button>
                  <Explain>Rates are fractions: 0.85 means 85%. "May drop at most 0.03" means at most 3 percentage points below the baseline run.</Explain>
                </div>
              ) : <div className="mt-4"><Textarea rows={10} value={text} onChange={(e) => setText(e.target.value)} spellCheck={false} /></div>}
              {save.isError && <div className="mt-3"><ErrorState error={save.error} /></div>}
              <div className="mt-4 flex gap-2"><Button variant="primary" loading={save.isPending} onClick={() => save.mutate()}>Save gate</Button><Button variant="ghost" onClick={() => setEditing(null)}>Cancel</Button></div>
            </Card>
          </motion.div>
        )}
      </AnimatePresence>
      {gates.isLoading ? <Loading /> : gates.isError ? <ErrorState error={gates.error} /> : (gates.data ?? []).length === 0 ? (
        <Empty title="No gates yet" icon={<ShieldCheck className="size-6" />} action={<Button variant="primary" onClick={() => start('new')}>Create a gate</Button>}>A gate turns "is it good enough to ship?" into explicit rules. Runs started with a gate show a PASS or FAIL stamp.</Empty>
      ) : (
        <div className="grid gap-4 lg:grid-cols-2">
          {gates.data!.map((g) => (
            <Card key={g.id} title={<span className="flex items-center gap-2"><ShieldCheck className="size-4 text-accent" />{g.name}</span>} subtitle={projects.all.find((p) => p.id === g.project_id)?.name}
              actions={<Button size="sm" variant="ghost" onClick={() => start(g)}>Edit</Button>}>
              <ul className="space-y-1.5">
                {gateToRules(g.config).map((r, i) => <li key={i} className="flex items-center gap-2 text-sm"><Badge tone={r.kind === 'drop' ? 'info' : 'neutral'}>{r.kind === 'drop' ? 'vs baseline' : 'absolute'}</Badge>{describe(r)}</li>)}
              </ul>
            </Card>
          ))}
        </div>
      )}
    </>
  )
}
