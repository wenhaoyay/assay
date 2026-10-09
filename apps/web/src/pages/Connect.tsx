// "Connect a chatbot": four steps, each showing its result before the next.
// 1 how to reach it  2 the request  3 a test question and the reply mapped by clicking  4 safety, save.
// The configuration stays the record: the Advanced panel shows it as JSON, in sync both ways.
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import clsx from 'clsx'
import {
  ArrowLeft, ArrowRight, Check, CircleAlert, Code2, FileUp, KeyRound, Lock, MousePointerClick, Plug, Radio, Send, Sparkles, Terminal, Wand2, X,
} from 'lucide-react'
import { AnimatePresence, motion } from 'motion/react'
import { useState, type ReactNode } from 'react'
import { useNavigate, useSearchParams } from 'react-router-dom'
import { CleanupMethodHelp, ConnectionHelp, MethodHelp } from '../components/helpTexts'
import { JsonTree } from '../components/JsonTree'
import { Badge, Button, Card, ErrorState, Field, Input, Json, Notice, PageHeader, PageSkeleton, Segmented, Select, Table, Textarea, Toggle, toast } from '../components/ui'
import { LabelHelp } from '../components/LabelHelp'
import { api } from '../lib/api'
import { useCrumbs } from '../lib/crumbs'
import { projectOption, useProjects } from '../lib/projects'
import { ms, plural, usd } from '../lib/format'
import type { Capability, ConnectorTemplate, Dataset, Project, Target, TargetResult } from '../lib/types'

type Route = 'curl' | 'http' | 'stream' | 'openai' | 'python' | 'logs' | 'template'
type Cfg = Record<string, unknown> & { response?: Record<string, unknown> }

const ROUTES: { id: Route; title: string; body: string; icon: typeof Terminal; badge?: string }[] = [
  { id: 'curl', title: 'Paste a curl command', body: 'From browser DevTools ("Copy as cURL") or Postman. Everything fills itself in.', icon: Terminal, badge: 'Recommended' },
  { id: 'http', title: 'HTTP API (JSON reply)', body: 'Type the URL and request body yourself.', icon: Plug },
  { id: 'stream', title: 'Streaming chat (SSE)', body: 'The reply arrives as server-sent events.', icon: Radio },
  { id: 'openai', title: 'OpenAI-compatible endpoint', body: 'Any /chat/completions API. No mapping needed.', icon: Sparkles },
  { id: 'python', title: 'Python function', body: 'module:function(test_input, options, ctx) in this process.', icon: Code2 },
  { id: 'logs', title: 'I only have logs', body: 'Upload a JSONL or CSV of past answers and grade those.', icon: FileUp },
]

const STEPS = ['How to reach it', 'The request', 'Test and map', 'Safety and save']

interface Probe {
  ok: boolean
  status?: number
  kind?: 'json' | 'text' | 'sse' | 'ndjson'
  json?: unknown
  text?: string
  events?: { type: string; count: number; sample: unknown }[]
  stream_suggestion?: Record<string, unknown>
  collected?: unknown // a stream folded into one reply, so it can be mapped like JSON
  elapsed_ms?: number
  error?: string
  explanation?: string | null
  suggestion?: { mapping: Record<string, unknown>; reasons: Record<string, string>; standard: { matches: boolean; present: string[]; missing: string[]; problems: string[] } }
}

interface TestResult {
  ok: boolean
  elapsed_ms?: number
  raw?: unknown
  normalized?: TargetResult
  error?: string | null
  explanation?: string | null
  capabilities?: Capability[]
  standard?: { matches: boolean; missing: string[] } | null
}

/** The bot replies in the standard shape ("gaugelab": saved before the project was renamed). */
export const isStandardShape = (s: unknown) => s === 'assay' || s === 'gaugelab'

const blankHttp = (): Cfg => ({ base_url: 'http://localhost:8000', endpoint: '/chat', method: 'POST', timeout_s: 60, body: { message: '{{input.message}}', session_id: 'eval-{{uuid}}' }, reply_shape: 'assay' })

export function ConnectPage() {
  const [params] = useSearchParams()
  const fromId = params.get('from')
  const editing = useQuery({ queryKey: ['target', fromId], queryFn: () => api.get<Target>(`/api/targets/${fromId}`), enabled: !!fromId })
  if (fromId && !editing.data) return editing.isError ? <ErrorState error={editing.error} /> : <PageSkeleton />
  return <ConnectWizard key={fromId ?? 'new'} editing={editing.data ?? null} />
}

function ConnectWizard({ editing }: { editing: Target | null }) {
  const fromId = editing ? String(editing.id) : null
  useCrumbs([{ label: 'Connections', to: '/targets' }, { label: fromId ? 'Edit connection' : 'Connect a chatbot' }], `connect-${fromId}`)
  const nav = useNavigate()
  const qc = useQueryClient()
  const projects = useProjects()
  const templates = useQuery({ queryKey: ['connector-templates'], queryFn: () => api.get<ConnectorTemplate[]>('/api/connector-templates') })
  const editCfg = editing?.latest_version.config as Cfg | undefined
  const [step, setStep] = useState(editing ? 2 : 0)
  const [route, setRoute] = useState<Route>(editing?.adapter === 'python' ? 'python' : editing ? 'http' : 'curl')
  const [adapter, setAdapter] = useState<'http' | 'python'>(editing?.adapter === 'python' ? 'python' : 'http')
  const [cfg, setCfg] = useState<Cfg>(() => (editCfg ? JSON.parse(JSON.stringify(editCfg)) : blankHttp()))
  const [standard, setStandardState] = useState(editCfg ? isStandardShape(editCfg.reply_shape) : true)
  // The standard-shape switch and the config change together.
  const setStandard = (on: boolean) => {
    setStandardState(on)
    if (adapter !== 'http') return
    setCfg((c) => {
      if (on) return { ...c, reply_shape: 'assay' }
      const { reply_shape: _drop, ...rest } = c
      return { response: { answer: 'answer' }, ...rest }
    })
  }
  const [advanced, setAdvanced] = useState(false)
  const [message, setMessage] = useState('What can you help me with?')
  const [probe, setProbe] = useState<Probe | null>(null)
  const [test, setTest] = useState<TestResult | null>(null)
  const [picking, setPicking] = useState<string | null>(null)
  const [pickError, setPickError] = useState<string | null>(null)


  const chooseRoute = (r: Route) => {
    setRoute(r)
    setProbe(null)
    setTest(null)
    if (r === 'python') { setAdapter('python'); setCfg({ callable: 'my_bot.app:answer', options: {} }); setStandardState(false) }
    else {
      setAdapter('http')
      if (r === 'openai') { applyTemplate(templates.data?.find((t) => t.id === 'builtin:openai-chat')); return }
      if (r === 'stream') { applyTemplate(templates.data?.find((t) => t.id === 'builtin:sse')); return }
      setCfg((c) => (c.base_url ? { ...c, reply_shape: 'assay' } : blankHttp()))
      setStandardState(true)
    }
  }
  const applyTemplate = (t?: ConnectorTemplate) => {
    if (!t) return
    setAdapter(t.adapter)
    setCfg(JSON.parse(JSON.stringify(t.config)))
    setStandardState(isStandardShape((t.config as Cfg).reply_shape))
    setRoute(t.adapter === 'python' ? 'python' : (t.config as Cfg).stream ? 'stream' : t.id === 'builtin:openai-chat' ? 'openai' : 'template')
    setStep(1)
  }


  const runProbe = useMutation({
    meta: { silent: true },
    mutationFn: () => api.post<Probe>('/api/connect/probe', { adapter, config: cfg, message }),
    onSuccess: (p) => {
      setProbe(p)
      setTest(null)
      if (adapter === 'http' && p.ok) {
        if (p.kind === 'sse' || p.kind === 'ndjson') {
          if (!cfg.stream && p.stream_suggestion) setCfg((c) => ({ ...c, stream: { ...p.stream_suggestion, format: p.kind } }))
          // The sources and citations a stream carries, read from the folded reply.
          if (p.suggestion && !standard && (!cfg.response || Object.keys(cfg.response).length <= 1)) setCfg((c) => ({ ...c, response: p.suggestion!.mapping }))
        } else if (p.suggestion) {
          if (standard && !p.suggestion.standard.matches) { /* keep standard on; the user is told it does not match */ }
          if (!standard && (!cfg.response || Object.keys(cfg.response).length <= 1)) setCfg((c) => ({ ...c, response: p.suggestion!.mapping }))
        }
      }
    },
  })
  const runTest = useMutation({
    meta: { silent: true },
    mutationFn: () => api.post<TestResult>('/api/connect/test', { adapter, config: cfg, message }),
    onSuccess: setTest,
  })

  const canNext = step === 0 ? route !== 'logs' : step === 1 ? true : step === 2 ? !!test?.ok : true

  return (
    <>
      <PageHeader title={fromId ? `Edit ${editing?.name ?? 'connection'}` : 'Connect a chatbot'}
        help={<>
          <p>Four steps: how you reach the bot, the request, a test question with the reply mapped, then safety and save.</p>
          <p>Each step shows what it found before you go on. Nothing is saved until a test question has come back right.</p>
          <p>Advanced (JSON) shows the whole configuration beside the steps; edits on either side update the other.</p>
        </>}
        actions={<Button variant={advanced ? 'primary' : 'secondary'} onClick={() => setAdvanced((v) => !v)}><Code2 className="size-3.5" />Advanced (JSON)</Button>} />
      <Stepper step={step} onStep={(i) => i <= step && setStep(i)} />
      <div className={clsx('mt-5 grid gap-5', advanced && 'xl:grid-cols-[minmax(0,1fr)_420px]')}>
        <div className="min-w-0" data-tour="connect">
          <AnimatePresence mode="wait">
            <motion.div key={step} initial={{ opacity: 0, x: 16 }} animate={{ opacity: 1, x: 0 }} exit={{ opacity: 0, x: -16 }} transition={{ duration: 0.18 }}>
              {step === 0 && <StepRoute route={route} onRoute={chooseRoute} templates={templates.data ?? []} onTemplate={applyTemplate} standard={standard} setStandard={setStandard} projects={projects.visible} />}
              {step === 1 && (route === 'logs' ? null : <StepRequest route={route} adapter={adapter} cfg={cfg} setCfg={setCfg} />)}
              {step === 2 && (
                <StepMap adapter={adapter} cfg={cfg} setCfg={setCfg} standard={standard} setStandard={setStandard} message={message} setMessage={setMessage}
                  probe={probe} runProbe={() => runProbe.mutate()} probing={runProbe.isPending} test={test} runTest={() => runTest.mutate()} testing={runTest.isPending} probeError={runProbe.error} testError={runTest.error}
                  picking={picking} setPicking={(p) => { setPicking(p); setPickError(null) }} pickError={pickError} setPickError={setPickError} />
              )}
              {step === 3 && <StepSave adapter={adapter} cfg={cfg} setCfg={setCfg} projects={projects.visible} editing={editing}
                reply={test?.raw ?? probe?.json} testMs={test?.elapsed_ms ?? probe?.elapsed_ms ?? null}
                onSaved={(id) => { qc.invalidateQueries({ queryKey: ['targets'] }); qc.invalidateQueries({ queryKey: ['projects'] }); nav(`/targets/${id}`, { viewTransition: true }) }} />}
            </motion.div>
          </AnimatePresence>
          {route === 'logs' && step === 0 && <div className="mt-5"><LogsImport projects={projects.visible} onDone={(id) => nav(`/targets/${id}`)} /></div>}
          {!(route === 'logs' && step === 0) && (
            <div className="mt-5 flex items-center gap-2">
              {step > 0 && <Button onClick={() => setStep(step - 1)}><ArrowLeft className="size-3.5" />Back</Button>}
              {step < 3 && <Button variant="primary" disabled={!canNext} onClick={() => setStep(step + 1)}>Next: {STEPS[step + 1]} <ArrowRight className="size-3.5" /></Button>}
              {step === 2 && !test?.ok && <span className="text-xs text-ink-2">Send a test question that comes back right to continue.</span>}
            </div>
          )}
        </div>
        {advanced && <AdvancedPanel adapter={adapter} cfg={cfg} setCfg={setCfg} />}
      </div>
    </>
  )
}

