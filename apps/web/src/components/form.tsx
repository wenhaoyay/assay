// Shared form-ish and choice components: Checkbox, FileInput, Chip, TextLink, SelectCard, Menu.
// (Input, Textarea, Select, Toggle, Segmented, Field and Button live in ./ui.) What to use when is
// in the "Components" section of docs/design.md; do not hand-roll these.
import clsx from 'clsx'
import { motion } from 'motion/react'
import { useEffect, useRef, useState, type AnchorHTMLAttributes, type ButtonHTMLAttributes, type InputHTMLAttributes, type KeyboardEvent as ReactKeyboardEvent, type ReactNode } from 'react'
import { Link } from 'react-router-dom'
import { Button, DUR } from './ui'

// ---------------------------------------------------------------------------------------------
// Checkbox
// ---------------------------------------------------------------------------------------------

/** A labelled checkbox with an optional hint line. `onChange` gets the new boolean. */
export function Checkbox({ checked, onChange, label, hint, disabled, className, ...rest }: Omit<InputHTMLAttributes<HTMLInputElement>, 'type' | 'onChange' | 'checked' | 'className'> & {
  checked: boolean
  onChange: (checked: boolean) => void
  label: ReactNode
  hint?: ReactNode
  className?: string
}) {
  return (
    <label className={clsx('flex items-start gap-2.5', disabled ? 'cursor-not-allowed opacity-60' : 'cursor-pointer', className)}>
      <input {...rest} type="checkbox" checked={checked} disabled={disabled} onChange={(e) => onChange(e.target.checked)} className="mt-[3px] size-4 shrink-0 accent-accent" />
      <span className="min-w-0 text-sm">
        {label}
        {hint && <span className="block text-xs text-ink-3">{hint}</span>}
      </span>
    </label>
  )
}

// ---------------------------------------------------------------------------------------------
// FileInput
// ---------------------------------------------------------------------------------------------

/** A file picker: a button and the chosen name, never the OS "Choose file" control. */
export function FileInput({ onFiles, accept, multiple, disabled, label = 'Choose file', className, ...rest }: Omit<InputHTMLAttributes<HTMLInputElement>, 'type' | 'onChange' | 'className' | 'value'> & {
  onFiles: (files: File[]) => void
  label?: string
  className?: string
}) {
  const ref = useRef<HTMLInputElement>(null)
  const [names, setNames] = useState('')
  return (
    <div className={clsx('flex min-w-0 flex-wrap items-center gap-2', className)}>
      <input {...rest} ref={ref} type="file" accept={accept} multiple={multiple} disabled={disabled} className="sr-only" tabIndex={-1}
        onChange={(e) => {
          const files = [...(e.target.files ?? [])]
          setNames(files.length > 1 ? `${files.length} files` : files[0]?.name ?? '')
          if (files.length) onFiles(files)
          e.target.value = ''
        }} />
      <Button size="sm" disabled={disabled} onClick={() => ref.current?.click()}>{label}</Button>
      <span className="min-w-0 truncate text-xs text-ink-3">{names || 'No file chosen'}</span>
    </div>
  )
}

// ---------------------------------------------------------------------------------------------
// Chip: the one toggle / filter chip
// ---------------------------------------------------------------------------------------------

const CHIP_ON = {
  accent: 'border-accent bg-accent-wash text-accent-ink',
  good: 'border-good/50 bg-good-wash text-good-ink',
  bad: 'border-bad/50 bg-bad-wash text-bad-ink',
  warn: 'border-warn/60 bg-warn-wash text-warn-ink',
} as const

/**
 * A toggle or filter chip: one shape (28 px pill), one selected style. `tone` colours the selected
 * state only when the colour means something (a "failed" filter is `bad`); otherwise leave it.
 * `count` is a figure after the label. Give it `to` (a route) or `href` and it is a link chip: the
 * same pill as a link, with no pressed state.
 */
