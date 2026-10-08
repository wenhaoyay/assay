// "Share": a run or a comparison as a report someone else can read - Markdown (download or copy),
// a printable page (Print / Save as PDF), or the full JSON.
import { Check, ChevronDown, ClipboardCopy, FileDown, FileJson, Printer, Share2 } from 'lucide-react'
import { AnimatePresence, motion } from 'motion/react'
import { useEffect, useRef, useState } from 'react'
import { Button } from './ui'

export function ShareMenu({ runId, baselineId }: { runId: number; baselineId?: number | null }) {
  const [open, setOpen] = useState(false)
  const [copied, setCopied] = useState(false)
  const ref = useRef<HTMLDivElement>(null)
  const md = `/api/runs/${runId}/export?format=md${baselineId ? `&baseline=${baselineId}` : ''}`
  useEffect(() => {
    if (!open) return
    const close = (e: MouseEvent) => { if (!ref.current?.contains(e.target as Node)) setOpen(false) }
    window.addEventListener('mousedown', close)
    return () => window.removeEventListener('mousedown', close)
  }, [open])
  const copy = async () => {
    const text = await (await fetch(md)).text()
    await navigator.clipboard.writeText(text)
    setCopied(true)
    setTimeout(() => setCopied(false), 1600)
  }
  const item = 'flex w-full items-center gap-2 rounded-md px-2.5 py-1.5 text-left text-sm hover:bg-surface-2'
  return (
    <div className="relative" ref={ref}>
      <Button onClick={() => setOpen((v) => !v)} aria-expanded={open}><Share2 className="size-3.5" />Share<ChevronDown className="size-3" /></Button>
      <AnimatePresence>
        {open && (
          <motion.div initial={{ opacity: 0, y: -4, scale: 0.98 }} animate={{ opacity: 1, y: 0, scale: 1 }} exit={{ opacity: 0, y: -4 }} transition={{ duration: 0.12 }}
            className="absolute right-0 z-30 mt-1 w-64 rounded-xl border border-line bg-surface p-1.5 shadow-pop">
            <a className={item} href={md} download={`gaugelab-${baselineId ? `${baselineId}-vs-` : ''}${runId}.md`}><FileDown className="size-4 text-ink-3" />Markdown report</a>
            <button type="button" className={item} onClick={copy}>{copied ? <Check className="size-4 text-good-ink" /> : <ClipboardCopy className="size-4 text-ink-3" />}{copied ? 'Copied' : 'Copy as Markdown'}</button>
            <button type="button" className={item} onClick={() => { setOpen(false); setTimeout(() => window.print(), 50) }}><Printer className="size-4 text-ink-3" />Print / save as PDF</button>
            <a className={item} href={`/api/runs/${runId}/export?format=json${baselineId ? `&baseline=${baselineId}` : ''}`}><FileJson className="size-4 text-ink-3" />Full JSON</a>
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  )
}
