// A short guided walk through GaugeLab (for a demo, or a first visit). Each step opens a page,
// spotlights one element (data-tour="...") and says what it is for. Steps whose element is not on
// the page are shown centred instead of failing.
import { useQuery } from '@tanstack/react-query'
import { ArrowLeft, ArrowRight, X } from 'lucide-react'
import { AnimatePresence, motion } from 'motion/react'
import { useEffect, useLayoutEffect, useMemo, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { api } from '../lib/api'
import type { HomeData } from '../lib/types'
import { Button, Kbd } from './ui'

interface Step {
  path: string
  target: string
  title: string
  body: string
}

export function Tour({ open, onClose }: { open: boolean; onClose: () => void }) {
  const nav = useNavigate()
  const home = useQuery({ queryKey: ['home'], queryFn: () => api.get<HomeData>('/api/home'), enabled: open })
  const [i, setI] = useState(0)
  const [rect, setRect] = useState<DOMRect | null>(null)

  const steps = useMemo<Step[]>(() => {
    const p = home.data?.projects.find((x) => x.latest_run_id) ?? home.data?.projects[0]
    const base = p?.previous_run_id ?? 1
    const cand = p?.latest_run_id ?? 2
    return [
      { path: '/', target: 'projects', title: 'One card per chatbot', body: 'Every chatbot you test has a card: its latest pass rate, the change since the last comparable run, a trend line and the release gate. GaugeLab is not tied to any one bot.' },
      { path: p ? `/p/${p.id}` : '/', target: 'verdict', title: 'The verdict first', body: 'A chatbot\'s home answers "did it get better?" in one sentence, with the evidence underneath: the interval, the regressed and improved cases, and where in the pipeline failures start.' },
      { path: `/compare?baseline=${base}&candidate=${cand}`, target: 'forest', title: 'Compare two versions', body: 'Each metric is a dot with its 95% interval. If the line crosses zero, the difference could be noise - you can see it rather than take it on trust.' },
      { path: `/runs/${cand}?tab=failures`, target: 'failures', title: 'Why it failed', body: 'Failures are grouped by case and by type. Press J/K to move, Enter to open the trial: the failing check, the answer with the required phrases highlighted, the reference, the trace.' },
      { path: '/calibration', target: 'flashcard', title: 'Can you trust the judge?', body: 'Label answers yourself with P / F / U. GaugeLab measures how often each grading model agrees with you; a new model starts uncalibrated. The bake-off pits models against your labels.' },
      { path: '/settings?tab=models', target: 'models', title: 'Bring a better grading model', body: 'Connect OpenAI (or any compatible API) with a key stored in the operating system\'s credential store, check its speed, JSON reliability and cost, and make it the default.' },
      { path: '/targets/new', target: 'connect', title: 'Connect any chatbot', body: 'Paste a curl command, send a test question, and click the reply to say where the answer and sources are. Bots that reply in the GaugeLab shape need no mapping at all.' },
      { path: '/', target: 'palette', title: 'Everything is a keystroke away', body: 'Ctrl+K searches runs, cases and chatbots and runs commands ("compare 5 6"). Press E for plain-English explanations, ? for all shortcuts.' },
    ]
  }, [home.data])

  useEffect(() => {
    if (open) setI(0)
  }, [open])

  const step = steps[i]
  useEffect(() => {
    if (open && step) nav(step.path, { viewTransition: true })
  }, [open, i, step, nav])

  useLayoutEffect(() => {
    if (!open || !step) return
    setRect(null)
    let tries = 0
    const find = () => {
      const el = document.querySelector(`[data-tour="${step.target}"]`)
      if (el) {
        el.scrollIntoView({ block: 'center', behavior: 'smooth' })
        setTimeout(() => setRect(el.getBoundingClientRect()), 350)
      } else if (tries++ < 20) {
        timer = setTimeout(find, 150)
      }
    }
    let timer = setTimeout(find, 200)
    return () => clearTimeout(timer)
  }, [open, step])

  useEffect(() => {
    if (!open) return
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose()
      if (e.key === 'ArrowRight') setI((x) => Math.min(steps.length - 1, x + 1))
      if (e.key === 'ArrowLeft') setI((x) => Math.max(0, x - 1))
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [open, onClose, steps.length])

  if (!step) return null
  const pad = 8
  const bubbleTop = rect ? Math.min(window.innerHeight - 220, rect.bottom + 14) : window.innerHeight / 2 - 100
  const bubbleLeft = rect ? Math.max(16, Math.min(window.innerWidth - 400, rect.left)) : window.innerWidth / 2 - 190

  return (
    <AnimatePresence>
      {open && (
        <motion.div className="fixed inset-0 z-[90]" initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }}>
          {rect ? (
            <motion.div className="pointer-events-none fixed rounded-xl ring-2 ring-accent"
              style={{ boxShadow: '0 0 0 9999px rgb(0 0 0 / 0.45)' }}
              initial={false}
              animate={{ left: rect.left - pad, top: rect.top - pad, width: rect.width + pad * 2, height: Math.min(rect.height + pad * 2, window.innerHeight * 0.7) }}
              transition={{ type: 'spring', stiffness: 260, damping: 30 }} />
          ) : <div className="fixed inset-0 bg-black/45" />}
          <motion.div key={i} role="dialog" aria-label={step.title}
            initial={{ opacity: 0, y: 8 }} animate={{ opacity: 1, y: 0 }} transition={{ type: 'spring', stiffness: 400, damping: 32 }}
            className="fixed w-[380px] rounded-2xl border border-line bg-surface p-4 shadow-pop" style={{ top: bubbleTop, left: bubbleLeft }}>
            <div className="mb-1 flex items-center justify-between">
              <span className="text-[11px] font-medium uppercase tracking-wide text-accent-ink">Tour - {i + 1} of {steps.length}</span>
              <button type="button" onClick={onClose} aria-label="End tour" className="text-ink-3 hover:text-ink"><X className="size-4" /></button>
            </div>
            <h3 className="text-[15px] font-semibold">{step.title}</h3>
            <p className="mt-1 text-[13px] text-ink-2">{step.body}</p>
            <div className="mt-3 flex items-center gap-2">
              <div className="flex gap-1">{steps.map((_, k) => <span key={k} className={k === i ? 'h-1.5 w-4 rounded-full bg-accent' : 'size-1.5 rounded-full bg-line-strong'} />)}</div>
              <span className="ml-auto flex items-center gap-1 text-[11px] text-ink-3 max-sm:hidden"><Kbd>←</Kbd><Kbd>→</Kbd></span>
              <Button size="sm" variant="ghost" disabled={i === 0} onClick={() => setI(i - 1)}><ArrowLeft className="size-3.5" /></Button>
              {i < steps.length - 1
                ? <Button size="sm" variant="primary" onClick={() => setI(i + 1)}>Next <ArrowRight className="size-3.5" /></Button>
                : <Button size="sm" variant="primary" onClick={onClose}>Done</Button>}
            </div>
          </motion.div>
        </motion.div>
      )}
    </AnimatePresence>
  )
}
