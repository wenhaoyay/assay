// The chatbots to offer in lists. "Hide demo data" (Settings) drops the seeded demo chatbot from
// pickers and the home page; it is still there, and still reachable by its own links.
import { useQuery } from '@tanstack/react-query'
import { api } from './api'
import type { Project, Settings } from './types'

export function useSettings() {
  return useQuery({ queryKey: ['settings'], queryFn: () => api.get<{ values: Settings }>('/api/settings') })
}

export function useProjects() {
  const projects = useQuery({ queryKey: ['projects'], queryFn: () => api.get<Project[]>('/api/projects') })
  const settings = useSettings()
  const hideDemo = !!settings.data?.values.hide_demo
  const all = projects.data ?? []
  const visible = hideDemo ? all.filter((p) => !p.is_demo) : all
  return { ...projects, all, visible, hideDemo }
}

/** "Acme Support Demo" -> "Acme Support Demo (demo)" in a <select>, where a badge cannot go. */
export const projectOption = (p: Project) => (p.is_demo ? `${p.name} (demo)` : p.name)
