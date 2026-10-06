import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import clsx from 'clsx'
import { Download, FileUp, Lock, Plus, Sparkles } from 'lucide-react'
import { useMemo, useState } from 'react'
import { Link, useParams, useSearchParams } from 'react-router-dom'
import { CaseMatrixView, MatrixLegend } from '../components/viz'
import { Badge, Button, Card, Empty, ErrorState, Explain, Field, Input, Json, Loading, Notice, PageHeader, Segmented, Select, StatusBadge, Table, Tabs, Textarea } from '../components/ui'
import { api } from '../lib/api'
import { useCrumbs } from '../lib/crumbs'
import { when } from '../lib/format'
import { usePrefs } from '../lib/prefs'
import type { Candidate, CaseMatrix, Dataset, DatasetVersion, EditResult, Project, ProviderConfig, Settings, TestCase } from '../lib/types'

export function VersionBadge({ v }: { v: Pick<DatasetVersion, 'version' | 'status' | 'run_count'> }) {
  return (
    <span className="inline-flex items-center gap-1.5">
      <Badge tone="info" className="font-mono">v{v.version}</Badge>
      <StatusBadge status={v.status} />
      {v.status === 'frozen' && (
        <span className="inline-flex items-center gap-1 text-xs text-ink-3" title="Used by a run. It can no longer change; edits create a new version.">
          <Lock className="size-3" aria-hidden /> used by {v.run_count} run{v.run_count === 1 ? '' : 's'}
        </span>
      )}
    </span>
  )
}

function GroundTruthNote() {
  return (
    <Notice tone="info" title="Who decides what is correct?">
      You do. GaugeLab cannot infer ground truth: every expected outcome in a dataset was written, imported or
      approved by a person. AI-generated cases stay in a review queue until someone approves them.
    </Notice>
  )
}