function Stepper({ step, onStep }: { step: number; onStep: (i: number) => void }) {
  return (
    <ol className="flex flex-wrap items-center gap-2">
      {STEPS.map((s, i) => (
        <li key={s} className="flex items-center gap-2">
          <button type="button" onClick={() => onStep(i)} disabled={i > step}
            className={clsx('flex items-center gap-2 rounded-full border px-3 py-1 text-sm transition-colors',
              i === step ? 'border-accent bg-accent-wash font-medium text-accent-ink' : i < step ? 'border-good/40 text-good-ink' : 'border-line text-ink-3')}>
            <span className={clsx('flex size-5 items-center justify-center rounded-full font-mono text-label font-semibold', i === step ? 'bg-accent text-on-accent' : i < step ? 'bg-good text-on-solid' : 'bg-surface-3 text-ink-3')}>
              {i < step ? <Check className="size-3" /> : i + 1}
            </span>
            {s}
          </button>
          {i < STEPS.length - 1 && <span className="h-px w-6 bg-line-strong" />}
        </li>
      ))}
    </ol>
  )
}

function StepRoute({ route, onRoute, templates, onTemplate, standard, setStandard }: {
  route: Route; onRoute: (r: Route) => void; templates: ConnectorTemplate[]; onTemplate: (t: ConnectorTemplate) => void
  standard: boolean; setStandard: (v: boolean) => void; projects: Project[]
}) {
  return (
    <div className="space-y-5">
      <Card title="How do you reach your chatbot?">
        <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3" role="radiogroup">
          {ROUTES.map((r) => (
            <button key={r.id} type="button" role="radio" aria-checked={route === r.id} onClick={() => onRoute(r.id)}
              className={clsx('relative flex flex-col items-start rounded-xl border p-4 text-left transition-colors', route === r.id ? 'border-accent bg-accent-wash/50' : 'border-line hover:border-line-strong')}>
              {route === r.id && <motion.span layoutId="route-ring" className="absolute inset-0 rounded-xl ring-2 ring-accent" />}
              <div className="flex items-center gap-2"><r.icon className={clsx('size-4', route === r.id ? 'text-accent-ink' : 'text-ink-3')} /><span className="text-sm font-semibold">{r.title}</span>{r.badge && <Badge tone="accent">{r.badge}</Badge>}</div>
              <p className="mt-1 text-xs text-ink-2">{r.body}</p>
            </button>
          ))}
        </div>
      </Card>
      {route !== 'logs' && route !== 'python' && (
        <Card>
          <Toggle checked={standard} onChange={setStandard}
            label={<LabelHelp label="My bot replies in the Assay shape" title="The Assay reply shape">
              <p>The reply is <code>{'{answer, sources, citations, tool_calls, usage}'}</code>: nothing to map.</p>
              <p>Turn it off for bots you did not build: you will map the reply by clicking it. <a className="text-accent-ink underline" href="/settings?tab=shape">How to add the shape to a bot</a></p>
            </LabelHelp>} />
        </Card>
      )}
      {route !== 'logs' && (
        <Card title="Or start from a template" meta={`${templates.length}`} help={<p>Fills the steps from a known setup. Your saved connections appear here too.</p>}>
          <div className="grid gap-2 sm:grid-cols-2 lg:grid-cols-3">
            {templates.map((t) => (
              <button key={t.id} type="button" onClick={() => onTemplate(t)} className="flex flex-col items-start rounded-lg border border-line p-3 text-left hover:border-accent/50 hover:bg-surface-2">
                <div className="flex items-center gap-2 text-sm font-medium">{t.name}{!t.builtin && <Badge tone="accent">yours</Badge>}</div>
                <div className="mt-0.5 line-clamp-2 text-xs text-ink-2">{t.description}</div>
              </button>
            ))}
          </div>
        </Card>
      )}
    </div>
  )
}

/** String values that look like JSON literals: "null", "true", "false" (usually a typo for the literal). */
export function quotedLiterals(body: unknown, path = 'body'): { path: string; value: string }[] {
  if (typeof body === 'string') return ['null', 'true', 'false'].includes(body.trim().toLowerCase()) ? [{ path, value: body.trim().toLowerCase() }] : []
  if (Array.isArray(body)) return body.flatMap((v, i) => quotedLiterals(v, `${path}[${i}]`))
  if (body && typeof body === 'object') return Object.entries(body).flatMap(([k, v]) => quotedLiterals(v, `${path}.${k}`))
  return []
}

