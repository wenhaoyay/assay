# Background jobs

Runs, re-grades, re-reads, re-asks, judge bake-offs and model downloads run in the background.
They share one contract so every screen can say what is happening, how long it will take, and
stop it.

## States

`queued` → `running` → `completed` | `completed_with_errors` | `failed` | `cancelled`, with
`running` → `cancelling` → `cancelled` when someone stops it.

- **Stop** (`POST /api/runs/{id}/cancel`, `POST /api/bakeoffs/{id}/cancel`) sets `cancelling`
  at once and persists it. In-flight calls to the bot and the grading model are cancelled (the
  task is cancelled, so the HTTP request is dropped); answers that were in flight are stored as
  `cancelled`. The job reaches `cancelled` within a few seconds. Stopping a job that is already
  `cancelling` or `cancelled` returns it unchanged (200); stopping a finished job is a 409.
- **Errors anywhere** (setting up the adapter or grading model, running, writing the summary)
  end the job as `failed` with `error` set to a plain sentence for the screen (no exception
  class names). A job is never left `queued` or `running` by an exception.
- **Server restart**: `queued`/`running` jobs become `failed` with "The server stopped while this
  was running."; `cancelling` jobs become `cancelled`. Bake-offs get the same treatment.
- **Model downloads** keep their progress in memory. After a restart the progress endpoint
  answers `{"status": "lost", "done": true, "error": "The server restarted during the download.
  Start it again."}` so the screen stops polling. A download whose stream sends nothing for 60 s
  fails with a timeout.

## Progress (in `GET /api/runs/{id}` and the bake-off record)

```json
"n_questions": 58,
"progress": {
  "total": 580, "asked": 12, "graded": 8,
  "judge_calls_done": 41, "judge_calls_total": 3480,
  "waiting_on": "grading_model",
  "grading_model": "ollama/llama3.1:8b",
  "eta_s": 104000
}
```

- `n_questions` is known from the start (stored in the run snapshot), never `null` while live.
- `asked`: answers requested from the bot; `graded`: answers fully graded (= `progress_done`).
- `judge_calls_*`: grading-model calls; `judge_calls_total` is `null` when no grading model.
- `waiting_on`: `"bot"`, `"grading_model"` or `null` (idle/finished).
- `eta_s`: from the estimate made when the job started (stored in the snapshot as
  `estimate.seconds`), replaced by the observed rate once a few answers are graded. `null` only
  when nothing is known. Never derived from cancelled answers.
- Live values come from the running process; when the job is not running here, `asked =
  graded`, `waiting_on = null`.

## Estimates before starting

- `POST /api/estimate` (New run) returns `seconds` including grading-model time.
- `POST /api/runs/{id}/reevaluate`, `POST /api/runs/{id}/reask-load-errors`, `POST /api/bakeoffs`
  and `POST /api/datasets/{id}/generate-candidates` accept `"estimate_only": true` and then return
  `{"seconds": ..., "judge_calls": ..., "cost_usd": ...}` without starting anything.
- The screens ask for confirmation when `seconds > 3600` ("This will take about 29 hours on
  this computer. Start anyway?").
- The connect dry run's full-run time includes grading time for the default grading model.

## Grading-model calls

- One queue per grading model: a local model (Ollama, LM Studio on this computer) takes one call
  at a time; a cloud model takes as many as the run's "In parallel".
- The HTTP timeout covers the request only, not the time spent waiting in that queue.
- A timeout is retried once. One grade has an overall deadline of 5 minutes; past it the check
  is an `error` ("The grading model took longer than 5 minutes.").

## Quick check

A run setup preset, the default on New run: 30 questions sampled across categories (fixed
seed, so repeat runs ask the same 30), 1 try, the objective checks plus `correctness`. The
case filter gains `{"sample": 30, "seed": 7}` (stratified by category, deterministic).
