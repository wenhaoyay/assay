import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import clsx from 'clsx'
import { Activity, BookmarkPlus, Check, Pencil, Plug, RefreshCw, Send } from 'lucide-react'
import { useState } from 'react'
import { Link, useParams } from 'react-router-dom'
import { ReadingCard } from '../components/Causes'
import { Sparkline } from '../components/viz'
import { Badge, Button, Card, Empty, ErrorState, Explain, Field, Input, Json, Loading, Notice, PageHeader, PageSkeleton, ProjectMark, Segmented, Table, Toggle, linkButton } from '../components/ui'
import { api } from '../lib/api'
import { useCrumbs } from '../lib/crumbs'
import { ms, pct, usd, when } from '../lib/format'
import type { Capability, Project, Target, TargetCheck, TargetResult } from '../lib/types'
import { Capabilities } from './Connect'

export function HealthDot({ check, size = 10 }: { check: TargetCheck | null | undefined; size?: number }) {
  const tone = !check ? 'bg-untested' : check.ok ? 'bg-good' : 'bg-bad'
  const title = !check ? 'Not checked yet' : check.ok ? `Answered${check.elapsed_ms ? ` in ${ms(check.elapsed_ms)}` : ''} - ${when(check.at)}` : `${check.explanation ?? check.error ?? 'Failed'} - ${when(check.at)}`
  return (
    <span className="relative inline-flex shrink-0" title={title} aria-label={title} style={{ width: size, height: size }}>
      {check?.ok && <span className="absolute inline-flex size-full animate-ping rounded-full bg-good opacity-30 [animation-iteration-count:2]" />}
      <span className={clsx('relative inline-flex size-full rounded-full', tone)} />
    </span>
  )
}

export function TargetsPage() {
  useCrumbs([{ label: 'Setup' }, { label: 'Connections' }], 'targets')
  const qc = useQueryClient()
  const targets = useQuery({ queryKey: ['targets'], queryFn: () => api.get<Target[]>('/api/targets') })
  const projects = useQuery({ queryKey: ['projects'], queryFn: () => api.get<Project[]>('/api/projects') })
  const check = useMutation({
    mutationFn: (id: number) => api.post<TargetCheck>(`/api/targets/${id}/check`),
    onSettled: () => qc.invalidateQueries({ queryKey: ['targets'] }),
  })
  const groups = (projects.data ?? []).map((p) => ({ p, ts: (targets.data ?? []).filter((t) => t.project_id === p.id) })).filter((g) => g.ts.length)
  return (
    <>
      <PageHeader
        title="Connections"
        description="Where your chatbots run: anything reachable over HTTP, a Python function, or answers imported from logs. Changing a connection's model or prompt makes a new version; runs keep the version they used."
        actions={<Link to="/targets/new" viewTransition className={linkButton('primary')}><Plug className="size-3.5" /> Connect a chatbot</Link>}
      />
      {targets.isLoading ? <Loading /> : targets.isError ? <ErrorState error={targets.error} /> : targets.data!.length === 0 ? (
        <Empty title="No chatbot connected yet" icon={<Plug className="size-6" />} action={<Link to="/targets/new" className={linkButton('primary')}>Connect a chatbot</Link>}>
          Paste a curl command, send a test question, click the reply to say where the answer is. Or run <code>gaugelab seed</code> for the Acme demo.
        </Empty>
      ) : (
        <div className="space-y-5">
          {groups.map(({ p, ts }) => (
            <Card key={p.id} padded={false} title={<Link to={`/p/${p.id}`} className="flex items-center gap-2 hover:underline"><ProjectMark name={p.name} color={p.color} size={20} />{p.name}</Link>}>
              <Table>
                <thead><tr><th className="w-6"></th><th>Name</th><th>Kind</th><th>Version</th><th>What distinguishes it</th><th>Last check</th><th></th></tr></thead>
                <tbody>
                  {ts.map((t) => (
                    <tr key={t.id} className="hover:bg-surface-2/60">
                      <td><HealthDot check={t.last_check} /></td>
                      <td>
                        <Link className="font-medium hover:underline" to={`/targets/${t.id}`} viewTransition>{t.name}</Link>
                        {t.local_judges_only && <Badge tone="accent" className="ml-1.5">local judges only</Badge>}
                        {t.shared && <Badge className="ml-1.5">shared</Badge>}
                        <div className="line-clamp-1 text-xs text-ink-3">{t.description}</div>
                      </td>
                      <td><Badge>{t.adapter === 'replay' ? 'imported' : t.adapter}</Badge>{(t.latest_version.config as { reply_shape?: string }).reply_shape === 'gaugelab' && <Badge tone="accent" className="ml-1">standard shape</Badge>}</td>
                      <td className="num">v{t.latest_version.version}</td>
                      <td className="text-ink-2">{t.latest_version.variant_label || '-'}</td>
                      <td className="whitespace-nowrap text-xs text-ink-3">{t.last_check ? (t.last_check.ok ? `ok, ${ms(t.last_check.elapsed_ms)}` : <span className="text-bad-ink">{t.last_check.explanation ?? 'failed'}</span>) : 'never'}</td>
                      <td className="text-right">{t.adapter !== 'replay' && <Button size="sm" variant="ghost" loading={check.isPending && check.variables === t.id} onClick={() => check.mutate(t.id)}><RefreshCw className="size-3.5" />Check</Button>}</td>
                    </tr>
                  ))}
                </tbody>
              </Table>
            </Card>
          ))}
        </div>
      )}
    </>
  )
}

