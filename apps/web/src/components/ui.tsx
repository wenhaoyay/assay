// UI primitives (the role shadcn/ui would play), styled with the token classes.
import clsx from 'clsx'
import { AlertTriangle, Check, CircleSlash, Info, Loader2, X } from 'lucide-react'
import { animate, motion, useInView, useMotionValue, useTransform } from 'motion/react'
import {
  useEffect,
  useId,
  useRef,
  useState,
  type ButtonHTMLAttributes,
  type InputHTMLAttributes,
  type ReactNode,
  type SelectHTMLAttributes,
  type TextareaHTMLAttributes,
} from 'react'
import { createPortal } from 'react-dom'
import { ApiError } from '../lib/api'
import { GLOSSARY, type GlossaryKey } from '../lib/glossary'
import { usePrefs, useMotionOn } from '../lib/prefs'

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
        'inline-flex items-center justify-center gap-1.5 rounded-md font-medium transition-[background-color,box-shadow,transform] duration-150 active:translate-y-px disabled:cursor-not-allowed disabled:opacity-50',
        size === 'sm' ? 'h-7 px-2.5 text-xs' : size === 'lg' ? 'h-10 px-4 text-sm' : 'h-8 px-3 text-[13px]',
        variant === 'primary' && 'bg-accent text-on-accent shadow-sm hover:bg-accent-strong',
        variant === 'secondary' && 'border border-line-strong bg-surface text-ink hover:bg-surface-2',
        variant === 'ghost' && 'text-ink-2 hover:bg-surface-2 hover:text-ink',
        variant === 'danger' && 'border border-bad/40 bg-surface text-bad-ink hover:bg-bad-wash',
        variant === 'good' && 'bg-good text-white hover:bg-good/85',
        variant === 'bad' && 'bg-bad text-white hover:bg-bad/85',
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
    'inline-flex items-center justify-center gap-1.5 rounded-md font-medium transition-colors',
    size === 'sm' ? 'h-7 px-2.5 text-xs' : 'h-8 px-3 text-[13px]',
    variant === 'primary' && 'bg-accent text-on-accent shadow-sm hover:bg-accent-strong',
    variant === 'secondary' && 'border border-line-strong bg-surface text-ink hover:bg-surface-2',
    variant === 'ghost' && 'text-ink-2 hover:bg-surface-2 hover:text-ink',
  )

export function Card({ title, actions, children, className, padded = true, subtitle, id }: {
  title?: ReactNode
  actions?: ReactNode
  children: ReactNode
  className?: string
  padded?: boolean
  subtitle?: ReactNode
  id?: string
}) {
  return (
    <section id={id} className={clsx('rounded-xl border border-line bg-surface shadow-card', className)}>
      {(title || actions) && (
        <header className="flex min-h-11 items-center justify-between gap-3 border-b border-line px-4 py-2">
          <div className="min-w-0">
            <h2 className="text-[13px] font-semibold tracking-tight">{title}</h2>
            {subtitle && <div className="text-xs text-ink-3">{subtitle}</div>}
          </div>
          <div className="flex shrink-0 items-center gap-2">{actions}</div>
        </header>
      )}
      <div className={clsx(padded && 'p-[var(--card-p)]')}>{children}</div>
    </section>
  )
}

type Tone = 'neutral' | 'good' | 'bad' | 'warn' | 'info' | 'error' | 'accent'

export function Badge({ tone = 'neutral', children, className, title }: {
  tone?: Tone
  children: ReactNode
  className?: string
  title?: string
}) {
  return (
    <span
      title={title}
      className={clsx(
        'inline-flex h-5 items-center gap-1 whitespace-nowrap rounded px-1.5 text-[11px] font-medium',
        tone === 'neutral' && 'bg-surface-2 text-ink-2',
        tone === 'good' && 'bg-good-wash text-good-ink',
        tone === 'bad' && 'bg-bad-wash text-bad-ink',
        tone === 'warn' && 'bg-warn-wash text-warn-ink',
        tone === 'info' && 'bg-info-wash text-accent-ink',
        tone === 'accent' && 'bg-accent-wash text-accent-ink',
        tone === 'error' && 'bg-error-wash text-error-ink',
        className,
      )}
    >
      {children}
    </span>
  )
}

