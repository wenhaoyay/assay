// The context bar ("Acme Support › Run #6 › fact_03 › trial 2"). Pages declare their trail;
// the layout shows it. Every part is a link.
import { createContext, useContext, useEffect, useState, type ReactNode } from 'react'

export interface Crumb {
  label: ReactNode
  to?: string
}

const Ctx = createContext<{ crumbs: Crumb[]; set: (c: Crumb[]) => void }>({ crumbs: [], set: () => {} })

export function CrumbsProvider({ children }: { children: ReactNode }) {
  const [crumbs, set] = useState<Crumb[]>([])
  return <Ctx.Provider value={{ crumbs, set }}>{children}</Ctx.Provider>
}

export function useCrumbsValue() {
  return useContext(Ctx).crumbs
}

/** Declare this page's trail. Pass a key that changes when the trail should change. */
export function useCrumbs(crumbs: Crumb[], key: string) {
  const { set } = useContext(Ctx)
  useEffect(() => {
    set(crumbs)
    return () => set([])
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key])
}
