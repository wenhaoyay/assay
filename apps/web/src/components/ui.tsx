// Small UI primitives (the role shadcn/ui would play), styled with the token classes.
import clsx from 'clsx'
import { AlertTriangle, Check, CircleSlash, Info, Loader2, X } from 'lucide-react'
import type { ButtonHTMLAttributes, InputHTMLAttributes, ReactNode, SelectHTMLAttributes, TextareaHTMLAttributes } from 'react'
import { ApiError } from '../lib/api'

export function Button({
  variant = 'secondary',
  size = 'md',
  loading,
  className,
  children,
  ...rest
}: ButtonHTMLAttributes<HTMLButtonElement> & {
  variant?: 'primary' | 'secondary' | 'ghost' | 'danger'
  size?: 'sm' | 'md'
  loading?: boolean
}) {
  return (
    <button
      {...rest}
      disabled={rest.disabled || loading}
      className={clsx(
        'inline-flex items-center justify-center gap-1.5 rounded-md font-medium transition-colors disabled:cursor-not-allowed disabled:opacity-50',
        size === 'sm' ? 'h-7 px-2.5 text-xs' : 'h-8 px-3 text-[13px]',
        variant === 'primary' && 'bg-ink text-surface hover:bg-ink/85',
        variant === 'secondary' && 'border border-line-strong bg-surface text-ink hover:bg-surface-2',
        variant === 'ghost' && 'text-ink-2 hover:bg-surface-2 hover:text-ink',
        variant === 'danger' && 'border border-bad/40 bg-surface text-bad-ink hover:bg-bad-wash',
        className,
      )}
    >
      {loading && <Loader2 className="size-3.5 animate-spin" aria-hidden />}
      {children}
    </button>
  )
}

export function Card({ title, actions, children, className, padded = true }: {
  title?: ReactNode
  actions?: ReactNode
  children: ReactNode
  className?: string
  padded?: boolean
}) {
  return (
    <section className={clsx('rounded-lg border border-line bg-surface', className)}>
      {(title || actions) && (
        <header className="flex min-h-10 items-center justify-between gap-3 border-b border-line px-4 py-2">
          <h2 className="text-[13px] font-semibold">{title}</h2>
          <div className="flex items-center gap-2">{actions}</div>
        </header>
      )}
      <div className={clsx(padded && 'p-4')}>{children}</div>
    </section>
  )
}

type Tone = 'neutral' | 'good' | 'bad' | 'warn' | 'info'

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
  error: { tone: 'bad', text: 'Error', icon: 'warn' },
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

export function Field({ label, hint, children, error }: { label: string; hint?: ReactNode; children: ReactNode; error?: string }) {
  return (
    <label className="block space-y-1">
      <span className="text-xs font-medium text-ink-2">{label}</span>
      {children}
      {hint && !error && <span className="block text-xs text-ink-3">{hint}</span>}
      {error && <span className="block text-xs text-bad-ink">{error}</span>}
    </label>
  )
}

const control =
  'rounded-md border border-line-strong bg-surface px-2.5 text-[13px] text-ink placeholder:text-ink-3 focus:border-accent focus:outline-none'
// Full width unless the caller sets a width (Tailwind cannot order two width utilities by class order).
const width = (className?: string) => (/(^|\s)(max-)?w-/.test(className ?? '') ? '' : 'w-full')

export function Input(props: InputHTMLAttributes<HTMLInputElement>) {
  return <input {...props} className={clsx(control, width(props.className), 'h-8', props.className)} />
}

export function Textarea(props: TextareaHTMLAttributes<HTMLTextAreaElement>) {
  return <textarea {...props} className={clsx(control, width(props.className), 'py-2 font-mono text-xs leading-relaxed', props.className)} />
}

export function Select(props: SelectHTMLAttributes<HTMLSelectElement>) {
  return <select {...props} className={clsx(control, width(props.className), 'h-8 pr-7', props.className)} />
}

export function Tabs<T extends string>({ tabs, value, onChange }: {
  tabs: { id: T; label: ReactNode }[]
  value: T
  onChange: (t: T) => void
}) {
  return (
    <div role="tablist" className="flex gap-1 border-b border-line">
      {tabs.map((t) => (
        <button
          key={t.id}
          role="tab"
          aria-selected={value === t.id}
          onClick={() => onChange(t.id)}
          className={clsx(
            '-mb-px border-b-2 px-3 py-2 text-[13px] font-medium',
            value === t.id ? 'border-ink text-ink' : 'border-transparent text-ink-3 hover:text-ink',
          )}
        >
          {t.label}
        </button>
      ))}
    </div>
  )
}