export function DatasetsPage() {
  useCrumbs([{ label: 'Setup' }, { label: 'Datasets' }], 'datasets')
  const qc = useQueryClient()
  const datasets = useQuery({ queryKey: ['datasets'], queryFn: () => api.get<Dataset[]>('/api/datasets') })
  const projects = useQuery({ queryKey: ['projects'], queryFn: () => api.get<Project[]>('/api/projects') })
  const [file, setFile] = useState<File | null>(null)
  const [name, setName] = useState('')
  const [newName, setNewName] = useState('')
  const projectId = async () => projects.data?.[0]?.id ?? (await api.post<Project>('/api/projects', { name: 'Default' })).id
  const upload = useMutation({
    mutationFn: async () => {
      const form = new FormData()
      form.set('project_id', String(await projectId()))
      if (name) form.set('name', name)
      form.set('file', file!)
      return api.upload<Dataset>('/api/datasets/import', form)
    },
    onSuccess: () => { qc.invalidateQueries({ queryKey: ['datasets'] }); setFile(null); setName('') },
  })
  const create = useMutation({
    mutationFn: async () => api.post<Dataset>('/api/datasets', { project_id: await projectId(), name: newName, cases: [] }),
    onSuccess: () => { qc.invalidateQueries({ queryKey: ['datasets'] }); setNewName('') },
  })

  return (
    <>
      <PageHeader title="Datasets" description="Versioned golden datasets: test cases with the outcomes a person expects. A version used by a run is frozen for good." />
      <div className="mb-5 grid gap-5 lg:grid-cols-[minmax(0,1fr)_380px]">
        <GroundTruthNote />
        <Card title="Add a dataset">
          <div className="space-y-3">
            <div className="flex gap-2">
              <Input placeholder="New empty dataset name" value={newName} onChange={(e) => setNewName(e.target.value)} />
              <Button disabled={!newName.trim()} loading={create.isPending} onClick={() => create.mutate()}><Plus className="size-3.5" /> Create</Button>
            </div>
            <div className="border-t border-line pt-3">
              <Field label="Or import JSON / YAML / CSV" hint="CSV columns: id, question, reference_answer, must_mention, must_not_claim, relevant_documents, required_tools, refusal_expected, category, difficulty, tags.">
                <input type="file" accept=".json,.yaml,.yml,.csv" onChange={(e) => setFile(e.target.files?.[0] ?? null)} className="block w-full text-xs file:mr-3 file:rounded-md file:border file:border-line-strong file:bg-surface file:px-2.5 file:py-1 file:text-xs" />
              </Field>
              <div className="mt-2 flex gap-2">
                <Input placeholder="Name (optional)" value={name} onChange={(e) => setName(e.target.value)} />
                <Button disabled={!file} loading={upload.isPending} onClick={() => upload.mutate()}><FileUp className="size-3.5" /> Import</Button>
              </div>
              {upload.isError && <div className="mt-2"><ErrorState error={upload.error} /></div>}
              {create.isError && <div className="mt-2"><ErrorState error={create.error} /></div>}
            </div>
          </div>
        </Card>
      </div>
      {datasets.isLoading ? <Loading /> : datasets.isError ? <ErrorState error={datasets.error} /> : datasets.data!.length === 0 ? (
        <Empty title="No datasets yet">Import a file above, or run <code>gaugelab seed</code> for the 58-case Acme golden set.</Empty>
      ) : (
        <Card padded={false}>
          <Table>
            <thead><tr><th>Dataset</th><th>Latest version</th><th className="text-right">Cases</th><th>Change</th><th>Review queue</th></tr></thead>
            <tbody>
              {datasets.data!.map((d) => (
                <tr key={d.id} className="hover:bg-surface-2/60">
                  <td><Link to={`/datasets/${d.id}`} className="font-medium hover:underline">{d.name}</Link><div className="max-w-xl truncate text-xs text-ink-3">{d.description}</div></td>
                  <td>{d.latest && <VersionBadge v={d.latest} />}</td>
                  <td className="num text-right">{d.latest?.case_count ?? 0}</td>
                  <td className="max-w-72 truncate text-xs text-ink-2">{d.latest?.change_summary}</td>
                  <td>{d.unreviewed_candidates > 0 ? <Badge tone="warn">{d.unreviewed_candidates} unreviewed</Badge> : <span className="text-xs text-ink-3">-</span>}</td>
                </tr>
              ))}
            </tbody>
          </Table>
        </Card>
      )}
    </>
  )
}

type DTab = 'cases' | 'history' | 'generate' | 'versions'

