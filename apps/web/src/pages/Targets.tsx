import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { Plug, Plus } from 'lucide-react'
import { useState } from 'react'
import { Link, useNavigate, useParams } from 'react-router-dom'
import { Badge, Button, Card, Empty, ErrorState, Field, Input, Json, Loading, Notice, PageHeader, Select, Table, Tabs, Textarea } from '../components/ui'
import { api } from '../lib/api'
import { ms, when } from '../lib/format'
import type { Project, Target, TargetResult } from '../lib/types'

const TEMPLATES: Record<string, { adapter: Target['adapter']; config: Record<string, unknown>; help: string }> = {
  'HTTP - JSON response': {
    adapter: 'http',
    help: 'POST a JSON body, map fields of the JSON reply. Every field except answer is optional.',
    config: {
      base_url: 'http://localhost:9040',
      endpoint: '/chat',
      method: 'POST',
      timeout_s: 60,
      body: { message: '{{input.message}}' },
      response: {
        answer: 'answer',
        retrieved_documents: { path: 'sources', each: { id: 'id', title: 'title', score: 'score', text: 'text' } },
        tool_calls: { path: 'tool_calls', each: { name: 'name', arguments: 'arguments', result: 'result', status: 'status' } },
        usage: { input_tokens: 'usage.input_tokens', output_tokens: 'usage.output_tokens' },
        provider: { provider: 'provider', model: 'model' },
      },
    },
  },
  'HTTP - streamed (SSE)': {
    adapter: 'http',
    help: 'Server-sent events: fold events into one object (concat text deltas, keep sources), then map it.',
    config: {
      base_url: 'http://localhost:8080',
      endpoint: '/api/ask',
      method: 'POST',
      timeout_s: 120,
      body: { question: '{{input.message}}' },
      stream: {
        format: 'sse',
        type_path: 'type',
        events: {
          delta: { op: 'concat', path: 'text', into: 'answer' },
          sources: { path: 'sources', into: 'sources' },
          done: { path: '.', into: 'done' },
        },
      },
      response: {
        answer: 'answer',
        retrieved_documents: { path: 'sources', each: { id: 'id', title: 'title', text: 'text' } },
        citations_from_markers: { pattern: '\\[(\\d+)\\]', lookup: 'sources', key: 'n', each: { id: 'id' } },
      },
    },
  },
  'Python function': {
    adapter: 'python',
    help: 'Call "package.module:function(test_input, options, ctx)" in the API process - no HTTP service needed.',
    config: { callable: 'acme_support_agent.app:run', options: { variant: 'candidate' } },
  },
}

