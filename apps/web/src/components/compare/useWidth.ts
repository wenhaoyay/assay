import { useLayoutEffect, useRef, useState } from 'react'

/** The width of a container, kept up to date (charts draw at their real pixel width). */
export function useWidth<T extends HTMLElement = HTMLDivElement>(fallback = 640) {
  const ref = useRef<T>(null)
  const [w, setW] = useState(fallback)
  useLayoutEffect(() => {
    const el = ref.current
    if (!el) return
    setW(el.clientWidth || fallback)
    const ro = new ResizeObserver(([e]) => setW(Math.max(120, Math.floor(e.contentRect.width))))
    ro.observe(el)
    return () => ro.disconnect()
  }, [fallback])
  return [ref, w] as const
}
