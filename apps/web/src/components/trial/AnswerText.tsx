// An answer as text: phrases it must mention underlined green, phrases it must not claim struck
// red, and its citation markers ([doc_id] or [n]) as chips. With ``resolve`` and ``onLight`` the
// chips are linked to the passages the bot read (E2).
import clsx from 'clsx'
import { Fragment, useMemo } from 'react'
import { wordDiff } from '../../lib/compare'

function escapeRe(s: string) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

type Part = { text: string; kind: null | 'good' | 'bad' | 'cite'; marker?: string }

export function splitAnswer(text: string, good: string[], bad: string[]): Part[] {
  // A phrase may list alternatives as "a|b"; any of them counts.
  const alt = (xs: string[]) => xs.flatMap((x) => x.split('|'))
  const terms = [...alt(good).map((g) => ({ t: g, k: 'good' as const })), ...alt(bad).map((b) => ({ t: b, k: 'bad' as const }))]
    .filter((x) => x.t.trim()).sort((a, b) => b.t.length - a.t.length)
  const alts = [...terms.map((x) => escapeRe(x.t)), '\\[[^\\]\\[]{1,120}\\]']
  const re = new RegExp(`(${alts.join('|')})`, 'gi')
  return text.split(re).map((chunk, i) => {
    if (i % 2 === 0) return { text: chunk, kind: null }
    const term = terms.find((x) => x.t.toLowerCase() === chunk.toLowerCase())
    if (term) return { text: chunk, kind: term.k }
    return { text: chunk, kind: 'cite', marker: chunk.slice(1, -1).trim() }
  })
}

export function AnswerText({ text, good, bad, resolve, lit, onLight }: {
  text: string
  good: string[]
  bad: string[]
  /** Which passage (key) a marker refers to, or null when it matches none. */
  resolve?: (marker: string) => string | null
  lit?: string | null
  onLight?: (key: string | null) => void
}) {
  const parts = useMemo(() => splitAnswer(text, good, bad), [text, good, bad])
  return (
    <>
      {parts.map((p, i) => {
        if (p.kind === null) return <Fragment key={i}>{p.text}</Fragment>
        if (p.kind === 'good') return <mark key={i} className="rounded-[3px] bg-good-wash px-0.5 text-inherit shadow-[inset_0_-2px_0_var(--good)]">{p.text}</mark>
        if (p.kind === 'bad') return <mark key={i} className="rounded-[3px] bg-bad-wash px-0.5 text-bad-ink line-through decoration-bad/70">{p.text}</mark>
        // A citation marker, possibly several ids: [a, b] or [1][2].
        const ids = (p.marker ?? '').split(/\s*[,;]\s*/).filter(Boolean)
        return (
          <Fragment key={i}>
            {ids.map((id, k) => {
              const key = resolve?.(id) ?? null
              const on = !!key && key === lit
              const unknown = !!resolve && !key
              return (
                <mark key={k} data-cite={key ?? undefined} onMouseEnter={() => key && onLight?.(key)} onMouseLeave={() => key && onLight?.(null)}
                  title={!resolve ? 'citation' : key ? `Cites ${key}` : 'Cites a source the bot did not report reading'}
                  className={clsx('mx-0.5 inline-block rounded-[5px] px-1.5 align-[0.08em] font-mono text-xs leading-[1.5] transition-colors',
                    on ? 'bg-accent text-on-accent' : unknown ? 'border border-dashed border-line-strong bg-transparent text-ink-3' : 'bg-accent-wash text-accent-ink', key && 'cursor-pointer')}>
                  {k === 0 && <span className="sr-only">[</span>}{id}{k === ids.length - 1 && <span className="sr-only">]</span>}
                </mark>
              )
            })}
          </Fragment>
        )
      })}
    </>
  )
}

/** E3: the word-level difference from another answer to this one. */
export function AnswerDiff({ from, to }: { from: string; to: string }) {
  const parts = useMemo(() => wordDiff(from, to), [from, to])
  return (
    <>
      {parts.map((p, i) => p.kind === 'same' ? <Fragment key={i}>{p.text}</Fragment> : (
        <span key={i} className={clsx('rounded-[3px] px-px', p.kind === 'del' ? 'bg-bad-wash text-bad-ink line-through decoration-bad/60' : 'bg-good-wash text-good-ink')}>{p.text}</span>
      ))}
    </>
  )
}
