// A form field for the setup screens: the shared form label (sentence case, as `Field`) with its ?
// beside it, the control, and an optional live readout under it (a figure that changes as you
// choose; never a static hint). `group` draws a div instead of a label, for a field whose control
// is several buttons (a click on the label must not press the first one).
import type { ReactNode } from 'react'
import { LabelHelp } from '../LabelHelp'

export function SetupField({ label, help, helpTitle, readout, children, className, group = false }: {
  label: ReactNode
  help?: ReactNode
  helpTitle?: string
  readout?: ReactNode
  children: ReactNode
  className?: string
  group?: boolean
}) {
  const Tag = group ? 'div' : 'label'
  return (
    <Tag className={className ?? 'flex min-w-0 flex-col gap-1'}>
      <span className="text-xs font-medium text-ink-2">
        {help ? <LabelHelp label={label} title={helpTitle ?? (typeof label === 'string' ? label : undefined)}>{help}</LabelHelp> : label}
      </span>
      {children}
      {readout && <span className="block text-xs text-ink-2">{readout}</span>}
    </Tag>
  )
}
