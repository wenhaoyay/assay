// What the bot read: the passages search returned, best first, with the score as a bar and
// expected / cited chips. Hovering a row (or a citation chip in the answer) lights the other and
// opens the passage. A dashed red row is an expected document search never found.
import clsx from 'clsx'
import { AnimatePresence, motion } from 'motion/react'
import { useState } from 'react'
import { plural } from '../../lib/format'
import type { TrialDetail } from '../../lib/types'
import { Badge, Empty, SectionHead } from '../ui'

export type Source = NonNullable<NonNullable<TrialDetail['result']>['retrieved_documents']>[number]

/** Which retrieved document a citation marker ("device_alpha", "2") refers to. */
export function resolverFor(docs: Source[] | null | undefined) {
  return (marker: string): string | null => {
    if (!docs?.length) return null
    const m = marker.trim()
    const byId = docs.find((d) => d.id === m || d.id.toLowerCase() === m.toLowerCase())
    if (byId) return byId.id
    if (/^\d+$/.test(m)) {
      const byN = docs.find((d) => d.n != null && String(d.n) === m)
      if (byN) return byN.id
      const k = Number(m) - 1
      if (k >= 0 && k < docs.length && docs.every((d) => d.n == null)) return docs[k].id
    }
    return null
  }
}

export function Sources({ docs, relevant, cited, lit, onLight, shown = 1 }: {
  docs: Source[] | null | undefined
  /** Expected documents; an entry may list alternatives as "a|b". */
  relevant: string[]
  cited: (d: Source) => boolean
  lit: string | null
  onLight: (key: string | null) => void
  /** 0..1: how far the retrieval step has got in the trace replay (passages fade in). */
  shown?: number
}) {
  const [pinned, setPinned] = useState<string | null>(null)
  const expected = new Set(relevant.flatMap((d) => d.split('|')))
  const missing = docs ? relevant.filter((r) => !r.split('|').some((alt) => docs.some((d) => d.id === alt))) : []
  const max = Math.max(1e-9, ...(docs ?? []).map((d) => Math.abs(d.score ?? 0)))
  const fmtScore = (v: number) => (Math.abs(v) >= 10 ? v.toFixed(1) : v.toFixed(2))
  return (
    <section data-testid="sources">
      <SectionHead title="What the bot read" rule meta={docs ? plural(docs.length, 'passage') : undefined}
        help={<>
          <p>The passages search returned, best score first, with the score as a bar. Expected = a document the question needs; cited = the answer refers to it.</p>
          <p>A dashed red row is a needed document search never found. Hover a row to read its passage (click to keep it open); hover a citation in the answer to light the passage it came from.</p>
        </>} />
      <div className="pt-4" />
      {docs == null ? <Empty title="The bot did not report what it read">Return the retrieved passages in its response to see them here.</Empty>
        : docs.length === 0 ? <Empty title="Search returned nothing" /> : (
          <ol className="space-y-1">
            {docs.map((d, i) => {
              const on = lit === d.id || pinned === d.id
              const visible = shown >= (i + 1) / (docs.length + 1)
              const where = d.label ?? (d.page != null ? `p. ${d.page}` : null)
              return (
                <li key={`${d.id}-${i}`} data-doc={d.id} onMouseEnter={() => onLight(d.id)} onMouseLeave={() => onLight(null)}
                  onClick={() => setPinned(pinned === d.id ? null : d.id)}
                  className={clsx('cursor-default rounded-lg px-2.5 py-2 transition-[background-color,box-shadow,opacity,transform] duration-300',
                    on ? 'bg-accent-wash shadow-[inset_3px_0_0_var(--accent)]' : 'hover:bg-surface-2',
                    !visible && 'translate-x-3 opacity-15')}>
                  <div className="flex items-baseline gap-2">
                    <span className="w-4 shrink-0 text-right font-mono text-xs text-ink-3">{d.n ?? i + 1}</span>
                    <span className="min-w-0 flex-1 text-sm">
                      <span className="font-medium text-ink">{d.title ?? d.id}</span>{' '}
                      <span className="break-all font-mono text-xs text-ink-3">{d.id}{where ? ` · ${where}` : ''}{d.date ? ` · ${d.date}` : ''}</span>
                    </span>
                    {expected.has(d.id) && <Badge tone="pass">expected</Badge>}
                    {cited(d) && <Badge tone="accent">cited</Badge>}
                  </div>
                  {d.score != null && (
                    <div className="mt-1.5 flex items-center gap-2 pl-6">
                      <div className="h-1 flex-1 overflow-hidden rounded-full bg-surface-3"><div className="h-full rounded-full bg-accent" style={{ width: `${(Math.abs(d.score) / max) * 100}%` }} /></div>
                      <span className="num w-10 text-right font-mono text-xs text-ink-3">{fmtScore(d.score)}</span>
                    </div>
                  )}
                  <AnimatePresence initial={false}>
                    {on && d.text && (
                      <motion.div initial={{ height: 0, opacity: 0 }} animate={{ height: 'auto', opacity: 1 }} exit={{ height: 0, opacity: 0 }} transition={{ duration: 0.16 }} className="overflow-hidden">
                        <p className="ml-6 mt-2 max-h-48 overflow-auto whitespace-pre-wrap border-l-2 border-accent pl-2.5 text-sm text-ink-2">{d.text}</p>
                      </motion.div>
                    )}
                  </AnimatePresence>
                </li>
              )
            })}
            {missing.map((m) => (
              <li key={`missing-${m}`} className="rounded-lg border-[1.5px] border-dashed border-bad/70 px-2.5 py-2 text-sm">
                <b className="font-semibold text-bad-ink">Not read:</b> <span className="font-mono text-xs">{m.split('|').join(' or ')}</span>, expected but not among the passages
              </li>
            ))}
          </ol>
        )}
    </section>
  )
}
