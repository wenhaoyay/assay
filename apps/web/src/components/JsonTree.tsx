// A JSON reply as a tree you can click: picking a node gives its path ("reply.sources.0.id").
// Nodes already mapped to a role carry that role's label.
import clsx from 'clsx'
import { ChevronRight } from 'lucide-react'
import { useState } from 'react'

export function JsonTree({ data, onPick, marks = {}, picking = false }: {
  data: unknown
  onPick?: (path: string, value: unknown) => void
  marks?: Record<string, string>
  picking?: boolean
}) {
  return (
    <div className={clsx('scroll-thin max-h-[480px] overflow-auto rounded-lg border bg-surface-2/40 p-2 font-mono text-xs leading-relaxed', picking ? 'border-accent ring-2 ring-accent/20' : 'border-line')}>
      <Node k={null} v={data} path="" depth={0} onPick={onPick} marks={marks} picking={picking} />
    </div>
  )
}

function preview(v: unknown): string {
  if (typeof v === 'string') return JSON.stringify(v.length > 90 ? `${v.slice(0, 90)}...` : v)
  return JSON.stringify(v)
}

function Node({ k, v, path, depth, onPick, marks, picking }: {
  k: string | null
  v: unknown
  path: string
  depth: number
  onPick?: (path: string, value: unknown) => void
  marks: Record<string, string>
  picking: boolean
}) {
  const [open, setOpen] = useState(depth < 3)
  const isObj = v !== null && typeof v === 'object'
  const mark = marks[path]
  const label = k !== null && (
    <button type="button" onClick={() => onPick?.(path, v)} disabled={!onPick}
      className={clsx('rounded px-0.5 text-left', onPick && 'hover:bg-accent-wash hover:text-accent-ink', picking && onPick && 'cursor-crosshair', mark && 'bg-accent-wash text-accent-ink')}>
      {k}
    </button>
  )
  const tag = mark && <span className="ml-1.5 rounded bg-accent px-1 font-sans text-label font-medium text-on-accent">{mark}</span>
  if (!isObj) {
    return (
      <div className="flex items-start gap-1" style={{ paddingLeft: depth * 14 }}>
        <span className="w-3.5" />
        {label}{k !== null && <span className="text-ink-3">:</span>}
        <button type="button" onClick={() => onPick?.(path, v)} disabled={!onPick}
          className={clsx('min-w-0 break-all rounded px-0.5 text-left', typeof v === 'string' ? 'text-good-ink' : 'text-series-1', onPick && 'hover:bg-accent-wash', mark && 'ring-1 ring-accent')}>
          {preview(v)}
        </button>
        {tag}
      </div>
    )
  }
  const entries = Array.isArray(v) ? v.slice(0, 3).map((x, i) => [String(i), x] as const) : Object.entries(v as Record<string, unknown>)
  const more = Array.isArray(v) && v.length > 3 ? v.length - 3 : 0
  return (
    <div>
      <div className="flex items-center gap-1" style={{ paddingLeft: depth * 14 }}>
        <button type="button" onClick={() => setOpen((o) => !o)} aria-label={open ? 'Collapse' : 'Expand'} className="text-ink-3"><ChevronRight className={clsx('size-3.5 transition-transform', open && 'rotate-90')} /></button>
        {label}{k !== null && <span className="text-ink-3">:</span>}
        <span className="text-ink-3">{Array.isArray(v) ? `[${v.length}]` : `{${Object.keys(v as object).length}}`}</span>
        {tag}
      </div>
      {open && entries.map(([ck, cv]) => <Node key={ck} k={ck} v={cv} path={path ? `${path}.${ck}` : ck} depth={depth + 1} onPick={onPick} marks={marks} picking={picking} />)}
      {open && more > 0 && <div className="text-ink-3" style={{ paddingLeft: (depth + 1) * 14 + 18 }}>... {more} more</div>}
    </div>
  )
}