interface TestResponse {
  ok: boolean
  elapsed_ms?: number
  raw?: unknown
  normalized?: TargetResult
  error?: string | null
  explanation?: string | null
  capabilities?: Capability[]
}

/** The mapping as a readable list: "answer ← reply.text". */
function MappingSummary({ config }: { config: Record<string, unknown> }) {
  if (config.reply_shape === 'gaugelab') return <p className="text-[13px]"><Badge tone="accent">standard shape</Badge> The bot replies with answer, sources, citations, tool calls and usage - nothing mapped.</p>
  const resp = (config.response ?? {}) as Record<string, unknown>
  const rows: [string, string][] = []
  for (const [k, v] of Object.entries(resp)) {
    if (typeof v === 'string') rows.push([k, v])
    else if (v && typeof v === 'object' && 'path' in v) rows.push([k, `${(v as { path: string }).path} → ${Object.entries((v as { each?: Record<string, unknown> }).each ?? {}).map(([a, b]) => `${a}: ${typeof b === 'string' ? b : JSON.stringify(b)}`).join(', ')}`])
    else rows.push([k, Object.entries(v as Record<string, unknown>).map(([a, b]) => `${a}: ${b}`).join(', ')])
  }
  return (
    <dl className="grid grid-cols-[150px_minmax(0,1fr)] gap-x-3 gap-y-1 text-[13px]">
      {rows.map(([k, v]) => <div key={k} className="contents"><dt className="text-ink-3">{k.replace(/_/g, ' ')}</dt><dd className="break-all font-mono text-xs">{v}</dd></div>)}
    </dl>
  )
}

