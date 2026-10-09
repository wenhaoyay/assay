// What a run's status means for the screen, in one place.
import type { RunHeader, RunStatus } from './types'

/** Queued, running, or being stopped: the screen keeps polling. */
export const isLive = (s: RunStatus | string | undefined | null) => s === 'queued' || s === 'running' || s === 'cancelling'

/** Finished with results worth comparing. */
export const isCompleted = (s: RunStatus | string | undefined | null) => s === 'completed' || s === 'completed_with_errors'

/** How many questions a run asks: the server's count, else tries divided by tries per question. */
export function questionsOf(r: Pick<RunHeader, 'n_questions' | 'n_cases' | 'progress_total' | 'trials_per_case'> | undefined | null): number | null {
  if (!r) return null
  if (r.n_questions != null) return r.n_questions
  if (r.n_cases != null) return r.n_cases
  const per = r.trials_per_case || 1
  return r.progress_total ? Math.round(r.progress_total / per) : null
}
