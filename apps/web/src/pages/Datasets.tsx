import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import clsx from 'clsx'
import { Archive, ArchiveRestore, Download, Hammer, Lock, Plus, Sparkles, Trash2 } from 'lucide-react'
import { useMemo, useState, type ReactNode } from 'react'
import { Link, useParams, useSearchParams } from 'react-router-dom'
import { DatasetAdd } from '../components/DatasetAdd'
import { AddVariations, BuildPanel, ProvenanceBadge, TermChips } from '../components/Golden'
import { CaseMatrixView, MatrixLegend } from '../components/viz'
import { Badge, Button, Card, Code, Empty, ErrorState, Field, Input, Json, Loading, Notice, PageHeader, Segmented, Select, StatusBadge, Textarea, linkButton, useLongWork } from '../components/ui'
import { Checkbox, FileInput, TextLink } from '../components/form'
import { ScrollTable, ScrollTabs } from '../components/Layout'
import { LabelHelp } from '../components/LabelHelp'
import { api } from '../lib/api'
import { useCrumbs } from '../lib/crumbs'
import { plural, when } from '../lib/format'
import { usePrefs } from '../lib/prefs'
import { plainPattern } from '../lib/trials'
import { projectOption, useProjects } from '../lib/projects'
import type { Candidate, CaseMatrix, Dataset, DatasetVersion, EditResult, Project, ProviderConfig, Settings, TestCase } from '../lib/types'

export function VersionBadge({ v }: { v: Pick<DatasetVersion, 'version' | 'status' | 'run_count'> }) {
  return (
    <span className="inline-flex items-center gap-1.5">
      <Badge tone="info" className="font-mono">v{v.version}</Badge>
      <StatusBadge status={v.status} />
      {v.status === 'frozen' && (
        <span className="inline-flex items-center gap-1 whitespace-nowrap text-xs text-ink-2" title="Used by a run. It can no longer change; edits create a new version.">
          <Lock className="size-3" aria-hidden /> used by <span className="font-mono">{v.run_count}</span> run{v.run_count === 1 ? '' : 's'}
        </span>
      )}
    </span>
  )
}


export function DatasetsPage() {
  useCrumbs([{ label: 'Setup' }, { label: 'Datasets' }], 'datasets')
  const [params] = useSearchParams()
  const [showArchived, setShowArchived] = useState(false)
  const datasets = useQuery({ queryKey: ['datasets', 'with-archived'], queryFn: () => api.get<Dataset[]>('/api/datasets?include_archived=true') })
  const projects = useProjects()
  const fromProject = Number(params.get('project')) || ''
  const all = (datasets.data ?? []).filter((d) => !projects.hideDemo || !projects.all.find((p) => p.id === d.project_id)?.is_demo)
  const shown = all.filter((d) => showArchived || !d.archived)
  const archivedCount = all.filter((d) => d.archived).length

  return (
    <>
      <PageHeader title="Datasets" help={<>
        <p>Versioned golden datasets: test cases with the outcomes a person expects. A version used by a run is frozen for good; editing it makes a new version.</p>
        <p><span className="font-semibold">Who decides what is correct? You do.</span> Assay cannot infer ground truth: every expected outcome in a dataset was written, imported or approved by a person. AI-generated cases stay in a review queue until someone approves them.</p>
      </>} />
      <div className="space-y-12">
      <div className="grid gap-6 lg:grid-cols-[minmax(0,1fr)_400px] lg:gap-10">
        <WaysToBuild />
        <Card title="Add questions" boxed help={<p>Type or paste questions, or upload a file, into a new or existing dataset. You add the expected answers afterwards, or approve good answers on the Build tab.</p>}>
          <DatasetAdd key={fromProject} defaultProjectId={fromProject} />
        </Card>
      </div>
      {datasets.isLoading ? <Loading /> : datasets.isError ? <ErrorState error={datasets.error} /> : all.length === 0 ? (
        <Empty title="No datasets yet. A gauge with nothing to read.">Add questions above, or run <Code>assay seed</Code> for the 58-case Acme golden set.</Empty>
      ) : (
        <Card padded={false} title="Your datasets" meta={`${shown.length}`} help={<p>Each dataset belongs to one chatbot; change it here. A set that runs have used can only be archived (its questions stay with those runs); an unused one can be deleted.</p>}
          actions={archivedCount > 0 && <Button size="sm" variant="ghost" onClick={() => setShowArchived((v) => !v)}>{showArchived ? 'Hide' : 'Show'} {archivedCount} archived</Button>}>
          <ScrollTable className="[&_table]:min-w-[760px]">
            <thead><tr className="whitespace-nowrap"><th className="t-label">Dataset</th><th className="t-label">Chatbot</th><th className="t-label">Latest version</th><th className="t-label text-right">Cases</th><th className="t-label">Review queue</th><th className="w-40" /></tr></thead>
            <tbody>
              {shown.map((d) => <DatasetRow key={d.id} d={d} projects={projects.all} />)}
            </tbody>
          </ScrollTable>
        </Card>
      )}
      </div>
    </>
  )
}

