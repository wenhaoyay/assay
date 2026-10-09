// You vs the judge: the agreement needle (Cohen's kappa against a trust line) and the 2x2 grid of
// your labels against the judge's, one dot per label. Both read the stats endpoint's confusion
// matrix, so they move as soon as a new label lands.
import clsx from 'clsx'
import { motion } from 'motion/react'
import { plural } from '../../lib/format'
import type { Agreement } from '../../lib/types'
import { useMotionOn } from '../../lib/prefs'
import { Needle, SampleSize } from '../instrument'

export const TRUST = 0.6
const LABELS = ['PASS', 'FAIL', 'UNKNOWN'] as const

/** Kappa with a rough 95% interval, from the PASS/FAIL corner of the confusion matrix. */
export function kappaFigures(a: Agreement) {
  const c = a.confusion
  const pp = c.PASS?.PASS ?? 0
  const pf = c.PASS?.FAIL ?? 0
  const fp = c.FAIL?.PASS ?? 0
  const ff = c.FAIL?.FAIL ?? 0
  const n = pp + pf + fp + ff
  if (n === 0) return { n, po: null, kappa: a.kappa, half: null }
  const po = (pp + ff) / n
  const pY = (pp + pf) / n
  const pJ = (pp + fp) / n
  const pe = pY * pJ + (1 - pY) * (1 - pJ)
  const kappa = a.kappa ?? (pe >= 1 ? 1 : (po - pe) / (1 - pe))
  const se = pe >= 1 ? 0 : Math.sqrt((po * (1 - po)) / (n * (1 - pe) ** 2))
  return { n, po, kappa, half: 1.96 * se }
}

export function trustWord(kappa: number | null, half: number | null): { text: string; tone: 'good' | 'warn' | 'bad' | 'none' } {
  if (kappa === null) return { text: 'no labels yet', tone: 'none' }
  if (kappa >= TRUST && kappa - (half ?? 0) >= TRUST) return { text: 'trustworthy', tone: 'good' }
  if (kappa >= TRUST) return { text: 'promising: label more', tone: 'warn' }
  return { text: 'not yet: keep it supervised', tone: 'bad' }
}

/** The needle and its readout. ``sampleNote`` adds the small-sample word (off where a badge says it). */
export function AgreementGauge({ a, small, sampleNote = true, size = 170 }: { a: Agreement; small?: boolean; sampleNote?: boolean; size?: number }) {
  const f = kappaFigures(a)
  const word = trustWord(f.kappa, f.half)
  const tiny = small ?? f.n < 20
  return (
    <div className="flex flex-wrap items-end gap-x-5 gap-y-2" data-testid="agreement-gauge">
      <Needle value={f.kappa === null ? null : Math.max(0, Math.min(1, f.kappa))} gate={TRUST} gateLabel="trust" size={size}
        label={f.kappa === null ? 'No agreement figure yet' : `Agreement kappa ${f.kappa.toFixed(2)}`} endLabels={['0', '1']} />
      <div className="min-w-0 pb-4">
        <div className="t-fig flex items-baseline gap-1.5">
          {f.kappa === null ? '–' : <><span className="text-ink-3">κ</span><span>{f.kappa.toFixed(2)}</span></>}
          {f.half !== null && f.kappa !== null && <span className="num font-mono text-sm text-ink-3">± {f.half.toFixed(2)}</span>}
        </div>
        <div className="mt-1 text-sm text-ink-2">
          {f.po !== null ? <><span className="num font-mono">{Math.round(f.po * 100)}%</span> raw agreement over {plural(f.n, 'label')}</> : 'no labels yet'}
        </div>
        {f.kappa !== null && (
          <div className={clsx('mt-0.5 text-sm font-medium', word.tone === 'good' ? 'text-good-ink' : word.tone === 'warn' ? 'text-warn-ink' : 'text-bad-ink')} data-testid="trust-word">{word.text}</div>
        )}
        {f.n > 0 && (
          <div className="mt-1.5 flex items-center gap-2">
            <SampleSize n={f.n} min={20} unit="labels" />
            {sampleNote && tiny && <span className="text-xs text-warn-ink">small sample</span>}
          </div>
        )}
      </div>
    </div>
  )
}

/** You (rows) against the grading model (columns). Diagonal cells agree; the others are where it cannot be trusted. */
export function TwoByTwo({ a, testPrefix = 'cell' }: { a: Agreement; testPrefix?: string }) {
  const motionOn = useMotionOn()
  const rows = LABELS.filter((h) => h !== 'UNKNOWN' || Object.values(a.confusion[h] ?? {}).some((v) => v > 0))
  const cols = LABELS.filter((j) => j !== 'UNKNOWN' || rows.some((h) => (a.confusion[h]?.[j] ?? 0) > 0))
  const name = (l: string) => (l === 'UNKNOWN' ? 'not sure' : l.toLowerCase())
  return (
    <div className="grid gap-1.5" style={{ gridTemplateColumns: `max-content repeat(${cols.length}, minmax(0, 1fr))` }}
      role="table" aria-label="Confusion matrix (rows: you, columns: grading model)" data-testid="two-by-two">
      <span />
      {cols.map((j) => <span key={j} className="t-label pb-1 text-center" role="columnheader">Grading model: {name(j)}</span>)}
      {rows.map((h) => (
        <div key={h} className="contents" role="row">
          <span className="t-label self-center pr-2" role="rowheader">You: {name(h)}</span>
          {cols.map((j) => {
            const v = a.confusion[h]?.[j] ?? 0
            const agree = h === j
            const unsure = h === 'UNKNOWN' || j === 'UNKNOWN'
            return (
              <div key={j} role="cell" data-testid={`${testPrefix}-${h}-${j}`}
                className={clsx('min-h-24 rounded-xl p-2.5', unsure ? 'bg-surface-2' : agree ? 'bg-good-wash' : 'bg-bad-wash')}>
                <div className="t-fig">{v}</div>
                <div className="text-xs text-ink-2">{unsure ? 'not sure' : agree ? 'agree' : 'disagree'}</div>
                <div className="mt-1.5 flex flex-wrap gap-[3px]" aria-hidden>
                  {Array.from({ length: Math.min(v, 60) }, (_, i) => (
                    <motion.i key={i} className={clsx('block size-[7px] rounded-full', unsure ? 'bg-untested' : agree ? 'bg-good' : 'bg-bad')}
                      initial={motionOn ? { scale: 0.2 } : false} animate={{ scale: 1 }} transition={{ type: 'spring', stiffness: 600, damping: 14 }} />
                  ))}
                  {v > 60 && <span className="num font-mono text-label text-ink-3">+{v - 60}</span>}
                </div>
              </div>
            )
          })}
        </div>
      ))}
    </div>
  )
}
