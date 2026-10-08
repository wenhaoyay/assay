import { useQuery } from '@tanstack/react-query'
import clsx from 'clsx'
import { AlertTriangle, GitCompareArrows, Play, X } from 'lucide-react'
import { AnimatePresence, motion } from 'motion/react'
import { useMemo, useState } from 'react'
import { Link, useNavigate } from 'react-router-dom'
import { RunsTable } from '../components/RunsTable'
import { Sparkline } from '../components/viz'
import { Button, Card, Code, Empty, ErrorState, Input, Kbd, Loading, PageHeader, Segmented, Select, Term, linkButton } from '../components/ui'
import { api } from '../lib/api'
import { useCrumbs } from '../lib/crumbs'
import type { Project, RunHeader } from '../lib/types'

export function RunsPage() {
  useCrumbs([{ label: 'Home', to: '/' }, { label: 'Runs' }], 'runs')
  const nav = useNavigate()
  const runs = useQuery({
    queryKey: ['runs'],
    queryFn: () => api.get<RunHeader[]>('/api/runs?limit=300'),
    refetchInterval: (q) => (q.state.data?.some((r) => r.status === 'running' || r.status === 'queued') ? 2000 : false),
  })
  const projects = useQuery({ queryKey: ['projects'], queryFn: () => api.get<Project[]>('/api/projects') })
  const [selected, setSelected] = useState<number[]>([])
  const [group, setGroup] = useState<'comparable' | 'flat'>('comparable')
  const [project, setProject] = useState<number | ''>('')
  const [search, setSearch] = useState('')

  const rows = useMemo(() => (runs.data ?? []).filter((r) =>
    (!project || r.project_id === project) &&
    (!search || `${r.id} ${r.experiment} ${r.target} ${r.variant_label}`.toLowerCase().includes(search.toLowerCase()))), [runs.data, project, search])
  const groups = useMemo(() => {
    const m = new Map<string, RunHeader[]>()
    for (const r of rows) {
      const k = r.comparability_key ?? 'other'
      m.set(k, [...(m.get(k) ?? []), r])
    }
    return [...m.values()]
  }, [rows])

  const toggle = (id: number) => setSelected((s) => (s.includes(id) ? s.filter((x) => x !== id) : s.length >= 2 ? s : [...s, id]))
  const pair = selected.map((id) => (runs.data ?? []).find((r) => r.id === id)).filter(Boolean) as RunHeader[]
  const [a, b] = [...pair].sort((x, y) => x.id - y.id)
  const comparable = pair.length === 2 && a.comparability_key === b.comparability_key

  return (
    <>
      <PageHeader
        title="Runs"
        help={<>
          <p>Each run asked one chatbot version every question in a dataset, and graded the answers.</p>
          <p>Runs are grouped by <Term k="comparable">comparable setup</Term>: runs in one group asked the same questions with the same checks and judge, so their numbers can be read side by side. Across groups they cannot. The line beside each group is its pass rate, oldest to newest.</p>
          <p>Tick two runs to compare them. J/K move through the first group, Enter opens the picked run.</p>
        </>}
        actions={<Link to="/runs/new" viewTransition className={linkButton('primary')}><Play className="size-3.5" /> New run</Link>}
      />
      <div className="mb-6 flex flex-wrap items-center gap-2">
        <Input className="w-64" placeholder="Search runs" value={search} onChange={(e) => setSearch(e.target.value)} aria-label="Search runs" />
        <Select className="w-56" value={project} onChange={(e) => setProject(e.target.value ? Number(e.target.value) : '')} aria-label="Chatbot">
          <option value="">All chatbots</option>{(projects.data ?? []).map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
        </Select>
        <Segmented size="sm" label="Grouping" value={group} onChange={setGroup} options={[{ id: 'comparable', label: 'Grouped by setup' }, { id: 'flat', label: 'All, newest first' }]} />
        <span className="ml-auto flex items-center gap-1 text-xs text-ink-3"><Kbd>J</Kbd><Kbd>K</Kbd> move · <Kbd>Enter</Kbd> open</span>
      </div>
      {runs.isLoading ? <Loading /> : runs.isError ? <ErrorState error={runs.error} /> : rows.length === 0 ? (
        (runs.data ?? []).length === 0
          ? <Empty title="No runs yet. The needle is resting on zero." action={<Link to="/runs/new" className={linkButton('primary')}>Start a run</Link>}>Run a chatbot version on a dataset, or load the Acme demo with <Code>gaugelab seed --run</Code>.</Empty>
          : <Empty title="Nothing matches that search.">Clear the search or pick all chatbots.</Empty>
      ) : group === 'flat' ? (
        <Card title="All runs" meta={`${rows.length} runs`} padded={false}><RunsTable runs={rows} selectable selected={selected} onToggle={toggle} keyboard /></Card>
      ) : (
        <div className="space-y-10">
          {groups.map((g, i) => {
            const r0 = g[0]
            const heur = r0.judge?.provider === 'heuristic'
            const trend = [...g].reverse().filter((r) => !r.off_topic).map((r) => r.metrics?.overall_pass_rate ?? null)
            return (
              <Card key={r0.comparability_key ?? i} padded={false}
                title={<>{r0.dataset} <span className="font-mono text-sm font-medium text-ink-3">v{r0.dataset_version}</span></>}
                meta={<>{g.length} {g.length === 1 ? 'run' : 'runs'} · {r0.n_cases ?? '?'} questions{r0.case_filter ? ' (reduced)' : ''} · setup {r0.comparability_key?.slice(0, 6)}</>}
                help={<>
                  <p>These runs asked the same {r0.n_cases ?? ''} questions{r0.case_filter ? ' (a reduced suite)' : ''} with the same checks and judge, so their pass rates can be read side by side.</p>
                  <p>Judge: {r0.judge ? (heur ? 'heuristic word overlap (a rough guide, hatched wherever it appears)' : `${r0.judge.provider}/${r0.judge.model}`) : 'none'}. Setup {r0.comparability_key}: runs with different checks count different things in their pass rate.</p>
                  <p>The line is each run's pass rate, oldest to newest; runs that asked another chatbot's questions are left out of it.</p>
                </>}
                actions={<span className="flex items-center gap-3">
                  <span className={clsx('rounded px-1.5 text-xs text-ink-3', heur && 'hatched text-ink-2')}>{r0.judge ? (heur ? 'heuristic judge' : r0.judge.model) : 'no judge'}</span>
                  {trend.length > 1 && <Sparkline values={trend} width={120} height={26} label="pass rate across these runs" />}
                </span>}>
                <RunsTable runs={g} selectable selected={selected} onToggle={toggle} keyboard={i === 0} />
              </Card>
            )
          })}
        </div>
      )}

      <AnimatePresence>
        {selected.length > 0 && (
          <motion.div initial={{ y: 80, opacity: 0 }} animate={{ y: 0, opacity: 1 }} exit={{ y: 80, opacity: 0 }} transition={{ type: 'spring', stiffness: 400, damping: 32 }}
            style={{ x: '-50%' }}
            className="fixed bottom-6 left-1/2 z-40 flex items-center gap-3 rounded-xl border border-line bg-surface px-4 py-2.5 shadow-pop">
            <span className="text-sm">
              {pair.length === 1 ? <>Run <span className="font-mono font-semibold">#{pair[0].id}</span> picked · tick one more</> : <>Compare <span className="font-mono font-semibold text-series-1">#{a.id}</span> (baseline) with <span className="font-mono font-semibold text-series-2">#{b.id}</span></>}
            </span>
            {pair.length === 2 && !comparable && <span className="flex items-center gap-1 text-xs text-warn-ink"><AlertTriangle className="size-3.5" />different setups</span>}
            <Button variant="primary" size="sm" disabled={pair.length < 2} onClick={() => nav(`/compare?baseline=${a.id}&candidate=${b.id}`, { viewTransition: true })}><GitCompareArrows className="size-3.5" />Compare</Button>
            <Button variant="ghost" size="sm" onClick={() => setSelected([])} aria-label="Clear selection"><X className="size-3.5" /></Button>
          </motion.div>
        )}
      </AnimatePresence>
    </>
  )
}
