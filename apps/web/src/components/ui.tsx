// UI primitives (the role shadcn/ui would play), styled with the token classes. The reference for
// what to use when is the "Components" section of docs/design.md. Form-ish pieces (Checkbox,
// FileInput, Chip, TextLink, Menu, SelectCard) live in ./form.
import clsx from 'clsx'
import { AlertTriangle, Check, CircleSlash, Info, Loader2, X } from 'lucide-react'
import { animate, motion, useInView, useMotionValue, useTransform } from 'motion/react'
import {
  useEffect,
  useId,
  useRef,
  useState,
  useSyncExternalStore,
  type AnchorHTMLAttributes,
  type ButtonHTMLAttributes,
  type CSSProperties,
  type HTMLAttributes,
  type InputHTMLAttributes,
  type ReactNode,
  type SelectHTMLAttributes,
  type TextareaHTMLAttributes,
} from 'react'
import { createPortal } from 'react-dom'
import { Link } from 'react-router-dom'
import { ApiError } from '../lib/api'
import { GLOSSARY, type GlossaryKey } from '../lib/glossary'
import { LONG_SECONDS, spanOf } from '../lib/format'
import { useMotionOn } from '../lib/prefs'

/** Motion durations in seconds, the JS twin of --dur-fast / --dur-ui / --dur-slow in index.css. */
export const DUR = { fast: 0.12, ui: 0.18, slow: 0.25 } as const

const BTN_PRIMARY = 'bg-accent text-on-accent shadow-btn-solid hover:bg-accent-strong'
const BTN_SECONDARY = 'border border-line-strong bg-surface text-ink shadow-btn-raised hover:bg-surface-2'
const BTN_GHOST = 'text-ink-2 hover:bg-surface-2 hover:text-ink'

export function Button({
  variant = 'secondary',
  size = 'md',
  loading,
  className,
  children,
  ...rest
}: ButtonHTMLAttributes<HTMLButtonElement> & {
  variant?: 'primary' | 'secondary' | 'ghost' | 'danger' | 'good' | 'bad'
  size?: 'sm' | 'md' | 'lg'
  loading?: boolean
}) {
  return (
    <button
      type="button"
      {...rest}
      disabled={rest.disabled || loading}
      className={clsx(
        'inline-flex items-center justify-center gap-1.5 rounded-lg font-medium transition-[background-color,box-shadow,transform] duration-(--dur-ui) active:translate-y-px disabled:cursor-not-allowed disabled:opacity-50',
        size === 'sm' ? 'h-7 px-2.5 text-xs' : size === 'lg' ? 'h-10 px-4 text-base' : 'h-8 px-3 text-sm',
        variant === 'primary' && BTN_PRIMARY,
        variant === 'secondary' && BTN_SECONDARY,
        variant === 'ghost' && BTN_GHOST,
        variant === 'danger' && 'border border-bad/40 bg-surface text-bad-ink hover:bg-bad-wash',
        variant === 'good' && 'bg-good text-on-solid hover:bg-good/85',
        variant === 'bad' && 'bg-bad text-on-solid hover:bg-bad/85',
        className,
      )}
    >
      {loading && <Loader2 className="size-3.5 animate-spin" aria-hidden />}
      {children}
    </button>
  )
}

/** A link styled as a button (for navigation that should look like an action). */
export const linkButton = (variant: 'primary' | 'secondary' | 'ghost' = 'secondary', size: 'sm' | 'md' = 'md') =>
  clsx(
    'inline-flex items-center justify-center gap-1.5 rounded-lg font-medium transition-colors duration-(--dur-ui)',
    size === 'sm' ? 'h-7 px-2.5 text-xs' : 'h-8 px-3 text-sm',
    variant === 'primary' && BTN_PRIMARY,
    variant === 'secondary' && BTN_SECONDARY,
    variant === 'ghost' && BTN_GHOST,
  )

/**
 * The heading row of every section, boxed or not: the title (18/600, never truncated), the circled
 * ? (``help``: what it shows, how to use it, any caveat), an optional count or sample chip
 * (``meta``), and the actions at the right, which wrap below the title on a narrow screen. No
 * caption beside the title: it goes in the ? or in the content. ``rule`` draws the line under it.
 */
export function SectionHead({ title, help, meta, actions, rule = false, as: Tag = 'h2', className }: {
  title?: ReactNode
  help?: ReactNode
  meta?: ReactNode
  actions?: ReactNode
  rule?: boolean
  as?: 'h1' | 'h2' | 'h3'
  className?: string
}) {
  return (
    <header className={clsx('flex min-h-11 flex-wrap items-center justify-between gap-x-3 gap-y-2', rule && 'border-b border-line pb-2.5', className)}>
      <div className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1">
        {title && <Tag className="t-h min-w-0">{title}</Tag>}
        {help && <Help title={typeof title === 'string' ? title : 'About this'}>{help}</Help>}
        {meta && <span className="num whitespace-nowrap font-mono text-xs text-ink-3">{meta}</span>}
      </div>
      {actions && <div className="flex flex-wrap items-center gap-2">{actions}</div>}
    </header>
  )
}

/**
 * The boxed surface: one radius, one border, one shadow, padding from --card-p (the density
 * setting). Use it for forms, cards in a grid and side panels; never hand-roll
 * ``rounded-xl border bg-surface shadow-card``. ``padded={false}`` for a table or list that runs
 * to the edge. No hover movement: a clickable panel changes colour, it does not lift.
 */
export function Panel({ children, className, padded = true, ...rest }: HTMLAttributes<HTMLDivElement> & { padded?: boolean }) {
  return (
    <div {...rest} className={clsx('rounded-xl border border-line bg-surface shadow-card', padded && 'p-[var(--card-p)]', className)}>
      {children}
    </div>
  )
}

/**
 * A Panel that acts: a button (`onClick`) or a link (`to` a route, `href` an address). The same surface as `Panel`, with a
 * focus ring and a colour change on hover; it never lifts. Put the tile's title and text inside.
 */