export function TargetPage() {
  const { id } = useParams()
  const qc = useQueryClient()
  const t = useQuery({ queryKey: ['target', id], queryFn: () => api.get<Target>(`/api/targets/${id}`) })
  const projects = useQuery({ queryKey: ['projects'], queryFn: () => api.get<Project[]>('/api/projects') })
  const health = useQuery({ queryKey: ['target-health', id], queryFn: () => api.get<{ runs: { id: number; pass_rate: number | null }[]; typical_latency_ms: number | null; telemetry: Record<string, number> }>(`/api/targets/${id}/health`) })
  const project = projects.data?.find((p) => p.id === t.data?.project_id)
  useCrumbs([...(project ? [{ label: project.name, to: `/p/${project.id}` }] : [{ label: 'Connections', to: '/targets' }]), { label: t.data?.name ?? '...' }], `target-${id}-${t.data?.name}-${project?.name}`)
  const [message, setMessage] = useState('What can you help me with?')
  const [view, setView] = useState<'seen' | 'raw'>('seen')
  const [cfgView, setCfgView] = useState<'summary' | 'json'>('summary')
  const test = useMutation({ mutationFn: () => api.post<TestResponse>('/api/connect/test', { adapter: t.data!.adapter, config: t.data!.latest_version.config, message }) })
  const check = useMutation({ mutationFn: () => api.post<TargetCheck>(`/api/targets/${id}/check`), onSuccess: () => qc.invalidateQueries({ queryKey: ['target', id] }) })
  const flags = useMutation({ mutationFn: (body: Record<string, unknown>) => api.patch(`/api/targets/${id}/flags`, body), onSuccess: () => { qc.invalidateQueries({ queryKey: ['target', id] }); qc.invalidateQueries({ queryKey: ['targets'] }); qc.invalidateQueries({ queryKey: ['estimate'] }) } })
  const [costText, setCostText] = useState<string | null>(null)
  const template = useMutation({ mutationFn: () => api.post('/api/connector-templates', { name: t.data!.name, adapter: t.data!.adapter, config: t.data!.latest_version.config, description: t.data!.latest_version.variant_label }) })
  if (t.isLoading) return <PageSkeleton />
  if (t.isError) return <ErrorState error={t.error} />
  const target = t.data!
  const v = target.latest_version
  const lc = target.last_check

  return (
    <>
      <PageHeader
        title={<span className="flex items-center gap-3"><HealthDot check={lc} size={12} />{target.name}</span>}
        description={target.description || `${target.adapter} target`}
        actions={
          <>
            <Badge>{target.adapter === 'replay' ? 'imported' : target.adapter}</Badge>
            <Badge tone="accent">v{v.version}</Badge>
            {target.adapter !== 'replay' && <Button loading={check.isPending} onClick={() => check.mutate()}><Activity className="size-3.5" />Check now</Button>}
            {target.adapter !== 'replay' && <Link to={`/targets/new?from=${target.id}`} viewTransition className={linkButton()}><Pencil className="size-3.5" />Edit (new version)</Link>}
            {target.adapter !== 'replay' && <Button variant="ghost" loading={template.isPending} onClick={() => template.mutate()} title="Save as a template">{template.isSuccess ? <Check className="size-3.5" /> : <BookmarkPlus className="size-3.5" />}</Button>}
          </>
        }
      />
      {lc && !lc.ok && <div className="mb-4"><Notice tone="bad" title={lc.explanation ?? 'The last check failed'}><span className="font-mono text-xs">{lc.error}</span> - {when(lc.at)}</Notice></div>}
      <div className="grid gap-5 xl:grid-cols-[minmax(0,1.2fr)_minmax(0,1fr)]">
        <div className="space-y-5">
          <Card title={<span className="inline-flex items-center gap-1.5"><Send className="size-3.5" /> Ask it something</span>}>
            <div className="flex gap-2">
              <Input value={message} onChange={(e) => setMessage(e.target.value)} aria-label="Test message" />
              <Button variant="primary" loading={test.isPending} onClick={() => test.mutate()}>Send</Button>
            </div>
            {test.isError && <div className="mt-3"><ErrorState error={test.error} /></div>}
            {!test.data && !test.isPending && <p className="mt-3 text-xs text-ink-3">Sends one question with this version's configuration and shows the reply the way GaugeLab reads it, and which checks that makes possible.</p>}
            {test.data && (
              <div className="mt-3 space-y-3">
                {test.data.ok ? <Notice tone="good" title={`Answered in ${ms(test.data.elapsed_ms)}`} /> : <Notice tone="bad" title={test.data.explanation ?? test.data.error ?? 'No answer'}>{test.data.error}</Notice>}
                {test.data.normalized && (
                  <>
                    <Segmented size="sm" value={view} onChange={setView} options={[{ id: 'seen', label: 'As GaugeLab reads it' }, { id: 'raw', label: 'Raw reply' }]} />
                    {view === 'seen' ? (
                      <div className="grid gap-4 md:grid-cols-2">
                        <div className="space-y-2 text-[13px]">
                          <div className="rounded-lg border border-line bg-surface-2/50 px-3 py-2">{test.data.normalized.answer}</div>
                          {test.data.normalized.retrieved_documents && <div className="text-xs text-ink-2">Sources: {test.data.normalized.retrieved_documents.map((d) => <code key={d.id} className="mr-1">{d.id}</code>)}</div>}
                          {test.data.normalized.tool_calls && <div className="text-xs text-ink-2">Tools: {test.data.normalized.tool_calls.map((x, i) => <code key={i} className="mr-1">{x.name}</code>)}</div>}
                        </div>
                        <Capabilities caps={test.data.capabilities ?? []} />
                      </div>
                    ) : <Json value={test.data.raw} maxHeight={380} />}
                  </>
                )}
              </div>
            )}
          </Card>
          <Card title="Health" subtitle="From the latest runs of this connection">
            <div className="grid grid-cols-3 gap-3 text-[13px]">
              <div><div className="text-xs text-ink-3">Last check</div><div>{lc ? (lc.ok ? `ok - ${when(lc.at)}` : 'failed') : 'never'}</div></div>
              <div><div className="text-xs text-ink-3">Typical answer time</div><div className="num">{ms(health.data?.typical_latency_ms)}</div></div>
              <div><div className="text-xs text-ink-3">Pass rate, recent runs</div>{health.data?.runs.length ? <Sparkline values={[...health.data.runs].reverse().map((r) => r.pass_rate)} width={110} height={28} /> : <span className="text-ink-3">no runs</span>}</div>
            </div>
            {lc?.coverage && <p className="mt-3 text-xs text-ink-3">Reports: {lc.coverage.join(', ') || 'answer only'}.</p>}
            {health.data?.runs[0] && <p className="mt-1 text-xs text-ink-3">Latest run <Link className="text-accent-ink underline" to={`/runs/${health.data.runs[0].id}`}>#{health.data.runs[0].id}</Link>: {pct(health.data.runs[0].pass_rate)}.</p>}
          </Card>
        </div>
        <div className="space-y-5">
          <ReadingCard targetId={target.id} />
          <Card title="Grading privacy">
            <Toggle checked={!!target.local_judges_only} onChange={(val) => flags.mutate({ local_judges_only: val })} label="Local grading models only"
              hint="This bot's answers may only be graded by a model running on this machine (Ollama, LM Studio). Runs that pick a cloud model are refused." />
          </Card>
          <Card title="Load and cost">
            <Toggle checked={!!target.shared} onChange={(val) => flags.mutate({ shared: val })} label="Other people use this bot"
              hint="New runs then ask 2 questions at a time by default, and warn above that: test questions all at once would slow down real users' answers." />
            <div className="mt-4">
              <Field label="Cost per answer (USD, your estimate)" hint={<>For bots that report no token counts (GaugeLab cannot price them). With it, the spend cap and estimates can count this bot's answers. {target.cost_per_answer_usd != null ? 'Now: ' + usd(target.cost_per_answer_usd) + ' per answer.' : 'Not set: the cap cannot limit this bot.'}</>}>
                <div className="flex gap-2">
                  <Input className="w-32" type="number" min={0} step="0.001" aria-label="Cost per answer" placeholder="e.g. 0.04"
                    value={costText ?? (target.cost_per_answer_usd != null ? String(target.cost_per_answer_usd) : '')} onChange={(e) => setCostText(e.target.value)} />
                  <Button size="sm" disabled={costText === null} loading={flags.isPending} onClick={() => { flags.mutate(costText ? { cost_per_answer_usd: Number(costText) } : { clear_cost_per_answer: true }); setCostText(null) }}>Save</Button>
                </div>
              </Field>
            </div>
          </Card>
          <Card title={`Configuration - v${v.version}`} actions={<Segmented size="sm" value={cfgView} onChange={setCfgView} options={[{ id: 'summary', label: 'Readable' }, { id: 'json', label: 'JSON' }]} />}>
            {cfgView === 'json' ? <Json value={v.config} maxHeight={420} /> : (
              <div className="space-y-3 text-[13px]">
                {'base_url' in v.config && (
                  <div className="font-mono text-xs"><Badge>{String(v.config.method ?? 'POST')}</Badge> {String(v.config.base_url)}{String(v.config.endpoint ?? '')}</div>
                )}
                {'callable' in v.config && <div className="font-mono text-xs">{String(v.config.callable)}</div>}
                {'body' in v.config && <div><div className="text-xs text-ink-3">Body</div><code className="block break-all text-xs">{JSON.stringify(v.config.body)}</code></div>}
                {!!v.config.auth && <div className="text-xs text-good-ink">Auth header from {(v.config.auth as { secret_ref: string }).secret_ref}</div>}
                {'base_url' in v.config && <div><div className="mb-1 text-xs text-ink-3">Where each thing is in the reply</div><MappingSummary config={v.config} /></div>}
                {!!v.config.cleanup && <div className="text-xs text-ink-2">Deletes each saved conversation afterwards.</div>}
                <Explain>A configuration is versioned: editing creates v{v.version + 1}, and past runs keep the version they used.</Explain>
              </div>
            )}
          </Card>
          <Card title="Versions" padded={false}>
            <Table>
              <thead><tr><th>Version</th><th>Variant</th><th>What changed</th><th>Created</th></tr></thead>
              <tbody>
                {[...(target.versions ?? [])].reverse().map((tv) => (
                  <tr key={tv.id}><td className="num">v{tv.version}</td><td>{tv.variant_label || '-'}</td><td className="text-ink-2">{tv.notes || '-'}</td><td className="whitespace-nowrap text-xs text-ink-3">{when(tv.created_at)}</td></tr>
                ))}
              </tbody>
            </Table>
          </Card>
        </div>
      </div>
    </>
  )
}