type ChipProps = {
  selected?: boolean
  tone?: keyof typeof CHIP_ON
  count?: ReactNode
  icon?: ReactNode
  to?: string
  href?: string
  viewTransition?: boolean
}
export function Chip({ selected = false, tone = 'accent', count, icon, children, className, to, href, viewTransition, ...rest }: Omit<ButtonHTMLAttributes<HTMLButtonElement>, keyof ChipProps> & ChipProps) {
  const cls = clsx('inline-flex h-7 items-center gap-1.5 whitespace-nowrap rounded-full border px-2.5 text-xs font-medium transition-colors duration-(--dur-fast) disabled:cursor-not-allowed disabled:opacity-50',
    selected ? CHIP_ON[tone] : 'border-line-strong bg-surface text-ink-2 hover:bg-surface-2 hover:text-ink', className)
  const body = <>{icon}{children}{count !== undefined && count !== null && <span className="num font-mono text-label opacity-70">{count}</span>}</>
  if (to) return <Link to={to} viewTransition={viewTransition} className={cls} {...(rest as AnchorHTMLAttributes<HTMLAnchorElement>)}>{body}</Link>
  if (href) return <a href={href} className={cls} {...(rest as AnchorHTMLAttributes<HTMLAnchorElement>)}>{body}</a>
  return <button type="button" aria-pressed={selected} {...rest} className={cls}>{body}</button>
}

// ---------------------------------------------------------------------------------------------
// TextLink: the accent text "button"
// ---------------------------------------------------------------------------------------------

/**
 * Accent text that acts: a route (`to`), an address (`href`) or a button (`onClick`). One look:
 * accent ink, underline on hover. `quiet` for a secondary one (grey until hovered).
 */
export function TextLink({ to, href, size = 'md', quiet = false, className, children, target, rel, viewTransition, ...rest }: Omit<ButtonHTMLAttributes<HTMLButtonElement>, 'target'> & {
  to?: string
  href?: string
  size?: 'sm' | 'md'
  quiet?: boolean
  /** An address that opens in a new tab: `rel` defaults to `noreferrer noopener`. */
  target?: '_blank' | '_self'
  rel?: string
  /** A route change that cross-fades (the default for page links elsewhere). */
  viewTransition?: boolean
}) {
  const cls = clsx('inline-flex items-center gap-1 font-medium underline-offset-2 hover:underline disabled:cursor-not-allowed disabled:opacity-50', size === 'sm' ? 'text-xs' : 'text-sm', quiet ? 'text-ink-3 hover:text-ink' : 'text-accent-ink', className)
  const anchor = rest as unknown as AnchorHTMLAttributes<HTMLAnchorElement>
  if (to) return <Link to={to} viewTransition={viewTransition} target={target} rel={rel} className={cls} {...anchor}>{children}</Link>
  if (href) return <a href={href} target={target} rel={rel ?? (target === '_blank' ? 'noreferrer noopener' : undefined)} className={cls} {...anchor}>{children}</a>
  return <button type="button" className={cls} {...rest}>{children}</button>
}

// ---------------------------------------------------------------------------------------------
// SelectCard: an option card (role="radio")
// ---------------------------------------------------------------------------------------------

/**
 * One option among a few, as a card. Wrap the set in `<div role="radiogroup" aria-label="...">`.
 * Selecting changes colour only (no hover lift); put motion on what the choice reveals.
 */
export function SelectCard({ selected, onSelect, title, children, icon, className, disabled, ...rest }: Omit<ButtonHTMLAttributes<HTMLButtonElement>, 'title' | 'onSelect'> & {
  selected: boolean
  onSelect: () => void
  title: ReactNode
  icon?: ReactNode
}) {
  return (
    <button type="button" role="radio" aria-checked={selected} disabled={disabled} onClick={onSelect} {...rest}
      className={clsx('flex w-full items-start gap-3 rounded-xl border p-[var(--card-p)] text-left transition-colors duration-(--dur-ui) disabled:cursor-not-allowed disabled:opacity-50',
        selected ? 'border-accent bg-accent-wash ring-1 ring-accent' : 'border-line bg-surface shadow-card hover:border-line-strong hover:bg-surface-2', className)}>
      {icon && <span className={clsx('mt-0.5 shrink-0', selected ? 'text-accent-ink' : 'text-ink-3')}>{icon}</span>}
      <span className="min-w-0 flex-1">
        <span className="block text-sm font-medium text-ink">{title}</span>
        {children && <span className="mt-0.5 block text-sm text-ink-2">{children}</span>}
      </span>
      <span aria-hidden className={clsx('mt-0.5 flex size-4 shrink-0 items-center justify-center rounded-full border-[1.5px] transition-colors duration-(--dur-ui)', selected ? 'border-accent bg-accent' : 'border-line-strong')}>
        {selected && <span className="size-1.5 rounded-full bg-on-accent" />}
      </span>
    </button>
  )
}