/** Where golden questions can come from, each one click away. */
function WaysToBuild() {
  const ways: [string, ReactNode][] = [
    ['Approve good answers', <>Open a dataset → <i>Build</i>: mark a bot's answers right or wrong; Assay suggests what a correct answer must mention.</>],
    ['Prompt kit', <>Copy a ready prompt into your own ChatGPT or Claude with your documents; the result lands in the review queue.</>],
    ['Real questions', <>Upload chat history; similar questions are grouped by how often they were asked.</>],
    ['Colleagues', <>Send the <TextLink href="/api/datasets/template.csv" className="underline">spreadsheet template</TextLink> or use expert interview mode.</>],
  ]
  return (
    <Card title="Ways to build a set" boxed className="flex flex-col" help={<p>The machine does the typing; you vouch for every case. Each way ends in the same place: cases a person has approved.</p>}>
      <dl className="divide-y divide-line text-sm">
        {ways.map(([k, v]) => (
          <div key={k} className="grid gap-x-4 gap-y-0.5 py-2.5 first:pt-0 last:pb-0 sm:grid-cols-[9.5rem_minmax(0,1fr)]">
            <dt className="font-medium text-ink">{k}</dt>
            <dd className="text-ink-2">{v}</dd>
          </div>
        ))}
      </dl>
    </Card>
  )
}

function DatasetRow({ d, projects }: { d: Dataset; projects: Project[] }) {
  const qc = useQueryClient()
  const [confirm, setConfirm] = useState(false)
  const refresh = () => { qc.invalidateQueries({ queryKey: ['datasets'] }); qc.invalidateQueries({ queryKey: ['home'] }) }
  const patch = useMutation({ mutationFn: (body: Record<string, unknown>) => api.patch<Dataset>(`/api/datasets/${d.id}`, body), onSuccess: refresh })
  const del = useMutation({ mutationFn: () => api.del(`/api/datasets/${d.id}`), onSuccess: () => { setConfirm(false); refresh() } })
  const used = (d.run_count ?? 0) > 0
  return (
    <>
      <tr className={clsx('hover:bg-surface-2/60', d.archived && 'opacity-60')}>
        <td>
          <Link to={`/datasets/${d.id}`} className="font-medium hover:underline">{d.name}</Link>
          {d.archived && <Badge className="ml-2">archived</Badge>}
          <div className="max-w-md truncate text-xs text-ink-2">{d.description || d.latest?.change_summary}</div>
        </td>
        <td>
          <Select className="w-52" value={d.project_id} aria-label={`Chatbot of ${d.name}`} onChange={(e) => patch.mutate({ project_id: Number(e.target.value) })}>
            {projects.map((p) => <option key={p.id} value={p.id}>{projectOption(p)}</option>)}
          </Select>
        </td>
        <td>{d.latest && <VersionBadge v={d.latest} />}</td>
        <td className="num text-right font-mono">{d.latest?.case_count ?? 0}</td>
        <td>{d.unreviewed_candidates > 0 ? <Badge tone="warn">{d.unreviewed_candidates} unreviewed</Badge> : <span className="text-xs text-ink-3">-</span>}</td>
        <td className="text-right">
          {d.archived ? <Button size="sm" variant="ghost" onClick={() => patch.mutate({ archived: false })}><ArchiveRestore className="size-3.5" />Restore</Button>
            : used ? <Button size="sm" variant="ghost" title="Runs used this set: archiving hides it and keeps their questions" onClick={() => patch.mutate({ archived: true })}><Archive className="size-3.5" />Archive</Button>
            : <Button size="sm" variant="ghost" onClick={() => setConfirm(true)}><Trash2 className="size-3.5" />Delete</Button>}
        </td>
      </tr>
      {(confirm || patch.isError || del.isError) && (
        <tr><td colSpan={6} className="bg-surface-2/50">
          {confirm && (
            <div className="flex flex-wrap items-center gap-2 text-sm">
              <span>Delete <span className="font-semibold">{d.name}</span> and its <span className="font-mono">{d.latest?.case_count ?? 0}</span> {(d.latest?.case_count ?? 0) === 1 ? 'question' : 'questions'}? No run used it. This cannot be undone.</span>
              <Button size="sm" variant="danger" loading={del.isPending} onClick={() => del.mutate()}>Delete</Button>
              <Button size="sm" variant="ghost" onClick={() => setConfirm(false)}>Cancel</Button>
            </div>
          )}
          {patch.isError && <ErrorState error={patch.error} />}
          {del.isError && <ErrorState error={del.error} />}
        </td></tr>
      )}
    </>
  )
}

type DTab = 'cases' | 'build' | 'history' | 'generate' | 'versions'

export function DatasetPage() {
  const { id } = useParams()
  const [params, setParams] = useSearchParams()
  // The tab lives in the address, so links to ?tab=build work from anywhere (and keep ?v=).
  const tab = (params.get('tab') as DTab) ?? 'cases'
  const setTab = (t: DTab) => setParams((p) => { p.set('tab', t); return p })
  const ds = useQuery({ queryKey: ['dataset', id], queryFn: () => api.get<Dataset>(`/api/datasets/${id}`) })
  const versionId = Number(params.get('v')) || ds.data?.latest?.id
  const version = useQuery({
    queryKey: ['dataset-version', versionId],
    queryFn: () => api.get<DatasetVersion>(`/api/dataset-versions/${versionId}`),
    enabled: !!versionId,
  })
  const [notice, setNotice] = useState<string | null>(null)
  const projects = useQuery({ queryKey: ['projects'], queryFn: () => api.get<Project[]>('/api/projects') })
  const matrix = useQuery({ queryKey: ['matrix', id], queryFn: () => api.get<CaseMatrix>(`/api/datasets/${id}/matrix?limit=12`) })
  const project = projects.data?.find((p) => p.id === ds.data?.project_id)
  useCrumbs([...(project ? [{ label: project.name, to: `/p/${project.id}` }] : [{ label: 'Datasets', to: '/datasets' }]), { label: ds.data?.name ?? '...' }], `dataset-${id}-${ds.data?.name}-${project?.name}`)
  if (ds.isLoading) return <Loading />
  if (ds.isError) return <ErrorState error={ds.error} />
  const d = ds.data!
  const switchTo = (vid: number) => setParams((p) => { p.set('v', String(vid)); return p })

  return (
    <>
      <PageHeader
        title={d.name}
        help={<>
          {d.description && <p>{d.description}</p>}
          <p>Cases lists the questions of the chosen version and what a right answer needs. Build turns a bot's answers into golden cases. Results across runs shows every case in every run. Generate drafts candidates from documents for your review.</p>
          <p>A version a run used is frozen: editing a case saves to a new draft version.</p>
        </>}
        actions={
          <>
            <Select aria-label="Version" value={versionId} onChange={(e) => switchTo(Number(e.target.value))} className="w-72">
              {[...d.versions].reverse().map((v) => <option key={v.id} value={v.id}>v{v.version} · {v.case_count} cases · {v.status === 'frozen' ? `frozen, used by ${v.run_count} run${v.run_count === 1 ? '' : 's'}` : 'draft'}</option>)}
            </Select>
            <a className={linkButton()} href={`/api/dataset-versions/${versionId}/export?format=yaml`}><Download className="size-3.5" /> YAML</a>
            <a className={linkButton()} href={`/api/dataset-versions/${versionId}/export?format=json`}><Download className="size-3.5" /> JSON</a>
          </>
        }
      />
      {notice && <div className="mb-6"><Notice tone="warn" title="New version created">{notice}</Notice></div>}
      <ScrollTabs
        tabs={[
          { id: 'cases', label: `Cases${version.data ? ` (${version.data.case_count})` : ''}` },
          { id: 'build', label: <span className="inline-flex items-center gap-1.5"><Hammer className="size-3.5" /> Build</span> },
          { id: 'history', label: 'Results across runs' },
          { id: 'generate', label: <span className="inline-flex items-center gap-1.5"><Sparkles className="size-3.5" /> Generate &amp; review{d.unreviewed_candidates ? <Badge tone="warn">{d.unreviewed_candidates}</Badge> : null}</span> },
          { id: 'versions', label: `Versions (${d.versions.length})` },
        ]}
        value={tab}
        onChange={setTab}
      />
      <div className="mt-6">
        {tab === 'cases' && (version.isLoading ? <Loading /> : version.isError ? <ErrorState error={version.error} /> : version.data && (
          <CasesPanel
            version={version.data}
            matrix={matrix.data}
            focus={params.get('case')}
            onEdited={(r) => {
              if (r.branched) { setNotice(r.notice ?? null); switchTo(r.id) }
            }}
          />
        ))}
        {tab === 'build' && version.data && <BuildPanel dataset={d} version={version.data} project={project} onEdited={(r) => { if (r.branched) { setNotice(r.notice ?? null); switchTo(r.id) } }} />}
        {tab === 'history' && <HistoryPanel matrix={matrix.data} loading={matrix.isLoading} focus={params.get('case')} />}
        {tab === 'generate' && versionId && <GeneratePanel datasetId={d.id} versionId={versionId} onPromoted={(r) => { if (r.branched) setNotice(r.notice ?? null); switchTo(r.id); setTab('cases') }} />}
        {tab === 'versions' && (
          <Card padded={false} title="Versions" meta={`${d.versions.length}`} help={<p>Every saved version of this dataset, newest first. Click one to open its cases. The hash identifies the exact content a run used.</p>}>
            <ScrollTable className="[&_table]:min-w-[760px]">
              <thead><tr className="whitespace-nowrap"><th className="t-label">Version</th><th className="t-label">Status</th><th className="t-label text-right">Cases</th><th className="t-label">Parent</th><th className="t-label">Change summary</th><th className="t-label">Hash</th><th className="t-label">Created</th></tr></thead>
              <tbody>
                {[...d.versions].reverse().map((v) => (
                  <tr key={v.id} className={clsx('cursor-pointer hover:bg-surface-2/60', v.id === versionId && 'bg-surface-2/60')} onClick={() => { switchTo(v.id); setTab('cases') }}>
                    <td className="num font-mono">v{v.version}</td>
                    <td><StatusBadge status={v.status} /></td>
                    <td className="num text-right font-mono">{v.case_count}</td>
                    <td className="num font-mono text-ink-3">{d.versions.find((p) => p.id === v.parent_version_id)?.version ? `v${d.versions.find((p) => p.id === v.parent_version_id)!.version}` : '-'}</td>
                    <td className="max-w-md text-ink-2">{v.change_summary}</td>
                    <td className="font-mono text-xs text-ink-3">{v.content_hash}</td>
                    <td className="text-xs text-ink-3">{when(v.created_at)}</td>
                  </tr>
                ))}
              </tbody>
            </ScrollTable>
          </Card>
        )}
      </div>
    </>
  )
}

function expectedSummary(c: TestCase): string[] {
  const e = c.expected
  const out: string[] = []
  if (e.answer.reference) out.push('reference answer')
  if (e.answer.must_mention.length) out.push(`must mention ${e.answer.must_mention.length}`)
  if (e.answer.must_not_claim.length) out.push(`must not claim ${e.answer.must_not_claim.length}`)
  if (e.answer.regex.length) out.push('pattern')
  if (e.relevant_documents.length) out.push(`${e.relevant_documents.length} document${e.relevant_documents.length === 1 ? '' : 's'} needed`)
  if (e.required_tools.length || e.tool_calls.length) out.push('tool use')
  if (Object.keys(e.expected_outcome).length) out.push('outcome')
  if (e.refusal_expected === true) out.push('should decline')
  return out
}

function CaseHistory({ matrix, caseId }: { matrix?: CaseMatrix; caseId: string }) {
  if (!matrix) return null
  const row = matrix.cells[caseId] ?? {}
  const runs = matrix.runs.filter((r) => row[String(r.id)])
  if (!runs.length) return <span className="text-xs text-ink-3">not run</span>
  return (
    <span className="inline-flex items-center gap-[3px]" title={runs.map((r) => `#${r.id}: ${row[String(r.id)].passed}/${row[String(r.id)].total}`).join('\n')}>
      {runs.slice(-8).map((r) => {
        const v = row[String(r.id)]
        return <Link key={r.id} to={`/runs/${r.id}?tab=cases&case=${encodeURIComponent(caseId)}`} onClick={(e) => e.stopPropagation()} aria-label={`Run ${r.id}: ${v.passed} of ${v.total} passed`}
          className={clsx('size-2.5 rounded-[3px]', v.passed === v.total ? 'bg-good' : v.passed === 0 ? 'bg-bad' : 'bg-flaky', r.judge === 'heuristic' && 'hatched')} />
      })}
      {matrix.always_fail.includes(caseId) && <Badge tone="bad" className="ml-1">always fails</Badge>}
    </span>
  )
}

function HistoryPanel({ matrix, loading, focus }: { matrix?: CaseMatrix; loading: boolean; focus: string | null }) {
  const [filter, setFilter] = useState<'all' | 'changed' | 'always_fail' | 'flaky'>('all')
  if (loading || !matrix) return <Loading />
  if (!matrix.runs.length) return <Empty title="No runs on this dataset yet. Nothing has been measured against it.">Each completed run adds a column here.</Empty>
  return (
    <Card padded={false} title="Every case in every run" meta={`${matrix.cases.length} × ${matrix.runs.length}`} help={<>
      <p>{matrix.cases.length} cases (rows) by {matrix.runs.length} runs (columns, oldest on the left). Each cell is how many tries of that case passed in that run; hatched cells were graded by the heuristic judge.</p>
      <p>A case that fails in every run, whatever the version, is often a wrong or outdated golden answer rather than a bad bot.</p>
    </>}
      actions={<Segmented size="sm" value={filter} onChange={setFilter} options={[{ id: 'all', label: 'All' }, { id: 'changed', label: 'Changed' }, { id: 'flaky', label: 'Flaky' }, { id: 'always_fail', label: `Always failing ${matrix.always_fail.length}` }]} />}>
      <div className="border-b border-line py-2"><MatrixLegend /></div>
      <CaseMatrixView data={matrix} filter={filter} focusCase={focus} />
    </Card>
  )
}

function CasesPanel({ version, onEdited, matrix, focus }: { version: DatasetVersion; onEdited: (r: EditResult) => void; matrix?: CaseMatrix; focus?: string | null }) {
  const cases = useMemo(() => version.cases ?? [], [version.cases])
  const lint = useQuery({ queryKey: ['lint', version.id], queryFn: () => api.get<{ issues: { case_id: string }[] }>(`/api/dataset-versions/${version.id}/lint`) })
  const [search, setSearch] = useState('')
  const [category, setCategory] = useState('')
  const [editing, setEditing] = useState<TestCase | 'new' | null>(null)
  const categories = useMemo(() => [...new Set(cases.map((c) => c.category))].sort(), [cases])
  const shown = cases.filter((c) =>
    (!category || c.category === category) &&
    (!search || `${c.id} ${c.title} ${c.input.message} ${c.tags.join(' ')}`.toLowerCase().includes(search.toLowerCase())),
  )

  return (
    <div className="space-y-6">
      {version.status === 'frozen' && (
        <Notice tone="info" title="This version is frozen">A run used it, so it stays exactly as it was. Editing a case saves your change to a new draft version.</Notice>
      )}
      {(lint.data?.issues.length ?? 0) > 0 && (
        <p className="text-xs text-warn-ink">{plural(lint.data!.issues.length, 'possible problem')} in this set (duplicates, phrases too generic to test anything, cases that always fail). <Link className="underline" to={`?v=${version.id}&tab=build`}>See them on Build</Link>.</p>
      )}
      {editing && <CaseEditor versionId={version.id} initial={editing === 'new' ? null : editing} onClose={() => setEditing(null)} onSaved={(r) => { setEditing(null); onEdited(r) }} />}
      <div className="flex flex-wrap items-center gap-2">
        <Input className="max-w-72" placeholder="Search id, question, tag" value={search} onChange={(e) => setSearch(e.target.value)} aria-label="Search cases" />
        <Select className="max-w-52" value={category} onChange={(e) => setCategory(e.target.value)} aria-label="Category">
          <option value="">All categories</option>
          {categories.map((c) => <option key={c}>{c}</option>)}
        </Select>
        <span className="text-xs text-ink-2"><span className="font-mono">{shown.length}</span> of <span className="font-mono">{cases.length}</span></span>
        <Button className="ml-auto" variant={editing ? 'secondary' : 'primary'} onClick={() => setEditing('new')}><Plus className="size-3.5" /> Add case</Button>
      </div>
      {cases.length === 0 ? (
        <Empty title="No cases in this version. An empty exam is easy to pass.">Add one manually, import a file, or generate candidates from your documents (they will need your review).</Empty>
      ) : (
        <Card padded={false}>
          <ScrollTable className="[&_table]:min-w-[760px]">
            <thead><tr className="whitespace-nowrap"><th className="t-label">Id</th><th className="t-label">Question</th><th className="t-label">Category</th><th className="t-label">What a right answer needs</th><th className="t-label">Recent runs</th><th></th></tr></thead>
            <tbody>
              {shown.map((c) => (
                <tr key={c.id} data-case={c.id} className={clsx('align-top hover:bg-surface-2/60', focus === c.id && 'bg-accent-wash')}>
                  <td className="whitespace-nowrap font-mono text-xs">{c.id}<div className="mt-0.5"><ProvenanceBadge c={c} origin={(c as TestCase & { _origin?: string })._origin} /></div></td>
                  <td className="max-w-xl"><div className="font-medium text-ink">{c.title}</div><div className="text-ink-2">{c.input.message}</div></td>
                  <td><Badge>{c.category}</Badge><div className="mt-0.5 text-xs text-ink-3">{c.difficulty}</div></td>
                  <td><div className="flex flex-wrap gap-1">{expectedSummary(c).map((s) => <Badge key={s}>{s}</Badge>)}</div></td>
                  <td><CaseHistory matrix={matrix} caseId={c.id} /></td>
                  <td className="whitespace-nowrap"><Button size="sm" variant="ghost" onClick={() => setEditing(c)}>{version.status === 'frozen' ? 'Edit (new version)' : 'Edit'}</Button><AddVariations versionId={version.id} caseId={c.id} /></td>
                </tr>
              ))}
            </tbody>
          </ScrollTable>
        </Card>
      )}
    </div>
  )
}

const NL = '\n'
const lines = (s: string) => s.split(NL).map((x) => x.trim()).filter(Boolean)

export function CaseEditor({ versionId, initial, onClose, onSaved }: {
  versionId: number
  initial: TestCase | null
  onClose: () => void
  onSaved: (r: EditResult) => void
}) {
  const [id, setId] = useState(initial?.id ?? '')
  const [title, setTitle] = useState(initial?.title ?? '')
  const [category, setCategory] = useState(initial?.category ?? 'general')
  const [difficulty, setDifficulty] = useState(initial?.difficulty ?? 'medium')
  const [question, setQuestion] = useState(initial?.input.message ?? '')
  const [reference, setReference] = useState(initial?.expected.answer.reference ?? '')
  const [mention, setMention] = useState((initial?.expected.answer.must_mention ?? []).join('\n'))
  const [forbid, setForbid] = useState((initial?.expected.answer.must_not_claim ?? []).join('\n'))
  const [refusal, setRefusal] = useState(initial?.expected.refusal_expected == null ? '' : String(initial.expected.refusal_expected))
  const [patterns, setPatterns] = useState<string[]>(initial?.expected.answer.regex ?? [])
  const [advanced, setAdvanced] = useState(false)
  const rest = initial ? { ...initial.expected } : {}
  const [advancedText, setAdvancedText] = useState(JSON.stringify({ expected: rest, evaluator_config: initial?.evaluator_config ?? {}, tags: initial?.tags ?? [] }, null, 2))
  const [jsonError, setJsonError] = useState<string | null>(null)

  const save = useMutation({
    mutationFn: () => {
      let adv: { expected?: Record<string, unknown>; evaluator_config?: Record<string, unknown>; tags?: string[] } = {}
      if (advanced) {
        try { adv = JSON.parse(advancedText) } catch (e) { setJsonError((e as Error).message); throw e }
      }
      const baseExpected = (advanced ? adv.expected : initial?.expected) ?? {}
      const answer = { ...((baseExpected as { answer?: object }).answer ?? {}), reference: reference || null, must_mention: lines(mention), must_not_claim: lines(forbid), regex: patterns }
      const body = {
        id, title, category, difficulty,
        description: initial?.description ?? '',
        tags: adv.tags ?? initial?.tags ?? [],
        input: { ...(initial?.input ?? {}), message: question },
        expected: { ...baseExpected, answer, refusal_expected: refusal === '' ? null : refusal === 'true' },
        evaluator_config: adv.evaluator_config ?? initial?.evaluator_config ?? {},
        evaluators: initial?.evaluators ?? null,
        enabled: initial?.enabled ?? true,
        metadata: initial?.metadata ?? {},
      }
      return initial
        ? api.put<EditResult>(`/api/dataset-versions/${versionId}/cases/${encodeURIComponent(initial.id)}`, body)
        : api.post<EditResult>(`/api/dataset-versions/${versionId}/cases`, body)
    },
    onSuccess: onSaved,
  })

  return (
    <Card boxed title={initial ? `Edit ${initial.id}` : 'New case'} actions={<Button size="sm" variant="ghost" onClick={onClose}>Close</Button>}>
      <div className="grid gap-4 lg:grid-cols-2">
        <div className="space-y-3">
          <div className="grid grid-cols-2 gap-3">
            <Field label="Id"><Input value={id} onChange={(e) => setId(e.target.value)} placeholder="warranty_018" /></Field>
            <Field label="Title"><Input value={title} onChange={(e) => setTitle(e.target.value)} /></Field>
            <Field label="Category"><Input value={category} onChange={(e) => setCategory(e.target.value)} /></Field>
            <Field label="Difficulty">
              <Select value={difficulty} onChange={(e) => setDifficulty(e.target.value)}>{['easy', 'medium', 'hard'].map((x) => <option key={x}>{x}</option>)}</Select>
            </Field>
          </div>
          <Field label="User question"><Textarea rows={3} className="font-sans text-sm" value={question} onChange={(e) => setQuestion(e.target.value)} /></Field>
          <Field label={<LabelHelp label="Reference answer"><p>What a correct answer says. Used by the correctness and completeness judges.</p></LabelHelp>}><Textarea rows={3} className="font-sans text-sm" value={reference} onChange={(e) => setReference(e.target.value)} /></Field>
        </div>
        <div className="space-y-3">
          <Field label={<LabelHelp label="Must mention" title="Must mention"><p>One phrase per line; every line must appear in the answer (whole words, capitals do not matter). Write a|b for alternatives.</p><p>Click words from the reference answer below to add them.</p></LabelHelp>}><Textarea rows={3} value={mention} onChange={(e) => setMention(e.target.value)} /></Field>
          <TermChips text={reference} picked={lines(mention)} exclude={[]}
            onToggle={(t) => setMention((m) => (lines(m).includes(t) ? lines(m).filter((x) => x !== t) : [...lines(m), t]).join(NL))} />
          <PlainMatchers onAdd={(p) => setPatterns((x) => [...x, p])} />
          {patterns.length > 0 && <div className="flex flex-wrap gap-1">{patterns.map((p) => <Badge key={p} className="font-mono">{p}<button type="button" aria-label="Remove pattern" className="ml-1" onClick={() => setPatterns((x) => x.filter((y) => y !== p))}>×</button></Badge>)}</div>}
          <Field label={<LabelHelp label="Must not claim"><p>One phrase per line; the answer fails if any appears.</p></LabelHelp>}><Textarea rows={2} value={forbid} onChange={(e) => setForbid(e.target.value)} /></Field>
          <Field label="Should the assistant decline?">
            <Select value={refusal} onChange={(e) => setRefusal(e.target.value)}>
              <option value="">Not specified</option><option value="false">No - it should answer</option><option value="true">Yes - it should decline</option>
            </Select>
          </Field>
          <TextLink size="sm" onClick={() => setAdvanced((v) => !v)}>
            {advanced ? 'Hide advanced' : 'Advanced: relevant documents, tools and arguments, outcome, schema, evaluator config'}
          </TextLink>
          {advanced && (
            <Field label={<LabelHelp label="Advanced (JSON)" title="Fields of expected"><p>relevant_documents, required_tools, tool_calls [{'{'}name, arguments, symmetric{'}'}], forbidden_tools, tool_policy, expected_outcome, max_extra_tool_calls, required_citations, min_citations, answer.regex, answer.json_schema...</p></LabelHelp>} error={jsonError ?? undefined}>
              <Textarea mono rows={14} value={advancedText} onChange={(e) => { setAdvancedText(e.target.value); setJsonError(null) }} spellCheck={false} />
            </Field>
          )}
        </div>
      </div>
      {save.isError && !jsonError && <div className="mt-3"><ErrorState error={save.error} /></div>}
      <div className="mt-4 flex gap-2">
        <Button variant="primary" disabled={!id.trim() || !question.trim()} loading={save.isPending} onClick={() => save.mutate()}>Save case</Button>
        <Button variant="ghost" onClick={onClose}>Cancel</Button>
      </div>
    </Card>
  )
}

function GeneratePanel({ datasetId, versionId, onPromoted }: { datasetId: number; versionId: number; onPromoted: (r: EditResult) => void }) {
  const qc = useQueryClient()
  const docs = useQuery({ queryKey: ['docs', datasetId], queryFn: () => api.get<{ id: number; filename: string; chars: number }[]>(`/api/datasets/${datasetId}/documents`) })
  const providers = useQuery({ queryKey: ['providers'], queryFn: () => api.get<ProviderConfig[]>('/api/providers') })
  const [status, setStatus] = useState<'unreviewed' | 'approved' | 'rejected' | ''>('unreviewed')
  const cands = useQuery({ queryKey: ['candidates', datasetId, status], queryFn: () => api.get<Candidate[]>(`/api/datasets/${datasetId}/candidates${status ? `?status=${status}` : ''}`) })
  const [selected, setSelected] = useState<number[]>([])
  const settings = useQuery({ queryKey: ['settings'], queryFn: () => api.get<{ values: Settings }>('/api/settings') })
  const [picked, setProvider] = useState<number | ''>('')
  // Until you pick, the default model for drafting test cases (Settings > Defaults).
  const provider = picked || (settings.data?.values.default_generator?.provider_config_id ?? '')
  const prefs = usePrefs()
  const [reviewer, setReviewer] = useState(() => prefs.annotator)
  const [editingId, setEditingId] = useState<number | null>(null)
  const [editText, setEditText] = useState('')
  const refresh = () => { qc.invalidateQueries({ queryKey: ['candidates', datasetId] }); qc.invalidateQueries({ queryKey: ['dataset', String(datasetId)] }) }

  const upload = useMutation({
    mutationFn: (f: File) => { const form = new FormData(); form.set('file', f); return api.upload(`/api/datasets/${datasetId}/documents`, form) },
    onSuccess: () => qc.invalidateQueries({ queryKey: ['docs', datasetId] }),
  })
  const generate = useMutation({
    mutationFn: () => api.post<{ created: number; errors: { document: string; error: string }[]; notice: string }>(`/api/datasets/${datasetId}/generate-candidates`, genBody()),
    onSuccess: refresh,
  })
  const review = useMutation({
    mutationFn: ({ id, action }: { id: number; action: string }) => {
      try { localStorage.setItem('gl-reviewer', reviewer) } catch { /* ignore */ }
      return api.post(`/api/candidates/${id}/review`, { action, reviewer })
    },
    onSuccess: refresh,
    meta: { silent: true },
  })
  const long = useLongWork()
  const genBody = () => ({ document_ids: selected, provider_config_id: provider || providers.data?.[0]?.id })
  const edit = useMutation({ mutationFn: (id: number) => api.put(`/api/candidates/${id}`, { case: JSON.parse(editText) }), onSuccess: () => { setEditingId(null); refresh() } })
  const promote = useMutation({ mutationFn: () => api.post<EditResult>(`/api/dataset-versions/${versionId}/approve-candidates`, {}), onSuccess: (r) => { refresh(); onPromoted(r) } })

  return (
    <div className="space-y-6">
      <Notice tone="warn" title="Generated cases are candidates, not ground truth">
        A model drafts questions and answers from your documents. Each one stays <span className="font-semibold">unreviewed</span> until a person approves,
        edits or rejects it; only approved cases can be added to a dataset version. Check the evidence quote: Assay flags quotes it cannot find in the document.
      </Notice>
      <div className="grid gap-4 lg:grid-cols-[minmax(0,1fr)_360px]">
        <Card boxed title="1. Reference documents" help={<p>Upload Markdown, TXT, JSON or PDF, then tick the documents to draft questions from.</p>}>
          <FileInput accept=".md,.txt,.json,.pdf" label="Upload document" aria-label="Upload document" onFiles={(f) => upload.mutate(f[0])} />
          {upload.isError && <div className="mt-2"><ErrorState error={upload.error} /></div>}
          <ul className="mt-3 max-h-48 space-y-1 overflow-y-auto text-sm">
            {(docs.data ?? []).map((d) => (
              <li key={d.id}>
                <Checkbox checked={selected.includes(d.id)} onChange={(on) => setSelected((s) => (on ? [...s, d.id] : s.filter((x) => x !== d.id)))}
                  label={<><span className="font-mono text-xs">{d.filename}</span> <span className="text-xs text-ink-3"><span className="font-mono">{d.chars}</span> chars</span></>} />
              </li>
            ))}
            {docs.data?.length === 0 && <li className="text-ink-2">No documents uploaded yet (Markdown, TXT, JSON or PDF).</li>}
          </ul>
        </Card>
        <Card boxed title="2. Generate">
          <div className="space-y-3">
            <Field label={<LabelHelp label="Generator model"><p>Your documents are sent to this provider. A local Ollama model keeps them on this machine.</p></LabelHelp>}>
              <Select value={provider} onChange={(e) => setProvider(e.target.value ? Number(e.target.value) : '')}>
                {(providers.data ?? []).map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
              </Select>
            </Field>
            {providers.data?.length === 0 && <Notice tone="warn">Add a model under <Link className="underline" to="/settings?tab=models">Settings &gt; Models &amp; keys</Link> first.</Notice>}
            <Button variant="primary" disabled={!selected.length || !providers.data?.length} loading={generate.isPending || long.checking} onClick={() => long.run(() => api.post<{ seconds?: number }>(`/api/datasets/${datasetId}/generate-candidates`, { ...genBody(), estimate_only: true }), () => generate.mutate())}>
              <Sparkles className="size-3.5" /> Generate candidates
            </Button>
            {generate.data && <Notice tone={generate.data.errors.length ? 'warn' : 'good'} title={`${plural(generate.data.created, 'candidate')} added to the review queue`}>{generate.data.errors.map((e) => <div key={e.document}>{e.document}: {e.error}</div>)}</Notice>}
            {generate.isError && <ErrorState error={generate.error} />}
          </div>
        </Card>
      </div>

      <Card
        title="3. Review queue"
        help={<p>Approve, edit or reject each candidate; every decision records who made it. Check the evidence quote: Assay flags quotes it cannot find in the document. Add approved to dataset puts the approved ones into a version.</p>}
        actions={
          <>
            <Input className="h-7 w-40 text-xs" placeholder="Your name (reviewer)" value={reviewer} onChange={(e) => setReviewer(e.target.value)} aria-label="Reviewer" />
            <Select className="h-7 w-36 text-xs" value={status} onChange={(e) => setStatus(e.target.value as typeof status)} aria-label="Filter by status">
              <option value="unreviewed">Unreviewed</option><option value="approved">Approved</option><option value="rejected">Rejected</option><option value="">All</option>
            </Select>
            <Button size="sm" loading={promote.isPending} onClick={() => promote.mutate()}>Add approved to dataset</Button>
          </>
        }
      >
        {promote.isError && <div className="mb-3"><ErrorState error={promote.error} /></div>}
        {review.isError && <div className="mb-3"><ErrorState error={review.error} /></div>}
        {!reviewer && <p className="mb-3 text-xs text-warn-ink">Enter your name to approve or reject: every decision records who made it.</p>}
        {cands.isLoading ? <Loading /> : (cands.data ?? []).length === 0 ? (
          <Empty title="Nothing in this queue." />
        ) : (
          <ul className="space-y-3">
            {cands.data!.map((c) => (
              <li key={c.id} className="rounded-md border border-line p-3">
                <div className="flex flex-wrap items-center gap-2">
                  <StatusBadge status={c.status} />
                  <Badge>{c.kind}</Badge>
                  {c.edited && <Badge tone="info">edited</Badge>}
                  {c.approved_in_version_id && <Badge tone="good">in dataset</Badge>}
                  <span className="font-mono text-xs text-ink-3">{c.document}</span>
                  {c.reviewer && <span className="text-xs text-ink-2">reviewed by {c.reviewer}</span>}
                </div>
                <div className="mt-2 text-sm font-medium">{c.case.input.message}</div>
                <div className="mt-1 text-sm text-ink-2"><span className="text-ink-3">Proposed answer: </span>{c.case.expected.answer.reference ?? '-'}</div>
                {c.evidence.map((e, i) => (
                  <div key={i} className="mt-2 rounded border-l-2 border-line-strong bg-surface-2 px-2 py-1 text-xs">
                    <span className="text-ink-3">Evidence: </span>{e.quote ? `"${e.quote}"` : '(none - declining is the expected behaviour)'}
                    {e.warnings.map((w) => <div key={w} className="mt-1 font-medium text-warn-ink">{w}</div>)}
                  </div>
                ))}
                {editingId === c.id ? (
                  <div className="mt-2 space-y-2">
                    <Textarea mono rows={12} value={editText} onChange={(e) => setEditText(e.target.value)} spellCheck={false} />
                    {edit.isError && <ErrorState error={edit.error} />}
                    <div className="flex gap-2"><Button size="sm" loading={edit.isPending} onClick={() => edit.mutate(c.id)}>Save edit</Button><Button size="sm" variant="ghost" onClick={() => setEditingId(null)}>Cancel</Button></div>
                  </div>
                ) : !c.approved_in_version_id && (
                  <div className="mt-3 flex gap-2">
                    <Button size="sm" disabled={!reviewer || review.isPending} loading={review.isPending && review.variables?.id === c.id && review.variables.action === 'approve'} onClick={() => review.mutate({ id: c.id, action: 'approve' })}>Approve</Button>
                    <Button size="sm" variant="ghost" disabled={!reviewer} onClick={() => { setEditingId(c.id); setEditText(JSON.stringify(c.case, null, 2)) }}>Edit</Button>
                    <Button size="sm" variant="danger" disabled={!reviewer || review.isPending} loading={review.isPending && review.variables?.id === c.id && review.variables.action === 'reject'} onClick={() => review.mutate({ id: c.id, action: 'reject' })}>Reject</Button>
                    {c.status !== 'unreviewed' && <Button size="sm" variant="ghost" onClick={() => review.mutate({ id: c.id, action: 'reset' })}>Undo</Button>}
                  </div>
                )}
                {editingId !== c.id && c.status === 'approved' && c.edited && <div className="mt-2"><Json value={c.case.expected} maxHeight={120} /></div>}
              </li>
            ))}
          </ul>
        )}
      </Card>
      {long.dialog}
    </div>
  )
}

/** Plain-word rules turned into patterns: "contains any of", "the whole word", "the exact number". */
function PlainMatchers({ onAdd }: { onAdd: (pattern: string) => void }) {
  const [kind, setKind] = useState<'any' | 'number' | 'word'>('any')
  const [text, setText] = useState('')
  const make = () => {
    const parts = text.split(/,\s*|\|/).map((x) => x.trim()).filter(Boolean)
    if (!parts.length) return
    onAdd(plainPattern(kind, parts))
    setText('')
  }
  return (
    <div className="rounded-lg border border-line p-2">
      <div className="mb-1 text-xs font-medium text-ink-2"><LabelHelp label="Or a rule in plain words" title="Rules in plain words"><p>Assay writes the pattern (shown below the rule) so "91" does not match "910", and capitals do not matter.</p></LabelHelp></div>
      <div className="flex flex-wrap gap-2">
        <Select className="w-48" value={kind} onChange={(e) => setKind(e.target.value as typeof kind)} aria-label="Rule kind">
          <option value="any">contains any of</option><option value="word">contains the whole word</option><option value="number">contains the exact number</option>
        </Select>
        <Input className="w-56" value={text} onChange={(e) => setText(e.target.value)} placeholder={kind === 'any' ? 'EOL, end of life' : kind === 'number' ? '91' : 'backflush'} aria-label="Rule text" onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); make() } }} />
        <Button size="sm" disabled={!text.trim()} onClick={make}>Add rule</Button>
      </div>

    </div>
  )
}
