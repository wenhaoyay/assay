// Small parts the run page's charts share: a question chip, a chart tooltip, a width hook and the
// empty state of a filtered chart.
import clsx from 'clsx'
import { useLayoutEffect, useRef, useState, type ReactNode, type RefObject } from 'react'
import { createPortal } from 'react-dom'
import { Link } from 'react-router-dom'
import { GaugeArt } from '../ui'

export type ChipTone = 'good' | 'bad' | 'warn' | 'neutral'

/** A question as a chip: opens its try, lights the same question everywhere on hover. */
export function CaseChip({ caseId, trialId, tone = 'neutral', children, color, title }: {
  caseId: string; trialId: number; tone?: ChipTone; children?: ReactNode; color?: string; title?: string
}) {
  return (
    <Link to={`/trials/${trialId}`} data-case={caseId} title={title ?? caseId} viewTransition
      className={clsx('inline-flex h-6 max-w-72 items-center gap-1.5 truncate rounded-full border px-2.5 text-xs font-medium transition-colors hover:bg-surface-2',
        tone === 'good' && 'border-good/40 text-good-ink',
        tone === 'bad' && 'border-bad/40 text-bad-ink',
        tone === 'warn' && 'border-warn/50 text-warn-ink',
        tone === 'neutral' && 'border-line-strong text-ink-2')}
      style={color ? { borderColor: color } : undefined}>
      <span className="truncate">{children ?? <span className="font-mono">{caseId}</span>}</span>
    </Link>
  )
}

/** Width of an element, kept current. */
export function useWidth<T extends HTMLElement>(fallback = 800): [RefObject<T | null>, number] {
  const ref = useRef<T>(null)
  const [w, setW] = useState(fallback)
  useLayoutEffect(() => {
    const el = ref.current
    if (!el) return
    setW(el.clientWidth || fallback)
    if (typeof ResizeObserver === 'undefined') return
    const ro = new ResizeObserver(() => setW(el.clientWidth || fallback))
    ro.observe(el)
    return () => ro.disconnect()
  }, [fallback])
  return [ref, w]
}

export interface TipState { x: number; y: number; body: ReactNode }

/** A small tooltip that follows the pointer over a chart. */
export function ChartTip({ tip }: { tip: TipState | null }) {
  if (!tip) return null
  return createPortal(
    <div className="pointer-events-none fixed z-[85] max-w-72 rounded-lg border border-line bg-surface px-2.5 py-1.5 text-xs text-ink-2 shadow-pop"
      style={{ left: Math.min(tip.x + 14, window.innerWidth - 300), top: tip.y + 14 }}>
      {tip.body}
    </div>,
    document.body,
  )
}

export function NothingPasses({ children = 'Nothing passes every filter.' }: { children?: ReactNode }) {
  return (
    <div className="flex flex-col items-center gap-2 py-8 text-ink-3">
      <GaugeArt size={48} />
      <div className="text-sm">{children}</div>
    </div>
  )
}

export function Dot({ className, color, size = 8 }: { className?: string; color?: string; size?: number }) {
  return <span className={clsx('inline-block shrink-0 rounded-full', className)} style={{ width: size, height: size, background: color }} />
}

export function LegendItem({ className, color, children }: { className?: string; color?: string; children: ReactNode }) {
  return <span className="inline-flex items-center gap-1.5 text-xs text-ink-3"><Dot className={className} color={color} />{children}</span>
}
