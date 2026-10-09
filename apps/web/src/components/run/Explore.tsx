// The run's Explore tab: linked charts over every try (A2), any against any (A3), what if the bot
// declined (A4), category × difficulty (A5), words that predict failure (A6), the question map (A7).
import { useMemo, useState } from 'react'
import { Chip } from '../form'
import { ErrorState, Loading, Segmented } from '../ui'
import { NothingPasses } from './bits'
import { AnyAgainstAny, EMPTY_FILTER, isFiltered, LinkedCharts, passes, type XFilter } from './Crossfilter'
import { useExplore, toRows } from './data'
import { DeclineWhatIf } from './DeclineWhatIf'
import { Heatmap } from './Heatmap'
import { QuestionMap } from './QuestionMap'
import { Words } from './Words'

const NAV: [string, string][] = [['xf', 'Linked charts'], ['scatter', 'Scatter'], ['decline', 'Decline below X'], ['heat', 'Heatmap'], ['words', 'Words'], ['qmap', 'Question map']]

export function ExploreTab({ runId }: { runId: number }) {
  const q = useExplore(runId)
  const rows = useMemo(() => toRows(q.data?.trials ?? []), [q.data])
  const [filter, setFilter] = useState<XFilter>(EMPTY_FILTER)
  const [resetKey, setResetKey] = useState(0)
  const [at, setAt] = useState('xf')
  if (q.isLoading) return <Loading label="Reading every try" />
  if (q.isError) return <ErrorState error={q.error} />
  if (!rows.length) return <NothingPasses>No scored tries in this run yet.</NothingPasses>
  const sub = rows.filter((r) => passes(r, filter))
  const nf = sub.filter((r) => r.st !== 'passed').length
  const go = (id: string) => {
    const el = document.getElementById(id)
    if (!el) return
    const main = document.getElementById('main')
    if (main) main.scrollTo({ top: el.getBoundingClientRect().top - main.getBoundingClientRect().top + main.scrollTop - 110, behavior: 'smooth' })
    else el.scrollIntoView({ behavior: 'smooth', block: 'start' })
    const still = document.documentElement.dataset.motion === 'reduced' || window.matchMedia?.('(prefers-reduced-motion: reduce)').matches
    if (!still) el.animate?.([{ backgroundColor: 'color-mix(in srgb, var(--accent) 10%, transparent)' }, { backgroundColor: 'transparent' }], { duration: 1200 })
  }
  return (
    <div data-testid="explore">
      <div className="sticky top-[52px] z-(--z-bar) -mx-1 mb-6 flex flex-wrap items-center gap-x-3 gap-y-2 border-b border-line bg-page/90 px-1 py-2 backdrop-blur">
        <div className="scroll-thin max-w-full overflow-x-auto">
          <Segmented size="sm" label="Jump to" value={at} onChange={(id) => { setAt(id); go(id) }} options={NAV.map(([id, label]) => ({ id, label }))} />
        </div>
        <span className="ml-auto text-xs text-ink-2" data-testid="xf-count" aria-live="polite">
          <span className="num font-mono font-semibold text-ink">{sub.length}</span> of <span className="num font-mono">{rows.length}</span> tries · <span className="num font-mono text-bad-ink">{nf}</span> failed
          {sub.length < 30 && sub.length < rows.length && <span className="text-warn-ink"> · small sample</span>}
        </span>
        <Chip selected={isFiltered(filter)} aria-pressed={undefined} disabled={!isFiltered(filter)} onClick={() => { setFilter(EMPTY_FILTER); setResetKey((k) => k + 1) }}>Clear filters{isFiltered(filter) ? ' ×' : ''}</Chip>
      </div>
      <div className="space-y-12">
        <LinkedCharts rows={rows} filter={filter} setFilter={setFilter} resetKey={resetKey} />
        <AnyAgainstAny rows={rows} filter={filter} setFilter={setFilter} resetKey={resetKey} />
        <DeclineWhatIf rows={rows} />
        <div className="grid gap-12 lg:grid-cols-2">
          <Heatmap rows={rows} />
          <Words rows={rows} />
        </div>
        <QuestionMap rows={rows} />
      </div>
    </div>
  )
}