export function PanelButton({ to, href, viewTransition, className, children, ...rest }: Omit<ButtonHTMLAttributes<HTMLButtonElement>, 'className'> & {
  to?: string
  href?: string
  viewTransition?: boolean
  className?: string
}) {
  const cls = clsx('flex h-full w-full flex-col items-start rounded-xl border border-line bg-surface p-3 text-left shadow-card transition-colors duration-(--dur-ui) hover:border-line-strong hover:bg-surface-2 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent disabled:cursor-not-allowed disabled:opacity-50', className)
  if (to) return <Link to={to} viewTransition={viewTransition} className={cls} {...(rest as unknown as AnchorHTMLAttributes<HTMLAnchorElement>)}>{children}</Link>
  if (href) return <a href={href} className={cls} {...(rest as unknown as AnchorHTMLAttributes<HTMLAnchorElement>)}>{children}</a>
  return <button type="button" className={cls} {...rest}>{children}</button>
}

/**
 * A section: a heading row (``SectionHead``) over a rule, no box. What it shows lives behind the
 * circled ? (``help``), never as a grey subtitle. ``meta`` is a count or ``<SampleSize>`` beside the
 * heading; ``boxed`` keeps a panel for content that needs one (forms, cards in a grid, side panels).
 */
export function Card({ title, actions, children, className, padded = true, subtitle, help, meta, boxed = false, id }: {
  title?: ReactNode
  actions?: ReactNode
  children: ReactNode
  className?: string
  padded?: boolean
  /** @deprecated Use ``help``: a subtitle is routed to the ? anyway. */
  subtitle?: ReactNode
  help?: ReactNode
  meta?: ReactNode
  boxed?: boolean
  id?: string
}) {
  const heading = (title || actions) && (
    <SectionHead title={title} help={help ?? subtitle} meta={meta} actions={actions} rule
      className={boxed ? 'px-[var(--card-p)] py-2.5' : undefined} />
  )
  if (boxed) {
    return (
      <section id={id} className={clsx('rounded-xl border border-line bg-surface shadow-card', className)}>
        {heading}
        <div className={clsx(padded && 'p-[var(--card-p)]')}>{children}</div>
      </section>
    )
  }
  return (
    <section id={id} className={clsx('min-w-0', className)}>
      {heading}
      <div className={clsx(padded && heading && 'pt-4')}>{children}</div>
    </section>
  )
}

/**
 * Badge tones. The eight STATES have one look each everywhere (design.md "States"): `pass`,
 * `fail`, `flaky` (amber), `unscored` (solid grey), `unmeasured` (dashed outline: not measured /
 * not applicable), `error` (violet), `heuristic` (hatched: a word-overlap score, not a grading
 * model's verdict) and `cancelled` (quiet outline). `good` / `bad` / `warn` are the older names of
 * pass / fail / flaky; `neutral` / `info` / `accent` are plain labels, not states.
 */
export type Tone = 'neutral' | 'info' | 'accent' | 'good' | 'bad' | 'warn' | 'pass' | 'fail' | 'flaky' | 'unscored' | 'unmeasured' | 'error' | 'heuristic' | 'cancelled'

const TONE: Record<Tone, string> = {
  neutral: 'bg-surface-2 text-ink-2',
  info: 'bg-info-wash text-accent-ink',
  accent: 'bg-accent-wash text-accent-ink',
  good: 'bg-good-wash text-good-ink',
  pass: 'bg-good-wash text-good-ink',
  bad: 'bg-bad-wash text-bad-ink',
  fail: 'bg-bad-wash text-bad-ink',
  warn: 'bg-warn-wash text-warn-ink',
  flaky: 'bg-warn-wash text-warn-ink',
  unscored: 'bg-untested text-ink',
  unmeasured: 'border border-dashed border-line-strong text-ink-3',
  error: 'bg-error-wash text-error-ink',
  heuristic: 'hatched border border-line-strong text-ink-2',
  cancelled: 'border border-line text-ink-3',
}

export function Badge({ tone = 'neutral', children, className, title }: {
  tone?: Tone
  children: ReactNode
  className?: string
  title?: string
}) {
  return (
    <span title={title} className={clsx('inline-flex h-5 items-center gap-1 whitespace-nowrap rounded-full px-2 text-xs font-medium', TONE[tone], className)}>
      {children}
    </span>
  )
}

/** The states a mark (a dot, a cell, a badge) can be in. */
export type StateName = 'pass' | 'fail' | 'flaky' | 'unscored' | 'error' | 'heuristic' | 'cancelled'

/** Fill classes for a dot or cell in each state: use these, never `bg-red-500` or a hex. */
export const STATE_DOT: Record<StateName, string> = {
  pass: 'bg-good',
  fail: 'bg-bad',
  flaky: 'bg-flaky',
  unscored: 'bg-untested',
  error: 'bg-error',
  heuristic: 'hatched border border-line-strong bg-surface-2',
  cancelled: 'border border-untested',
}

/** A trial or run status word ("passed", "failed", "PASS"...) as one of the states. */
export function stateOf(status: string | null | undefined): StateName {
  switch ((status ?? '').toLowerCase()) {
    case 'pass': case 'passed': case 'completed': case 'approved': return 'pass'
    case 'fail': case 'failed': return 'fail'
    case 'flaky': return 'flaky'
    case 'error': case 'completed_with_errors': return 'error'
    case 'heuristic': return 'heuristic'
    case 'cancelled': case 'canceled': return 'cancelled'
    default: return 'unscored'
  }
}

/** A round mark in one of the states (a flaky one is amber, an unscored one solid grey). */
export function StateDot({ state, size = 8, title, className }: { state: StateName; size?: number; title?: string; className?: string }) {
  return <span title={title} className={clsx('inline-block shrink-0 rounded-full', STATE_DOT[state], className)} style={{ width: size, height: size }} />
}

