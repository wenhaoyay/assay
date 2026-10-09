import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import clsx from 'clsx'
import { Check, Clipboard, Cloud, Cpu, ExternalLink, Lock, Plus, RefreshCw, ShieldCheck, Star, Trash2, X } from 'lucide-react'
import { AnimatePresence, motion } from 'motion/react'
import { Fragment, useState } from 'react'
import { useSearchParams } from 'react-router-dom'
import { Badge, Button, Card, Empty, ErrorState, Field, Input, Json, Loading, Notice, PageHeader, Panel, Segmented, Select, Term, Toggle } from '../components/ui'
import { Checkbox, TextLink } from '../components/form'
import { LabelHelp } from '../components/LabelHelp'
import { ScrollTable, ScrollTabs } from '../components/Layout'
import { api } from '../lib/api'
import { whereLabel } from '../lib/models'
import { useCrumbs } from '../lib/crumbs'
import { ms, pct, plural, usd } from '../lib/format'
import { usePrefs } from '../lib/prefs'
import type { CatalogEntry, ConnectorTemplate, ModelCheck, ProviderConfig, Settings } from '../lib/types'
import { LocalModelsCard } from '../components/LocalModels'
import { Pricing } from './Evaluators'

// TextLink's props do not list target/rel (they reach the anchor through the rest spread).

type STab = 'models' | 'defaults' | 'appearance' | 'shape' | 'templates' | 'pricing' | 'server'

export function SettingsPage() {
  const [params, setParams] = useSearchParams()
  const tab = (params.get('tab') as STab) ?? 'models'
  useCrumbs([{ label: 'Settings' }, { label: { models: 'Models & keys', defaults: 'Defaults', appearance: 'Appearance', shape: 'Reply shape', templates: 'Templates', pricing: 'Pricing', server: 'Server' }[tab] }], `settings-${tab}`)
  return (
    <>
      <PageHeader title="Settings" help={<p>Grading models and keys, workspace defaults, connection templates, prices, and how Assay looks.</p>} />
      <ScrollTabs tabs={[
        { id: 'models', label: 'Models & keys' }, { id: 'defaults', label: 'Defaults' }, { id: 'appearance', label: 'Appearance' },
        { id: 'shape', label: 'Reply shape' }, { id: 'templates', label: 'Connection templates' }, { id: 'pricing', label: 'Pricing' }, { id: 'server', label: 'Server' },
      ]} value={tab} onChange={(t) => setParams({ tab: t })} />
      <div className="mt-8">
        {tab === 'models' && <ModelsTab />}
        {tab === 'defaults' && <DefaultsTab />}
        {tab === 'appearance' && <AppearanceTab />}
        {tab === 'shape' && <ShapeTab />}
        {tab === 'templates' && <TemplatesTab />}
        {tab === 'pricing' && <Pricing />}
        {tab === 'server' && <ServerTab />}
      </div>
    </>
  )
}

// --------------------------------------------------------------------------------------
// Models & keys
// --------------------------------------------------------------------------------------

