# Evaluation methodology

## Who defines correctness

GaugeLab does not know ground truth. Every expected outcome in a golden dataset was written,
imported or approved by a person. AI-generated test cases are candidates in a review queue
until someone approves them, and each candidate carries the quote it was drafted from. When
GaugeLab cannot find that quote in the source document, it flags the candidate.

## Objective first, judges only where meaning must be judged

If code can decide it, code decides it. An LLM call is never spent on "was
`check_warranty` called?".

| Question | Evaluator | Kind |
|---|---|---|
| Does the answer contain the required facts? | `must_mention` (whole words, `a\|b` alternatives) | deterministic |
| Does it avoid a known wrong claim? | `forbidden_claims` | deterministic |
| Does it match a format or a structured schema? | `regex`, `json_schema`, `exact_match` | deterministic |
| Do its citations point at documents that exist? | `citation_validity` | deterministic |
| Did it decline when it should, and only then? | `refusal_check` (phrases); `appropriate_refusal` (judge) | deterministic / judge |
| Are the numbers it states present in the evidence? | `numbers_grounded` | deterministic |
| Was the right evidence retrieved? | `recall_at_k` (gating), `precision_at_k`, `mrr`, `ndcg_at_k` | retrieval |
| Did the agent call the required tools, correctly? | `tool_selection`, `tool_arguments`, `forbidden_tools`, `unnecessary_tools` | agent |
| Did it reach the expected outcome? | `task_success` (checks tool results / structured output) | agent |
| Does the answer agree with what the tool returned? | `tool_result_consistency` | agent |
| When a tool failed, did it admit it rather than invent a result? | `error_recovery` | agent |
| How many steps did it take? | `step_count` (diagnostic; fails only against a configured limit) | agent |
| Is it fast and cheap enough? | `latency`, `token_budget`, `cost_budget` | performance |
| Is it correct / grounded / relevant / complete / on-instruction? | `correctness`, `groundedness`, `relevance`, `completeness`, `instruction_adherence` | LLM judge |

### Three things that are deliberately kept apart

- **Retrieval quality is not answer quality.** A system can retrieve the right document and
  still answer wrongly, or answer correctly from the wrong document. Recall@k and
  correctness are separate metrics.
- **Groundedness is not correctness.** Grounded means every claim is supported by the
  retrieved context. A grounded answer is wrong if the context was wrong, and a correct
  answer is ungrounded if it relies on knowledge the system did not retrieve.
- **Tool accuracy is not final-answer correctness.** `tool_accuracy` combines
  `tool_selection`, `tool_arguments` and `forbidden_tools`. The answer is graded on its own.

## Statuses, and why missing data never becomes a number

Every evaluation has one of six statuses:

| Status | Meaning | Counts toward the pass rate? |
|---|---|---|
| `pass` / `fail` | decided | yes |
| `unknown` | the judge said the material was insufficient | no |
| `not_applicable` | the case does not ask for this check | no |
| `not_evaluated` | the case asks, but the target did not report what is needed (no retrieved documents, no tool calls...) | no |
| `error` | the evaluator itself failed | fails the trial if the evaluator is gating |

A black-box chatbot that returns only text is therefore still evaluable for correctness,
relevance, refusal and latency. It simply shows "not evaluated" for retrieval and tool
metrics.

A **trial passes** when no gating evaluator says `fail` or `error` and the target did not
error. Diagnostic evaluators (precision@k, MRR, nDCG, step count, and anything from the
heuristic judge) are reported but never fail a trial on their own.

## No single magic score

GaugeLab never folds metrics into a weighted "AI score". Each metric is shown on its own,
with its N, and release decisions go through explicit gates:

```yaml
overall_pass_rate: {min: 0.85}
groundedness:      {min: 0.90}
p95_latency_ms:    {max: 3000}
regression:
  overall_pass_rate: {maximum_drop: 0.03}
```

Each gate is PASS, FAIL or NOT_EVALUATED. A run whose gates include an unavailable metric
is `INCOMPLETE`, not PASS.

## Repeated trials

LLM systems are not deterministic, so a case can be run `k` times. Every trial is stored
separately, and each case gets two estimators (Chen et al., 2021), computed from `c`
passes in `n` trials:

- **pass@k** = 1 - C(n-c, k) / C(n, k): *can the system succeed at least once in k attempts?*
- **pass^k** = C(c, k) / C(n, k): *does it succeed every time in k attempts?*

The gap between the two is flakiness. In the Acme demo, the baseline's pass@3 is 51.7% but
its pass^3 is 44.8%. Cases whose trials disagree are listed as flaky, never hidden in an
average.

## Uncertainty

- **Unit of analysis = case.** Rates are averaged per case first. Bootstrap intervals
  resample cases (2,000 resamples, fixed seed, so the numbers are reproducible).
- **Paired comparison.** Baseline and candidate are compared on the same cases. The interval
  of the delta comes from resampling the per-case differences, which is tighter and more
  honest than comparing two independent intervals.
- **McNemar's exact test** on cases whose pass/fail outcome changed (a case "passes" when
  it passes every trial). It answers "how surprising is this split if both variants were
  equally good?". It says nothing about how big the effect is.
- **Plain readings.** The compare page says *likely better* or *likely worse* only when the
  95% interval excludes zero, and *within noise* otherwise. It never says "significant". With
  58 cases, an interval spans about ±13 percentage points, so small differences mostly read as
  noise. That is the right answer, not a failure of the tool.

## Failure taxonomy

Each failed gating evaluator names a failure type: `retrieval_miss`, `wrong_answer`,
`unsupported_claim`, `should_have_refused`, `incorrect_tool`, `incorrect_tool_arguments`,
`unnecessary_tool`, `tool_result_misused`, `citation_error`, `malformed_output`,
`incomplete_response`, `latency_regression`, `cost_regression`, `execution_error`, and
`judge_disagreement` (manual). A failed trial counts once per type it shows. A person can
override the automatic classification on the trial page, with a note. The run's failure
chart and filters use the override.

## Cost

Costs are estimates: reported tokens × the price table (`gaugelab/pricing/prices.yaml`
plus overrides). Every price row carries the date it took effect and its source. A model
that is not in the table costs **unknown**, never zero. Before a run, the judge cost is
estimated from prompt sizes, and an optional budget stops scheduling when spend reaches it.