type Icon = 'check' | 'x' | 'slash' | 'warn'
// Status words are sentence case ("Pass", "Incomplete"); capitals belong to the gate stamp alone.
const STATUS: Record<string, { tone: Tone; text: string; icon?: Icon }> = {
  pass: { tone: 'pass', text: 'Pass', icon: 'check' },
  passed: { tone: 'pass', text: 'Passed', icon: 'check' },
  PASS: { tone: 'pass', text: 'Pass', icon: 'check' },
  fail: { tone: 'fail', text: 'Fail', icon: 'x' },
  failed: { tone: 'fail', text: 'Failed', icon: 'x' },
  FAIL: { tone: 'fail', text: 'Fail', icon: 'x' },
  error: { tone: 'error', text: 'Error', icon: 'warn' },
  unknown: { tone: 'flaky', text: 'Unknown' },
  UNKNOWN: { tone: 'flaky', text: 'Unknown' },
  not_applicable: { tone: 'unmeasured', text: 'N/A', icon: 'slash' },
  not_evaluated: { tone: 'unmeasured', text: 'Not evaluated', icon: 'slash' },
  NOT_EVALUATED: { tone: 'unmeasured', text: 'Not evaluated', icon: 'slash' },
  not_measured: { tone: 'unmeasured', text: 'Not measured', icon: 'slash' },
  INCOMPLETE: { tone: 'flaky', text: 'Incomplete', icon: 'warn' },
  unscored: { tone: 'unscored', text: 'Unscored' },
  heuristic: { tone: 'heuristic', text: 'Heuristic' },
  cancelled: { tone: 'cancelled', text: 'Cancelled', icon: 'slash' },
  queued: { tone: 'info', text: 'Queued' },
  running: { tone: 'info', text: 'Running' },
  cancelling: { tone: 'flaky', text: 'Stopping…' },
  completed: { tone: 'pass', text: 'Completed', icon: 'check' },
  completed_with_errors: { tone: 'flaky', text: 'Completed with errors', icon: 'warn' },
  draft: { tone: 'info', text: 'Draft' },
  frozen: { tone: 'neutral', text: 'Frozen' },
  unreviewed: { tone: 'flaky', text: 'Unreviewed' },
  approved: { tone: 'pass', text: 'Approved', icon: 'check' },
  rejected: { tone: 'neutral', text: 'Rejected', icon: 'x' },
  flaky: { tone: 'flaky', text: 'Flaky', icon: 'warn' },
}

export function StatusBadge({ status, className }: { status: string; className?: string }) {
  const s = STATUS[status] ?? { tone: 'neutral' as Tone, text: status }
  const Icon = s.icon === 'check' ? Check : s.icon === 'x' ? X : s.icon === 'slash' ? CircleSlash : s.icon === 'warn' ? AlertTriangle : null
  return (
    <Badge tone={s.tone} className={className}>
      {status === 'running' || status === 'cancelling' ? <Loader2 className="size-3 animate-spin" aria-hidden /> : Icon && <Icon className="size-3" aria-hidden />}
      {s.text}
    </Badge>
  )
}

/** A run's status, shown only when it is not the normal "completed" (noise otherwise). */
export function RunStatus({ status, done, total }: { status: string; done?: number; total?: number }) {
  if (status === 'completed') return null
  return (
    <span className="inline-flex items-center gap-1.5">
      <StatusBadge status={status} />
      {status === 'running' && total ? <span className="num text-xs text-ink-3">{done}/{total}</span> : null}
    </span>
  )
}

export function Field({ label, hint, children, error }: { label: ReactNode; hint?: ReactNode; children: ReactNode; error?: string }) {
  return (
    <label className="flex flex-col items-stretch gap-1">
      <span className="text-xs font-medium text-ink-2">{label}</span>
      {children}
      {hint && !error && <span className="block text-xs text-ink-3">{hint}</span>}
      {error && <span className="block text-xs text-bad-ink">{error}</span>}
    </label>
  )
}

const control =
  'rounded-md border border-line-strong bg-surface px-2.5 text-sm text-ink placeholder:text-ink-3/70 placeholder:italic focus:border-accent focus:outline-none focus:ring-2 focus:ring-accent/20'
// Full width unless the caller sets a width (Tailwind cannot order two width utilities by class order).
const width = (className?: string) => (/(^|\s)w-/.test(className ?? '') ? '' : 'w-full')

export function Input(props: InputHTMLAttributes<HTMLInputElement>) {
  return <input {...props} className={clsx(control, width(props.className), 'h-8', props.className)} />
}

/** Multi-line text. Sans by default (sentences); `mono` for JSON, a curl command or other code. */
export function Textarea({ mono = false, ...props }: TextareaHTMLAttributes<HTMLTextAreaElement> & { mono?: boolean }) {
  return <textarea {...props} className={clsx(control, width(props.className), 'py-2 leading-relaxed', mono && 'font-mono text-xs', props.className)} />
}

/** A native select with the OS chevron replaced by a token-coloured one. */
export function Select(props: SelectHTMLAttributes<HTMLSelectElement>) {
  return <select {...props} className={clsx(control, 'select-ctl', width(props.className), 'h-8 pr-7', props.className)} />
}

export function Toggle({ checked, onChange, label, hint, disabled }: { checked: boolean; onChange: (v: boolean) => void; label: ReactNode; hint?: ReactNode; disabled?: boolean }) {
  return (
    <div className="flex items-start gap-3">
      <button
        type="button"
        role="switch"
        aria-checked={checked}
        aria-label={typeof label === 'string' ? label : undefined}
        disabled={disabled}
        onClick={() => onChange(!checked)}
        className={clsx('relative mt-0.5 inline-flex h-5 w-9 shrink-0 rounded-full transition-colors duration-(--dur-ui) disabled:cursor-wait disabled:opacity-60', checked ? 'bg-accent' : 'bg-line-strong')}
      >
        <motion.span layout transition={{ type: 'spring', stiffness: 600, damping: 35 }}
          className={clsx('absolute top-0.5 size-4 rounded-full bg-on-solid shadow', checked ? 'right-0.5' : 'left-0.5')} />
      </button>
      <span>
        <span className="text-sm font-medium">{label}</span>
        {hint && <span className="block text-xs text-ink-3">{hint}</span>}
      </span>
    </div>
  )
}

