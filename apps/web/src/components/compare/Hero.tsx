// 6.6 The verdict: the needle on the pass-rate change and its interval, one serif headline, one
// plain sentence, and the price.
import clsx from 'clsx'
import type { ReactNode } from 'react'
import { chancePhrase, reading } from '../../lib/compare'
import { plural } from '../../lib/format'
import type { Comparison, ComparisonRow } from '../../lib/types'
import { Delta, Needle, SampleSize } from '../instrument'
import { READING_W } from '../home/shared'
import { Help, Term } from '../ui'
import { fmtRel } from './delta'

export function headline(overall: ComparisonRow | null): { word: string; tone: 'good' | 'bad' | 'neutral'; rest: ReactNode } {
  if (!overall || overall.delta === null) return { word: 'Not enough to compare.', tone: 'neutral', rest: ' The two runs share too few questions.' }
  const pts = <em>{Math.abs(overall.delta * 100).toFixed(1)} points</em>
  const dir = overall.delta > 0 ? 'up' : 'down'
  const read = reading(overall).text
  if (read === 'likely better') return { word: 'Better.', tone: 'good', rest: <> Pass rate {dir} {pts}, beyond noise.</> }
  if (read === 'likely worse') return { word: 'Worse.', tone: 'bad', rest: <> Pass rate {dir} {pts}, beyond noise.</> }
  if (overall.delta === 0) return { word: 'No change.', tone: 'neutral', rest: ' Pass rate exactly the same.' }
  if (read === 'within noise') return { word: 'No clear change.', tone: 'neutral', rest: <> Pass rate {dir} {pts}, within noise.</> }
  return { word: overall.delta > 0 ? 'Up.' : 'Down.', tone: 'neutral', rest: <> Pass rate {dir} {pts}; no interval to say how sure it is.</> }
}

export function Hero({ c, actions }: { c: Comparison; actions?: ReactNode }) {
  const overall = c.metrics.find((m) => m.metric === 'overall_pass_rate') ?? null
  const mc = c.mcnemar
  const h = headline(overall)
  const tok = c.metrics.find((m) => m.unit === 'count' && /token/i.test(m.metric))
  const cost = c.metrics.find((m) => m.unit === 'cost')
  const priced = [tok, cost].filter((m): m is ComparisonRow => !!m && m.relative !== null)
  const rises = priced.some((m) => (m.relative ?? 0) > 0.05)
  const falls = priced.length > 0 && priced.every((m) => (m.relative ?? 0) < -0.05)
  return (
    <section className="grid items-center gap-x-10 gap-y-4 md:grid-cols-[auto_minmax(0,1fr)]" data-tour="verdict">
      <div className="justify-self-center">
        <Needle mode="delta" value={overall?.delta ?? null} low={overall?.ci?.ci_low} high={overall?.ci?.ci_high} size={250}
          label={`Pass rate change ${overall?.delta != null ? (overall.delta * 100).toFixed(1) : 'n/a'} points`} />
      </div>
      <div className="min-w-0">
        <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
          <SampleSize n={c.n_shared_cases} unit="questions" />
          {actions && <span className="ml-auto">{actions}</span>}
        </div>
        <h1 className="t-title mt-2" data-testid="verdict">
          <span className={clsx(h.tone === 'good' && 'text-good-ink', h.tone === 'bad' && 'text-bad-ink')}>{h.word}</span>{h.rest}
          <span className="ml-3 inline-block align-[0.3em]">
            <Help title="How to read this" wide>
              <p>The needle is the change in pass rate from #{c.baseline_run.id} to #{c.candidate_run.id}; the teal arc behind it is its 95% interval, from resampling questions. An interval clear of zero means a real change, not luck. If the arc covers the middle, the two versions may really be equally good.</p>
              <p>Every question is paired: the same question in both runs, so a hard question counts against both.</p>
              <p>“Why this result?”, further down, rebuilds that interval in front of you.</p>
            </Help>
          </span>
        </h1>
        <p className={clsx('mt-3 text-lead text-ink-2', READING_W)}>
          <b className="font-semibold text-good-ink">{plural(c.improvements.length, 'question')} improved</b>,{' '}
          <b className="font-semibold text-bad-ink">{c.regressions.length} regressed</b>, <span className="font-mono">{mc.both_fail}</span> fail in both.
          {mc.p_value !== null && (
            <> {mc.p_value < 0.05 ? 'A split this lopsided' : 'A split like this'} turns up by chance {chancePhrase(mc.p_value)}{mc.p_value >= 0.05 ? ', so it may be luck' : ''}{' '}
              <span className="text-ink-3">(<Term k="mcnemar">McNemar</Term> p = <span className="font-mono">{mc.p_value.toFixed(3)}</span>)</span>.</>
          )}
        </p>
        {priced.length > 0 && (
          <p className={clsx('mt-2 text-sm', rises ? 'text-warn-ink' : falls ? 'text-good-ink' : 'text-ink-2')} data-testid="price-line">
            {rises ? '⚠ The price: ' : falls ? 'Cheaper too: ' : 'The price: '}
            {priced.map((m, i) => (
              <span key={m.metric}>{i > 0 && ', '}{m.unit === 'cost' ? 'cost per answer' : 'tokens per answer'}{' '}
                <Delta value={m.relative} format={(_, v) => fmtRel(v, 0)} higherIsBetter={false} noise={0.05} />
              </span>
            ))}.
          </p>
        )}
      </div>
    </section>
  )
}
