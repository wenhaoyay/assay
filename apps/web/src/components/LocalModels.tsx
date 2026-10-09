// Run a grading model on this PC with Ollama: install (external site), is it running, which
// model fits this machine, download after the third-party notice, connect, then calibrate.
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import clsx from 'clsx'
import { BookOpen, Check, Cloud, Download, ExternalLink, RefreshCw } from 'lucide-react'
import { useState } from 'react'
import { api } from '../lib/api'
import { fmtDay } from '../lib/format'
import { useSettings } from '../lib/projects'
import type { ProviderConfig } from '../lib/types'
import { Checkbox, TextLink } from './form'
import { ScrollTable } from './Layout'
import { Badge, Button, Card, Dialog, ErrorState, Help, Notice, Panel, ProgressBar } from './ui'

const OLLAMA_URL = 'https://ollama.com/download'
// TextLink's props do not list target/rel (they reach the anchor through the rest spread).

interface Status { running: boolean; version?: string; models: { name: string; size_gb: number; cloud: boolean }[]; base_url: string; error?: string }
interface Advice {
  memory: { total_gb: number | null; free_gb: number | null }
  gpu: string | null
  cpu_count: number | null
  recommended: string | null
  suggestions: { model: string; size_gb: number; needs_gb: number; seconds_per_check: number; fits: boolean; note: string }[]
}
interface Pull { model: string; status: string; completed: number; total: number | null; done: boolean; error: string | null }

/** The third-party notice, shown before the first download and in the guide. */
export function ThirdPartyNotice() {
  return (
    <div className="space-y-1.5 text-sm text-ink-2">
      <p><b className="font-semibold">Ollama and the models it downloads are third-party software.</b> They are not made, endorsed, reviewed or supported by Assay. The install link opens an external website.</p>
      <ul className="list-disc space-y-1 pl-4">
        <li>You download and install them <b className="font-semibold">at your own risk</b>. Check each model's licence and terms, and your organisation's rules on installing software and on data (IT approval may be required).</li>
        <li>Assay gives <b className="font-semibold">no warranty</b> for the availability, accuracy, safety or performance of third-party models, and is not responsible for their output.</li>
        <li>Downloads are large (1–10 GB) and running a model uses this PC's memory, disk and power.</li>
        <li>Models whose names end in <code>-cloud</code> or <code>:cloud</code> <b className="font-semibold">run on the provider's servers</b>: questions and answers leave this PC, even though they are reached through the local Ollama.</li>
      </ul>
      <p className="text-xs text-ink-2">This notice is information, not legal advice. Have your organisation review it if Assay is used beyond your own PC.</p>
    </div>
  )
}