export function Tabs<T extends string>({ tabs, value, onChange, className }: {
  tabs: { id: T; label: ReactNode }[]
  value: T
  onChange: (t: T) => void
  className?: string
}) {
  const group = useId()
  return (
    <div role="tablist" className={clsx('scroll-thin flex gap-1 overflow-x-auto border-b border-line', className)}>
      {tabs.map((t) => (
        <button
          key={t.id}
          role="tab"
          type="button"
          aria-selected={value === t.id}
          onClick={() => onChange(t.id)}
          className={clsx('relative whitespace-nowrap px-3 py-2 text-sm font-medium transition-colors', value === t.id ? 'text-ink' : 'text-ink-3 hover:text-ink')}
        >
          {t.label}
          {value === t.id && (
            <motion.span layoutId={`tab-${group}`} className="absolute inset-x-1 -bottom-px h-0.5 rounded-full bg-accent"
              transition={{ type: 'spring', stiffness: 500, damping: 40 }} />
          )}
        </button>
      ))}
    </div>
  )
}

/** One segmented control: a pill track with a sliding thumb. `sm` (the default) beside controls and in toolbars; `md` when it stands alone. */
export function Segmented<T extends string>({ options, value, onChange, size = 'sm', label }: {
  options: { id: T; label: ReactNode }[]
  value: T
  onChange: (v: T) => void
  size?: 'sm' | 'md'
  label?: string
}) {
  const group = useId()
  return (
    <div className="inline-flex rounded-lg border border-line bg-surface-2 p-0.5" role="group" aria-label={label}>
      {options.map((o) => (
        <button key={o.id} type="button" onClick={() => onChange(o.id)} aria-pressed={value === o.id}
          className={clsx('relative rounded-md px-2.5 font-medium transition-colors', size === 'sm' ? 'h-6 text-xs' : 'h-7 text-sm', value === o.id ? 'text-ink' : 'text-ink-3 hover:text-ink')}>
          {value === o.id && <motion.span layoutId={`seg-${group}`} className="absolute inset-0 rounded-md bg-surface shadow-sm" transition={{ type: 'spring', stiffness: 500, damping: 40 }} />}
          <span className="relative">{o.label}</span>
        </button>
      ))}
    </div>
  )
}

export function Notice({ tone = 'info', title, children, action }: { tone?: 'info' | 'warn' | 'bad' | 'good'; title?: ReactNode; children?: ReactNode; action?: ReactNode }) {
  const Icon = tone === 'bad' || tone === 'warn' ? AlertTriangle : tone === 'good' ? Check : Info
  return (
    <div
      role={tone === 'bad' ? 'alert' : 'status'}
      className={clsx(
        'flex gap-2.5 rounded-lg border px-3 py-2.5 text-sm',
        tone === 'info' && 'border-accent/25 bg-info-wash',
        tone === 'warn' && 'border-warn/40 bg-warn-wash',
        tone === 'bad' && 'border-bad/30 bg-bad-wash',
        tone === 'good' && 'border-good/30 bg-good-wash',
      )}
    >
      <Icon className={clsx('mt-0.5 size-4 shrink-0', tone === 'bad' ? 'text-bad-ink' : tone === 'warn' ? 'text-warn-ink' : tone === 'good' ? 'text-good-ink' : 'text-accent-ink')} aria-hidden />
      <div className="min-w-0 flex-1 space-y-1">
        {title && <div className="font-medium">{title}</div>}
        {children && <div className="text-ink-2">{children}</div>}
      </div>
      {action && <div className="shrink-0 self-center">{action}</div>}
    </div>
  )
}

export function ErrorState({ error, retry }: { error: unknown; retry?: () => void }) {
  const e = error instanceof ApiError ? error : null
  return (
    <Notice tone="bad" title={e?.message ?? (error instanceof Error ? error.message : 'Something went wrong')}>
      {e?.details?.length ? (
        <ul className="mt-1 list-disc space-y-0.5 pl-4 font-mono text-xs">
          {e.details.slice(0, 20).map((d) => <li key={d}>{d}</li>)}
          {e.details.length > 20 && <li>… and {e.details.length - 20} more</li>}
        </ul>
      ) : null}
      {retry && <Button size="sm" className="mt-2" onClick={retry}>Try again</Button>}
    </Notice>
  )
}

const SKELETON = {
  line: 'h-4', // a line of text
  title: 'h-5 w-1/3', // a section heading
  heading: 'h-7 w-64', // a page title
  figure: 'h-24', // one figure in a row of figures
  chart: 'h-40', // a small chart
  block: 'h-64', // a table or a large chart
} as const

/** A placeholder shaped like the content. One look (shimmer), a few named heights. */
export function Skeleton({ size = 'line', className, style }: { size?: keyof typeof SKELETON; className?: string; style?: CSSProperties }) {
  return <div className={clsx('skeleton', SKELETON[size], className)} style={style} aria-hidden />
}

/** Loading placeholder shaped like the content (a spinner on a blank page tells you nothing). */
export function Loading({ label = 'Loading', rows = 4 }: { label?: string; rows?: number }) {
  return (
    <div className="space-y-3 p-4" role="status" aria-label={label}>
      <span className="sr-only">{label}…</span>
      <Skeleton size="title" />
      {Array.from({ length: rows }, (_, i) => <Skeleton key={i} style={{ width: `${92 - i * 9}%` }} />)}
    </div>
  )
}

export function PageSkeleton() {
  return (
    <div className="space-y-5" role="status" aria-label="Loading">
      <Skeleton size="heading" />
      <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">{[0, 1, 2, 3].map((i) => <Skeleton key={i} size="figure" />)}</div>
      <Skeleton size="block" />
    </div>
  )
}