const STATUS: Record<string, { tone: Tone; text: string; icon?: 'check' | 'x' | 'slash' | 'warn' }> = {
  pass: { tone: 'good', text: 'Pass', icon: 'check' },
  passed: { tone: 'good', text: 'Passed', icon: 'check' },
  PASS: { tone: 'good', text: 'PASS', icon: 'check' },
  fail: { tone: 'bad', text: 'Fail', icon: 'x' },
  failed: { tone: 'bad', text: 'Failed', icon: 'x' },
  FAIL: { tone: 'bad', text: 'FAIL', icon: 'x' },
  error: { tone: 'error', text: 'Error', icon: 'warn' },
  unknown: { tone: 'warn', text: 'Unknown' },
  UNKNOWN: { tone: 'warn', text: 'UNKNOWN' },
  not_applicable: { tone: 'neutral', text: 'N/A', icon: 'slash' },
  not_evaluated: { tone: 'neutral', text: 'Not evaluated', icon: 'slash' },
  NOT_EVALUATED: { tone: 'neutral', text: 'Not evaluated', icon: 'slash' },
  INCOMPLETE: { tone: 'warn', text: 'INCOMPLETE', icon: 'warn' },
  unscored: { tone: 'neutral', text: 'Unscored' },
  cancelled: { tone: 'neutral', text: 'Cancelled', icon: 'slash' },
  queued: { tone: 'info', text: 'Queued' },
  running: { tone: 'info', text: 'Running' },
  completed: { tone: 'good', text: 'Completed', icon: 'check' },
  completed_with_errors: { tone: 'warn', text: 'Completed with errors', icon: 'warn' },
  draft: { tone: 'info', text: 'Draft' },
  frozen: { tone: 'neutral', text: 'Frozen' },
  unreviewed: { tone: 'warn', text: 'Unreviewed' },
  approved: { tone: 'good', text: 'Approved', icon: 'check' },
  rejected: { tone: 'neutral', text: 'Rejected', icon: 'x' },
  flaky: { tone: 'warn', text: 'Flaky', icon: 'warn' },
}

