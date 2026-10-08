// Shapes returned by the API (apps/api/app/serializers.py and routers).

export type EvalStatus = 'pass' | 'fail' | 'unknown' | 'not_applicable' | 'not_evaluated' | 'error'
export type RunStatus = 'queued' | 'running' | 'completed' | 'completed_with_errors' | 'failed' | 'cancelled'
export type GateStatus = 'PASS' | 'FAIL' | 'INCOMPLETE' | 'NOT_EVALUATED'

export interface Project {
  id: number
  name: string
  description: string
  color?: string
  icon?: string
  is_demo?: boolean
}

export interface TargetVersion {
  id: number
  version: number
  config: Record<string, unknown>
  config_hash: string
  variant_label: string
  notes: string
  created_at: string
}

export interface Target {
  id: number
  project_id: number
  name: string
  description: string
  adapter: 'http' | 'python' | 'replay'
  local_judges_only?: boolean
  shared?: boolean
  cost_per_answer_usd?: number | null
  last_check?: TargetCheck | null
  latest_version: TargetVersion
  versions?: TargetVersion[]
}

export interface Expected {
  answer: {
    reference?: string | null
    exact?: string | null
    label?: string | null
    must_mention: string[]
    must_not_claim: string[]
    regex: string[]
    forbidden_regex?: string[]
    json_schema?: Record<string, unknown> | null
  }
  relevant_documents: string[]
  required_citations: string[]
  required_tools: string[]
  tool_calls: { name: string; arguments: Record<string, unknown> }[]
  forbidden_tools: string[]
  expected_outcome: Record<string, unknown>
  refusal_expected?: boolean | null
  [k: string]: unknown
}

export interface TestCase {
  id: string
  title: string
  category: string
  description: string
  difficulty: string
  tags: string[]
  input: { message: string; history: { role: string; content: string }[]; fields: Record<string, unknown> }
  expected: Expected
  evaluators: string[] | null
  evaluator_config: Record<string, Record<string, unknown>>
  enabled: boolean
  metadata: Record<string, unknown>
  _row_id?: number
  _origin?: string
}

export interface DatasetVersion {
  id: number
  dataset_id: number
  version: number
  parent_version_id: number | null
  status: 'draft' | 'frozen'
  content_hash: string
  case_count: number
  change_summary: string
  created_at: string
  frozen_at: string | null
  run_count: number
  cases?: TestCase[]
  dataset_name?: string
}

export interface Dataset {
  id: number
  project_id: number
  name: string
  description: string
  versions: DatasetVersion[]
  latest: DatasetVersion | null
  unreviewed_candidates: number
  archived?: boolean
  run_count?: number
}

export interface EditResult extends DatasetVersion {
  branched: boolean
  notice?: string
}

export interface Metrics {
  overall_pass_rate?: number | null
  tool_accuracy?: number | null
  p50_latency_ms?: number | null
  p95_latency_ms?: number | null
  average_total_tokens?: number | null
  average_cost_usd?: number | null
  total_judge_cost_usd?: number | null
  [k: string]: number | null | undefined
}

export interface JudgeInfo {
  provider: string
  model: string
  temperature?: number
  kind?: string
}

export interface RunHeader {
  id: number
  experiment_id: number
  project_id?: number | null
  target_id?: number | null
  dataset_id?: number | null
  comparability_key?: string
  case_filter?: Record<string, string[]> | null
  concurrency?: number | null
  experiment: string
  status: RunStatus
  source: 'live' | 'imported' | 'reevaluated'
  parent_run_id: number | null
  stop_reason: string | null
  error: string | null
  target: string
  target_version: number
  variant_label: string
  dataset: string
  dataset_version: number
  trials_per_case: number
  judge: JudgeInfo | null
  progress_done: number
  progress_total: number
  created_at: string
  started_at: string | null
  finished_at: string | null
  metrics: Metrics
  n_cases: number | null
  failed_trials: number | null
  gate_status: GateStatus | null
  /** 95% interval of the overall pass rate. */
  overall_ci?: [number | null, number | null]
  /** The chatbot whose questions this run asked, when they were written for another one. */
  off_topic?: string | null
}

export interface EvaluatorSummary {
  pass_rate: number | null
  ci_low: number | null
  ci_high: number | null
  n_cases: number
  n_decided: number
  counts: Partial<Record<EvalStatus, number>>
  mean_score: number | null
  kind: string
  version: string
  gating: boolean
}

export interface Reliability {
  k: number
  pass_at_k: number | null
  pass_hat_k: number | null
  n_cases: number
}