export function DatasetPage() {
  const { id } = useParams()
  const [params, setParams] = useSearchParams()
  const [tab, setTab] = useState<DTab>((params.get('tab') as DTab) ?? 'cases')
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
        description={d.description}
        actions={
          <>
            <Select aria-label="Version" value={versionId} onChange={(e) => switchTo(Number(e.target.value))} className="w-72">
              {[...d.versions].reverse().map((v) => <option key={v.id} value={v.id}>v{v.version} - {v.case_count} cases - {v.status === 'frozen' ? `frozen, used by ${v.run_count} run${v.run_count === 1 ? '' : 's'}` : 'draft'}</option>)}
            </Select>
            <a className="inline-flex h-8 items-center gap-1.5 rounded-md border border-line-strong bg-surface px-3 text-[13px] hover:bg-surface-2" href={`/api/dataset-versions/${versionId}/export?format=yaml`}><Download className="size-3.5" /> YAML</a>
            <a className="inline-flex h-8 items-center gap-1.5 rounded-md border border-line-strong bg-surface px-3 text-[13px] hover:bg-surface-2" href={`/api/dataset-versions/${versionId}/export?format=json`}><Download className="size-3.5" /> JSON</a>
          </>
        }
      />
      {notice && <div className="mb-4"><Notice tone="warn" title="New version created">{notice}</Notice></div>}
      <Tabs
        tabs={[
          { id: 'cases', label: `Cases${version.data ? ` (${version.data.case_count})` : ''}` },
          { id: 'history', label: 'Results across runs' },
          { id: 'generate', label: <span className="inline-flex items-center gap-1.5"><Sparkles className="size-3.5" /> Generate &amp; review{d.unreviewed_candidates ? <Badge tone="warn">{d.unreviewed_candidates}</Badge> : null}</span> },
          { id: 'versions', label: `Versions (${d.versions.length})` },
        ]}
        value={tab}
        onChange={setTab}
      />
      <div className="mt-4">
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
        {tab === 'history' && <HistoryPanel matrix={matrix.data} loading={matrix.isLoading} focus={params.get('case')} />}
        {tab === 'generate' && versionId && <GeneratePanel datasetId={d.id} versionId={versionId} onPromoted={(r) => { if (r.branched) setNotice(r.notice ?? null); switchTo(r.id); setTab('cases') }} />}
        {tab === 'versions' && (
          <Card padded={false}>
            <Table>
              <thead><tr><th>Version</th><th>Status</th><th className="text-right">Cases</th><th>Parent</th><th>Change summary</th><th>Hash</th><th>Created</th></tr></thead>
              <tbody>
                {[...d.versions].reverse().map((v) => (
                  <tr key={v.id} className={clsx('cursor-pointer hover:bg-surface-2/60', v.id === versionId && 'bg-surface-2/60')} onClick={() => { switchTo(v.id); setTab('cases') }}>
                    <td className="num font-mono">v{v.version}</td>
                    <td><StatusBadge status={v.status} /></td>
                    <td className="num text-right">{v.case_count}</td>
                    <td className="num text-ink-3">{d.versions.find((p) => p.id === v.parent_version_id)?.version ? `v${d.versions.find((p) => p.id === v.parent_version_id)!.version}` : '-'}</td>
                    <td className="max-w-md text-ink-2">{v.change_summary}</td>
                    <td className="font-mono text-xs text-ink-3">{v.content_hash}</td>
                    <td className="text-xs text-ink-3">{when(v.created_at)}</td>
                  </tr>
                ))}
              </tbody>
            </Table>
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
  if (!matrix.runs.length) return <Empty title="No runs on this dataset yet">Each completed run adds a column here.</Empty>
  return (
    <Card padded={false} title="Every case in every run" subtitle={`${matrix.cases.length} cases x ${matrix.runs.length} runs (oldest on the left)`}
      actions={<Segmented size="sm" value={filter} onChange={setFilter} options={[{ id: 'all', label: 'All' }, { id: 'changed', label: 'Changed' }, { id: 'flaky', label: 'Flaky' }, { id: 'always_fail', label: `Always failing ${matrix.always_fail.length}` }]} />}>
      <div className="border-b border-line px-4 py-2"><MatrixLegend /><Explain className="mt-1">A case that fails in every run, whatever the version, is often a wrong or outdated golden answer rather than a bad bot.</Explain></div>
      <CaseMatrixView data={matrix} filter={filter} focusCase={focus} />
    </Card>
  )
}

function CasesPanel({ version, onEdited, matrix, focus }: { version: DatasetVersion; onEdited: (r: EditResult) => void; matrix?: CaseMatrix; focus?: string | null }) {
  const cases = useMemo(() => version.cases ?? [], [version.cases])
  const [search, setSearch] = useState('')
  const [category, setCategory] = useState('')
  const [editing, setEditing] = useState<TestCase | 'new' | null>(null)
  const categories = useMemo(() => [...new Set(cases.map((c) => c.category))].sort(), [cases])
  const shown = cases.filter((c) =>
    (!category || c.category === category) &&
    (!search || `${c.id} ${c.title} ${c.input.message} ${c.tags.join(' ')}`.toLowerCase().includes(search.toLowerCase())),
  )

  return (
    <div className="space-y-4">
      {version.status === 'frozen' && (
        <Notice tone="info" title="This version is frozen">A run used it, so it stays exactly as it was. Editing a case saves your change to a new draft version.</Notice>
      )}
      {editing && <CaseEditor versionId={version.id} initial={editing === 'new' ? null : editing} onClose={() => setEditing(null)} onSaved={(r) => { setEditing(null); onEdited(r) }} />}
      <div className="flex flex-wrap items-center gap-2">
        <Input className="max-w-72" placeholder="Search id, question, tag" value={search} onChange={(e) => setSearch(e.target.value)} aria-label="Search cases" />
        <Select className="max-w-52" value={category} onChange={(e) => setCategory(e.target.value)} aria-label="Category">
          <option value="">All categories</option>
          {categories.map((c) => <option key={c}>{c}</option>)}
        </Select>
        <span className="text-xs text-ink-3">{shown.length} of {cases.length}</span>
        <Button className="ml-auto" variant="primary" onClick={() => setEditing('new')}><Plus className="size-3.5" /> Add case</Button>
      </div>
      {cases.length === 0 ? (
        <Empty title="No cases in this version">Add one manually, import a file, or generate candidates from your documents (they will need your review).</Empty>
      ) : (
        <Card padded={false}>
          <Table>
            <thead><tr><th>Id</th><th>Question</th><th>Category</th><th>What a right answer needs</th><th>Recent runs</th><th></th></tr></thead>
            <tbody>
              {shown.map((c) => (
                <tr key={c.id} className={clsx('align-top hover:bg-surface-2/60', focus === c.id && 'bg-accent-wash')}>
                  <td className="whitespace-nowrap font-mono text-xs">{c.id}{c.metadata?.generated ? <Badge tone="info" className="ml-1">generated</Badge> : null}</td>
                  <td className="max-w-xl"><div className="font-medium">{c.title}</div><div className="text-ink-2">{c.input.message}</div></td>
                  <td><Badge>{c.category}</Badge><div className="mt-0.5 text-[11px] text-ink-3">{c.difficulty}</div></td>
                  <td><div className="flex flex-wrap gap-1">{expectedSummary(c).map((s) => <Badge key={s}>{s}</Badge>)}</div></td>
                  <td><CaseHistory matrix={matrix} caseId={c.id} /></td>
                  <td><Button size="sm" variant="ghost" onClick={() => setEditing(c)}>{version.status === 'frozen' ? 'Edit (new version)' : 'Edit'}</Button></td>
                </tr>
              ))}
            </tbody>
          </Table>
        </Card>
      )}
    </div>
  )
}

const lines = (s: string) => s.split('\n').map((x) => x.trim()).filter(Boolean)

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
      const answer = { ...((baseExpected as { answer?: object }).answer ?? {}), reference: reference || null, must_mention: lines(mention), must_not_claim: lines(forbid) }
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
    <Card title={initial ? `Edit ${initial.id}` : 'New case'} actions={<Button size="sm" variant="ghost" onClick={onClose}>Close</Button>}>
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
          <Field label="User question"><Textarea rows={3} className="font-sans text-[13px]" value={question} onChange={(e) => setQuestion(e.target.value)} /></Field>
          <Field label="Reference answer" hint="What a correct answer says. Used by correctness/completeness judges."><Textarea rows={3} className="font-sans text-[13px]" value={reference} onChange={(e) => setReference(e.target.value)} /></Field>
        </div>
        <div className="space-y-3">
          <Field label="Must mention (one per line, a|b for alternatives)"><Textarea rows={3} value={mention} onChange={(e) => setMention(e.target.value)} /></Field>
          <Field label="Must not claim (one per line)"><Textarea rows={2} value={forbid} onChange={(e) => setForbid(e.target.value)} /></Field>
          <Field label="Should the assistant decline?">
            <Select value={refusal} onChange={(e) => setRefusal(e.target.value)}>
              <option value="">Not specified</option><option value="false">No - it should answer</option><option value="true">Yes - it should decline</option>
            </Select>
          </Field>
          <button className="text-xs font-medium text-accent-ink hover:underline" onClick={() => setAdvanced((v) => !v)}>
            {advanced ? 'Hide advanced' : 'Advanced: relevant documents, tools and arguments, outcome, schema, evaluator config'}
          </button>
          {advanced && (
            <Field label="Advanced (JSON)" error={jsonError ?? undefined} hint="Fields of expected: relevant_documents, required_tools, tool_calls [{name, arguments, symmetric}], forbidden_tools, tool_policy, expected_outcome, max_extra_tool_calls, required_citations, min_citations, answer.regex, answer.json_schema...">
              <Textarea rows={14} value={advancedText} onChange={(e) => { setAdvancedText(e.target.value); setJsonError(null) }} spellCheck={false} />
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
    mutationFn: () => api.post<{ created: number; errors: { document: string; error: string }[]; notice: string }>(`/api/datasets/${datasetId}/generate-candidates`, { document_ids: selected, provider_config_id: provider || providers.data?.[0]?.id }),
    onSuccess: refresh,
  })
  const review = useMutation({
    mutationFn: ({ id, action }: { id: number; action: string }) => {
      try { localStorage.setItem('gl-reviewer', reviewer) } catch { /* ignore */ }
      return api.post(`/api/candidates/${id}/review`, { action, reviewer })
    },
    onSuccess: refresh,
  })
  const edit = useMutation({ mutationFn: (id: number) => api.put(`/api/candidates/${id}`, { case: JSON.parse(editText) }), onSuccess: () => { setEditingId(null); refresh() } })
  const promote = useMutation({ mutationFn: () => api.post<EditResult>(`/api/dataset-versions/${versionId}/approve-candidates`, {}), onSuccess: (r) => { refresh(); onPromoted(r) } })

  return (
    <div className="space-y-4">
      <Notice tone="warn" title="Generated cases are candidates, not ground truth">
        A model drafts questions and answers from your documents. Each one stays <b>unreviewed</b> until a person approves,
        edits or rejects it; only approved cases can be added to a dataset version. Check the evidence quote: GaugeLab flags quotes it cannot find in the document.
      </Notice>
      <div className="grid gap-4 lg:grid-cols-[minmax(0,1fr)_360px]">
        <Card title="1. Reference documents">
          <input type="file" accept=".md,.txt,.json,.pdf" onChange={(e) => e.target.files?.[0] && upload.mutate(e.target.files[0])} className="block text-xs file:mr-3 file:rounded-md file:border file:border-line-strong file:bg-surface file:px-2.5 file:py-1 file:text-xs" aria-label="Upload document" />
          {upload.isError && <div className="mt-2"><ErrorState error={upload.error} /></div>}
          <ul className="mt-3 max-h-48 space-y-1 overflow-y-auto text-[13px]">
            {(docs.data ?? []).map((d) => (
              <li key={d.id}>
                <label className="flex items-center gap-2">
                  <input type="checkbox" checked={selected.includes(d.id)} onChange={(e) => setSelected((s) => (e.target.checked ? [...s, d.id] : s.filter((x) => x !== d.id)))} />
                  <span className="font-mono text-xs">{d.filename}</span><span className="text-xs text-ink-3">{d.chars} chars</span>
                </label>
              </li>
            ))}
            {docs.data?.length === 0 && <li className="text-ink-3">No documents uploaded yet (Markdown, TXT, JSON or PDF).</li>}
          </ul>
        </Card>
        <Card title="2. Generate">
          <div className="space-y-3">
            <Field label="Generator model" hint={providers.data?.length ? 'Your documents are sent to this provider. A local Ollama model keeps them on this machine.' : undefined}>
              <Select value={provider} onChange={(e) => setProvider(e.target.value ? Number(e.target.value) : '')}>
                {(providers.data ?? []).map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
              </Select>
            </Field>
            {providers.data?.length === 0 && <Notice tone="warn">Add a model provider under <Link className="underline" to="/evaluators?tab=providers">Evaluators &gt; Judge providers</Link> first.</Notice>}
            <Button variant="primary" disabled={!selected.length || !providers.data?.length} loading={generate.isPending} onClick={() => generate.mutate()}>
              <Sparkles className="size-3.5" /> Generate candidates
            </Button>
            {generate.data && <Notice tone={generate.data.errors.length ? 'warn' : 'good'} title={`${generate.data.created} candidate(s) added to the review queue`}>{generate.data.errors.map((e) => <div key={e.document}>{e.document}: {e.error}</div>)}</Notice>}
            {generate.isError && <ErrorState error={generate.error} />}
          </div>
        </Card>
      </div>

      <Card
        title="3. Review queue"
        actions={
          <>
            <Input className="h-7 w-40 text-xs" placeholder="Your name (reviewer)" value={reviewer} onChange={(e) => setReviewer(e.target.value)} aria-label="Reviewer" />
            <Select className="h-7 w-36 text-xs" value={status} onChange={(e) => setStatus(e.target.value as typeof status)} aria-label="Filter by status">
              <option value="unreviewed">Unreviewed</option><option value="approved">Approved</option><option value="rejected">Rejected</option><option value="">All</option>
            </Select>
            <Button size="sm" variant="primary" loading={promote.isPending} onClick={() => promote.mutate()}>Add approved to dataset</Button>
          </>
        }
      >
        {promote.isError && <div className="mb-3"><ErrorState error={promote.error} /></div>}
        {!reviewer && <p className="mb-3 text-xs text-warn-ink">Enter your name to approve or reject: every decision records who made it.</p>}
        {cands.isLoading ? <Loading /> : (cands.data ?? []).length === 0 ? (
          <p className="text-[13px] text-ink-3">Nothing here.</p>
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
                  {c.reviewer && <span className="text-xs text-ink-3">reviewed by {c.reviewer}</span>}
                </div>
                <div className="mt-2 text-[13px] font-medium">{c.case.input.message}</div>
                <div className="mt-1 text-[13px] text-ink-2"><span className="text-ink-3">Proposed answer: </span>{c.case.expected.answer.reference ?? '-'}</div>
                {c.evidence.map((e, i) => (
                  <div key={i} className="mt-2 rounded border-l-2 border-line-strong bg-surface-2 px-2 py-1 text-xs">
                    <span className="text-ink-3">Evidence: </span>{e.quote ? `"${e.quote}"` : '(none - declining is the expected behaviour)'}
                    {e.warnings.map((w) => <div key={w} className="mt-1 font-medium text-warn-ink">{w}</div>)}
                  </div>
                ))}
                {editingId === c.id ? (
                  <div className="mt-2 space-y-2">
                    <Textarea rows={12} value={editText} onChange={(e) => setEditText(e.target.value)} spellCheck={false} />
                    {edit.isError && <ErrorState error={edit.error} />}
                    <div className="flex gap-2"><Button size="sm" variant="primary" loading={edit.isPending} onClick={() => edit.mutate(c.id)}>Save edit</Button><Button size="sm" variant="ghost" onClick={() => setEditingId(null)}>Cancel</Button></div>
                  </div>
                ) : !c.approved_in_version_id && (
                  <div className="mt-3 flex gap-2">
                    <Button size="sm" variant="primary" disabled={!reviewer} onClick={() => review.mutate({ id: c.id, action: 'approve' })}>Approve</Button>
                    <Button size="sm" disabled={!reviewer} onClick={() => { setEditingId(c.id); setEditText(JSON.stringify(c.case, null, 2)) }}>Edit</Button>
                    <Button size="sm" variant="danger" disabled={!reviewer} onClick={() => review.mutate({ id: c.id, action: 'reject' })}>Reject</Button>
                    {c.status !== 'unreviewed' && <Button size="sm" variant="ghost" onClick={() => review.mutate({ id: c.id, action: 'reset' })}>Undo</Button>}
                  </div>
                )}
                {editingId !== c.id && c.status === 'approved' && c.edited && <div className="mt-2"><Json value={c.case.expected} maxHeight={120} /></div>}
              </li>
            ))}
          </ul>
        )}
      </Card>
    </div>
  )
}
