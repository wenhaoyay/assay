// A small picture of "questions at a time": dots arrive at the bot together; the bot works on a
// couple at once and the rest wait at the door, their wait timers growing. Plays once per change.
import { motion } from 'motion/react'
import { useMotionOn } from '../lib/prefs'
import { DUR } from './ui'

const SERVE = 2 // illustrative: how many the bot works on at once

export function QueueViz({ atOnce }: { atOnce: number }) {
  const motionOn = useMotionOn()
  const n = Math.min(Math.max(1, atOnce), 10)
  const waiting = Math.max(0, n - SERVE)
  const W = 320
  const door = 214
  const caption = n <= 1 ? 'One at a time: nothing waits, so timings show the bot\'s real speed.'
    : n <= SERVE ? 'Little waiting: timings stay close to the bot\'s real speed.'
    : n <= 4 ? 'Some questions wait their turn: timings run a little slow.'
    : 'Most questions wait at the door: the timings measure the queue, not the bot.'
  return (
    <figure className="mt-3 flex flex-wrap items-center gap-x-5 gap-y-1" aria-label={caption}>
      <svg key={n} width={W} height={48} viewBox={`0 0 ${W} 48`} className="max-w-full shrink-0" role="img" aria-hidden>
        <g className="gridline"><line x1={0} x2={door} y1={30} y2={30} /></g>
        <rect x={door} y={6} width={92} height={36} rx={8} fill="var(--surface-2)" stroke="var(--line-strong)" />
        <text x={door + 46} y={18} textAnchor="middle">bot</text>
        {Array.from({ length: n }, (_, i) => {
          const inside = i < SERVE
          const rank = i - SERVE // 0.. for waiting dots
          const x = inside ? door + 32 + i * 28 : door - 12 - rank * 18
          return (
            <g key={i}>
              <motion.circle r={5.5} cy={30} fill={inside ? 'var(--accent)' : 'var(--warn)'}
                initial={motionOn ? { cx: 6, opacity: 0 } : false} animate={{ cx: x, opacity: 1 }} transition={motionOn ? { duration: DUR.slow, delay: 0.04 * i, ease: 'easeOut' } : { duration: 0 }} />
              {!inside && (
                <motion.rect x={x - 6} y={16} height={3} rx={1.5} fill="var(--warn)"
                  initial={motionOn ? { width: 0 } : false} animate={{ width: 4 + (rank + 1) * (8 / Math.max(1, waiting / 2)) }} transition={motionOn ? { duration: DUR.slow, delay: DUR.slow } : { duration: 0 }} />
              )}
            </g>
          )
        })}
      </svg>
      <figcaption className="max-w-xs text-xs text-ink-2">{caption}</figcaption>
    </figure>
  )
}