function unquote(body: unknown, path: string): unknown {
  const keys = path.replace(/\[(\d+)\]/g, '.$1').split('.').slice(1)
  const out = JSON.parse(JSON.stringify(body)) as Record<string, unknown>
  let node: Record<string, unknown> = out
  keys.slice(0, -1).forEach((k) => { node = node[k] as Record<string, unknown> })
  const last = keys[keys.length - 1]
  const v = String(node[last]).trim().toLowerCase()
  node[last] = v === 'null' ? null : v === 'true'
  return out
}

/** Where a conversation id sits in a reply, e.g. "done.conversation_id" for a streamed reply. */
export function findChatId(raw: unknown, path = ''): string | null {
  if (!raw || typeof raw !== 'object') return null
  const entries = Array.isArray(raw) ? [] : Object.entries(raw as Record<string, unknown>)
  for (const [k, v] of entries) {
    if (/^(conversation|session|chat|thread)_?id$/i.test(k) && (typeof v === 'string' || typeof v === 'number') && String(v).length > 0) return path ? `${path}.${k}` : k
  }
  for (const [k, v] of entries) {
    const found = v && typeof v === 'object' && !Array.isArray(v) ? findChatId(v, path ? `${path}.${k}` : k) : null
    if (found) return found
  }
  return null
}

function StepRequest({ route, adapter, cfg, setCfg }: { route: Route; adapter: 'http' | 'python'; cfg: Cfg; setCfg: (f: (c: Cfg) => Cfg) => void }) {
  const [curl, setCurl] = useState('')
  const [parsed, setParsed] = useState<null | { secrets: { header: string; prefix: string; value: string; hint: string }[]; session_fields: string[]; question_path: string | null; looks_streaming: boolean }>(null)
  const [bodyText, setBodyText] = useState(JSON.stringify(cfg.body ?? {}, null, 2))
  const [bodyErr, setBodyErr] = useState<string | null>(null)
  const parse = useMutation({
    mutationFn: () => api.post<Record<string, unknown> & { secrets: { header: string; prefix: string; value: string; hint: string }[]; session_fields: string[]; question_path: string | null; looks_streaming: boolean; body_template: unknown }>('/api/connect/parse-curl', { command: curl }),
    onSuccess: (p) => {
      const body = p.body_template as Record<string, unknown> | null
      if (body && typeof body === 'object') for (const f of p.session_fields) body[f] = 'eval-{{uuid}}'
      setCfg((c) => ({ ...c, base_url: p.base_url, endpoint: p.endpoint, method: p.method, headers: p.headers, query: p.query, body: body ?? {}, auth: undefined }))
      setBodyText(JSON.stringify(body ?? {}, null, 2))
      setParsed(p)
    },
  })
  const field = (k: string) => String(cfg[k] ?? '')
  const set = (k: string, v: unknown) => setCfg((c) => ({ ...c, [k]: v }))
  if (adapter === 'python') {
    return (
      <Card title="Which function?" help={<p>Return a dict with at least "answer"; add "retrieved_documents", "citations", "tool_calls" and "usage" to unlock more checks.</p>}>
        <div className="grid gap-3 md:grid-cols-2">
          <Field label={<LabelHelp label="Callable"><p><code>package.module:function</code>, called as <code>function(test_input, options, ctx)</code>.</p></LabelHelp>}><Input value={field('callable')} onChange={(e) => set('callable', e.target.value)} /></Field>
          <Field label="Options (JSON)"><Input value={JSON.stringify(cfg.options ?? {})} onChange={(e) => { try { set('options', JSON.parse(e.target.value)) } catch { /* typing */ } }} /></Field>
        </div>
      </Card>
    )
  }
  return (
    <div className="space-y-5">
      {route === 'curl' && (
        <Card title="Paste the curl command" help={<>
          <p>Copy a real request to your bot as curl and Assay reads the address, headers and body from it, finds where the question goes, and offers to store any key securely.</p>
          <p>Chrome / Edge DevTools → Network → right-click the request → Copy → Copy as cURL (bash).</p>
        </>}>
          <Textarea mono rows={6} value={curl} onChange={(e) => setCurl(e.target.value)} placeholder={"curl 'https://my-bot.example.com/api/chat' \\\n  -H 'Authorization: Bearer sk-...' \\\n  -H 'Content-Type: application/json' \\\n  --data-raw '{\"question\":\"How do I reset it?\"}'"} aria-label="curl command" />
          <div className="mt-2 flex items-center gap-2">
            <Button variant="primary" loading={parse.isPending} disabled={curl.trim().length < 6} onClick={() => parse.mutate()}><Wand2 className="size-3.5" />Read it</Button>
            <span className="text-xs text-ink-2">DevTools → Network → Copy as cURL (bash)</span>
          </div>
          {parse.isError && <div className="mt-2"><ErrorState error={parse.error} /></div>}
          {parsed && (
            <motion.div initial={{ opacity: 0 }} animate={{ opacity: 1 }} className="mt-3 space-y-2">
              <Notice tone="good" title="Request read">
                {parsed.question_path ? <>The question goes in <code>{parsed.question_path}</code> - replaced by each test question.</> : 'No question field found: put {{input.message}} where the question goes in the body below.'}
                {parsed.session_fields.length > 0 && <> A fresh <code>{parsed.session_fields.join(', ')}</code> per question keeps cases from sharing chat history.</>}
                {parsed.looks_streaming && <> It looks like a streaming endpoint.</>}
              </Notice>
              {parsed.secrets.map((s) => <SecretRow key={s.header} secret={s} onStored={(ref) => setCfg((c) => ({ ...c, auth: { header: s.header, prefix: s.prefix, secret_ref: ref } }))} stored={(cfg.auth as { header?: string } | undefined)?.header === s.header} />)}
            </motion.div>
          )}
        </Card>
      )}
      <Card title="Request">
        <div className="grid gap-3 md:grid-cols-[minmax(0,1fr)_minmax(0,1fr)_110px]">
          <Field label="Base URL"><Input value={field('base_url')} onChange={(e) => set('base_url', e.target.value)} /></Field>
          <Field label="Endpoint"><Input value={field('endpoint')} onChange={(e) => set('endpoint', e.target.value)} /></Field>
          <Field label={<span className="inline-flex items-center gap-1.5">Method<MethodHelp /></span>}><Select value={field('method') || 'POST'} onChange={(e) => set('method', e.target.value)} aria-label="Method"><option>POST</option><option>GET</option></Select></Field>
        </div>
        <div className="mt-3">
          <Field label={<LabelHelp label="Body (JSON)" title="Placeholders in the body"><p><code>{'{{input.message}}'}</code> the question, <code>{'{{uuid}}'}</code> a fresh id per call, <code>{'{{input.fields.x}}'}</code> a per-case field.</p></LabelHelp>} error={bodyErr ?? undefined}>
            <Textarea mono rows={7} value={bodyText} spellCheck={false} onChange={(e) => { setBodyText(e.target.value); try { set('body', JSON.parse(e.target.value)); setBodyErr(null) } catch { setBodyErr('Not valid JSON yet') } }} />
          </Field>
        </div>
        {field('method') === 'GET' && Object.keys((cfg.body as object) ?? {}).length > 0 && (
          <p className="mt-2 text-xs text-warn-ink">GET sends no body: the fields above are ignored. Put what the bot needs in the address instead, or switch back to POST.</p>
        )}
        {quotedLiterals(cfg.body).map((w) => (
          <p key={w.path} className="mt-2 text-xs text-warn-ink">
            <code>{w.path}</code> is the <i>text</i> "{w.value}" because of its quotes. If you meant the empty value, write <code>{w.value}</code> without quotes (a bot that expects an id refuses the text "null").
            <button type="button" className="ml-1 text-accent-ink underline" onClick={() => { const fixed = unquote(cfg.body, w.path); set('body', fixed); setBodyText(JSON.stringify(fixed, null, 2)) }}>Remove the quotes</button>
          </p>
        ))}
        {!!cfg.auth && <p className="mt-2 flex items-center gap-1.5 text-xs text-good-ink"><Lock className="size-3.5" />Sends {(cfg.auth as { header: string }).header} from {(cfg.auth as { secret_ref: string }).secret_ref} - the key itself is not in this configuration.</p>}
      </Card>
    </div>
  )
}