function ModelsTab() {
  const qc = useQueryClient()
  const catalog = useQuery({ queryKey: ['catalog'], queryFn: () => api.get<CatalogEntry[]>('/api/models/catalog') })
  const models = useQuery({ queryKey: ['models'], queryFn: () => api.get<ProviderConfig[]>('/api/models') })
  const settings = useQuery({ queryKey: ['settings'], queryFn: () => api.get<{ values: Settings; keyring_available: boolean }>('/api/settings') })
  const [connecting, setConnecting] = useState<CatalogEntry | null>(null)
  const refresh = () => { qc.invalidateQueries({ queryKey: ['models'] }); qc.invalidateQueries({ queryKey: ['settings'] }); qc.invalidateQueries({ queryKey: ['home'] }) }
  const byCatalog = (id: string) => (models.data ?? []).filter((m) => m.catalog_id === id)

  return (
    <div className="space-y-12" data-tour="models">
      <Card title="Your grading models" meta={models.data?.length ? `${models.data.length}` : undefined} help={<>
        <p>A grading model ("judge") reads an answer and decides whether it is correct, grounded, relevant... Objective checks never need one.</p>
        <p>Keys are stored in your operating system's credential store and never shown again.</p>
        <p>Check sends five grading calls and reports speed, how many verdicts came back as valid JSON, and what 100 calls would cost.</p>
      </>}>
        {models.isLoading ? <Loading /> : models.isError ? <ErrorState error={models.error} retry={() => models.refetch()} /> : (models.data ?? []).length === 0 ? (
          <Empty title="No grading model yet. Objective checks still run; meaning needs a judge.">Connect OpenAI below (or a local model) to enable meaning checks and the judge bake-off.</Empty>
        ) : (
          <div className="grid gap-4 lg:grid-cols-2">
            {models.data!.map((m) => <ModelCard key={m.id} m={m} settings={settings.data?.values} onChange={refresh} />)}
          </div>
        )}
      </Card>
      <LocalModelsCard models={models.data ?? []} onChange={refresh} />
      <Card title="Connect a provider" help={<p>Pick a provider to connect a grading model from it. Model lists come from the provider itself, so they are never out of date.</p>}>
        {!settings.data?.keyring_available && <div className="mb-6"><Notice tone="warn" title="No OS credential store here">Keys can still be used from the server environment: set them in <code>.env</code> and use the "environment variable" option.</Notice></div>}
        <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-5">
          {(catalog.data ?? []).map((c) => (
            <button key={c.id} type="button" onClick={() => setConnecting(c)} aria-pressed={connecting?.id === c.id}
              className={clsx('flex h-full flex-col items-start gap-2 rounded-xl border p-4 text-left transition-colors duration-(--dur-ui)',
                connecting?.id === c.id ? 'border-accent bg-accent-wash ring-1 ring-accent' : 'border-line bg-surface shadow-card hover:border-line-strong hover:bg-surface-2')}>
              <span className="text-base font-semibold text-ink">{c.label}</span>
              <span className="flex flex-wrap gap-1">
                {c.local ? <Badge tone="pass"><Cpu className="size-3" />local</Badge> : <Badge><Cloud className="size-3" />cloud</Badge>}
                {byCatalog(c.id).length > 0 && <Badge tone="accent">{byCatalog(c.id).length} connected</Badge>}
              </span>
              <span className="text-xs text-ink-2">{c.blurb}</span>
              <span className="mt-auto inline-flex items-center gap-1 pt-1 text-xs font-medium text-accent-ink"><Plus className="size-3" />Connect</span>
            </button>
          ))}
        </div>
      </Card>
      <AnimatePresence>
        {connecting && <ConnectProvider key={connecting.id} entry={connecting} keyring={settings.data?.keyring_available ?? false} onClose={() => setConnecting(null)} onDone={() => { setConnecting(null); refresh() }} />}
      </AnimatePresence>
    </div>
  )
}