export interface RunSummary {
  n_cases: number
  n_trials: number
  trials_per_case: number
  status_counts: Record<string, number>
  overall: { value: number | null; ci_low: number | null; ci_high: number | null; n: number }
  metrics: Metrics
  evaluators: Record<string, EvaluatorSummary>
  reliability: Record<string, Reliability | string[]> & { flaky_cases?: string[] }
  failures: Record<string, number>
  failed_trials: number
  by_category: Record<string, { pass_rate: number | null; n: number }>
  by_difficulty: Record<string, { pass_rate: number | null; n: number }>
  by_tag: Record<string, { pass_rate: number | null; n: number }>
  telemetry: Record<string, number>
}

export interface GateCheck {
  gate: string
  metric: string
  rule: 'min' | 'max'
  limit: number
  value: number | null
  status: 'PASS' | 'FAIL' | 'NOT_EVALUATED'
  kind: 'absolute' | 'relative'
  baseline: number | null
  reason?: string
}

export interface GateResult {
  id: number
  status: GateStatus
  baseline_run_id: number | null
  gate_id: number | null
  results: { status: GateStatus; gates: GateCheck[] }
  created_at: string
}

export interface RunDetail extends RunHeader {
  summary: RunSummary | null
  snapshot: Record<string, unknown>
  gate_results: GateResult[]
  load_errors?: { count: number; case_ids: string[] }
}

export interface TrialRow {
  id: number
  run_id: number
  case_id: string
  trial_index: number
  status: 'passed' | 'failed' | 'error' | 'unscored' | 'cancelled'
  answer: string
  latency_ms: number | null
  total_tokens: number | null
  target_cost_usd: number | null
  judge_cost_usd: number | null
  attempts: number
  failure_types: string[]
  failure_override: boolean
  failure_note: string
  failed_evaluators: string[]
  title: string
  category: string | null
  difficulty: string | null
  tags: string[]
  question: string | null
}

export interface Score {
  evaluator_id: string
  evaluator_version: string
  kind: string
  status: EvalStatus
  gating: boolean
  score: number | null
  label: string | null
  threshold: number | null
  explanation: string
  evidence: string[]
  failure_type: string | null
  judge_cost_usd: number | null
  duration_ms: number
  metadata: Record<string, unknown>
}

export interface Span {
  span_id: string
  parent_span_id: string | null
  type: string
  name: string
  start_time: number
  end_time: number
  duration_ms: number
  status: string
  input_summary: string | null
  output_summary: string | null
  metadata: Record<string, unknown>
  usage: { input_tokens?: number | null; output_tokens?: number | null; total_tokens?: number | null } | null
  cost_usd: number | null
  error: string | null
}

export interface TargetResult {
  answer: string
  citations: { id: string; title?: string; quote?: string; n?: number | string; label?: string }[] | null
  retrieved_documents: { id: string; title?: string; score?: number; text?: string; n?: number | string; label?: string; page?: number | string; date?: string }[] | null
  tool_calls: { name: string; arguments: Record<string, unknown>; result: unknown; status: string }[] | null
  usage: { input_tokens?: number | null; output_tokens?: number | null; total_tokens?: number | null } | null
  provider: { provider?: string; model?: string } | null
  error: string | null
  latency_ms: number | null
  metadata: Record<string, unknown>
}

export interface TrialDetail extends TrialRow {
  case: TestCase | null
  result: TargetResult | null
  raw: unknown
  scores: Score[]
  trace: { trace_id: string; spans: Span[] } | null
  sibling_trials: { id: number; trial_index: number; status: string }[]
  annotations: { dimension: string; label: string; annotator: string; note: string }[]
  cause: Verdict | null
  cause_ai: { cause: string; reason: string; confidence: string; model: string; cost_usd: number | null; at: string } | null
}

/** Why a failed answer failed (gaugelab/diagnosis.py). */
export interface Verdict {
  cause: string
  label: string
  kind: 'bot' | 'content' | 'test' | 'run' | 'unknown'
  fix: string
  evidence: string[]
  source: 'rule' | 'you' | 'ai'
  rule?: string
  model?: string
  confidence?: string
  maybe?: string
  needs_sources?: boolean
}

export interface CauseCount {
  cause: string
  label: string
  kind: Verdict['kind']
  fix: string
  cases: number
  examples: { trial_id: number; case_id: string; title: string; question?: string | null }[]
}

export interface RunCauses {
  run_id: number
  causes: CauseCount[]
  by_trial: Record<string, Verdict>
  by_case: Record<string, string>
  sources_reported: boolean
  documents: number
  off_topic: string | null
  kinds: Record<string, string>
  unplaced: number[]
}

export interface ComparisonRow {
  metric: string
  label: string
  unit: 'rate' | 'score' | 'latency' | 'count' | 'cost'
  baseline: number | null
  candidate: number | null
  delta: number | null
  relative: number | null
  ci: { delta: number; ci_low: number | null; ci_high: number | null; n: number; excludes_zero: boolean } | null
}