/** A gauge in line art: the empty-state drawing. */
export function GaugeArt({ size = 64 }: { size?: number }) {
  return (
    <svg width={size} height={size * 0.7} viewBox="0 0 64 44" aria-hidden fill="none" stroke="currentColor" strokeWidth={1.4} strokeLinecap="round">
      <path d="M6 38a26 26 0 0 1 52 0" /><path d="M32 38l-11-15" /><circle cx="32" cy="38" r="2.5" />
      <path d="M12 30l3 1M52 30l-3 1M32 13v3M19 18l2 2.5M45 18l-2 2.5" />
    </svg>
  )
}

/**
 * Nothing here yet: a plain title with no full stop ("No datasets yet"), one sentence of
 * explanation (children), one action. The gauge line is the default picture.
 */
export function Empty({ title, children, action, icon }: { title: string; children?: ReactNode; action?: ReactNode; icon?: ReactNode }) {
  return (
    <div className="flex flex-col items-start gap-2 rounded-xl border-[1.5px] border-dashed border-line-strong p-6">
      <div className="mb-1 text-ink-3">{icon ?? <GaugeArt size={56} />}</div>
      <div className="text-base font-semibold">{title.replace(/\.$/, '')}</div>
      {children && <div className="max-w-2xl text-sm text-ink-2">{children}</div>}
      {action && <div className="mt-1">{action}</div>}
    </div>
  )
}

export function Code({ children }: { children: ReactNode }) {
  return <code className="rounded bg-surface-2 px-1 py-0.5 font-mono text-xs">{children}</code>
}

export function Kbd({ children }: { children: ReactNode }) {
  return <kbd className="inline-flex h-5 min-w-5 items-center justify-center rounded border border-line-strong bg-surface px-1 font-mono text-label font-medium text-ink-2 shadow-[0_1px_0_var(--line-strong)]">{children}</kbd>
}

export function Json({ value, maxHeight = 360 }: { value: unknown; maxHeight?: number }) {
  return (
    <pre className="code scroll-thin overflow-auto rounded-md border border-line bg-surface-2 p-3" style={{ maxHeight }}>
      {typeof value === 'string' ? value : JSON.stringify(value, null, 2)}
    </pre>
  )
}

/** A number that counts up to its value the first time it is seen (and moves when it changes). */
export function CountUp({ value, format }: { value: number | null | undefined; format: (v: number | null) => string }) {
  const ref = useRef<HTMLSpanElement>(null)
  const inView = useInView(ref, { once: true })
  const canObserve = typeof IntersectionObserver !== 'undefined'
  const animated = useMotionOn() && canObserve
  const mv = useMotionValue(animated ? 0 : (value ?? 0))
  const text = useTransform(mv, (v) => format(v))
  useEffect(() => {
    if (value === null || value === undefined) return
    if (!animated) {
      mv.set(value)
      return
    }
    if (!inView) return
    const controls = animate(mv, value, { duration: 0.8, ease: [0.16, 1, 0.3, 1] })
    return () => controls.stop()
  }, [value, inView, animated, mv])
  if (value === null || value === undefined) return <span ref={ref} className="num">{format(null)}</span>
  return <motion.span ref={ref} className="num">{text}</motion.span>
}

/** A row of figures separated by thin rules (no boxes). */
export function Figs({ children, className }: { children: ReactNode; className?: string }) {
  return (
    <div className={clsx('grid auto-cols-fr grid-flow-col border-y border-line max-lg:grid-flow-row max-lg:grid-cols-2 [&>*:not(:first-child)]:border-l [&>*]:border-line max-lg:[&>*]:border-l-0 max-lg:[&>*]:border-t', className)}>
      {children}
    </div>
  )
}

/** One figure: a small-caps label, the number in mono, a line under it. Put several in <Figs>. */
export function Stat({ label, value, sub, title, tone, hatched, numeric, format, help, delta, nowrap }: {
  label: ReactNode
  value?: ReactNode
  sub?: ReactNode
  title?: string
  tone?: 'good' | 'bad' | 'neutral'
  hatched?: boolean
  numeric?: number | null
  format?: (v: number | null) => string
  help?: ReactNode
  delta?: ReactNode
  /** Keep the label on one line (it truncates, the full text is its tooltip) so neighbouring figures align. */
  nowrap?: boolean
}) {
  return (
    <div className={clsx('min-w-0 px-4 py-3.5 first:pl-0 max-lg:first:pl-4', hatched && 'hatched')} title={title}>
      <div className={clsx('t-label flex items-center gap-1', nowrap && 'whitespace-nowrap')}>{nowrap ? <span className="min-w-0 truncate" title={typeof label === 'string' ? label : undefined}>{label}</span> : label}{help && <Help title={typeof label === 'string' ? label : 'About this figure'}>{help}</Help>}</div>
      <div className={clsx('t-fig mt-2 break-words', tone === 'good' && 'text-good-ink', tone === 'bad' && 'text-bad-ink')}>
        {numeric !== undefined && format ? <CountUp value={numeric} format={format} /> : value}
      </div>
      {delta && <div className="num mt-1.5 font-mono text-xs">{delta}</div>}
      {sub && <div className="mt-1 text-xs text-ink-3">{sub}</div>}
    </div>
  )
}

/** Headers are left-aligned; give a numeric column's `<th>` (and its cells) `text-right`. */
export function Table({ children, className }: { children: ReactNode; className?: string }) {
  return (
    <div className={clsx('scroll-thin overflow-x-auto', className)}>
      <table className="gl-table w-full border-collapse text-sm [&_td]:border-t [&_td]:border-line [&_th]:text-xs [&_th]:font-medium [&_th]:text-ink-3">
        {children}
      </table>
    </div>
  )
}