function ModelCard({ m, settings, onChange }: { m: ProviderConfig; settings?: Settings; onChange: () => void }) {
  const [check, setCheck] = useState<ModelCheck | null>(null)
  const run = useMutation({ mutationFn: () => api.post<ModelCheck>(`/api/models/${m.id}/check`), onSuccess: setCheck, meta: { silent: true } })
  const setDefault = useMutation({ mutationFn: (key: 'default_judge' | 'default_generator') => api.put('/api/settings', { [key]: { provider_config_id: m.id } }), onSuccess: onChange, meta: { silent: true } })
  const del = useMutation({ mutationFn: () => api.del(`/api/providers/${m.id}`), onSuccess: onChange, meta: { silent: true } })
  const isJudge = settings?.default_judge?.provider_config_id === m.id
  const isGen = settings?.default_generator?.provider_config_id === m.id
  return (
    <Panel>
      <div className="flex items-start gap-3">
        <span className={clsx('flex size-9 shrink-0 items-center justify-center rounded-lg', m.local ? 'bg-good-wash text-good-ink' : 'bg-accent-wash text-accent-ink')}>{m.local ? <Cpu className="size-4" /> : <Cloud className="size-4" />}</span>
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-1.5">
            <span className="text-base font-semibold">{m.name}</span>
            {isJudge && <Badge tone="accent"><Star className="size-3" />default judge</Badge>}
            {isGen && <Badge tone="accent"><Star className="size-3" />default generator</Badge>}
          </div>
          <div className="font-mono text-xs text-ink-3">{m.provider} / {m.model}{m.base_url ? ` - ${m.base_url}` : ''}</div>
          <div className="mt-1 flex flex-wrap items-center gap-1.5 text-xs">
            {m.api_key_ref ? (
              <Badge tone={m.key_status === 'set' ? 'good' : 'bad'}><Lock className="size-3" />{m.key_status === 'set' ? `${m.key_hint ?? 'key set'} (${m.key_kind === 'keyring' ? 'OS store' : 'environment'})` : `${m.api_key_ref} missing`}</Badge>
            ) : <Badge tone="good">no key needed</Badge>}
            <Badge tone={m.calibration?.sufficient ? 'good' : 'warn'} title="Agreement with your own labels is measured per model"><Term k="calibrated">{m.calibration?.status ?? 'Uncalibrated'}</Term></Badge>
            <span className="text-ink-3">{m.cloud_via_ollama ? "answers go to Ollama's servers (a cloud model)" : m.local ? 'answers stay on this machine' : 'answers are sent to the provider'}</span>
          </div>
        </div>
      </div>
      <AnimatePresence>
        {check && (
          <motion.div initial={{ opacity: 0, height: 0 }} animate={{ opacity: 1, height: 'auto' }} exit={{ opacity: 0, height: 0 }} className="overflow-hidden">
            {check.ok ? (
              <div className="mt-3 grid grid-cols-3 border-y border-line [&>*+*]:border-l [&>*+*]:border-line">
                <CheckTile label="Speed" value={ms(check.median_ms)} sub="median of the calls" />
                <CheckTile label="Valid verdicts" value={`${check.valid_json}/${check.answered}`} sub={pct(check.json_reliability, 0)} tone={check.json_reliability === 1 ? 'good' : 'warn'} />
                <CheckTile label="100 grading calls" value={check.cost_per_100_calls_usd === null ? 'price unknown' : usd(check.cost_per_100_calls_usd)} sub={check.price_known ? 'from the price table' : 'add it under Pricing'} />
              </div>
            ) : <div className="mt-3"><Notice tone="bad" title={check.explanation ?? 'The model did not answer'}><span className="font-mono text-xs">{check.error}</span></Notice></div>}
            {check.warnings.map((w) => <p key={w} className="mt-2 text-xs text-warn-ink">{w}</p>)}
          </motion.div>
        )}
      </AnimatePresence>
      <div className="mt-3 flex flex-wrap gap-1.5">
        <Button size="sm" loading={run.isPending} onClick={() => run.mutate()}><RefreshCw className="size-3.5" />Check (5 calls)</Button>
        {!isJudge && <Button size="sm" loading={setDefault.isPending && setDefault.variables === 'default_judge'} onClick={() => setDefault.mutate('default_judge')}>Make default grading model</Button>}
        {!isGen && <Button size="sm" loading={setDefault.isPending && setDefault.variables === 'default_generator'} onClick={() => setDefault.mutate('default_generator')}>Use to draft test cases</Button>}
        {!m.used_by_runs && <Button size="sm" variant="danger" className="ml-auto" loading={del.isPending} onClick={() => del.mutate()}><Trash2 className="size-3.5" />Remove</Button>}
      </div>
      {del.isError && <div className="mt-2"><ErrorState error={del.error} /></div>}
      {run.isError && <div className="mt-2"><ErrorState error={run.error} /></div>}
      {setDefault.isError && <div className="mt-2"><ErrorState error={setDefault.error} /></div>}
    </Panel>
  )
}

function CheckTile({ label, value, sub, tone }: { label: string; value: string; sub: string; tone?: 'good' | 'warn' }) {
  return (
    <div className="min-w-0 px-3 py-2 first:pl-0">
      <div className="t-label">{label}</div>
      <div className={clsx('num mt-1 truncate font-mono text-lead font-medium', tone === 'good' && 'text-good-ink', tone === 'warn' && 'text-warn-ink')}>{value}</div>
      <div className="text-xs text-ink-3">{sub}</div>
    </div>
  )
}

