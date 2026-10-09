// A6 words that predict failure: question words more common in failing questions than in passing
// ones (smoothed log-odds), as pills; click one to list its questions.
import { useMemo, useState } from 'react'
import { Chip } from '../form'
import { SampleSize } from '../instrument'
import { Card } from '../ui'
import { CaseChip, NothingPasses } from './bits'
import { firstTries, type XRow } from './data'
import { caseRates } from './Heatmap'

const STOP = new Set(('a an the is are was were do does did i my me to of for in on at by with and or can could how what when which who whom whose will would be it its this that from as if not no yes than then there their about into any up out much many your have has where use still under while should get after you our we us they them too also just only own same so very am been being here why all each few more most other some such nor off over again further once both between through during before above below down'
).split(' '))

export function tokens(s: string): string[] {
  return [...new Set(s.toLowerCase().replace(/[^a-z0-9 ]/g, ' ').split(/\s+/).filter((w) => w.length > 2 && !STOP.has(w)))]
}

export function Words({ rows }: { rows: XRow[] }) {
  const qs = useMemo(() => firstTries(rows), [rows])
  const rates = useMemo(() => caseRates(rows), [rows])
  const [pick, setPick] = useState<string | null>(null)
  const { top, bot, cnt, F } = useMemo(() => {
    const fail = new Set(qs.filter((q) => (rates.get(q.c) ?? 1) < 0.5).map((q) => q.c))
    const cnt = new Map<string, { f: number; p: number; ids: XRow[] }>()
    for (const q of qs) for (const w of tokens(`${q.t.question} ${q.t.title}`)) {
      const v = cnt.get(w) ?? { f: 0, p: 0, ids: [] }
      if (fail.has(q.c)) v.f++; else v.p++
      v.ids.push(q)
      cnt.set(w, v)
    }
    const F = fail.size, P = qs.length - F
    const list = [...cnt].filter(([, v]) => v.f + v.p >= 2).map(([w, v]) => ({ w, ...v, lo: Math.log((v.f + 0.5) / (F - v.f + 0.5)) - Math.log((v.p + 0.5) / (P - v.p + 0.5)) }))
    return {
      top: list.filter((x) => x.lo > 0 && x.f > 0).sort((a, b) => b.lo - a.lo).slice(0, 12),
      bot: list.filter((x) => x.lo < 0 && x.p > 0).sort((a, b) => a.lo - b.lo).slice(0, 10),
      cnt, F,
    }
  }, [qs, rates])
  const pill = (x: (typeof top)[number], bad: boolean) => (
    <Chip key={x.w} selected={pick === x.w} tone={bad ? 'bad' : 'good'} count={`${bad ? x.f : x.p}/${x.f + x.p}`} onClick={() => setPick(pick === x.w ? null : x.w)}
      style={pick === x.w ? undefined : { background: `color-mix(in srgb, ${bad ? 'var(--bad)' : 'var(--good)'} ${Math.round(Math.min(1, Math.abs(x.lo) / 2.5) * 22)}%, var(--surface))` }}>
      {x.w}
    </Chip>
  )
  const list = pick ? cnt.get(pick)?.ids ?? [] : []
  return (
    <Card title="Words that predict failure" id="words" meta={<SampleSize n={qs.length} unit="questions" />}
      help={<>
        <p>Words that turn up more in questions the bot fails (under half its tries pass) than in ones it passes, and the reverse. The figure is the questions with that word that fail (or pass), out of all questions with it.</p>
        <p>Click a word to list its questions.</p>
        <p>Smoothed log-odds over a few dozen questions: a hint, not a finding.</p>
      </>}>
      {!top.length && !bot.length ? <NothingPasses>No word turns up often enough to tell.</NothingPasses> : (
        <div data-testid="words">
          <div className="t-label mb-2">More common in failing questions <span className="num font-mono normal-case tracking-normal">· {F}</span></div>
          <div className="flex flex-wrap gap-1.5">{top.length ? top.map((x) => pill(x, true)) : <span className="text-xs text-ink-3">None stands out.</span>}</div>
          <div className="t-label mb-2 mt-5">More common in passing ones</div>
          <div className="flex flex-wrap gap-1.5">{bot.length ? bot.map((x) => pill(x, false)) : <span className="text-xs text-ink-3">None stands out.</span>}</div>
          {pick && (
            <div className="mt-3 flex flex-wrap gap-1.5">
              {list.map((q) => { const v = rates.get(q.c) ?? 0; return <CaseChip key={q.c} caseId={q.c} trialId={q.id} tone={v < 0.5 ? 'bad' : 'good'} title={q.t.question}>{q.t.title}</CaseChip> })}
            </div>
          )}
        </div>
      )}
    </Card>
  )
}