export interface CaseChange {
  case_id: string
  title: string
  category: string
  baseline_pass_rate: number | null
  candidate_pass_rate: number | null
  candidate_failure_types: string[]
  baseline_failure_types: string[]
}

export interface Comparison {
  n_shared_cases: number
  only_in_baseline: string[]
  only_in_candidate: string[]
  metrics: ComparisonRow[]
  regressions: CaseChange[]
  improvements: CaseChange[]
  score_changes: { case_id: string; evaluator_id: string; baseline: number; candidate: number }[]
  mcnemar: { both_pass: number; only_baseline: number; only_candidate: number; both_fail: number; p_value: number | null }
  by_category: { category: string; baseline: number | null; candidate: number | null; delta: number | null; n: number }[]
  baseline_run: RunHeader
  candidate_run: RunHeader
  same_dataset_content: boolean
  causes?: { fixed: CauseCount[]; broke: CauseCount[] }
  baseline_summary: Pick<RunSummary, 'metrics' | 'failures' | 'reliability' | 'n_cases' | 'trials_per_case'>
  candidate_summary: Pick<RunSummary, 'metrics' | 'failures' | 'reliability' | 'n_cases' | 'trials_per_case'>
}

export interface EvaluatorInfo {
  id: string
  name: string
  version: string
  kind: 'deterministic' | 'retrieval' | 'agent' | 'llm_judge' | 'performance'
  gating: boolean
  description: string
  rubric?: {
    version: string
    question: string
    labels: Record<string, string>
    needs: string[]
    prompt_hash: string
    notes: string
    system_prompt: string
  }
  calibration?: { n: number; status: string }
}

export interface ProviderConfig {
  id: number
  name: string
  provider: 'openai' | 'ollama' | 'anthropic'
  model: string
  base_url: string | null
  api_key_ref: string | null
  key_status: 'set' | 'missing' | 'invalid' | null
  key_hint?: string | null
  key_kind?: 'env' | 'keyring' | null
  temperature: number
  max_tokens: number
  local?: boolean
  cloud_via_ollama?: boolean
  catalog_id?: string
  used_by_runs?: boolean
  default_for?: string[]
  calibration?: { n: number; by_dimension: Record<string, number>; status: string }
}

export interface Experiment {
  id: number
  project_id: number
  name: string
  description: string
  config: {
    evaluators: string[]
    trials: number
    concurrency: number
    seed: number
    k: number
    judge: Record<string, unknown> | null
    budget_usd: number | null
    options: Record<string, unknown>
  }
  gate_id: number | null
  created_at: string
  target: { id: number; name: string; version: number; version_id: number; variant_label: string } | null
  dataset: { id: number; name: string; version: number; version_id: number } | null
  run_ids: number[]
  latest_run_status: RunStatus | null
}

export interface Gate {
  id: number
  project_id: number
  name: string
  config: Record<string, unknown>
}

export interface Agreement {
  n: number
  accuracy: number | null
  precision: number | null
  recall: number | null
  f1: number | null
  kappa: number | null
  confusion: Record<string, Record<string, number>>
  positive: string
}

export interface CalibrationStats {
  dimension: string
  status: string
  by_judge?: Record<string, number>
  judge_filter?: string | null
  agreement: Agreement
  judges: { provider: string; model: string; prompt_hash: string }[]
  disagreements: {
    trial_id: number
    run_id: number
    case_id: string
    human: string
    judge: string
    judge_reason: string
    note: string
    answer: string
  }[]
  small_sample: boolean
}

export interface CalibrationItem {
  trial_id: number
  run_id: number
  case_id: string
  trial_index: number
  question: string | null
  reference: string | null
  answer: string
  context: { id: string; title?: string; text: string }[]
  tool_calls: TargetResult['tool_calls']
  human: { label: string; annotator: string; note: string } | null
  judge?: { label: string; reason: string; confidence: number | null }
}

export interface Candidate {
  id: number
  dataset_id: number
  status: 'unreviewed' | 'approved' | 'rejected'
  kind: string
  case: TestCase
  evidence: { document: string; quote: string; found: boolean | null; warnings: string[] }[]
  generator: Record<string, unknown>
  reviewer: string | null
  review_note: string
  edited: boolean
  approved_in_version_id: number | null
  document: string | null
}

export interface TargetCheck {
  ok: boolean
  at: string
  elapsed_ms?: number | null
  error?: string | null
  explanation?: string | null
  coverage?: string[]
  note?: string
}

export interface ProjectCard {
  id: number
  name: string
  description: string
  color: string
  icon: string
  is_demo?: boolean
  created_at: string | null
  counts: { targets: number; datasets: number; runs: number }
  active_runs: number
  latest_run_id: number | null
  latest_pass_rate: number | null
  previous_pass_rate: number | null
  previous_run_id: number | null
  latest_at: string | null
  gate_status: GateStatus | null
  trend: { run_id: number; pass_rate: number | null }[]
  latest_variant?: string | null
  /** The latest run, one entry per question in dataset order. */
  fingerprint?: { id: string; passed: number; total: number }[]
  /** Runs that asked another chatbot's questions (kept out of the card and trends). */
  off_topic_runs?: number
}

