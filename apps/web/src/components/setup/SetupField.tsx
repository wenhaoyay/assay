// A form field for the setup screens: a small-caps label with its ? beside it, the control, and an
// optional live readout under it (a figure that changes as you choose; never a static hint).
import type { ReactNode } from 'react'
import { Help } from '../ui'

export function SetupField({ label, help, helpTitle, readout, children, className }: {
  label: ReactNode
  help?: ReactNode
  helpTitle?: string
  readout?: ReactNode
  children: ReactNode
  className?: string
}) {
  return (
    <label className={className ?? 'flex min-w-0 flex-col gap-1.5'}>
      <span className="t-label flex items-center gap-1.5">
        {label}
        {help && <Help title={helpTitle ?? (typeof label === 'string' ? label : undefined)}>{help}</Help>}
      </span>
      {children}
      {readout && <span className="block text-xs text-ink-2">{readout}</span>}
    </label>
  )
}