function ConnectProvider({ entry, keyring, onClose, onDone }: { entry: CatalogEntry; keyring: boolean; onClose: () => void; onDone: () => void }) {
  const [keyMode, setKeyMode] = useState<'store' | 'env' | 'stored'>(keyring ? 'store' : 'env')
  const [key, setKey] = useState('')
  const [keyName, setKeyName] = useState(entry.key_name ?? 'LLM_API_KEY')
  const [keyRef, setKeyRef] = useState<string | null>(entry.needs_key ? null : '')
  const [baseUrl, setBaseUrl] = useState(entry.base_url)
  const [model, setModel] = useState('')
  const [name, setName] = useState('')
  const [makeDefault, setMakeDefault] = useState(true)
  const storeKey = useMutation({ mutationFn: () => api.put<{ ref: string; hint: string }>(`/api/secrets/${keyName}`, { value: key }), onSuccess: (r) => { setKeyRef(r.ref); setKey(''); setKeyMode('stored') } })
  const list = useMutation({ meta: { silent: true }, mutationFn: () => api.post<{ ok: boolean; models: string[]; error?: string }>('/api/models/list', { provider: entry.kind, base_url: baseUrl || null, api_key_ref: keyRef || null }) })
  const add = useMutation({
    meta: { silent: true },
    mutationFn: async () => {
      const m = await api.post<ProviderConfig>('/api/models', { name: name || `${entry.label} - ${model}`, provider: entry.kind, model, base_url: baseUrl || null, api_key_ref: keyRef || null })
      if (makeDefault) await api.put('/api/settings', { default_judge: { provider_config_id: m.id } })
      return m
    },
    onSuccess: onDone,
  })
  const keyReady = !entry.needs_key || !!keyRef
  return (
    <motion.div initial={{ opacity: 0, y: 8 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0, y: 8 }}>
      <Card boxed title={`Connect ${entry.label}`} actions={<Button size="sm" variant="ghost" onClick={onClose} aria-label="Close"><X className="size-4" /></Button>}>
        <ol className="space-y-5">
          <li>
            <div className="mb-2 flex items-center gap-2 text-sm font-semibold"><span className="flex size-5 items-center justify-center rounded-full bg-accent font-mono text-label text-on-accent">1</span>Where it is{entry.needs_key ? ' and the key' : ''}</div>
            <div className="grid gap-3 md:grid-cols-2">
              <Field label="Base URL" hint={entry.local ? 'On this machine' : undefined}><Input value={baseUrl} onChange={(e) => setBaseUrl(e.target.value)} /></Field>
              {entry.needs_key && (
                <div className="space-y-2">
                  <Segmented size="sm" value={keyMode === 'stored' ? 'store' : keyMode} onChange={(v) => { setKeyMode(v); setKeyRef(null) }} options={[{ id: 'store', label: 'Paste the key' }, { id: 'env', label: 'Environment variable' }]} />
                  {keyMode === 'store' && (
                    <div className="flex gap-2">
                      <Input type="password" autoComplete="off" placeholder={entry.id === 'openai' ? 'sk-...' : 'API key'} value={key} onChange={(e) => setKey(e.target.value)} aria-label="API key" />
                      <Input className="w-44" value={keyName} onChange={(e) => setKeyName(e.target.value)} aria-label="Save the key as" />
                      <Button loading={storeKey.isPending} disabled={key.length < 8} onClick={() => storeKey.mutate()}><Lock className="size-3.5" />Store</Button>
                    </div>
                  )}
                  {keyMode === 'stored' && <p className="flex items-center gap-1.5 text-sm text-good-ink"><Check className="size-4" />Stored as <code>{keyRef}</code> in the OS credential store.</p>}
                  {keyMode === 'env' && (
                    <div className="flex gap-2">
                      <Input value={keyName} onChange={(e) => setKeyName(e.target.value)} aria-label="Environment variable name" />
                      <Button onClick={() => setKeyRef(`env:${keyName}`)}>Use env:{keyName}</Button>
                    </div>
                  )}
                  {storeKey.isError && <ErrorState error={storeKey.error} />}
                  {entry.key_url && <TextLink href={entry.key_url} size="sm" target="_blank" rel="noreferrer noopener">Get a key <ExternalLink className="size-3" /></TextLink>}
                </div>
              )}
            </div>
          </li>
          <li className={clsx(!keyReady && 'pointer-events-none opacity-40')}>
            <div className="mb-2 flex items-center gap-2 text-sm font-semibold"><span className="flex size-5 items-center justify-center rounded-full bg-accent font-mono text-label text-on-accent">2</span>
              <LabelHelp label="Pick a model" title="Which model?"><p>For grading, a small fast model is usually enough; check its agreement with your labels in the bake-off before trusting it.</p></LabelHelp></div>
            <div className="flex flex-wrap items-end gap-2">
              <Button loading={list.isPending} onClick={() => list.mutate()}><RefreshCw className="size-3.5" />Load models from {entry.label}</Button>
              {list.data?.ok && (
                <Field label={plural(list.data.models.length, 'model')}>
                  <Select className="w-72" value={model} onChange={(e) => setModel(e.target.value)} aria-label="Model">
                    <option value="">Choose...</option>{list.data.models.map((x) => <option key={x}>{x}</option>)}
                  </Select>
                </Field>
              )}
              <Field label="or type a model id"><Input className="w-56" value={model} onChange={(e) => setModel(e.target.value)} placeholder="model id" /></Field>
            </div>
            {list.data && !list.data.ok && <p className="mt-2 text-xs text-bad-ink">{list.data.error}</p>}
            {list.isError && <div className="mt-2"><ErrorState error={list.error} /></div>}
          </li>
          <li className={clsx(!model && 'pointer-events-none opacity-40')}>
            <div className="mb-2 flex items-center gap-2 text-sm font-semibold"><span className="flex size-5 items-center justify-center rounded-full bg-accent font-mono text-label text-on-accent">3</span>
              <LabelHelp label="Name and save" title="A new model is uncalibrated"><p>A new model starts uncalibrated: runs it grades are marked so until you compare it with your own labels (Calibration).</p></LabelHelp></div>
            <div className="flex flex-wrap items-end gap-3">
              <Field label="Name"><Input className="w-72" value={name} onChange={(e) => setName(e.target.value)} placeholder={`${entry.label} - ${model || 'model'}`} /></Field>
              <Checkbox className="pb-1.5" checked={makeDefault} onChange={setMakeDefault} label="Make it the default judge" />
              <Button variant="primary" loading={add.isPending} disabled={!model || !keyReady} onClick={() => add.mutate()}><Check className="size-3.5" />Save</Button>
            </div>
            {add.isError && <div className="mt-2"><ErrorState error={add.error} /></div>}
          </li>
        </ol>
      </Card>
    </motion.div>
  )
}