/** The page title in the display serif (one per page); what the page is for lives behind a ?. */
export function PageHeader({ title, description, help, actions, eyebrow, children }: {
  title: ReactNode
  description?: ReactNode
  help?: ReactNode
  actions?: ReactNode
  eyebrow?: ReactNode
  children?: ReactNode
}) {
  const h = help ?? description
  return (
    <div className="mb-7 flex flex-wrap items-end justify-between gap-3">
      <div className="min-w-0">
        {eyebrow && <div className="t-label mb-1.5">{eyebrow}</div>}
        <h1 className="t-title">{title}{h && <span className="ml-3 inline-block align-[0.3em]"><Help title={typeof title === 'string' ? title : 'About this page'} wide>{h}</Help></span>}</h1>
        {children}
      </div>
      {actions && <div className="flex flex-wrap items-center gap-2">{actions}</div>}
    </div>
  )
}

/** A term with its plain meaning on hover (always available). */
export function Term({ k, children }: { k: GlossaryKey; children?: ReactNode }) {
  const g = GLOSSARY[k]
  const [pos, setPos] = useState<{ x: number; y: number } | null>(null)
  const ref = useRef<HTMLSpanElement>(null)
  const show = () => {
    const r = ref.current?.getBoundingClientRect()
    if (r) setPos({ x: Math.max(8, Math.min(r.left, window.innerWidth - 300)), y: r.bottom + 6 })
  }
  return (
    <>
      <span ref={ref} tabIndex={0} onMouseEnter={show} onMouseLeave={() => setPos(null)} onFocus={show} onBlur={() => setPos(null)}
        className="cursor-help underline decoration-ink-3/50 decoration-dotted underline-offset-[3px]">
        {children ?? g.term}
      </span>
      {pos && createPortal(
        <motion.div role="tooltip" initial={{ opacity: 0, y: 3 }} animate={{ opacity: 1, y: 0 }} transition={{ duration: DUR.fast }}
          className="pointer-events-none fixed z-(--z-pop) w-72 rounded-lg border border-line bg-surface p-3 text-xs font-normal normal-case tracking-normal shadow-pop"
          style={{ left: pos.x, top: pos.y }}>
          <div className="mb-0.5 font-semibold text-ink">{g.term}</div>
          <div className="text-ink-2">{g.plain}</div>
        </motion.div>,
        document.body,
      )}
    </>
  )
}

/** Pass/fail dots for the tries of one question: one dot per try (green pass, red fail, violet error, hollow not run). */
export function DotStrip({ statuses, size = 8, title }: { statuses: string[]; size?: number; title?: string }) {
  const passed = statuses.filter((s) => s === 'passed').length
  return (
    <span className="inline-flex items-center gap-[3px]" title={title ?? `${passed} of ${statuses.length} passed`} aria-label={`${passed} of ${statuses.length} passed`}>
      {statuses.map((s, i) => (
        <StateDot key={i} state={s === 'passed' ? 'pass' : s === 'failed' ? 'fail' : s === 'error' ? 'error' : 'cancelled'} size={size} />
      ))}
    </span>
  )
}

/** Consistent / flaky / failing label for a case's trials. */
export function Consistency({ statuses }: { statuses: string[] }) {
  const decided = statuses.filter((s) => s === 'passed' || s === 'failed' || s === 'error')
  const passed = decided.filter((s) => s === 'passed').length
  if (!decided.length) return <Badge>not run</Badge>
  if (decided.length === 1) return <StatusBadge status={decided[0]} />
  if (passed === decided.length) return <Badge tone="good"><Check className="size-3" />{passed}/{decided.length} passed</Badge>
  if (passed === 0) return <Badge tone="bad"><X className="size-3" />{decided.length}/{decided.length} failed - consistent</Badge>
  return <Badge tone="warn"><AlertTriangle className="size-3" />{passed}/{decided.length} passed - flaky</Badge>
}

/** Thin animated progress bar. */
export function ProgressBar({ value, tone = 'accent', className }: { value: number; tone?: 'accent' | 'good' | 'bad'; className?: string }) {
  return (
    <div className={clsx('h-1.5 overflow-hidden rounded-full bg-surface-3', className)}>
      <motion.div className={clsx('h-full rounded-full', tone === 'accent' ? 'bg-accent' : tone === 'good' ? 'bg-good' : 'bg-bad')}
        initial={{ width: 0 }} animate={{ width: `${Math.max(0, Math.min(1, value)) * 100}%` }} transition={{ type: 'spring', stiffness: 120, damping: 24 }} />
    </div>
  )
}

/** The colour names a chatbot can choose (values are --swatch-* tokens, safe in any `style`). */
export const PROJECT_COLORS: Record<string, string> = {
  teal: 'var(--swatch-teal)', blue: 'var(--swatch-blue)', violet: 'var(--swatch-violet)', rose: 'var(--swatch-rose)',
  amber: 'var(--swatch-amber)', green: 'var(--swatch-green)', slate: 'var(--swatch-slate)', orange: 'var(--swatch-orange)',
}

export function projectColor(name: string, color?: string): string {
  if (color && PROJECT_COLORS[color]) return PROJECT_COLORS[color]
  const keys = Object.keys(PROJECT_COLORS)
  return PROJECT_COLORS[keys[[...name].reduce((a, ch) => a + ch.charCodeAt(0), 0) % keys.length]]
}

export function ProjectMark({ name, color, size = 28 }: { name: string; color?: string; size?: number }) {
  const c = projectColor(name, color)
  const initials = name.split(/[\s-]+/).filter(Boolean).slice(0, 2).map((w) => w[0]?.toUpperCase()).join('')
  return (
    <span className="inline-flex shrink-0 items-center justify-center rounded-lg font-semibold text-on-swatch shadow-sm"
      style={{ width: size, height: size, background: `linear-gradient(135deg, ${c}, color-mix(in srgb, ${c} 68%, black))`, fontSize: size * 0.38 }}>
      {initials || '?'}
    </span>
  )
}

const GLYPH = 'inline-flex size-[18px] shrink-0 select-none items-center justify-center rounded-full border-[1.5px] align-middle font-sans text-label font-semibold not-italic leading-none tracking-normal'

