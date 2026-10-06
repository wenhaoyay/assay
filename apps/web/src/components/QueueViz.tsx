// A small picture of "questions at a time": dots arrive at the bot together; the bot works on a
// couple at once and the rest wait at the door, their wait timers growing. Plays once per change.
import { motion } from 'motion/react'

const SERVE = 2 // illustrative: how many the bot works on at once

export function QueueViz({ atOnce }: { atOnce: number }) {
  const n = Math.min(Math.max(1, atOnce), 10)
  const waiting = Math.max(0, n - SERVE)
  const W = 300
  const door = 196
  const caption = n <= 1 ? 'One at a time: nothing waits, so timings show the bot\'s real speed.'
    : n <= SERVE ? 'Little waiting: timings stay close to the bot\'s real speed.'
    : n <= 4 ? 'Some questions wait their turn: timings run a little slow.'
    : 'Most questions wait at the door: the timings measure the queue, not the bot.'
  return (
    <figure className="mt-2" aria-label={caption}>
      <svg key={n} width="100%" viewBox={`0 0 ${W} 46`} className="max-w-[300px]" role="img" aria-hidden>
        <rect x={door} y={6} width={86} height={34} rx={8} className="fill-surface-2 stroke-line-strong" />
        <text x={door + 43} y={17} textAnchor="middle" className="fill-ink-3 text-[9px]">bot</text>
        {Array.from({ length: n }, (_, i) => {
          const inside = i < SERVE
          const rank = i - SERVE // 0.. for waiting dots
          const x = inside ? door + 30 + i * 26 : door - 12 - rank * 16
          const y = inside ? 29 : 23
          return (
            <g key={i}>
              <motion.circle r={5} cy={y} className={inside ? 'fill-accent' : 'fill-warn'}
                initial={{ cx: 6, opacity: 0 }} animate={{ cx: x, opacity: 1 }} transition={{ duration: 0.5, delay: 0.04 * i, ease: 'easeOut' }} />
              {!inside && (
                <motion.rect x={x - 6} y={8} height={3} rx={1.5} className="fill-warn"
                  initial={{ width: 0 }} animate={{ width: 4 + (rank + 1) * (8 / Math.max(1, waiting / 2)) }} transition={{ duration: 1.4, delay: 0.5 }} />
              )}
            </g>
          )
        })}
      </svg>
      <figcaption className="text-[11px] text-ink-3">{caption}</figcaption>
    </figure>
  )
}