function SecretRow({ secret, onStored, stored }: { secret: { header: string; prefix: string; value: string; hint: string }; onStored: (ref: string) => void; stored: boolean }) {
  const [name, setName] = useState(secret.header.toUpperCase().replace(/[^A-Z0-9]+/g, '_').replace(/^_|_$/g, '') === 'AUTHORIZATION' ? 'BOT_API_KEY' : secret.header.toUpperCase().replace(/[^A-Z0-9]+/g, '_'))
  const save = useMutation({ mutationFn: () => api.put<{ ref: string }>(`/api/secrets/${name}`, { value: secret.value }), onSuccess: (r) => onStored(r.ref) })
  return (
    <div className={clsx('flex flex-wrap items-center gap-2 rounded-lg border px-3 py-2', stored ? 'border-good/40 bg-good-wash/40' : 'border-warn/40 bg-warn-wash/50')}>
      <KeyRound className={clsx('size-4', stored ? 'text-good-ink' : 'text-warn-ink')} />
      <span className="text-sm"><span className="font-mono font-semibold">{secret.header}</span> looks like a secret ({secret.hint}).</span>
      {stored ? <span className="ml-auto text-xs text-good-ink">Stored in the OS credential store</span> : (
        <>
          <span className="ml-auto text-xs text-ink-2">Save as</span>
          <Input className="w-40" value={name} onChange={(e) => setName(e.target.value)} aria-label="Secret name" />
          <Button size="sm" variant="primary" loading={save.isPending} onClick={() => save.mutate()}><Lock className="size-3.5" />Store securely</Button>
        </>
      )}
      {save.isError && <div className="w-full"><ErrorState error={save.error} /></div>}
    </div>
  )
}

// --------------------------------------------------------------------------------------
// Step 3: test and map
// --------------------------------------------------------------------------------------

const ROLES: { id: string; label: string; group: string; list?: string; sub?: string; hint: string }[] = [
  { id: 'answer', label: 'Answer', group: 'Answer', hint: 'The text the user sees' },
  { id: 'sources', label: 'Source list', group: 'Sources', hint: 'The list of retrieved documents' },
  { id: 'sources.id', label: 'Source id', group: 'Sources', list: 'sources', sub: 'id', hint: 'Names a document (used for recall, citations)' },
  { id: 'sources.title', label: 'Source title', group: 'Sources', list: 'sources', sub: 'title', hint: 'Optional' },
  { id: 'sources.text', label: 'Source text', group: 'Sources', list: 'sources', sub: 'text', hint: 'Needed for groundedness' },
  { id: 'sources.score', label: 'Source score', group: 'Sources', list: 'sources', sub: 'score', hint: 'Optional' },
  { id: 'citations', label: 'Citations', group: 'Citations', hint: 'Ids of the documents the answer cites' },
  { id: 'tools', label: 'Tool call list', group: 'Tools', hint: 'The list of tool calls' },
  { id: 'tools.name', label: 'Tool name', group: 'Tools', list: 'tools', sub: 'name', hint: '' },
  { id: 'tools.arguments', label: 'Tool arguments', group: 'Tools', list: 'tools', sub: 'arguments', hint: '' },
  { id: 'tools.result', label: 'Tool result', group: 'Tools', list: 'tools', sub: 'result', hint: 'Optional' },
  { id: 'usage.input_tokens', label: 'Input tokens', group: 'Tokens', hint: '' },
  { id: 'usage.output_tokens', label: 'Output tokens', group: 'Tokens', hint: '' },
  { id: 'provider.model', label: 'Model name', group: 'Model', hint: 'For cost estimates' },
]

type Mapping = Record<string, unknown>
const listKey = (l: string) => (l === 'sources' ? 'retrieved_documents' : 'tool_calls')

function getRole(m: Mapping, role: string): string | null {
  const r = ROLES.find((x) => x.id === role)!
  if (role === 'answer') return (m.answer as string) ?? null
  if (role === 'citations') return typeof m.citations === 'string' ? m.citations : (m.citations as { path?: string })?.path ?? null
  if (role === 'sources' || role === 'tools') return ((m[listKey(role)] as { path?: string }) ?? {}).path ?? null
  if (r.list) return ((m[listKey(r.list)] as { each?: Record<string, string> })?.each ?? {})[r.sub!] ?? null
  const [obj, k] = role.split('.')
  return ((m[obj] as Record<string, string>) ?? {})[k] ?? null
}

function setRole(m: Mapping, role: string, path: string | null): Mapping {
  const r = ROLES.find((x) => x.id === role)!
  const out = JSON.parse(JSON.stringify(m)) as Mapping
  if (role === 'answer') { out.answer = path ?? 'answer'; return out }
  if (role === 'citations') { if (path) out.citations = path; else delete out.citations; return out }
  if (role === 'sources' || role === 'tools') {
    const k = listKey(role)
    if (!path) { delete out[k]; return out }
    out[k] = { ...((out[k] as object) ?? {}), path, each: ((out[k] as { each?: object })?.each) ?? (role === 'sources' ? { id: 'id' } : { name: 'name', arguments: 'arguments' }) }
    return out
  }
  if (r.list) {
    const k = listKey(r.list)
    const cur = (out[k] as { path: string; each: Record<string, string> }) ?? { path: r.list, each: {} }
    const each = { ...cur.each }
    if (path) each[r.sub!] = path; else delete each[r.sub!]
    out[k] = { ...cur, each }
    return out
  }
  const [obj, key] = role.split('.')
  const o = { ...((out[obj] as Record<string, string>) ?? {}) }
  if (path) o[key] = path; else delete o[key]
  if (Object.keys(o).length) out[obj] = o; else delete out[obj]
  return out
}

function marksFor(m: Mapping): Record<string, string> {
  const marks: Record<string, string> = {}
  for (const r of ROLES) {
    const p = getRole(m, r.id)
    if (!p) continue
    const first = p.split('|')[0].replace(/\.\*\./g, '.0.').replace(/\[(\d+)\]/g, '.$1')
    if (r.list) {
      const lp = getRole(m, r.list)
      if (lp) marks[`${lp.split('|')[0].replace(/\.\*\./g, '.0.')}.0.${first}`] = r.label
    } else marks[first] = r.label
  }
  return marks
}

