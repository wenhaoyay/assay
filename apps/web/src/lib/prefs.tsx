// Viewer preferences: theme, density and motion. Stored in
// this browser only (they are conveniences, not data), applied as attributes on <html> so CSS
// can follow them.
import { MotionConfig } from 'motion/react'
import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from 'react'

export type Theme = 'light' | 'dark'
export type Density = 'comfortable' | 'compact'
export type Motion = 'full' | 'reduced'

export interface Prefs {
  theme: Theme
  density: Density
  motion: Motion
  annotator: string
}

const DEFAULTS: Prefs = { theme: 'light', density: 'comfortable', motion: 'full', annotator: '' }

function read<K extends keyof Prefs>(key: K): Prefs[K] {
  try {
    const raw = localStorage.getItem(`gl-${key}`)
    if (raw === null) {
      if (key === 'motion' && window.matchMedia?.('(prefers-reduced-motion: reduce)').matches) return 'reduced' as Prefs[K]
      if (key === 'annotator') return (localStorage.getItem('gl-reviewer') ?? '') as Prefs[K]
      return DEFAULTS[key]
    }
    return raw as Prefs[K]
  } catch {
    return DEFAULTS[key]
  }
}

interface PrefsApi extends Prefs {
  set: <K extends keyof Prefs>(key: K, value: Prefs[K]) => void
  toggle: (key: 'theme' | 'density' | 'motion') => void
}

const Ctx = createContext<PrefsApi | null>(null)

export function PrefsProvider({ children }: { children: ReactNode }) {
  const [prefs, setPrefs] = useState<Prefs>(() => ({
    theme: (document.documentElement.dataset.theme as Theme) ?? read('theme'),
    density: read('density'),
    motion: read('motion'),
    annotator: read('annotator'),
  }))

  useEffect(() => {
    const el = document.documentElement
    el.dataset.theme = prefs.theme
    el.dataset.density = prefs.density
    el.dataset.motion = prefs.motion
  }, [prefs.theme, prefs.density, prefs.motion])

  const set = useCallback(<K extends keyof Prefs>(key: K, value: Prefs[K]) => {
    setPrefs((p) => ({ ...p, [key]: value }))
    try {
      localStorage.setItem(`gl-${key}`, String(value))
    } catch {
      /* private mode: the preference lasts for this visit */
    }
  }, [])

  const toggle = useCallback((key: 'theme' | 'density' | 'motion') => {
    setPrefs((p) => {
      const next =
        key === 'theme' ? (p.theme === 'dark' ? 'light' : 'dark')
        : key === 'density' ? (p.density === 'compact' ? 'comfortable' : 'compact')
        : p.motion === 'reduced' ? 'full' : 'reduced'
      try {
        localStorage.setItem(`gl-${key}`, String(next))
      } catch {
        /* ignore */
      }
      return { ...p, [key]: next }
    })
  }, [])

  const api = useMemo(() => ({ ...prefs, set, toggle }), [prefs, set, toggle])
  return (
    <Ctx.Provider value={api}>
      <MotionConfig reducedMotion={prefs.motion === 'reduced' ? 'always' : 'user'}>{children}</MotionConfig>
    </Ctx.Provider>
  )
}

export function usePrefs(): PrefsApi {
  const v = useContext(Ctx)
  if (!v) {
    // Components rendered outside the provider (unit tests) get the defaults.
    return { ...DEFAULTS, set: () => {}, toggle: () => {} }
  }
  return v
}

/** True when animations should play (respects the in-app setting and the OS setting). */
export function useMotionOn(): boolean {
  const { motion } = usePrefs()
  const [os, setOs] = useState(() => window.matchMedia?.('(prefers-reduced-motion: reduce)').matches ?? false)
  useEffect(() => {
    const mq = window.matchMedia?.('(prefers-reduced-motion: reduce)')
    if (!mq) return
    const on = () => setOs(mq.matches)
    mq.addEventListener?.('change', on)
    return () => mq.removeEventListener?.('change', on)
  }, [])
  return motion === 'full' && !os
}