export function Notice({ tone = 'info', title, children }: { tone?: 'info' | 'warn' | 'bad' | 'good'; title?: ReactNode; children?: ReactNode }) {
  const Icon = tone === 'bad' || tone === 'warn' ? AlertTriangle : tone === 'good' ? Check : Info
  return (
    <div
      role={tone === 'bad' ? 'alert' : 'status'}
      className={clsx(
        'flex gap-2.5 rounded-md border px-3 py-2.5 text-[13px]',
        tone === 'info' && 'border-accent/25 bg-info-wash',
        tone === 'warn' && 'border-warn/40 bg-warn-wash',
        tone === 'bad' && 'border-bad/30 bg-bad-wash',
        tone === 'good' && 'border-good/30 bg-good-wash',
      )}
    >
      <Icon className={clsx('mt-0.5 size-4 shrink-0', tone === 'bad' ? 'text-bad-ink' : tone === 'warn' ? 'text-warn-ink' : tone === 'good' ? 'text-good-ink' : 'text-accent-ink')} aria-hidden />
      <div className="min-w-0 space-y-1">
        {title && <div className="font-medium">{title}</div>}
        {children && <div className="text-ink-2">{children}</div>}
      </div>
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

export function Loading({ label = 'Loading' }: { label?: string }) {
  return (
    <div className="flex items-center gap-2 p-6 text-[13px] text-ink-3" role="status">
      <Loader2 className="size-4 animate-spin" aria-hidden /> {label}...
    </div>
  )
}

export function Empty({ title, children, action }: { title: string; children?: ReactNode; action?: ReactNode }) {
  return (
    <div className="flex flex-col items-start gap-2 rounded-lg border border-dashed border-line-strong p-6">
      <div className="text-[13px] font-semibold">{title}</div>
      {children && <div className="max-w-2xl text-[13px] text-ink-2">{children}</div>}
      {action}
    </div>
  )
}

export function Code({ children }: { children: ReactNode }) {
  return <code className="rounded bg-surface-2 px-1 py-0.5 font-mono text-[12px]">{children}</code>
}

export function Json({ value, maxHeight = 360 }: { value: unknown; maxHeight?: number }) {
  return (
    <pre className="code scroll-thin overflow-auto rounded-md border border-line bg-surface-2 p-3" style={{ maxHeight }}>
      {typeof value === 'string' ? value : JSON.stringify(value, null, 2)}
    </pre>
  )
}

export function Stat({ label, value, sub, title }: { label: ReactNode; value: ReactNode; sub?: ReactNode; title?: string }) {
  return (
    <div className="rounded-lg border border-line bg-surface px-4 py-3" title={title}>
      <div className="text-xs text-ink-3">{label}</div>
      <div className="num mt-1 text-2xl font-semibold tracking-tight">{value}</div>
      {sub && <div className="num mt-0.5 text-xs text-ink-3">{sub}</div>}
    </div>
  )
}

export function Table({ children, className }: { children: ReactNode; className?: string }) {
  return (
    <div className={clsx('scroll-thin overflow-x-auto', className)}>
      <table className="w-full border-collapse text-[13px] [&_td]:border-t [&_td]:border-line [&_td]:px-3 [&_td]:py-2 [&_th]:px-3 [&_th]:py-2 [&_th]:text-left [&_th]:text-xs [&_th]:font-medium [&_th]:text-ink-3">
        {children}
      </table>
    </div>
  )
}

export function PageHeader({ title, description, actions }: { title: ReactNode; description?: ReactNode; actions?: ReactNode }) {
  return (
    <div className="mb-5 flex flex-wrap items-end justify-between gap-3">
      <div>
        <h1 className="text-lg font-semibold tracking-tight">{title}</h1>
        {description && <p className="mt-0.5 max-w-3xl text-[13px] text-ink-2">{description}</p>}
      </div>
      {actions && <div className="flex flex-wrap items-center gap-2">{actions}</div>}
    </div>
  )
}