function StepMap(props: {
  adapter: 'http' | 'python'; cfg: Cfg; setCfg: (f: (c: Cfg) => Cfg) => void; standard: boolean; setStandard: (v: boolean) => void
  message: string; setMessage: (v: string) => void; probe: Probe | null; runProbe: () => void; probing: boolean
  test: TestResult | null; runTest: () => void; testing: boolean; probeError?: unknown; testError?: unknown
  picking: string | null; setPicking: (p: string | null) => void; pickError: string | null; setPickError: (e: string | null) => void
}) {
  const { adapter, cfg, setCfg, standard, setStandard, message, setMessage, probe, runProbe, probing, test, runTest, testing, probeError, testError, picking, setPicking, pickError, setPickError } = props
  const mapping = (cfg.response ?? {}) as Mapping
  const isStream = probe?.kind === 'sse' || probe?.kind === 'ndjson'
  const raw = probe?.kind === 'json' ? probe.json : probe?.kind === 'text' ? probe.text : isStream ? probe?.collected : undefined
  const onPick = (path: string, value: unknown) => {
    if (!picking) return
    const r = ROLES.find((x) => x.id === picking)!
    let p = path
    if (picking === 'sources' || picking === 'tools') {
      const m = path.match(/^(.*?)(?:\.\d+)(?:\..*)?$/)
      if (!Array.isArray(value) && m) p = m[1]
      else if (!Array.isArray(value)) { setPickError('Pick the list itself (the node marked [n]).'); return }
    } else if (r.list) {
      const lp = getRole(mapping, r.list)
      if (!lp) { setPickError(`Pick the ${r.list === 'sources' ? 'source' : 'tool call'} list first.`); return }
      const prefix = `${lp.replace(/\.\*\./g, '.0.')}.0.`
      if (!path.startsWith(prefix)) { setPickError(`Pick a field inside one item of ${lp}.`); return }
      p = path.slice(prefix.length)
    }
    setCfg((c) => ({ ...c, response: setRole((c.response ?? {}) as Mapping, picking, p) }))
    setPicking(null)
  }
  const reasons = probe?.suggestion?.reasons ?? {}
  return (
    <div className="space-y-5">
      <Card title="Send a test question" help={<p>Sends one question with the request so far and shows the raw reply. With the Assay shape off, map the reply below by clicking it.</p>}>
        <div className="flex gap-2">
          <Input value={message} onChange={(e) => setMessage(e.target.value)} aria-label="Test question" />
          <Button variant="primary" loading={probing} onClick={runProbe}><Send className="size-3.5" />Send</Button>
        </div>
        {!!probeError && <div className="mt-3"><ErrorState error={probeError} /></div>}
        {probe && !probe.ok && <div className="mt-3"><Notice tone="bad" title={probe.explanation ?? 'The request failed'}><span className="font-mono text-xs">{probe.error}</span></Notice></div>}
        {probe?.ok && <p className="num mt-2 text-xs text-good-ink">Reply received{probe.status ? ` (HTTP ${probe.status}` : ''}{probe.elapsed_ms ? `, ${ms(probe.elapsed_ms)})` : ')'}{isStream ? `: a stream of ${plural(probe.events?.length ?? 0, 'event type')}` : ''}.</p>}
      </Card>

      {probe?.ok && adapter === 'http' && standard && probe.suggestion && (
        probe.suggestion.standard.matches
          ? <Notice tone="good" title="The reply is in the Assay shape - nothing to map">Found: {probe.suggestion.standard.present.join(', ')}.{probe.suggestion.standard.missing.length > 0 && <> Not in this reply: {probe.suggestion.standard.missing.join(', ')}.</>}</Notice>
          : <Notice tone="warn" title="This reply is not in the Assay shape" action={<Button size="sm" onClick={() => { setStandard(false); setCfg((c) => ({ ...c, response: probe.suggestion!.mapping })) }}>Map it instead</Button>}>
              {probe.suggestion.standard.problems.concat(probe.suggestion.standard.missing.includes('answer') ? ['There is no top-level "answer" string.'] : []).join(' ')} Turn the switch off and map the reply by clicking it.
            </Notice>
      )}

      {probe?.ok && adapter === 'http' && !standard && raw !== undefined && (
        <div className="grid gap-5 lg:grid-cols-[minmax(0,1fr)_340px]">
          <Card title={isStream ? 'The reply, with the stream folded into one' : 'The reply'} help={<p>Pick a role on the right, then click the node in the reply where it is. Nodes already mapped carry their role's label.</p>}>
            <AnimatePresence>{picking && <motion.div initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }} className="mb-2 flex items-center gap-2 text-xs text-accent-ink"><MousePointerClick className="size-3.5" />Picking <span className="font-semibold">{ROLES.find((r) => r.id === picking)?.label}</span>: click its node<Button size="sm" variant="ghost" onClick={() => setPicking(null)}>Cancel</Button></motion.div>}</AnimatePresence>
            {pickError && <p className="mb-2 text-xs text-bad-ink">{pickError}</p>}
            <JsonTree data={raw} onPick={onPick} marks={marksFor(mapping)} picking={!!picking} />
          </Card>
          <Card title="Where is each thing?" boxed help={<p>Assay guessed from the reply; confirm or fix. A green dot is mapped. Hover a path to see why it was guessed.</p>}>
            <ul className="space-y-1">
              {ROLES.map((r, i) => {
                const p = getRole(mapping, r.id)
                const prevGroup = i > 0 ? ROLES[i - 1].group : null
                return (
                  <li key={r.id}>
                    {r.group !== prevGroup && <div className="t-label mt-2">{r.group}</div>}
                    <div className={clsx('flex items-center gap-2 rounded-md px-2 py-1', picking === r.id && 'bg-accent-wash')}>
                      <span className={clsx('size-1.5 shrink-0 rounded-full', p ? 'bg-good' : 'bg-untested')} />
                      <span className="min-w-0 flex-1">
                        <span className="text-sm">{r.label}</span>
                        <span className={clsx('block truncate text-xs text-ink-3', p && 'font-mono')} title={reasons[r.id === 'sources' ? 'retrieved_documents' : r.id === 'tools' ? 'tool_calls' : r.id] ?? ''}>{p ?? (r.hint || 'not mapped')}</span>
                      </span>
                      <Button size="sm" variant={picking === r.id ? 'primary' : 'ghost'} onClick={() => setPicking(picking === r.id ? null : r.id)}>{p ? 'Change' : 'Pick'}</Button>
                      {p && r.id !== 'answer' && <button type="button" aria-label={`Clear ${r.label}`} className="text-ink-3 hover:text-bad-ink" onClick={() => setCfg((c) => ({ ...c, response: setRole((c.response ?? {}) as Mapping, r.id, null) }))}><X className="size-3.5" /></button>}
                    </div>
                  </li>
                )
              })}
            </ul>
          </Card>
        </div>
      )}

      {probe?.ok && isStream && (
        <Card title="Streamed reply" help={<>
          <p>Event types seen in the stream and how each is folded into one reply.</p>
          <p>Text pieces ("deltas") are joined into the answer; other events are kept by name so the mapping can read them. Edit the details in Advanced (JSON).</p>
        </>}>
          <ul className="space-y-1.5">
            {probe.events?.map((e) => {
              const rule = ((cfg.stream as { events?: Record<string, { op?: string; path?: string; into?: string }> })?.events ?? {})[e.type]
              return (
                <li key={e.type} className="grid grid-cols-[120px_60px_minmax(0,1fr)_minmax(0,1fr)] items-center gap-2 text-xs">
                  <code className="font-medium">{e.type}</code><span className="num font-mono text-ink-3">×{e.count}</span>
                  <span className="truncate font-mono text-ink-3">{JSON.stringify(e.sample).slice(0, 80)}</span>
                  <span>{rule ? <>{rule.op === 'concat' ? 'append text' : rule.op ?? 'keep'} <code>{rule.path}</code> → <code>{rule.into}</code></> : <span className="text-ink-3">ignored</span>}</span>
                </li>
              )
            })}
          </ul>
        </Card>
      )}

      {probe?.ok && (
        <Card title="What Assay will see" help={<p>Runs the whole connection (request and mapping) and shows the result as Assay reads it, and which checks that makes possible.</p>} actions={<Button variant="primary" loading={testing} onClick={runTest}><Check className="size-3.5" />Check the mapping</Button>}>
          {!!testError && <div className="mb-3"><ErrorState error={testError} /></div>}
          {!test ? <p className="text-sm text-ink-2">Not checked yet: press Check the mapping.</p> : !test.ok ? (
            <Notice tone="bad" title={test.explanation ?? test.error ?? 'No answer'}>{test.error}</Notice>
          ) : (
            <div className="grid gap-4 lg:grid-cols-2">
              <div className="space-y-2 text-sm">
                <div className="t-label">Answer · <span className="font-mono normal-case">{ms(test.elapsed_ms)}</span></div>
                <div className="line-clamp-6 rounded-lg border border-line bg-surface-2/50 px-3 py-2">{test.normalized?.answer}</div>
                {test.normalized?.retrieved_documents && <div className="text-xs text-ink-2">{plural(test.normalized.retrieved_documents.length, 'source')}: {test.normalized.retrieved_documents.slice(0, 5).map((d) => <code key={d.id} className="mr-1">{d.id}</code>)}</div>}
                {test.normalized?.tool_calls && <div className="text-xs text-ink-2">{plural(test.normalized.tool_calls.length, 'tool call')}: {test.normalized.tool_calls.map((t, i) => <code key={i} className="mr-1">{t.name}</code>)}</div>}
              </div>
              <Capabilities caps={test.capabilities ?? []} />
            </div>
          )}
        </Card>
      )}
    </div>
  )
}

export function Capabilities({ caps }: { caps: Capability[] }) {
  return (
    <div>
      <div className="t-label mb-1.5">What you'll get</div>
      <ul className="space-y-1.5">
        {caps.map((c, i) => (
          <motion.li key={c.field} initial={{ opacity: 0, x: 6 }} animate={{ opacity: 1, x: 0 }} transition={{ delay: i * 0.05 }} className="flex items-start gap-2 text-sm">
            {c.received ? <Check className="mt-0.5 size-4 shrink-0 text-good-ink" /> : c.mapped ? <CircleAlert className="mt-0.5 size-4 shrink-0 text-warn-ink" /> : <X className="mt-0.5 size-4 shrink-0 text-ink-3" />}
            <span>
              <span className={clsx(c.received ? 'font-semibold text-ink' : 'font-medium text-ink-2')}>{c.label}</span>{c.count !== null && c.received ? <span className="font-mono"> ({c.count})</span> : ''}
              <span className="block text-xs text-ink-2">{c.received ? `→ ${c.unlocks}` : c.mapped ? `Mapped, but empty in this reply - ${c.unlocks} may show "not evaluated"` : `Not mapped: ${c.unlocks} won't run`}</span>
            </span>
          </motion.li>
        ))}
      </ul>
    </div>
  )
}

// --------------------------------------------------------------------------------------
// Step 4: safety and save
// --------------------------------------------------------------------------------------