export interface Settings {
  default_judge: { provider_config_id?: number; provider?: 'heuristic' } | null
  default_generator: { provider_config_id?: number } | null
  spend_cap_usd: number | null
  hide_demo?: boolean
  ollama_notice_ack?: string | null
}

export interface HomeData {
  projects: ProjectCard[]
  active_runs: RunHeader[]
  settings: Settings
  has_providers: boolean
}

export interface Comparability {
  key: string
  dataset: string | null
  dataset_version: number | null
  n_cases: number | null
  case_filter: Record<string, string[]> | null
  judge: string | null
  evaluators: string[]
  trials: number | null
}

export interface Lineage {
  key: string
  comparability: Comparability
  run_ids: number[]
  points: { run_id: number; target: string; variant: string; pass_rate: number | null; p95_latency_ms: number | null; cost: number | null; concurrency?: number | null; at: string | null; ci_low?: number | null; ci_high?: number | null; off_topic?: string | null }[]
}

export interface Stage {
  id: string
  label: string
  failures: number
  checks: string[]
  types: Record<string, number>
}

export interface ProjectHome {
  project: ProjectCard
  lineages: Lineage[]
  verdict: {
    baseline_run_id: number
    candidate_run_id: number
    overall: ComparisonRow | null
    regressions: number
    improvements: number
    n_shared_cases: number
    rows: ComparisonRow[]
  } | null
  top_failures: { type: string; count: number }[]
  latest_run: RunHeader | null
  recent_runs: RunHeader[]
  targets: { id: number; name: string; adapter: string; last_check: TargetCheck | null; local_judges_only: boolean; version: number; variant_label: string }[]
  datasets: { id: number; name: string; versions: number; cases: number }[]
  stages: Stage[]
}

export interface CaseMatrix {
  runs: { id: number; name: string; target: string; variant: string; judge: string | null; pass_rate: number | null }[]
  cases: { id: string; title: string; category: string | null }[]
  cells: Record<string, Record<string, { passed: number; total: number; errors: number }>>
  always_fail: string[]
}

export interface SearchResults {
  projects: { id: number; name: string }[]
  targets: { id: number; name: string; project_id: number }[]
  runs: { id: number; name: string; status: string }[]
  datasets: { id: number; name: string }[]
  cases: { id: string; title: string; dataset_id: number; dataset: string }[]
}

export interface CatalogEntry {
  id: string
  label: string
  kind: 'openai' | 'ollama' | 'anthropic'
  base_url: string
  local: boolean
  key_name: string | null
  needs_key: boolean
  blurb: string
  key_url?: string
}

export interface ModelCheck {
  ok: boolean
  tries: number
  answered: number
  valid_json: number
  json_reliability: number | null
  median_ms: number | null
  cost_per_100_calls_usd: number | null
  price_known: boolean
  error: string | null
  explanation: string | null
  warnings: string[]
}

export interface Bakeoff {
  id: number
  dimension: string
  status: 'running' | 'completed' | 'failed'
  judges: { provider_config_id?: number; provider?: string }[]
  progress_done: number
  progress_total: number
  error: string | null
  created_at: string
  results: {
    judges: { judge: Record<string, unknown>; name: string; agreement: Agreement; unknown: number; median_ms: number | null; cost_usd: number; n: number }[]
    pairwise: { a: string; b: string; kappa: number | null }[]
    winner: string | null
  } | null
}

export interface ConnectorTemplate {
  id: string
  name: string
  description: string
  adapter: 'http' | 'python'
  config: Record<string, unknown>
  builtin: boolean
}

export interface Capability {
  field: string
  label: string
  unlocks: string
  mapped: boolean
  received: boolean
  count: number | null
}

/** One try, compact, for the run's flow diagram and the Explore charts (GET /api/runs/{id}/explore). */
export interface ExploreTrial {
  id: number
  case_id: string
  trial_index: number
  status: 'passed' | 'failed' | 'error' | string
  title: string
  question: string
  category: string | null
  difficulty: string | null
  latency_ms: number | null
  total_tokens: number | null
  cost_usd: number | null
  answer_length: number
  top_score: number | null
  n_documents: number
  needs_documents: boolean
  should_refuse: boolean
  needs_tool: boolean
  must_mention: string[]
  scores: Record<string, { status: string; score: number | null; kind: string }>
  cause: { cause: string; label: string; kind: string } | null
}
export interface ExploreData {
  run_id: number
  judge: JudgeInfo | null
  trials: ExploreTrial[]
}