// --------------------------------------------------------------------------------------
// Defaults, appearance, server
// --------------------------------------------------------------------------------------

function DefaultsTab() {
  const qc = useQueryClient()
  const settings = useQuery({ queryKey: ['settings'], queryFn: () => api.get<{ values: Settings }>('/api/settings') })
  const models = useQuery({ queryKey: ['models'], queryFn: () => api.get<ProviderConfig[]>('/api/models') })
  const [cap, setCap] = useState<string | null>(null)
  const put = useMutation({ mutationFn: (v: Partial<Settings>) => api.put('/api/settings', v), onSuccess: () => { qc.invalidateQueries({ queryKey: ['settings'] }); qc.invalidateQueries({ queryKey: ['home'] }) } })
  if (settings.isLoading) return <Loading />
  const s = settings.data!.values
  const judgeVal = s.default_judge ? (s.default_judge.provider === 'heuristic' ? 'heuristic' : String(s.default_judge.provider_config_id)) : ''
  return (
    <div className="max-w-3xl space-y-12">
      <Card title="Default grading model" help={<>
        <p>Used by new runs unless a run picks its own.</p>
        <p>Changing the default never re-grades old runs: each run keeps the grading model it used.</p>
      </>}>
        <Select className="w-96" value={judgeVal} aria-label="Default judge"
          onChange={(e) => put.mutate({ default_judge: e.target.value === '' ? null : e.target.value === 'heuristic' ? { provider: 'heuristic' } : { provider_config_id: Number(e.target.value) } })}>
          <option value="">None</option>
          <option value="heuristic">Heuristic (word overlap, free, not an LLM)</option>
          {(models.data ?? []).map((m) => <option key={m.id} value={m.id}>{m.name} ({whereLabel(m)})</option>)}
        </Select>
      </Card>
      <Card title="Model for drafting test cases" help={<p>Generates candidate questions from your documents; you approve each one.</p>}>
        <Select className="w-96" value={s.default_generator?.provider_config_id ?? ''} aria-label="Default generator"
          onChange={(e) => put.mutate({ default_generator: e.target.value ? { provider_config_id: Number(e.target.value) } : null })}>
          <option value="">None</option>{(models.data ?? []).map((m) => <option key={m.id} value={m.id}>{m.name}</option>)}
        </Select>
      </Card>
      <Card title="Spend cap per run" help={<p>A run stops scheduling questions when its estimated spend reaches this. Questions already sent still finish.</p>}>
        <div className="flex items-end gap-2">
          <Field label="USD"><Input className="w-40" type="number" min={0} step="0.5" value={cap ?? (s.spend_cap_usd ?? '')} onChange={(e) => setCap(e.target.value)} placeholder="no cap" /></Field>
          <Button variant="primary" loading={put.isPending} onClick={() => put.mutate({ spend_cap_usd: cap === '' || cap === null ? null : Number(cap) })}>Save</Button>
        </div>
      </Card>
      <Card title="Demo data" help={<p>The seeded Acme Support Demo chatbot, for trying Assay and for showing it.</p>}>
        <Toggle checked={!!s.hide_demo} onChange={(v) => { put.mutate({ hide_demo: v }); qc.invalidateQueries({ queryKey: ['projects'] }) }}
          label={<LabelHelp label="Hide demo data"><p>Drops the demo chatbot from the home page and from chatbot pickers. Nothing is deleted; turn it back on before a demo.</p></LabelHelp>} />
      </Card>
      <Notice title="No silent fallback">If a grading model fails or is rate-limited, those answers are marked <span className="font-semibold">not evaluated</span>. Assay never switches to another model in the middle of a run, so one run is always graded by one model.</Notice>
      {put.isError && <ErrorState error={put.error} />}
    </div>
  )
}