export function LocalModelsCard({ models, onChange }: { models: ProviderConfig[]; onChange: () => void }) {
  const qc = useQueryClient()
  const settings = useSettings()
  const status = useQuery({ queryKey: ['local-status'], queryFn: () => api.get<Status>('/api/local-models/status'), refetchInterval: (q) => (q.state.data?.running ? false : 5000) })
  const advice = useQuery({ queryKey: ['local-advice'], queryFn: () => api.get<Advice>('/api/local-models/advice'), staleTime: 60_000 })
  const acked = !!settings.data?.values.ollama_notice_ack
  const [ticked, setTicked] = useState(false)
  const [guide, setGuide] = useState(false)
  const [pulling, setPulling] = useState<string | null>(null)
  const ack = useMutation({ mutationFn: () => api.put('/api/settings', { ollama_notice_ack: new Date().toISOString() }), onSuccess: () => qc.invalidateQueries({ queryKey: ['settings'] }), meta: { silent: true } })
  const startPull = useMutation({ mutationFn: (model: string) => api.post<Pull>('/api/local-models/pull', { model }), onSuccess: (p) => setPulling(p.model), meta: { silent: true } })
  const progress = useQuery({
    queryKey: ['local-pull', pulling], enabled: !!pulling,
    queryFn: async () => {
      const p = await api.get<Pull>(`/api/local-models/pull?model=${encodeURIComponent(pulling!)}`)
      if (p.done) qc.invalidateQueries({ queryKey: ['local-status'] }) // the new model is now installed
      return p
    },
    // Stop when the download is done or lost (a restart), or the request itself fails.
    refetchInterval: (q) => (q.state.data?.done || q.state.data?.status === 'lost' || q.state.status === 'error' ? false : 1000),
    retry: false,
  })
  const downloading = !!pulling && !progress.data?.done && progress.data?.status !== 'lost' && !progress.isError
  const connect = useMutation({
    mutationFn: async (model: string) => {
      const pc = await api.post<ProviderConfig>('/api/models', { name: `Ollama ${model}`, provider: 'ollama', model, base_url: status.data?.base_url })
      let checkError: string | null = null
      try { await api.post(`/api/models/${pc.id}/check`) } catch (e) { checkError = e instanceof Error ? e.message : 'The check failed.' }
      return { pc, checkError }
    },
    onSuccess: onChange,
    meta: { silent: true },
  })

  const st = status.data
  const installed = new Set((st?.models ?? []).map((m) => m.name))
  const connected = new Set(models.filter((m) => m.provider === 'ollama').map((m) => m.model))
  const steps = [
    { done: !!st?.running, label: 'Install Ollama' },
    { done: !!st?.running, label: 'Ollama is running' },
    { done: (st?.models ?? []).some((m) => !m.cloud), label: 'A model is downloaded' },
    { done: [...connected].some((m) => installed.has(m)), label: 'Connected as a grading model' },
  ]
  const a = advice.data
  const rec = a?.suggestions.find((s) => s.model === a.recommended)

  return (
    <Card title="Run a grading model on this PC (Ollama)"
      help={<>
        <p>Free per call, and the answers being graded never leave this PC. Slower than a cloud model.</p>
        <p>The four steps light up as they are done: install, running, a model downloaded, connected as a grading model. The full guide covers choosing a model, LM Studio and what to do when something goes wrong.</p>
      </>}
      actions={<Button size="sm" variant="ghost" onClick={() => setGuide(true)}><BookOpen className="size-3.5" />Full guide</Button>}>
      <div className="space-y-6">
      <ol className="flex flex-wrap gap-2">
        {steps.map((s, i) => (
          <li key={s.label}>
            <Badge tone={s.done ? 'pass' : 'neutral'}>{s.done ? <Check className="size-3" /> : <span className="font-mono">{i + 1}</span>}{s.label}</Badge>
          </li>
        ))}
      </ol>

      {!st?.running ? (
        <div className="space-y-3">
          <Notice tone="info" title={status.isLoading ? 'Looking for Ollama on this PC...' : `Ollama is not answering at ${st?.base_url ?? 'localhost:11434'}`}
            action={<Button size="sm" onClick={() => status.refetch()} loading={status.isFetching}><RefreshCw className="size-3.5" />Check again</Button>}>
            1. Install it from the Ollama website (an external, third-party site). 2. Open the Ollama app; it then runs in the background. This page notices within a few seconds.
          </Notice>
          <TextLink href={OLLAMA_URL} target="_blank" rel="noreferrer noopener" className="gap-1.5">
            ollama.com/download <ExternalLink className="size-3.5" /><span className="text-xs font-normal text-ink-3">(opens an external site)</span>
          </TextLink>
        </div>
      ) : (
        <p className="text-xs text-good-ink">Ollama <span className="font-mono">{st.version}</span> is running at <span className="font-mono">{st.base_url}</span>.</p>
      )}

      {a && (
        <div className="space-y-2">
          <div className="flex items-center gap-1.5 text-sm text-ink-2">
            <span><span className="font-medium text-ink">Which model fits this PC:</span> <span className="font-mono">{a.memory.free_gb ?? '?'}</span> GB of <span className="font-mono">{a.memory.total_gb ?? '?'}</span> GB memory free, {a.gpu ? `graphics: ${a.gpu}` : 'no graphics card found (models run on the processor, slowly)'}.</span>
            {rec && <Help title="Time against cost"><p>Grading 100 answers on 2 meaning checks is 200 calls. With {rec.model} here: about {Math.round((200 * rec.seconds_per_check) / 60)} min, free. With a cloud model: about {Math.max(1, Math.round((200 * 2.5) / 4 / 60))} min at 4 in parallel, paid per call (see a cloud model's Check for its cost per 100 calls).</p><p>Greyed rows need more free memory than this PC has now.</p></Help>}
          </div>
          <ScrollTable className="[&_table]:min-w-[640px]">
            <thead><tr className="whitespace-nowrap"><th className="t-label">Model</th><th className="t-label text-right">Download</th><th className="t-label text-right">Needs memory</th><th className="t-label text-right">Per call here</th><th /></tr></thead>
            <tbody>
              {a.suggestions.map((s) => (
                <tr key={s.model} className={clsx(!s.fits && !installed.has(s.model) && 'opacity-55')}>
                  <td>
                    <code className="font-mono text-xs">{s.model}</code>{s.model === a.recommended && <Badge tone="accent" className="ml-1.5">suggested</Badge>}
                    <div className="text-xs text-ink-2">{s.note}{!s.fits && (installed.has(s.model) ? ' Installed: free memory is tight now, so it may run slower.' : ' Needs more free memory than this PC has now.')}</div>
                  </td>
                  <td className="num whitespace-nowrap text-right font-mono">~{s.size_gb} GB</td>
                  <td className="num whitespace-nowrap text-right font-mono">~{s.needs_gb} GB</td>
                  <td className="num whitespace-nowrap text-right font-mono">~{s.seconds_per_check} s</td>
                  <td className="text-right">
                    {installed.has(s.model) ? (connected.has(s.model) ? <Badge tone="good"><Check className="size-3" />connected</Badge>
                      : <Button size="sm" loading={connect.isPending && connect.variables === s.model} onClick={() => connect.mutate(s.model)}>Use for grading</Button>)
                      : <Button size="sm" disabled={!st?.running || !acked || downloading} title={!acked ? 'Accept the third-party notice below first' : undefined} loading={startPull.isPending && startPull.variables === s.model} onClick={() => startPull.mutate(s.model)}><Download className="size-3.5" />Download</Button>}
                  </td>
                </tr>
              ))}
            </tbody>
          </ScrollTable>
        </div>
      )}

      {a && (st?.models ?? []).some((m) => !a.suggestions.some((s) => s.model === m.name)) && (
        <div className="flex flex-wrap items-center gap-2 text-xs">
          <span className="text-ink-3">Also installed:</span>
          {(st?.models ?? []).filter((m) => !a.suggestions.some((s) => s.model === m.name)).map((m) => (
            <span key={m.name} className="inline-flex items-center gap-1">
              <code>{m.name}</code>
              {m.cloud ? <Badge tone="warn"><Cloud className="size-3" />cloud: data leaves this PC</Badge> : null}
              {connected.has(m.name) ? <Badge tone="good">connected</Badge> : <Button size="sm" variant="ghost" onClick={() => connect.mutate(m.name)}>Use</Button>}
            </span>
          ))}
        </div>
      )}

      {downloading && progress.data && (
        <div>
          <div className="mb-1 flex justify-between text-xs text-ink-2"><span>Downloading <code>{pulling}</code>: {progress.data.status}</span>
            <span className="num font-mono">{progress.data.total ? `${(progress.data.completed / 1e9).toFixed(1)} / ${(progress.data.total / 1e9).toFixed(1)} GB` : ''}</span></div>
          <ProgressBar value={progress.data.total ? progress.data.completed / progress.data.total : 0} />
        </div>
      )}
      {progress.data?.error && <div><Notice tone="bad" title={progress.data.status === 'lost' ? 'The download stopped' : 'The download failed'}>{progress.data.error}</Notice></div>}
      {progress.isError && <div><ErrorState error={progress.error} /></div>}
      {connect.data?.checkError && <div><Notice tone="warn" title="Connected, but the check failed">{connect.data.checkError}</Notice></div>}
      {ack.isError && <div><ErrorState error={ack.error} /></div>}
      {startPull.isError && <div><ErrorState error={startPull.error} /></div>}
      {connect.isError && <div><ErrorState error={connect.error} /></div>}

      {st?.running && !acked && (
        <Panel className="bg-surface-2">
          <div className="mb-2 text-sm font-semibold">Before the first download</div>
          <ThirdPartyNotice />
          <Checkbox className="mt-3" checked={ticked} onChange={setTicked} label="I have read this notice and accept it" />
          <Button className="mt-3" size="sm" variant="primary" disabled={!ticked} loading={ack.isPending} onClick={() => ack.mutate()}>Continue to downloads</Button>
        </Panel>
      )}
      {acked && <p className="text-xs text-ink-2">Third-party notice accepted {fmtDay(settings.data!.values.ollama_notice_ack)}. <TextLink size="sm" onClick={() => setGuide(true)}>Read it again</TextLink></p>}

      {connected.size > 0 && (
        <Notice title="Calibrate before you trust it" action={<TextLink to="/calibration">Calibration</TextLink>}>
          A new grading model is unvalidated. Label about 30 answers yourself and Assay measures how often it agrees with you; small local models disagree more often than large cloud ones.
        </Notice>
      )}
      </div>

      <Dialog open={guide} onClose={() => setGuide(false)} title="Local grading models: the full guide" width={680}>
        <LocalGuide />
      </Dialog>
    </Card>
  )
}


function LocalGuide() {
  return (
    <div className="space-y-4 text-sm leading-relaxed text-ink-2">
      <section>
        <h3 className="mb-1 font-semibold text-ink">Is it free?</h3>
        <p>The software is free and there is no bill per grading call. You pay in other ways: memory and disk (an 8-billion-parameter model needs about 5–8 GB of memory and a 5 GB download), time (without a graphics card, tens of seconds per call), and grading quality (small models agree with people less often: calibrate). Models have their own licences, and installing software at work may need IT approval.</p>
      </section>
      <section>
        <h3 className="mb-1 font-semibold text-ink">Set it up</h3>
        <ol className="list-decimal space-y-1 pl-4">
          <li>Install Ollama from <a className="text-accent-ink underline" href={OLLAMA_URL} target="_blank" rel="noreferrer noopener">ollama.com/download</a> (external site) and open the app.</li>
          <li>Here, in Settings → Models &amp; keys, the Ollama card ticks <i>running</i> within a few seconds.</li>
          <li>Accept the third-party notice, then <b className="font-semibold">Download</b> the suggested model. The table shows the size and the expected time per grading call on this PC.</li>
          <li><b className="font-semibold">Use for grading</b>: Assay connects it and runs a 5-call check (speed, JSON reliability).</li>
          <li>Calibrate: label about 30 answers in Calibration; the judge bake-off compares it with other models on your labels.</li>
        </ol>
      </section>
      <section>
        <h3 className="mb-1 font-semibold text-ink">Choosing a model</h3>
        <p>Pick the largest model that fits in free memory and still answers in about half a minute. Close other large programs to free memory before running a big model. On a PC without a graphics card, a 3B model is a practical start; 8B is a better judge if you can wait.</p>
      </section>
      <section>
        <h3 className="mb-1 font-semibold text-ink">LM Studio instead</h3>
        <p>LM Studio (also third-party) serves models through an OpenAI-compatible address, usually <code>http://localhost:1234/v1</code>. Connect it under <i>Connect a provider → LM Studio</i>; it counts as local because the address is on this PC.</p>
      </section>
      <section>
        <h3 className="mb-1 font-semibold text-ink">When something goes wrong</h3>
        <ul className="list-disc space-y-1 pl-4">
          <li><b className="font-semibold">Not answering at localhost:11434</b>: open the Ollama app; if another program uses port 11434, close it or point the model's base URL at Ollama's address.</li>
          <li><b className="font-semibold">Out of memory / very slow</b>: choose a smaller model, close other programs, or grade fewer answers at a time.</li>
          <li><b className="font-semibold">Download stopped</b>: press Download again; Ollama resumes where it stopped.</li>
          <li><b className="font-semibold">Answers marked "not evaluated"</b>: the model replied without valid JSON or timed out. Run its Check; small models fail the JSON test more often.</li>
        </ul>
      </section>
      <section className="rounded-xl border border-line bg-surface-2 p-3">
        <h3 className="mb-1 font-semibold text-ink">Third-party notice</h3>
        <ThirdPartyNotice />
      </section>
    </div>
  )
}
