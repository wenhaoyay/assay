# Changelog

All notable changes to Assay are recorded here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/).

## [Unreleased] - 0.2.0

### Added

- Redesigned home pages: each chatbot opens on a verdict (better, worse or within noise) with a
  gauge, the trend of comparable runs and where in the pipeline failures start.
- A connect wizard: paste a curl command, send a test question, click the reply to map it, see
  which checks that unlocks, dry-run for time and cost. Secrets found in the command move to
  the OS credential store.
- Settings > Models & keys: connect OpenAI, Anthropic, Azure, Gemini, OpenRouter, any
  OpenAI-compatible gateway or a local model; a 5-call check reports speed, JSON reliability
  and cost per 100 grading calls.
- Golden-set building: approve or correct answers as flashcards, a prompt kit, real questions
  from chat history, an interview mode, a spreadsheet template, variations of a case, coverage
  and checks on the set itself.
- "What to fix first": every failed answer gets a likely cause with evidence, counted per run,
  and Compare shows what a change fixed and broke by cause.
- The instrument interface: a design system with OKLCH tokens, a gauge needle, run
  fingerprints, linked charts in Explore, live runs, and a release receipt.
- Local grading models: an Ollama setup guide with a third-party notice, and a judge bake-off.
- Three weeks of demo history (`assay seed --run --history`, `make demo-fresh`).
- Background jobs: stop, progress and estimates (work in progress).

### Changed

- The project is renamed from GaugeLab to Assay: package, command and every screen. A database saved under the old name (`data/gaugelab.db`) is still used when `data/assay.db` does not exist.
- Runs that are not comparable (different cases, checks or judge) are kept out of trends and
  flagged.
- Comparability now includes the version of each check and the judge's prompt template and
  settings, so a changed check no longer compares silently with an older run.
- Calibration is reported as agreement with human labels (accuracy, F1, Cohen's kappa) per
  judge model.

### Fixed

- Local-only security: the API answers only requests addressed to `localhost` or `127.0.0.1`
  (`ASSAY_ALLOWED_HOSTS` adds names); Python connections may name only the demo agent or a
  module listed in `ASSAY_PYTHON_TARGETS`; "local grading models only" is enforced wherever a
  run, re-grade, explanation or bake-off starts, not only in the screens.
- PostgreSQL: migration 0003 set a boolean column with an integer, which Postgres refuses; a fresh Postgres database now migrates and seeds the demo.
- A check the connection cannot measure is shown as not measured and never counts as a pass.
- Raw responses and the stored copy of each answer, trace and verdict are redacted before
  storage.
- The spend cap reserves each answer's expected cost.

## [0.1.0] - 2026-10-06

The first version.

### Added

- The core engine: adapters (HTTP with field mapping and stream reducers, Python, log replay),
  deterministic, retrieval, agent and performance evaluators, LLM-judge rubrics with strict
  JSON output and injection-resistant fencing, a runner with repeated trials, traces with
  redaction, and regression gates.
- Statistics: case-level bootstrap intervals, paired deltas, McNemar's exact test, pass@k and
  pass^k, Cohen's kappa.
- A FastAPI app with Alembic migrations, SQLite by default and Postgres supported, and a
  command-line interface (`run`, `compare`, `gate`, `export`, `ci`, `seed`, `serve`).
- A web app: overview, targets, datasets, experiments, runs, compare, calibration and traces.
- The fictional Acme demo agent and a 58-case golden dataset, with a case study including a
  local-LLM-judge run.
- Docker Compose (written, not yet run) and GitHub Actions workflows.
