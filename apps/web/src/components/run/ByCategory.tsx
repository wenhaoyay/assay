// "By category": a bar per question category, coloured by its pass rate, with a black tick for the
// baseline run.
import { Link } from 'react-router-dom'
import { pct } from '../../lib/format'
import { RateLegend, rateColor, SampleSize } from '../instrument'
import { Card } from '../ui'
import { plain } from './data'

export function ByCategory({ cats, base, baseId }: {
  cats: Record<string, { pass_rate: number | null; n: number }>
  base?: Record<string, { pass_rate: number | null; n: number }> | null
  baseId?: number | null
}) {
  const rows = Object.entries(cats).map(([k, v]) => ({ k, v: v.pass_rate, n: v.n, b: base?.[k]?.pass_rate ?? null }))
  return (
    <Card title="By category"
      help={<>
        <p>Pass rate per question category.{baseId ? <> The bar is this run; the black tick is #{baseId}.</> : null}</p>
        <p>The figure beside each name is how many questions it has. Categories with few questions (under 8) are a hint, not a finding.</p>
        <p>Click a category to list its questions.</p>
      </>}>
      <div className="space-y-3" data-testid="by-category">
        {rows.map((r, i) => (
          <Link key={r.k} to={`?tab=cases&category=${encodeURIComponent(r.k)}`} className="block rounded hover:bg-surface-2/60">
            <div className="flex items-center gap-2 text-sm">
              <span className="flex-1 truncate">{plain(r.k)}</span>
              <SampleSize n={r.n} min={8} />
              <span className="num w-12 text-right font-mono text-sm">{pct(r.v, 0)}</span>
            </div>
            <div className="relative mt-1 h-2.5 rounded-full bg-surface-3">
              <i className="grow-x absolute inset-y-0 left-0 rounded-full" style={{ width: `${(r.v ?? 0) * 100}%`, background: rateColor(r.v), animationDelay: `${i * 40}ms` }} />
              {r.b !== null && <i className="absolute -inset-y-[3px] w-0.5 bg-ink" style={{ left: `calc(${r.b * 100}% - 1px)` }} title={`#${baseId}: ${pct(r.b, 0)}`} />}
            </div>
          </Link>
        ))}
      </div>
      <RateLegend className="mt-4" />
    </Card>
  )
}