export function StatusBadge({ status, className }: { status: string; className?: string }) {
  const s = STATUS[status] ?? { tone: 'neutral' as Tone, text: status }
  const Icon = s.icon === 'check' ? Check : s.icon === 'x' ? X : s.icon === 'slash' ? CircleSlash : s.icon === 'warn' ? AlertTriangle : null
  return (
    <Badge tone={s.tone} className={className}>
      {status === 'running' ? <Loader2 className="size-3 animate-spin" aria-hidden /> : Icon && <Icon className="size-3" aria-hidden />}
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
  'rounded-md border border-line-strong bg-surface px-2.5 text-[13px] text-ink placeholder:text-ink-3/70 placeholder:italic focus:border-accent focus:outline-none focus:ring-2 focus:ring-accent/20'
// Full width unless the caller sets a width (Tailwind cannot order two width utilities by class order).
const width = (className?: string) => (/(^|\s)w-/.test(className ?? '') ? '' : 'w-full')

export function Input(props: InputHTMLAttributes<HTMLInputElement>) {
  return <input {...props} className={clsx(control, width(props.className), 'h-8', props.className)} />
}

export function Textarea(props: TextareaHTMLAttributes<HTMLTextAreaElement>) {
  return <textarea {...props} className={clsx(control, width(props.className), 'py-2 font-mono text-xs leading-relaxed', props.className)} />
}

export function Select(props: SelectHTMLAttributes<HTMLSelectElement>) {
  return <select {...props} className={clsx(control, width(props.className), 'h-8 pr-7', props.className)} />
}

export function Toggle({ checked, onChange, label, hint }: { checked: boolean; onChange: (v: boolean) => void; label: ReactNode; hint?: ReactNode }) {
  return (
    <div className="flex items-start gap-3">
      <button
        type="button"
        role="switch"
        aria-checked={checked}
        aria-label={typeof label === 'string' ? label : undefined}
        onClick={() => onChange(!checked)}
        className={clsx('relative mt-0.5 inline-flex h-5 w-9 shrink-0 rounded-full transition-colors', checked ? 'bg-accent' : 'bg-line-strong')}
      >
        <motion.span layout transition={{ type: 'spring', stiffness: 600, damping: 35 }}
          className={clsx('absolute top-0.5 size-4 rounded-full bg-white shadow', checked ? 'right-0.5' : 'left-0.5')} />
      </button>
      <span>
        <span className="text-[13px] font-medium">{label}</span>
        {hint && <span className="block text-xs text-ink-3">{hint}</span>}
      </span>
    </div>
  )
}

export function Tabs<T extends string>({ tabs, value, onChange }: {
  tabs: { id: T; label: ReactNode }[]
  value: T
  onChange: (t: T) => void
}) {
  const group = useId()
  return (
    <div role="tablist" className="scroll-thin flex gap-1 overflow-x-auto border-b border-line">
      {tabs.map((t) => (
        <button
          key={t.id}
          role="tab"
          type="button"
          aria-selected={value === t.id}
          onClick={() => onChange(t.id)}
          className={clsx('relative whitespace-nowrap px-3 py-2 text-[13px] font-medium transition-colors', value === t.id ? 'text-ink' : 'text-ink-3 hover:text-ink')}
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

export function Segmented<T extends string>({ options, value, onChange, size = 'md', label }: {
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
          className={clsx('relative rounded-md px-2.5 font-medium transition-colors', size === 'sm' ? 'h-6 text-xs' : 'h-7 text-[13px]', value === o.id ? 'text-ink' : 'text-ink-3 hover:text-ink')}>
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
        'flex gap-2.5 rounded-lg border px-3 py-2.5 text-[13px]',
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
          {e.details.length > 20 && <li>... and {e.details.length - 20} more</li>}
        </ul>
      ) : null}
      {retry && <Button size="sm" className="mt-2" onClick={retry}>Try again</Button>}
    </Notice>
  )
}

/** Loading placeholder shaped like the content (a spinner on a blank page tells you nothing). */
export function Loading({ label = 'Loading', rows = 4 }: { label?: string; rows?: number }) {
  return (
    <div className="space-y-3 p-4" role="status" aria-label={label}>
      <span className="sr-only">{label}...</span>
      <div className="skeleton h-5 w-1/3" />
      {Array.from({ length: rows }, (_, i) => <div key={i} className="skeleton h-4" style={{ width: `${92 - i * 9}%` }} />)}
    </div>
  )
}

export function PageSkeleton() {
  return (
    <div className="space-y-5" role="status" aria-label="Loading">
      <div className="skeleton h-7 w-64" />
      <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">{[0, 1, 2, 3].map((i) => <div key={i} className="skeleton h-24" />)}</div>
      <div className="skeleton h-64" />
    </div>
  )
}

export function Empty({ title, children, action, icon }: { title: string; children?: ReactNode; action?: ReactNode; icon?: ReactNode }) {
  return (
    <div className="flex flex-col items-start gap-2 rounded-xl border border-dashed border-line-strong bg-surface/50 p-6">
      {icon && <div className="mb-1 text-accent">{icon}</div>}
      <div className="text-[14px] font-semibold">{title}</div>
      {children && <div className="max-w-2xl text-[13px] text-ink-2">{children}</div>}
      {action && <div className="mt-1">{action}</div>}
    </div>
  )
}

export function Code({ children }: { children: ReactNode }) {
  return <code className="rounded bg-surface-2 px-1 py-0.5 font-mono text-[12px]">{children}</code>
}

export function Kbd({ children }: { children: ReactNode }) {
  return <kbd className="inline-flex h-5 min-w-5 items-center justify-center rounded border border-line-strong bg-surface px-1 font-mono text-[10px] font-medium text-ink-2 shadow-[0_1px_0_var(--line-strong)]">{children}</kbd>
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

export function Stat({ label, value, sub, title, tone, hatched, numeric, format, explain }: {
  label: ReactNode
  value?: ReactNode
  sub?: ReactNode
  title?: string
  tone?: 'good' | 'bad' | 'neutral'
  hatched?: boolean
  numeric?: number | null
  format?: (v: number | null) => string
  explain?: ReactNode
}) {
  return (
    <div className={clsx('rounded-xl border border-line bg-surface px-4 py-3 shadow-card', hatched && 'hatched')} title={title}>
      <div className="text-xs font-medium text-ink-3">{label}</div>
      <div className={clsx('num mt-1 text-[26px] font-semibold leading-tight tracking-tight', tone === 'good' && 'text-good-ink', tone === 'bad' && 'text-bad-ink')}>
        {numeric !== undefined && format ? <CountUp value={numeric} format={format} /> : value}
      </div>
      {sub && <div className="num mt-0.5 text-xs text-ink-3">{sub}</div>}
      {explain && <Explain className="mt-1.5">{explain}</Explain>}
    </div>
  )
}

export function Table({ children, className }: { children: ReactNode; className?: string }) {
  return (
    <div className={clsx('scroll-thin overflow-x-auto', className)}>
      <table className="gl-table w-full border-collapse text-[13px] [&_td]:border-t [&_td]:border-line [&_th]:text-left [&_th]:text-xs [&_th]:font-medium [&_th]:text-ink-3">
        {children}
      </table>
    </div>
  )
}

export function PageHeader({ title, description, actions, eyebrow }: { title: ReactNode; description?: ReactNode; actions?: ReactNode; eyebrow?: ReactNode }) {
  return (
    <div className="mb-5 flex flex-wrap items-end justify-between gap-3">
      <div className="min-w-0">
        {eyebrow && <div className="mb-1 text-xs font-medium text-ink-3">{eyebrow}</div>}
        <h1 className="text-[22px] font-semibold leading-tight tracking-tight">{title}</h1>
        {description && <div className="mt-1 max-w-3xl text-[13px] text-ink-2">{description}</div>}
      </div>
      {actions && <div className="flex flex-wrap items-center gap-2">{actions}</div>}
    </div>
  )
}

/** Plain-English text shown only when "Explain" is on (top bar switch, or the E key). */
export function Explain({ children, className }: { children: ReactNode; className?: string }) {
  const { explain } = usePrefs()
  if (!explain) return null
  return (
    <motion.div initial={{ opacity: 0, y: -2 }} animate={{ opacity: 1, y: 0 }}
      className={clsx('flex gap-1.5 text-xs leading-snug text-accent-ink', className)}>
      <span aria-hidden className="mt-[5px] size-1.5 shrink-0 rounded-full bg-accent" />
      <span>{children}</span>
    </motion.div>
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
        <motion.div role="tooltip" initial={{ opacity: 0, y: 3 }} animate={{ opacity: 1, y: 0 }} transition={{ duration: 0.12 }}
          className="pointer-events-none fixed z-[80] w-72 rounded-lg border border-line bg-surface p-3 text-xs font-normal normal-case tracking-normal shadow-pop"
          style={{ left: pos.x, top: pos.y }}>
          <div className="mb-0.5 font-semibold text-ink">{g.term}</div>
          <div className="text-ink-2">{g.plain}</div>
        </motion.div>,
        document.body,
      )}
    </>
  )
}

/** Pass/fail dots for the trials of one case: three dots, the third hollow red = third try failed. */
export function DotStrip({ statuses, size = 8, title }: { statuses: string[]; size?: number; title?: string }) {
  const passed = statuses.filter((s) => s === 'passed').length
  return (
    <span className="inline-flex items-center gap-[3px]" title={title ?? `${passed} of ${statuses.length} passed`} aria-label={`${passed} of ${statuses.length} passed`}>
      {statuses.map((s, i) => (
        <span key={i} className={clsx('rounded-full', s === 'passed' ? 'bg-good' : s === 'failed' ? 'bg-bad' : s === 'error' ? 'bg-error' : 'border border-untested')}
          style={{ width: size, height: size }} />
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

/** The colour names a chatbot can choose. */
export const PROJECT_COLORS: Record<string, string> = {
  teal: '#0f9b96', blue: '#2a78d6', violet: '#7c5cd6', rose: '#d64f7a', amber: '#d89a0b', green: '#2f9e57', slate: '#5f6b72', orange: '#e0682f',
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
    <span className="inline-flex shrink-0 items-center justify-center rounded-lg font-semibold text-white shadow-sm"
      style={{ width: size, height: size, background: `linear-gradient(135deg, ${c}, color-mix(in srgb, ${c} 68%, black))`, fontSize: size * 0.38 }}>
      {initials || '?'}
    </span>
  )
}