/** The circled ? as a picture (for a sentence that mentions it); the working one is `Help`. */
export function HelpGlyph() {
  return <span aria-label="the circled question mark" className={clsx(GLYPH, 'border-line-strong text-ink-3')}>?</span>
}

/**
 * A circled "?" beside a heading or label: what it shows, how to use it, any caveat. Hover or
 * focus shows it; a click pins it open; Esc or a click elsewhere closes it. Every subtitle and page
 * intro lives here (grey subtitles read as clutter). A span, not a button, so clicking a <label>
 * around it still reaches the control.
 */
export function Help({ title, children, label = 'What is this?', wide = false }: { title?: ReactNode; children: ReactNode; label?: string; wide?: boolean }) {
  const [pos, setPos] = useState<{ x: number; y: number; up: boolean } | null>(null)
  const [pinned, setPinned] = useState(false)
  const ref = useRef<HTMLSpanElement>(null)
  const pop = useRef<HTMLDivElement>(null)
  const timer = useRef<number | undefined>(undefined)
  const openedAt = useRef(0)
  const w = wide ? 420 : 340
  const place = () => {
    const r = ref.current?.getBoundingClientRect()
    if (!r) return
    openedAt.current = performance.now()
    const up = r.bottom + 260 > window.innerHeight && r.top > 280
    setPos({ x: Math.max(8, Math.min(r.left - 14, window.innerWidth - w - 8)), y: up ? r.top - 8 : r.bottom + 8, up })
  }
  const close = () => { window.clearTimeout(timer.current); setPos(null); setPinned(false) }
  const hoverOpen = () => { window.clearTimeout(timer.current); timer.current = window.setTimeout(place, 120) }
  const hoverClose = () => { if (pinned) return; window.clearTimeout(timer.current); timer.current = window.setTimeout(() => setPos(null), 180) }
  const click = (e: { preventDefault: () => void; stopPropagation: () => void }) => {
    e.preventDefault()
    e.stopPropagation()
    if (pos && pinned) { close(); return }
    if (!pos) place()
    setPinned(true)
  }
  useEffect(() => {
    if (!pos) return
    const onDoc = (e: MouseEvent | KeyboardEvent) => {
      if (e instanceof KeyboardEvent) { if (e.key === 'Escape') close(); return }
      if (!pop.current?.contains(e.target as Node) && !ref.current?.contains(e.target as Node)) close()
    }
    const away = () => { if (performance.now() - openedAt.current > 400) close() }
    document.addEventListener('mousedown', onDoc)
    document.addEventListener('keydown', onDoc)
    window.addEventListener('scroll', away, true)
    return () => { document.removeEventListener('mousedown', onDoc); document.removeEventListener('keydown', onDoc); window.removeEventListener('scroll', away, true) }
  }, [pos])
  useEffect(() => () => window.clearTimeout(timer.current), [])
  return (
    <>
      <span ref={ref} role="button" tabIndex={0} aria-label={label} aria-expanded={!!pos} onClick={click}
        onMouseEnter={hoverOpen} onMouseLeave={hoverClose} onFocus={place} onBlur={() => { if (!pinned) setPos(null) }}
        onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') click(e) }}
        className={clsx(GLYPH, 'cursor-help transition-colors duration-(--dur-fast)',
          pos ? 'border-accent bg-accent-wash text-accent-ink' : 'border-line-strong text-ink-3 hover:border-accent hover:text-accent-ink')}>
        ?
      </span>
      {pos && createPortal(
        <motion.div ref={pop} role="tooltip" aria-label={typeof title === 'string' ? title : label}
          initial={{ opacity: 0, y: pos.up ? 4 : -4 }} animate={{ opacity: 1, y: 0 }} transition={{ duration: DUR.fast }}
          onMouseEnter={() => window.clearTimeout(timer.current)} onMouseLeave={hoverClose}
          className="fixed z-(--z-pop) rounded-xl border border-line bg-surface p-3.5 font-sans text-sm font-normal normal-case not-italic leading-relaxed tracking-normal text-ink-2 shadow-pop [&_p+p]:mt-2"
          style={{ left: pos.x, top: pos.up ? undefined : pos.y, bottom: pos.up ? window.innerHeight - pos.y : undefined, width: w, maxWidth: 'calc(100vw - 16px)' }}>
          {title && (
            <div className="mb-1.5 flex items-start gap-2">
              <div className="flex-1 text-base font-semibold text-ink">{title}</div>
              {pinned && <button type="button" aria-label="Close" onClick={close} className="text-ink-3 hover:text-ink"><X className="size-3.5" /></button>}
            </div>
          )}
          <div className="space-y-2">{children}</div>
        </motion.div>,
        document.body,
      )}
    </>
  )
}

const FOCUSABLE = 'a[href], button:not([disabled]), input:not([disabled]):not([type="hidden"]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])'

/**
 * A centred dialog over a dimmed page. Focus moves in when it opens (to `data-autofocus`, else the
 * first control, else the close button), Tab stays inside, Esc or the backdrop closes it, and
 * focus goes back to what opened it. Put the one primary action last in a right-aligned row.
 */