// ---------------------------------------------------------------------------------------------
// Menu: the one popover
// ---------------------------------------------------------------------------------------------

/**
 * A popover menu: one radius, one padding, one shadow. `trigger` draws the button and spreads
 * `props` on it (that wires click, `aria-haspopup`, `aria-expanded`). Children are `MenuItem`s,
 * or any content when `role="dialog"` (a picker with its own search). A click on a `MenuItem`
 * closes it; Esc and a click outside close it too. Pass a function as children to get `close`.
 */
export function Menu({ trigger, children, align = 'left', width, role = 'menu', className, rootClassName }: {
  trigger: (t: { open: boolean; toggle: () => void; props: ButtonHTMLAttributes<HTMLButtonElement> }) => ReactNode
  children: ReactNode | ((close: () => void) => ReactNode)
  align?: 'left' | 'right'
  width?: number | string
  role?: 'menu' | 'dialog'
  /** The panel. */
  className?: string
  /** The wrapper around the trigger and panel (inline-block by default; `block w-full` to fill a column). */
  rootClassName?: string
}) {
  const [open, setOpen] = useState(false)
  const root = useRef<HTMLDivElement>(null)
  const close = () => setOpen(false)
  useEffect(() => {
    if (!open) return
    const down = (e: MouseEvent) => { if (!root.current?.contains(e.target as Node)) setOpen(false) }
    const key = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return
      setOpen(false)
      root.current?.querySelector<HTMLElement>('[aria-haspopup]')?.focus()
    }
    document.addEventListener('mousedown', down)
    document.addEventListener('keydown', key)
    return () => { document.removeEventListener('mousedown', down); document.removeEventListener('keydown', key) }
  }, [open])
  const toggle = () => setOpen((v) => !v)
  const onPanelKey = (e: ReactKeyboardEvent) => {
    if (role !== 'menu' || (e.key !== 'ArrowDown' && e.key !== 'ArrowUp')) return
    const items = [...(root.current?.querySelectorAll<HTMLElement>('[role="menuitem"]:not([disabled])') ?? [])]
    if (!items.length) return
    e.preventDefault()
    const at = items.indexOf(document.activeElement as HTMLElement)
    items[e.key === 'ArrowDown' ? (at + 1) % items.length : (at - 1 + items.length) % items.length].focus()
  }
  return (
    <div ref={root} className={clsx('relative', rootClassName ?? 'inline-block')}>
      {trigger({ open, toggle, props: { onClick: toggle, 'aria-haspopup': role === 'menu' ? 'menu' : 'dialog', 'aria-expanded': open } })}
      {open && (
        <motion.div role={role} initial={{ opacity: 0, y: -4 }} animate={{ opacity: 1, y: 0 }} transition={{ duration: DUR.fast }}
          onKeyDown={onPanelKey} onClick={(e) => { if ((e.target as HTMLElement).closest('[role="menuitem"]')) close() }}
          className={clsx('absolute z-(--z-menu) mt-1 min-w-48 rounded-xl border border-line bg-surface p-1.5 shadow-pop', align === 'right' ? 'right-0' : 'left-0', className)}
          style={{ width }}>
          {typeof children === 'function' ? children(close) : children}
        </motion.div>
      )}
    </div>
  )
}

/** One row of a `Menu`. `danger` for a delete. */
export function MenuItem({ icon, danger = false, className, children, ...rest }: ButtonHTMLAttributes<HTMLButtonElement> & { icon?: ReactNode; danger?: boolean }) {
  return (
    <button type="button" role="menuitem" {...rest}
      className={clsx('flex w-full items-center gap-2 rounded-md px-2.5 py-1.5 text-left text-sm transition-colors duration-(--dur-fast) disabled:cursor-not-allowed disabled:opacity-50',
        danger ? 'text-bad-ink hover:bg-bad-wash' : 'text-ink-2 hover:bg-surface-2 hover:text-ink', className)}>
      {icon && <span className="shrink-0 text-ink-3">{icon}</span>}
      <span className="min-w-0 flex-1">{children}</span>
    </button>
  )
}
