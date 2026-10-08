import type { ReactNode } from 'react'
import { Help } from './ui'

/** A form label (or toggle label) with its explanation behind a circled ? instead of a grey hint. */
export function LabelHelp({ label, title, children }: { label: ReactNode; title?: ReactNode; children: ReactNode }) {
  return (
    <span className="inline-flex items-center gap-1.5">
      {label}
      <Help title={title ?? (typeof label === 'string' ? label : undefined)}>{children}</Help>
    </span>
  )
}