interface DryCall { question: string; ok: boolean; elapsed_ms?: number; answer?: string; error?: string; explanation?: string; cost_usd?: number | null; cleanup?: string }
interface DryResult {
  calls: DryCall[]; median_ms: number | null; per_answer_cost_usd: number | null
  full_run_calls: number; full_run_seconds: number | null; full_run_cost_usd: number | null
  load?: { alone_ms: number | null; together_ms: number | null; n: number; ratio: number | null; errors: number; verdict: 'copes' | 'slows' | 'queues' | 'errors' | 'unknown'; suggested_concurrency: number }
}

const LOAD_TEXT: Record<string, string> = {
  copes: 'barely slows down when several questions arrive together: 4 at a time is fine.',
  slows: 'slows down noticeably when busy: use 2 at a time, and 1 when you compare speed.',
  queues: 'answers one at a time (the others wait): use 1 at a time; more only makes speed figures worse.',
  errors: 'returned errors when asked several at once: use 1 at a time.',
  unknown: 'could not be measured.',
}

const dur = (msTotal: number) => {
  const s = Math.round(msTotal / 1000)
  return s < 60 ? `~${Math.max(1, s)} s` : s < 3600 ? `~${Math.round(s / 60)} min` : `~${(s / 3600).toFixed(1)} h`
}