export function TargetsPage() {
  const nav = useNavigate()
  const qc = useQueryClient()
  const targets = useQuery({ queryKey: ['targets'], queryFn: () => api.get<Target[]>('/api/targets') })
  const projects = useQuery({ queryKey: ['projects'], queryFn: () => api.get<Project[]>('/api/projects') })
  const [creating, setCreating] = useState(false)
  const [tpl, setTpl] = useState(Object.keys(TEMPLATES)[0])
  const [name, setName] = useState('')
  const [label, setLabel] = useState('')
  const [projectId, setProjectId] = useState<number | ''>('')
  const [configText, setConfigText] = useState(JSON.stringify(TEMPLATES[tpl].config, null, 2))
  const [parseError, setParseError] = useState<string | null>(null)

  const create = useMutation({
    mutationFn: async () => {
      let config: Record<string, unknown>
      try {
        config = JSON.parse(configText)
      } catch (e) {
        setParseError(`Config is not valid JSON: ${(e as Error).message}`)
        throw e
      }
      let pid = projectId || projects.data?.[0]?.id
      if (!pid) pid = (await api.post<Project>('/api/projects', { name: 'Default' })).id
      return api.post<Target>('/api/targets', { project_id: pid, name, adapter: TEMPLATES[tpl].adapter, config, variant_label: label })
    },
    onSuccess: (t) => {
      qc.invalidateQueries({ queryKey: ['targets'] })
      nav(`/targets/${t.id}`)
    },
  })

  return (
    <>
      <PageHeader
        title="Targets"
        description="The systems under test: any chatbot or agent reachable over HTTP, a Python function, or results imported from logs. Editing a target creates a new version; runs keep the version they used."
        actions={<Button variant="primary" onClick={() => setCreating((v) => !v)}><Plus className="size-3.5" /> New target</Button>}
      />
      {creating && (
        <Card title="New target" className="mb-5">
          <div className="grid gap-4 lg:grid-cols-[320px_minmax(0,1fr)]">
            <div className="space-y-3">
              <Field label="Name"><Input value={name} onChange={(e) => setName(e.target.value)} placeholder="Support bot - prompt v3" /></Field>
              <Field label="Variant label" hint="What distinguishes this version (model, prompt, retriever...)."><Input value={label} onChange={(e) => setLabel(e.target.value)} placeholder="gpt-x / hybrid top-20" /></Field>
              <Field label="Project">
                <Select value={projectId} onChange={(e) => setProjectId(e.target.value ? Number(e.target.value) : '')}>
                  {(projects.data ?? []).map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
                  {!projects.data?.length && <option value="">Default (created)</option>}
                </Select>
              </Field>
              <Field label="Start from" hint={TEMPLATES[tpl].help}>
                <Select value={tpl} onChange={(e) => { setTpl(e.target.value); setConfigText(JSON.stringify(TEMPLATES[e.target.value].config, null, 2)) }}>
                  {Object.keys(TEMPLATES).map((k) => <option key={k}>{k}</option>)}
                </Select>
              </Field>
              <Notice tone="info" title="Secrets">Reference keys as <code>{'{"auth": {"secret_ref": "env:MY_KEY"}}'}</code>. GaugeLab stores the reference only; the key is read from the server environment at call time.</Notice>
            </div>
            <div className="space-y-2">
              <Field label="Configuration (JSON)" error={parseError ?? undefined}>
                <Textarea rows={22} value={configText} onChange={(e) => { setConfigText(e.target.value); setParseError(null) }} spellCheck={false} />
              </Field>
              {create.isError && !parseError && <ErrorState error={create.error} />}
              <div className="flex gap-2">
                <Button variant="primary" disabled={!name.trim()} loading={create.isPending} onClick={() => create.mutate()}>Create target</Button>
                <Button variant="ghost" onClick={() => setCreating(false)}>Cancel</Button>
              </div>
            </div>
          </div>
        </Card>
      )}
      {targets.isLoading ? <Loading /> : targets.isError ? <ErrorState error={targets.error} /> : targets.data!.length === 0 ? (
        <Empty title="No targets yet">Create one above, or run <code>gaugelab seed</code> to load the Acme demo agent in two variants.</Empty>
      ) : (
        <Card padded={false}>
          <Table>
            <thead><tr><th>Name</th><th>Adapter</th><th>Latest version</th><th>Variant</th><th>Updated</th></tr></thead>
            <tbody>
              {targets.data!.map((t) => (
                <tr key={t.id} className="hover:bg-surface-2/60">
                  <td><Link className="font-medium hover:underline" to={`/targets/${t.id}`}>{t.name}</Link><div className="text-xs text-ink-3">{t.description}</div></td>
                  <td><Badge>{t.adapter}</Badge></td>
                  <td className="num">v{t.latest_version.version} <span className="font-mono text-xs text-ink-3">{t.latest_version.config_hash}</span></td>
                  <td className="text-ink-2">{t.latest_version.variant_label || '-'}</td>
                  <td className="text-xs text-ink-3">{when(t.latest_version.created_at)}</td>
                </tr>
              ))}
            </tbody>
          </Table>
        </Card>
      )}
    </>
  )
}

interface TestResponse {
  ok: boolean
  elapsed_ms?: number
  raw?: unknown
  normalized?: TargetResult
  missing_telemetry?: string[]
  error?: string | null
  hint?: string | null
}

export function TargetPage() {
  const { id } = useParams()
  const qc = useQueryClient()
  const t = useQuery({ queryKey: ['target', id], queryFn: () => api.get<Target>(`/api/targets/${id}`) })
  const [message, setMessage] = useState('Is order 18372 still covered by warranty?')
  const [tab, setTab] = useState<'normalized' | 'raw'>('normalized')
  const [editing, setEditing] = useState(false)
  const [configText, setConfigText] = useState('')
  const [label, setLabel] = useState('')
  const [notes, setNotes] = useState('')
  const test = useMutation({ mutationFn: () => api.post<TestResponse>(`/api/targets/${id}/test`, { message }) })
  const save = useMutation({
    mutationFn: () => api.put<Target>(`/api/targets/${id}`, { config: JSON.parse(configText), variant_label: label, notes }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['target', id] })
      qc.invalidateQueries({ queryKey: ['targets'] })
      setEditing(false)
    },
  })
  if (t.isLoading) return <Loading />
  if (t.isError) return <ErrorState error={t.error} />
  const target = t.data!
  const v = target.latest_version

  return (
    <>
      <PageHeader
        title={target.name}
        description={target.description || `${target.adapter} target`}
        actions={
          <>
            <Badge>{target.adapter}</Badge>
            <Badge tone="info">v{v.version}</Badge>
            {target.adapter !== 'replay' && (
              <Button onClick={() => { setEditing(true); setConfigText(JSON.stringify(v.config, null, 2)); setLabel(v.variant_label) }}>Edit (new version)</Button>
            )}
          </>
        }
      />
      <div className="grid gap-5 xl:grid-cols-2">
        <Card title={<span className="inline-flex items-center gap-1.5"><Plug className="size-3.5" /> Test connection</span>}>
          <div className="flex gap-2">
            <Input value={message} onChange={(e) => setMessage(e.target.value)} aria-label="Test message" />
            <Button variant="primary" loading={test.isPending} onClick={() => test.mutate()}>Send</Button>
          </div>
          {test.isError && <div className="mt-3"><ErrorState error={test.error} /></div>}
          {test.data && (
            <div className="mt-3 space-y-3">
              {test.data.ok ? (
                <Notice tone="good" title={`Connected - answered in ${ms(test.data.elapsed_ms)}`}>
                  {test.data.missing_telemetry?.length
                    ? <>Not reported by this target: <b>{test.data.missing_telemetry.join(', ')}</b>. Checks that need them will show as <i>not evaluated</i>, never as a guess.</>
                    : 'All optional telemetry is reported.'}
                </Notice>
              ) : (
                <Notice tone="bad" title={test.data.error ?? 'The target did not return an answer'}>{test.data.hint}</Notice>
              )}
              {(test.data.normalized || test.data.raw !== undefined) && (
                <>
                  <Tabs tabs={[{ id: 'normalized', label: 'Normalized' }, { id: 'raw', label: 'Raw response' }]} value={tab} onChange={setTab} />
                  <Json value={tab === 'raw' ? test.data.raw : test.data.normalized} maxHeight={420} />
                </>
              )}
            </div>
          )}
        </Card>
        <div className="space-y-5">
          {editing ? (
            <Card title={`New version (v${v.version + 1})`}>
              <div className="space-y-3">
                <Field label="Variant label"><Input value={label} onChange={(e) => setLabel(e.target.value)} /></Field>
                <Field label="What changed"><Input value={notes} onChange={(e) => setNotes(e.target.value)} placeholder="e.g. switched retriever to hybrid" /></Field>
                <Field label="Configuration (JSON)"><Textarea rows={18} value={configText} onChange={(e) => setConfigText(e.target.value)} spellCheck={false} /></Field>
                {save.isError && <ErrorState error={save.error} />}
                <div className="flex gap-2">
                  <Button variant="primary" loading={save.isPending} onClick={() => save.mutate()}>Save as v{v.version + 1}</Button>
                  <Button variant="ghost" onClick={() => setEditing(false)}>Cancel</Button>
                </div>
              </div>
            </Card>
          ) : (
            <Card title={`Configuration - v${v.version}`}><Json value={v.config} maxHeight={420} /></Card>
          )}
          <Card title="Versions" padded={false}>
            <Table>
              <thead><tr><th>Version</th><th>Variant</th><th>Notes</th><th>Hash</th><th>Created</th></tr></thead>
              <tbody>
                {[...(target.versions ?? [])].reverse().map((tv) => (
                  <tr key={tv.id}><td className="num">v{tv.version}</td><td>{tv.variant_label || '-'}</td><td className="text-ink-2">{tv.notes || '-'}</td><td className="font-mono text-xs text-ink-3">{tv.config_hash}</td><td className="text-xs text-ink-3">{when(tv.created_at)}</td></tr>
                ))}
              </tbody>
            </Table>
          </Card>
        </div>
      </div>
    </>
  )
}