export function Dialog({ open, onClose, title, children, width = 560 }: { open: boolean; onClose: () => void; title: ReactNode; children: ReactNode; width?: number }) {
  const titleId = useId()
  const panel = useRef<HTMLDivElement>(null)
  const body = useRef<HTMLDivElement>(null)
  const close = useRef(onClose)
  useEffect(() => { close.current = onClose })
  useEffect(() => {
    if (!open) return
    const el = panel.current
    if (!el) return
    const returnTo = document.activeElement instanceof HTMLElement ? document.activeElement : null
    const items = () => [...el.querySelectorAll<HTMLElement>(FOCUSABLE)]
    if (!el.contains(document.activeElement)) {
      const first = body.current?.querySelector<HTMLElement>('[data-autofocus]') ?? body.current?.querySelector<HTMLElement>(FOCUSABLE) ?? items()[0] ?? el
      first.focus()
    }
    const key = (e: KeyboardEvent) => {
      if (e.key === 'Escape') { close.current(); return }
      if (e.key !== 'Tab') return
      const f = items()
      if (!f.length) { e.preventDefault(); el.focus(); return }
      const a = document.activeElement
      if (e.shiftKey && (a === f[0] || !el.contains(a))) { e.preventDefault(); f[f.length - 1].focus() }
      else if (!e.shiftKey && (a === f[f.length - 1] || !el.contains(a))) { e.preventDefault(); f[0].focus() }
    }
    document.addEventListener('keydown', key)
    return () => {
      document.removeEventListener('keydown', key)
      if (returnTo?.isConnected) returnTo.focus()
    }
  }, [open])
  if (!open) return null
  return createPortal(
    <div className="scrim fixed inset-0 z-(--z-modal) flex items-start justify-center overflow-y-auto p-4 pt-[8vh]" onMouseDown={(e) => { if (e.target === e.currentTarget) close.current() }}>
      <motion.div ref={panel} role="dialog" aria-modal="true" aria-labelledby={titleId} tabIndex={-1} initial={{ opacity: 0, y: 8, scale: 0.98 }} animate={{ opacity: 1, y: 0, scale: 1 }} transition={{ duration: DUR.ui }}
        className="modal-surface w-full outline-none" style={{ maxWidth: width }}>
        <div className="flex items-center gap-2 border-b border-line px-4 py-3">
          <div id={titleId} className="t-h flex-1">{title}</div>
          <button type="button" aria-label="Close" onClick={onClose} className="rounded-md p-1 text-ink-3 hover:bg-surface-2 hover:text-ink"><X className="size-4" /></button>
        </div>
        <div ref={body} className="p-4">{children}</div>
      </motion.div>
    </div>,
    document.body,
  )
}

// ---------------------------------------------------------------------------------------------
// Toasts: a failed action says so, wherever it was started
// ---------------------------------------------------------------------------------------------

interface ToastItem { id: number; message: string; tone: 'bad' | 'good' | 'info' }
let toasts: ToastItem[] = []
let toastSeq = 0
const toastListeners = new Set<() => void>()
const emitToasts = () => toastListeners.forEach((l) => l())

export function dismissToast(id: number) {
  toasts = toasts.filter((t) => t.id !== id)
  emitToasts()
}

/** Show a small message for a few seconds. Errors stay a little longer. */
export function toast(message: string, tone: ToastItem['tone'] = 'info') {
  if (toasts.some((t) => t.message === message)) return
  const id = ++toastSeq
  toasts = [...toasts.slice(-3), { id, message, tone }]
  emitToasts()
  setTimeout(() => dismissToast(id), tone === 'bad' ? 8000 : 4000)
}

export function Toaster() {
  const items = useSyncExternalStore((cb) => { toastListeners.add(cb); return () => { toastListeners.delete(cb) } }, () => toasts)
  const motionOn = useMotionOn()
  return (
    <div className="pointer-events-none fixed bottom-4 right-4 z-(--z-toast) flex w-[min(24rem,calc(100vw-2rem))] flex-col gap-2" data-testid="toaster">
      {items.map((t) => (
        <motion.div key={t.id} role={t.tone === 'bad' ? 'alert' : 'status'} initial={motionOn ? { opacity: 0, y: 8 } : false} animate={{ opacity: 1, y: 0 }} transition={{ duration: motionOn ? DUR.ui : 0 }}
          className={clsx('pointer-events-auto flex items-start gap-2 rounded-lg border bg-surface px-3 py-2.5 text-sm shadow-pop', t.tone === 'bad' ? 'border-bad/40' : t.tone === 'good' ? 'border-good/40' : 'border-line-strong')}>
          {t.tone === 'bad' ? <AlertTriangle className="mt-0.5 size-4 shrink-0 text-bad-ink" aria-hidden /> : <Info className="mt-0.5 size-4 shrink-0 text-accent-ink" aria-hidden />}
          <span className="min-w-0 flex-1">{t.message}</span>
          <button type="button" aria-label="Dismiss" onClick={() => dismissToast(t.id)} className="rounded p-0.5 text-ink-3 hover:bg-surface-2 hover:text-ink"><X className="size-3.5" /></button>
        </motion.div>
      ))}
    </div>
  )
}

/** A line for an action that failed, next to the button that started it. */
export function InlineError({ error }: { error: unknown }) {
  if (!error) return null
  const m = error instanceof Error ? error.message : 'Something went wrong'
  return <span role="alert" className="text-xs text-bad-ink">{m}</span>
}

/**
 * Asks before long work: `run(estimate, start)` calls the estimate; above an hour it opens the
 * dialog and starts only on "Start anyway". If the estimate fails (an older server), it starts.
 */
export function useLongWork() {
  const [pending, setPending] = useState<{ seconds: number; go: () => void } | null>(null)
  const [checking, setChecking] = useState(false)
  const run = async (estimate: () => Promise<{ seconds?: number | null } | null | undefined>, start: () => void) => {
    setChecking(true)
    let s: number | null = null
    try { s = (await estimate())?.seconds ?? null } catch { s = null }
    setChecking(false)
    if (s !== null && s > LONG_SECONDS) setPending({ seconds: s, go: start })
    else start()
  }
  const dialog = (
    <Dialog open={!!pending} onClose={() => setPending(null)} title="This will take a while" width={440}>
      <p className="text-sm text-ink-2">This will take about {pending ? spanOf(pending.seconds) : ''} on this computer. Start anyway?</p>
      <div className="mt-4 flex justify-end gap-2">
        <Button onClick={() => setPending(null)}>Cancel</Button>
        <Button variant="primary" onClick={() => { const g = pending?.go; setPending(null); g?.() }}>Start anyway</Button>
      </div>
    </Dialog>
  )
  return { run, checking, dialog }
}