function AppearanceTab() {
  const p = usePrefs()
  return (
    <div className="max-w-2xl space-y-12">
      <Card title="Look">
        <div className="space-y-4">
          <div className="flex items-center justify-between"><span className="text-sm font-medium">Theme</span><Segmented size="md" value={p.theme} onChange={(v) => p.set('theme', v)} options={[{ id: 'light', label: 'Light' }, { id: 'dark', label: 'Dark' }]} /></div>
          <div className="flex items-center justify-between"><span className="text-sm font-medium">Density</span><Segmented size="md" value={p.density} onChange={(v) => p.set('density', v)} options={[{ id: 'comfortable', label: 'Comfortable' }, { id: 'compact', label: 'Compact' }]} /></div>
        </div>
      </Card>
      <Card title="Motion" help={<p>The needle sweeps, figures roll and a passed gate stamps. Explanations live behind the circled ? beside every heading: hover it, or click to keep it open.</p>}>
        <div className="space-y-4">
          <Toggle checked={p.motion === 'full'} onChange={(v) => p.set('motion', v ? 'full' : 'reduced')}
            label={<LabelHelp label="Animations"><p>Off: everything appears instantly. Your system's reduce-motion setting is always respected.</p></LabelHelp>} />
        </div>
      </Card>
    </div>
  )
}

function ServerTab() {
  const s = useQuery({ queryKey: ['settings'], queryFn: () => api.get<{ server: { version: string; database: string; database_url: string } }>('/api/settings') })
  const health = useQuery({ queryKey: ['health'], queryFn: () => api.get<{ status: string }>('/api/health'), refetchInterval: 15_000 })
  return (
    <Card title="Assay server" className="max-w-2xl">
      <dl className="grid grid-cols-[160px_minmax(0,1fr)] gap-y-2 text-sm">
        <dt className="t-label self-center">Status</dt><dd className="flex items-center gap-2"><span className={clsx('size-2 rounded-full', health.isSuccess ? 'bg-good' : 'bg-bad')} />{health.isSuccess ? 'running' : 'unreachable'}</dd>
        <dt className="t-label self-center">Version</dt><dd className="num font-mono">{s.data?.server.version}</dd>
        <dt className="t-label self-center">Database</dt><dd>{s.data?.server.database} <span className="font-mono text-xs text-ink-3">{s.data?.server.database_url}</span></dd>
        <dt className="t-label self-center">API reference</dt><dd><TextLink href="/docs" target="_blank" rel="noreferrer noopener">OpenAPI docs <ExternalLink className="size-3" /></TextLink></dd>
      </dl>
    </Card>
  )
}

// --------------------------------------------------------------------------------------
// Reply shape + snippets
// --------------------------------------------------------------------------------------

const SNIPPETS: Record<string, string> = {
  FastAPI: `from fastapi import FastAPI
from pydantic import BaseModel

app = FastAPI()

class Ask(BaseModel):
    message: str
    session_id: str | None = None

@app.post("/eval")
def evaluate(q: Ask) -> dict:
    result = my_rag_pipeline(q.message)          # your existing code
    return {
        "answer": result.text,
        "sources": [{"id": d.id, "title": d.title, "text": d.text, "score": d.score}
                    for d in result.documents],
        "citations": result.cited_ids,              # ids from "sources"
        "tool_calls": [{"name": t.name, "arguments": t.args, "result": t.output,
                        "status": "success"} for t in result.tools],
        "usage": {"input_tokens": result.usage.prompt, "output_tokens": result.usage.completion},
        "model": {"provider": "openai", "model": result.model},
    }`,
  Flask: `from flask import Flask, jsonify, request

app = Flask(__name__)

@app.post("/eval")
def evaluate():
    q = request.get_json()["message"]
    r = my_rag_pipeline(q)                          # your existing code
    return jsonify(
        answer=r.text,
        sources=[{"id": d.id, "title": d.title, "text": d.text, "score": d.score} for d in r.documents],
        citations=r.cited_ids,
        tool_calls=[],
        usage={"input_tokens": r.usage.prompt, "output_tokens": r.usage.completion},
    )`,
  Express: `import express from "express";
const app = express();
app.use(express.json());

app.post("/eval", async (req, res) => {
  const r = await myRagPipeline(req.body.message);  // your existing code
  res.json({
    answer: r.text,
    sources: r.documents.map((d) => ({ id: d.id, title: d.title, text: d.text, score: d.score })),
    citations: r.citedIds,
    tool_calls: [],
    usage: { input_tokens: r.usage.prompt, output_tokens: r.usage.completion },
  });
});

app.listen(8000);`,
}

function ShapeTab() {
  const shape = useQuery({ queryKey: ['standard-shape'], queryFn: () => api.get<{ example: unknown }>('/api/connect/standard-shape') })
  const [lang, setLang] = useState<keyof typeof SNIPPETS>('FastAPI')
  const [copied, setCopied] = useState(false)
  return (
    <div className="grid gap-12 xl:grid-cols-2">
      <Card title="The Assay reply shape" help={<>
        <p>A bot that answers like this connects without any mapping.</p>
        <p>Only "answer" is required. Every extra field unlocks more checks: sources → retrieval and groundedness, tool calls → agent checks, usage → cost.</p>
      </>}>
        <ul className="mb-3 space-y-1 text-sm">
          <li><code>answer</code> - the text the user sees (required)</li>
          <li><code>sources</code> - retrieved documents: <code>id</code>, <code>title</code>, <code>text</code>, <code>score</code></li>
          <li><code>citations</code> - ids of the sources the answer cites</li>
          <li><code>tool_calls</code> - <code>name</code>, <code>arguments</code>, <code>result</code>, <code>status</code></li>
          <li><code>usage</code> - <code>input_tokens</code>, <code>output_tokens</code> (for cost)</li>
        </ul>
        {shape.data && <Json value={shape.data.example} maxHeight={380} />}
      </Card>
      <Card title="Add it to a bot" help={<>
        <p>One extra endpoint, about 20 lines, in the framework your bot already uses.</p>
        <p>Bots you did not build keep working: turn "My bot replies in the Assay shape" off in the connect wizard and map their reply by clicking it.</p>
      </>}
        actions={<Button size="sm" onClick={async () => { await navigator.clipboard.writeText(SNIPPETS[lang]); setCopied(true); setTimeout(() => setCopied(false), 1500) }}>{copied ? <Check className="size-3.5" /> : <Clipboard className="size-3.5" />}{copied ? 'Copied' : 'Copy'}</Button>}>
        <Segmented size="sm" value={lang} onChange={setLang} options={Object.keys(SNIPPETS).map((k) => ({ id: k as keyof typeof SNIPPETS, label: k }))} />
        <pre className="code scroll-thin mt-3 max-h-[440px] overflow-auto rounded-lg border border-line bg-surface-2 p-3">{SNIPPETS[lang]}</pre>
      </Card>
    </div>
  )
}

function TemplatesTab() {
  const qc = useQueryClient()
  const t = useQuery({ queryKey: ['connector-templates'], queryFn: () => api.get<ConnectorTemplate[]>('/api/connector-templates') })
  const del = useMutation({ mutationFn: (id: string) => api.del(`/api/connector-templates/${id.split(':')[1]}`), onSuccess: () => { setConfirm(null); qc.invalidateQueries({ queryKey: ['connector-templates'] }) }, meta: { silent: true } })
  const [open, setOpen] = useState<string | null>(null)
  const [confirm, setConfirm] = useState<string | null>(null)
  if (t.isLoading) return <Loading />
  if (t.isError) return <ErrorState error={t.error} retry={() => t.refetch()} />
  return (
    <Card padded={false} title="Connection templates" meta={`${(t.data ?? []).length}`} help={<>
      <p>Start a new connection from one of these in the connect wizard. Save your own from a connection's page.</p>
      <p>Templates hold key references (env:/keyring:), never keys.</p>
    </>}>
      <ScrollTable>
        <thead><tr><th className="t-label">Name</th><th className="t-label">Kind</th><th className="t-label">Description</th><th></th></tr></thead>
        <tbody>
          {(t.data ?? []).map((x) => (
            <Fragment key={x.id}>
              <tr>
                <td className="font-medium">{x.name}</td>
                <td>{x.builtin ? <Badge>built in</Badge> : <Badge tone="accent">yours</Badge>}</td>
                <td className="text-ink-2">{x.description}</td>
                <td className="whitespace-nowrap text-right">
                  <Button size="sm" variant="ghost" onClick={() => setOpen(open === x.id ? null : x.id)}>{open === x.id ? 'Hide' : 'Show'}</Button>
                  {!x.builtin && (confirm === x.id
                    ? <><Button size="sm" variant="danger" loading={del.isPending} onClick={() => del.mutate(x.id)}>Delete template</Button><Button size="sm" variant="ghost" onClick={() => setConfirm(null)}>Keep</Button></>
                    : <Button size="sm" variant="danger" aria-label={`Delete template ${x.name}`} onClick={() => { del.reset(); setConfirm(x.id) }}><Trash2 className="size-3.5" /></Button>)}
                </td>
              </tr>
              {open === x.id && <tr><td colSpan={4}><Json value={x.config} maxHeight={300} /></td></tr>}
            </Fragment>
          ))}
        </tbody>
      </ScrollTable>
      {del.isError && <div className="p-3"><ErrorState error={del.error} /></div>}
      <p className="flex items-center gap-1.5 border-t border-line py-2 text-xs text-ink-2"><ShieldCheck className="size-3.5 text-good-ink" />Templates hold key references (env:/keyring:), never keys.</p>
    </Card>
  )
}
