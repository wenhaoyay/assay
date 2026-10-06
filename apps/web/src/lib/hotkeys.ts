// Keyboard shortcuts. Single keys are ignored while typing in a field; "mod+k" works anywhere.
// Sequences like "g h" (go home) are supported: press g, then h within a second.
import { useEffect, useRef, useState } from 'react'

function typing(e: KeyboardEvent): boolean {
  const el = e.target as HTMLElement | null
  if (!el) return false
  const tag = el.tagName
  return tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT' || el.isContentEditable
}

function matches(e: KeyboardEvent, combo: string): boolean {
  const parts = combo.toLowerCase().split('+')
  const key = parts[parts.length - 1]
  const mod = parts.includes('mod')
  const shift = parts.includes('shift')
  if (mod !== (e.ctrlKey || e.metaKey)) return false
  if (parts.includes('shift') && !e.shiftKey) return false
  const k = e.key.toLowerCase()
  if (key === '?') return e.key === '?'
  if (key === 'enter') return k === 'enter'
  if (key === 'escape') return k === 'escape'
  if (!shift && e.shiftKey && key.length === 1 && key !== k) return false
  return k === key
}

let lastKey: { key: string; at: number } | null = null

/** Run ``handler`` when one of the combos is pressed. Combos: "j", "mod+k", "?", "g h". */
export function useHotkey(combos: string | string[], handler: (e: KeyboardEvent) => void, enabled = true) {
  const ref = useRef(handler)
  useEffect(() => {
    ref.current = handler
  })
  const list = Array.isArray(combos) ? combos : [combos]
  const key = list.join('|')
  useEffect(() => {
    if (!enabled) return
    const combosNow = key.split('|')
    const onKey = (e: KeyboardEvent) => {
      if (e.defaultPrevented) return
      for (const combo of combosNow) {
        const global = combo.includes('mod+') || combo === 'escape'
        if (!global && typing(e)) continue
        if (combo.includes(' ')) {
          const [first, second] = combo.split(' ')
          if (lastKey && lastKey.key === first && Date.now() - lastKey.at < 1000 && e.key.toLowerCase() === second && !e.ctrlKey && !e.metaKey) {
            e.preventDefault()
            lastKey = null
            ref.current(e)
            return
          }
          continue
        }
        if (matches(e, combo)) {
          e.preventDefault()
          ref.current(e)
          return
        }
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [key, enabled])
}

// Remember the last plain key for sequences ("g" then "h").
if (typeof window !== 'undefined') {
  window.addEventListener('keydown', (e) => {
    if (!typing(e) && !e.ctrlKey && !e.metaKey && e.key.length === 1) lastKey = { key: e.key.toLowerCase(), at: Date.now() }
  }, true)
}

/** j/k to move through a list, Enter to open the picked row. Rows carry data-kb-index. */
export function useListNav(count: number, onOpen: (index: number) => void, enabled = true) {
  const [active, setActive] = useState(-1)
  const clamped = Math.min(active, count - 1)
  const move = (d: number) => {
    setActive((a) => {
      const next = Math.max(0, Math.min(count - 1, (a < 0 ? (d > 0 ? -1 : count) : a) + d))
      requestAnimationFrame(() => document.querySelector(`[data-kb-index="${next}"]`)?.scrollIntoView({ block: 'nearest' }))
      return next
    })
  }
  useHotkey(['j', 'arrowdown'], () => move(1), enabled && count > 0)
  useHotkey(['k', 'arrowup'], () => move(-1), enabled && count > 0)
  useHotkey('enter', () => { if (clamped >= 0) onOpen(clamped) }, enabled && clamped >= 0)
  return [clamped, setActive] as const
}