function StepSave({ adapter, cfg, setCfg, projects, editing, onSaved, reply, testMs }: {
  adapter: 'http' | 'python'; cfg: Cfg; setCfg: (f: (c: Cfg) => Cfg) => void; projects: Project[]; editing: Target | null; onSaved: (id: number) => void
  reply: unknown; testMs: number | null
}) {
  const datasets = useQuery({ queryKey: ['datasets'], queryFn: () => api.get<Dataset[]>('/api/datasets') })
  const realProjects = projects.filter((p) => !p.is_demo)
  const [projectMode, setProjectMode] = useState<'existing' | 'new'>(editing || realProjects.length ? 'existing' : 'new')
  const [projectId, setProjectId] = useState<number | ''>(editing?.project_id ?? realProjects[0]?.id ?? '')
  const [newProject, setNewProject] = useState('')
  const [name, setName] = useState(editing?.name ?? '')
  const [label, setLabel] = useState(editing?.latest_version.variant_label ?? '')
  const [notes, setNotes] = useState('')
  const [asTemplate, setAsTemplate] = useState(false)
  const [savesChats, setSavesChats] = useState(!!cfg.cleanup)
  const chosenProject = projectMode === 'existing' ? projectId : ''
  const projectName = projectMode === 'existing' ? projects.find((p) => p.id === projectId)?.name ?? '' : newProject

  // Clean-up: read the chat id from where the reply actually has it.
  const idPath = findChatId(reply)
  const suggested = { method: 'DELETE', endpoint: `/api/conversations/{{raw.${idPath ?? 'conversation_id'}}}`, only_if: idPath ?? 'conversation_id' }
  const cleanup = (cfg.cleanup as { method?: string; endpoint?: string; only_if?: string } | undefined) ?? suggested
  const setCleanup = (on: boolean) => {
    setSavesChats(on)
    if (adapter !== 'http') return
    setCfg((c) => {
      if (on && !c.cleanup) return { ...c, cleanup: suggested }
      if (!on && c.cleanup) { const { cleanup: _x, ...rest } = c; return rest }
      return c
    })
  }
  const mismatch = savesChats && !!idPath && !!cleanup.only_if && cleanup.only_if !== idPath && !cleanup.endpoint?.includes(idPath)

  // Dry run: where the questions come from.
  const own = (datasets.data ?? []).filter((d) => d.project_id === chosenProject)
  const others = (datasets.data ?? []).filter((d) => d.project_id !== chosenProject)
  const [source, setSource] = useState<string>('')
  const [showOthers, setShowOthers] = useState(false)
  const [typed, setTyped] = useState(['', '', ''])
  const [loadCheck, setLoadCheck] = useState(false)
  const src = source || (own[0]?.latest ? `dsv:${own[0].latest.id}` : 'typed')
  const dsvId = src.startsWith('dsv:') ? Number(src.slice(4)) : null
  const pickedSet = (datasets.data ?? []).find((d) => d.versions.some((v) => v.id === dsvId))
  const foreign = pickedSet && pickedSet.project_id !== chosenProject ? pickedSet : null
  const foreignOwner = foreign ? projects.find((p) => p.id === foreign.project_id)?.name ?? 'another chatbot' : null
  const typedQs = typed.map((q) => q.trim()).filter(Boolean)
  const dry = useMutation({
    mutationFn: () => api.post<DryResult>('/api/connect/dry-run', {
      adapter, config: cfg, n: 3, load_check: loadCheck,
      dataset_version_id: dsvId, questions: src === 'typed' ? typedQs : null,
    }),
  })
  const perMs = src === 'test' ? testMs : dry.data?.median_ms ?? null
  const perCost = src === 'test' ? null : dry.data?.per_answer_cost_usd ?? null
  const asked = src === 'test' ? 0 : src === 'typed' ? typedQs.length : 3
  const canAsk = src !== 'test' && (src !== 'typed' || typedQs.length > 0)

  const save = useMutation({
    mutationFn: async () => {
      let t: Target
      if (editing) {
        t = await api.put<Target>(`/api/targets/${editing.id}`, { config: cfg, variant_label: label, notes })
      } else {
        let pid = projectMode === 'existing' ? projectId : ''
        if (!pid) pid = (await api.post<Project>('/api/projects', { name: newProject || name || 'My chatbot' })).id
        t = await api.post<Target>('/api/targets', { project_id: pid, name, adapter, config: cfg, variant_label: label })
      }
      if (asTemplate) await api.post('/api/connector-templates', { name: name || 'My connection', adapter, config: cfg, description: label })
      try { await api.post(`/api/targets/${t.id}/check`) } catch (e) { toast(`Saved, but the first check failed: ${e instanceof Error ? e.message : 'no answer'}`, 'bad') }
      return t
    },
    onSuccess: (t) => onSaved(t.id),
  })
  const saveWhy = editing ? null
    : projectMode === 'existing' && !projectId ? 'Choose the chatbot first (top of this step).'
    : projectMode === 'new' && !newProject.trim() ? 'Name the new chatbot first (top of this step).'
    : !name.trim() ? 'Name this connection first.' : null
  const initials = projectName ? projectName.split(/\s+/).map((w) => w[0]).join('').toUpperCase().slice(0, 4) : 'Bot'

  return (
    <div className="space-y-5">
      {!editing && (
        <Card title="Which chatbot is this?" help={<p>Decides which question sets are offered below and where its runs appear.</p>}>
          <div className="flex flex-wrap items-center gap-2">
            <Segmented size="sm" value={projectMode} onChange={setProjectMode} options={[{ id: 'existing', label: 'Existing' }, { id: 'new', label: 'New' }]} />
            {projectMode === 'existing'
              ? (
                <Select className="w-80" value={projectId} onChange={(e) => { setProjectId(Number(e.target.value)); setSource('') }} aria-label="Chatbot">
                  {!projectId && <option value="">Choose a chatbot...</option>}
                  {projects.map((p) => <option key={p.id} value={p.id}>{projectOption(p)}</option>)}
                </Select>
              )
              : <Input className="w-80" placeholder="e.g. Production Planning Assistant" value={newProject} onChange={(e) => setNewProject(e.target.value)} aria-label="New chatbot name" />}
            <ConnectionHelp />
          </div>
        </Card>
      )}
      {adapter === 'http' && (
        <Card title="Side effects" help={<p>Also check what else a question writes (usage tables, shared logs, budgets) before pointing Assay at a shared instance. When that is not acceptable, use an isolated copy or import logs instead.</p>}>
          <Toggle checked={savesChats} onChange={setCleanup}
            label={<LabelHelp label="Each question saves a conversation in the bot" title="Clean-up"><p>Then Assay deletes it right after the answer, so test runs do not pile up in the bot's history.</p></LabelHelp>} />
          {!savesChats && idPath && (
            <div className="mt-3">
              <Notice tone="info" title={<>The reply carries a chat id (<code>{idPath}</code>)</>} action={<Button size="sm" onClick={() => setCleanup(true)}>Clean up after each question</Button>}>
                The bot probably saves every question as a conversation. Without clean-up, test chats pile up in its history.
              </Notice>
            </div>
          )}
          {savesChats && (
            <div className="mt-3 grid gap-3 md:grid-cols-[120px_minmax(0,1fr)_220px]">
              <Field label={<span className="inline-flex items-center gap-1.5">Method<CleanupMethodHelp /></span>}>
                <Select value={cleanup.method} aria-label="Clean-up method" onChange={(e) => setCfg((c) => ({ ...c, cleanup: { ...cleanup, method: e.target.value } }))}><option>DELETE</option><option>POST</option></Select>
              </Field>
              <Field label={<LabelHelp label="Clean-up endpoint"><p><code>{'{{raw.x}}'}</code> reads a field of the reply.</p></LabelHelp>} hint={idPath ? <>Chat id at <code>{idPath}</code></> : undefined}>
                <Input aria-label="Clean-up endpoint" value={cleanup.endpoint} onChange={(e) => setCfg((c) => ({ ...c, cleanup: { ...cleanup, endpoint: e.target.value } }))} />
              </Field>
              <Field label="Only if the reply has">
                <Input aria-label="Clean-up only if" value={cleanup.only_if ?? ''} onChange={(e) => setCfg((c) => ({ ...c, cleanup: { ...cleanup, only_if: e.target.value || undefined } }))} />
              </Field>
            </div>
          )}
          {mismatch && (
            <div className="mt-3">
              <Notice tone="warn" title="The clean-up looks for the chat id in the wrong place" action={<Button size="sm" onClick={() => setCfg((c) => ({ ...c, cleanup: { ...cleanup, endpoint: suggested.endpoint, only_if: idPath ?? undefined } }))}>Use {idPath}</Button>}>
                It reads <code>{cleanup.only_if}</code>, but this bot's reply has the id at <code>{idPath}</code>: the delete would be skipped silently.
              </Notice>
            </div>
          )}
        </Card>
      )}
      <Card title="Dry run" help={<>
        <p>Speed (and cost, when the bot reports it) before a full run. Ask a few questions, optionally all at once too, to see how the bot copes when busy.</p>
        <p>Tries multiply everything: 3 tries per question = 3× the answers. Grading-model calls are extra (shown on New run).</p>
      </>}>
        <div className="flex flex-wrap items-end gap-2">
          <Field label="Questions from">
            <Select className="w-80" value={src} onChange={(e) => setSource(e.target.value)} aria-label="Dry-run questions">
              {own.length > 0 && (
                <optgroup label={`${projectName || 'This chatbot'}'s question sets`}>
                  {own.map((d) => d.latest && <option key={d.latest.id} value={`dsv:${d.latest.id}`}>{d.name} v{d.latest.version} ({d.latest.case_count} questions)</option>)}
                </optgroup>
              )}
              <optgroup label="Other">
                <option value="typed">Type my own questions</option>
                <option value="generic">Three generic questions</option>
                {testMs !== null && <option value="test">Use the test answer's timing (no extra cost)</option>}
              </optgroup>
              {showOthers && others.length > 0 && (
                <optgroup label="Written for other chatbots">
                  {others.map((d) => d.latest && <option key={d.latest.id} value={`dsv:${d.latest.id}`}>{d.name} v{d.latest.version} - {projects.find((p) => p.id === d.project_id)?.name ?? 'another chatbot'}</option>)}
                </optgroup>
              )}
            </Select>
          </Field>
          {canAsk && <Button loading={dry.isPending} onClick={() => dry.mutate()}><Send className="size-3.5" />Ask {asked} question{asked === 1 ? '' : 's'}{loadCheck ? `, then ${asked} at once` : ''}</Button>}
        </div>
        {others.length > 0 && (
          <label className="mt-2 flex items-center gap-2 text-xs text-ink-2">
            <input type="checkbox" className="accent-[var(--accent)]" checked={showOthers} onChange={(e) => setShowOthers(e.target.checked)} />Also list question sets written for other chatbots ({others.length})
          </label>
        )}
        {src === 'typed' && (
          <div className="mt-3 grid gap-2 md:grid-cols-3">
            {typed.map((q, i) => <Input key={i} value={q} placeholder={i === 0 ? 'A question users really ask' : 'Another (optional)'} aria-label={`Dry-run question ${i + 1}`} onChange={(e) => setTyped((t) => t.map((x, k) => (k === i ? e.target.value : x)))} />)}
          </div>
        )}
        {foreign && (
          <div className="mt-3">
            <Notice tone="warn" title={`These questions were written for ${foreignOwner}`}>
              {projectName || 'This chatbot'} will be answering off-topic questions, and each answer may be billed by the bot. Type your own instead, or pick one of its own sets.
            </Notice>
          </div>
        )}
        {src !== 'test' && asked > 0 && (
          <label className="mt-2 flex items-center gap-2 text-xs text-ink-2">
            <input type="checkbox" className="accent-[var(--accent)]" checked={loadCheck} onChange={(e) => setLoadCheck(e.target.checked)} />
            Also check how it copes when busy: ask the same questions again, all at once ({asked} more answer{asked === 1 ? '' : 's'})
          </label>
        )}
        {src === 'test' && <p className="mt-2 text-xs text-ink-2">No new questions: the estimate below uses the <span className="font-mono">{ms(testMs)}</span> the test question took. One answer is a rough guide; three are steadier.</p>}
        {dry.isError && <div className="mt-2"><ErrorState error={dry.error} /></div>}
        {dry.data && src !== 'test' && (
          <div className="mt-3 space-y-2">
            {dry.data.calls.map((c, i) => (
              <div key={i} className="flex items-start gap-2 text-sm">
                {c.ok ? <Check className="mt-0.5 size-4 text-good-ink" /> : <X className="mt-0.5 size-4 text-bad-ink" />}
                <span className="min-w-0 flex-1"><span className="text-ink-2">{c.question}</span><span className="block truncate text-xs text-ink-3">{c.ok ? c.answer : c.explanation ?? c.error}</span></span>
                <span className="num font-mono text-xs text-ink-3">{ms(c.elapsed_ms)}{c.cleanup && ` - clean-up ${c.cleanup}`}</span>
              </div>
            ))}
            {dry.data.load && (
              <Notice tone={dry.data.load.verdict === 'copes' ? 'good' : dry.data.load.verdict === 'unknown' ? 'info' : 'warn'}
                title={`Alone: ${ms(dry.data.load.alone_ms)} per answer. ${dry.data.load.n} at once: ${ms(dry.data.load.together_ms)}${dry.data.load.ratio ? ` (x${dry.data.load.ratio})` : ''}${dry.data.load.errors ? `, ${plural(dry.data.load.errors, 'error')}` : ''}.`}>
                This bot {LOAD_TEXT[dry.data.load.verdict]} Suggested <span className="font-semibold">In parallel: <span className="font-mono">{dry.data.load.suggested_concurrency}</span></span>.
              </Notice>
            )}
          </div>
        )}
        {perMs !== null && perMs !== undefined && (src === 'test' || dry.data) && (
          <div className="mt-3">
            <div className="mb-1 text-xs font-medium text-ink-2">
              What a full run would take{perCost === null ? '. The bot reports no token counts, so its price is unknown: count the billed answers.' : ''}
            </div>
            <Table>
              <thead><tr><th className="t-label">Question set</th><th className="t-label text-right">Answers (1 try)</th><th className="t-label text-right">Time at 1 / 4 in parallel</th><th className="t-label text-right">Bot cost</th></tr></thead>
              <tbody>
                {[...own.map((d) => ({ key: d.id, label: d.name, n: d.latest?.case_count ?? 0 })), { key: 0, label: 'Per 10 questions', n: 10 }].map((r) => (
                  <tr key={r.key}>
                    <td>{r.label}</td>
                    <td className="num text-right"><span className="font-mono">{r.n}</span> billed</td>
                    <td className="num text-right font-mono">{dur(r.n * perMs)} / {dur((r.n * perMs) / 4)}</td>
                    <td className="num text-right">{perCost !== null ? <span className="font-mono">{usd(perCost * r.n)}</span> : 'unknown'}</td>
                  </tr>
                ))}
              </tbody>
            </Table>
          </div>
        )}
      </Card>
      <Card title={editing ? `Save as version ${editing.latest_version.version + 1}` : 'Name and save'} boxed>
        <div className="grid gap-3 md:grid-cols-2">
          {!editing && (
            <Field label={<span className="inline-flex items-center gap-1.5">Name this connection<ConnectionHelp /></span>}>
              <Input aria-label="Connection name" placeholder={`e.g. ${initials} – local dev (:8120)`} value={name} onChange={(e) => setName(e.target.value)} />
            </Field>
          )}
          <Field label={<LabelHelp label="What's inside this version"><p>Model, prompt, retriever. Say what it is ("gpt-6-sol answer, high effort"), not just "v1": in six months it still tells you what changed.</p></LabelHelp>}>
            <Input aria-label="Version description" placeholder="e.g. gpt-x answer / hybrid top-20 / prompt v3" value={label} onChange={(e) => setLabel(e.target.value)} />
          </Field>
          {editing && <Field label="What changed"><Input value={notes} onChange={(e) => setNotes(e.target.value)} /></Field>}
        </div>
        <label className="mt-3 flex items-center gap-2 text-sm"><input type="checkbox" className="accent-[var(--accent)]" checked={asTemplate} onChange={(e) => setAsTemplate(e.target.checked)} />Also save as a template for connecting similar bots</label>
        {save.isError && <div className="mt-3"><ErrorState error={save.error} /></div>}
        <div className="mt-4 flex flex-wrap items-center gap-3">
          <Button variant="primary" size="lg" loading={save.isPending} disabled={!!saveWhy} onClick={() => save.mutate()}>
            <Check className="size-4" />{editing ? `Save version ${editing.latest_version.version + 1}` : 'Save connection'}
          </Button>
          {saveWhy && <span className="text-xs text-ink-2">{saveWhy}</span>}
        </div>
      </Card>
    </div>
  )
}

function AdvancedPanel({ adapter, cfg, setCfg }: { adapter: string; cfg: Cfg; setCfg: (f: (c: Cfg) => Cfg) => void }) {
  const [draft, setDraft] = useState<string | null>(null) // what you are typing; null = show the live config
  const [err, setErr] = useState<string | null>(null)
  const text = draft ?? JSON.stringify(cfg, null, 2)
  return (
    <div className="xl:sticky xl:top-16 xl:self-start">
      <Card title="Configuration" boxed meta={adapter} help={<>
        <p>The record of this connection. Edits here update the steps, and the other way round.</p>
        <p>Same format as YAML experiment files and <code>local/targets/*.yaml</code>.</p>
      </>}>
        <Textarea mono rows={26} value={text} spellCheck={false} onBlur={() => setDraft(null)}
          onChange={(e) => { setDraft(e.target.value); try { const v = JSON.parse(e.target.value); setCfg(() => v); setErr(null) } catch { setErr('Not valid JSON yet - the steps keep the last valid version.') } }} />
        {err && <p className="mt-1 text-xs text-warn-ink">{err}</p>}
      </Card>
    </div>
  )
}

// --------------------------------------------------------------------------------------
// Logs import: drop a file, preview, map columns by picking
// --------------------------------------------------------------------------------------

function LogsImport({ projects, onDone }: { projects: Project[]; onDone: (targetId: number) => void }) {
  const [file, setFile] = useState<File | null>(null)
  const [name, setName] = useState('Production log')
  const [projectId, setProjectId] = useState<number | ''>(projects[0]?.id ?? '')
  const [roles, setRoles] = useState<Record<string, string>>({})
  const preview = useMutation({
    mutationFn: (f: File) => { const fd = new FormData(); fd.append('file', f); return api.upload<{ rows: Record<string, unknown>[]; columns: { name: string; type: string; sample: unknown }[]; guess: Record<string, string>; bad_lines: number; approx_lines: number | null }>('/api/imports/preview', fd) },
    onSuccess: (p) => setRoles(p.guess),
  })
  const imp = useMutation({
    mutationFn: async () => {
      const response: Record<string, unknown> = { answer: roles.answer ?? 'answer' }
      if (roles.sources) response.retrieved_documents = { path: roles.sources, each: { id: roles.source_id || 'id|doc_id|source', text: roles.source_text || 'text|content' } }
      const config: Record<string, unknown> = { case_id: roles.case_id ?? 'id', message: roles.message ?? 'question', response, skip_invalid_lines: true }
      if (roles.category) config.category = roles.category
      if (roles.latency_ms) config.latency_ms = roles.latency_ms
      if (roles.latency_s) config.latency_s = roles.latency_s
      const fd = new FormData()
      fd.append('project_id', String(projectId || projects[0]?.id || 1))
      fd.append('name', name)
      fd.append('config', JSON.stringify(config))
      fd.append('file', file!)
      return api.upload<{ target_id?: number; target?: { id: number } }>('/api/imports', fd)
    },
    onSuccess: (r) => onDone(r.target_id ?? r.target?.id ?? 0),
  })
  const cols = preview.data?.columns ?? []
  const ROLE_LIST: [string, string][] = [['case_id', 'Id'], ['message', 'Question'], ['answer', 'Answer'], ['sources', 'Sources (list)'], ['category', 'Category'], ['latency_ms', 'Latency (ms)'], ['latency_s', 'Latency (s)']]
  return (
    <Card title="Import past answers" help={<>
      <p>Drop a log of past questions and answers (.jsonl, .json or .csv), then say which column is which.</p>
      <p>Creates a dataset of the logged questions and a "replay" connection that answers with what was logged: graded without calling the bot.</p>
    </>}>
      <label className={clsx('flex cursor-pointer flex-col items-center justify-center gap-2 rounded-xl border-2 border-dashed p-8 text-sm transition-colors', file ? 'border-good/50 bg-good-wash/30' : 'border-line-strong hover:border-accent')}
        onDragOver={(e) => e.preventDefault()} onDrop={(e) => { e.preventDefault(); const f = e.dataTransfer.files[0]; if (f) { setFile(f); preview.mutate(f) } }}>
        <FileUp className="size-6 text-ink-3" />
        {file ? <span><span className="font-mono font-medium">{file.name}</span> · <span className="font-mono">{Math.round(file.size / 1024)}</span> KB</span> : <span>Drop a <span className="font-mono">.jsonl</span>, <span className="font-mono">.json</span> or <span className="font-mono">.csv</span> file, or click to choose</span>}
        <input type="file" accept=".jsonl,.json,.csv,.ndjson" className="sr-only" onChange={(e) => { const f = e.target.files?.[0]; if (f) { setFile(f); preview.mutate(f) } }} />
      </label>
      {preview.isError && <div className="mt-3"><ErrorState error={preview.error} /></div>}
      {preview.data && (
        <div className="mt-4 space-y-4">
          <div className="grid gap-2 sm:grid-cols-2 lg:grid-cols-4">
            {ROLE_LIST.map(([k, l]) => (
              <Field key={k} label={l}>
                <Select value={roles[k] ?? ''} onChange={(e) => setRoles((r) => ({ ...r, [k]: e.target.value }))}>
                  <option value="">-</option>{cols.map((c) => <option key={c.name} value={c.name}>{c.name}</option>)}
                </Select>
              </Field>
            ))}
          </div>
          <div className="scroll-thin max-h-72 overflow-auto rounded-lg border border-line">
            <table className="w-full text-xs">
              <thead className="sticky top-0 bg-surface-2"><tr>{cols.slice(0, 8).map((c) => <th key={c.name} className={clsx('px-2 py-1 text-left font-medium', Object.values(roles).includes(c.name) && 'text-accent-ink')}>{c.name}</th>)}</tr></thead>
              <tbody>{preview.data.rows.slice(0, 10).map((r, i) => <tr key={i} className="border-t border-line">{cols.slice(0, 8).map((c) => <td key={c.name} className="max-w-48 truncate px-2 py-1">{typeof r[c.name] === 'object' ? JSON.stringify(r[c.name]) : String(r[c.name] ?? '')}</td>)}</tr>)}</tbody>
            </table>
          </div>
          {preview.data.bad_lines > 0 && <p className="text-xs text-warn-ink">{plural(preview.data.bad_lines, 'unreadable line')} will be skipped.</p>}
          <div className="grid gap-3 md:grid-cols-2">
            <Field label="Chatbot"><Select value={projectId} onChange={(e) => setProjectId(Number(e.target.value))}>{projects.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}</Select></Field>
            <Field label="Name"><Input value={name} onChange={(e) => setName(e.target.value)} /></Field>
          </div>
          {imp.isError && <ErrorState error={imp.error} />}
          <Button variant="primary" loading={imp.isPending} disabled={!roles.message} onClick={() => imp.mutate()}><FileUp className="size-3.5" />Import</Button>

        </div>
      )}
    </Card>
  ) as ReactNode
}

// Re-exported for the target page's test panel.
export { Json }
