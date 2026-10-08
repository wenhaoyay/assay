import type { ProviderConfig } from './types'

/** Where a grading model's calls go, in words for a <select> or a badge. */
export const whereLabel = (m: Pick<ProviderConfig, 'local' | 'cloud_via_ollama'>) =>
  m.cloud_via_ollama ? 'cloud via Ollama' : m.local ? 'local' : 'cloud'
