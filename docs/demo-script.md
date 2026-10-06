# Demo script (4 minutes)

Setup, before the demo:

```bash
gaugelab seed --run      # dataset, two variants, gate, and both runs (about 10 seconds)
gaugelab serve           # http://localhost:8040
```

## 1. The question (20 s)

"I changed my retriever and my prompt. Is the support agent actually better, or just
different? GaugeLab answers that with a versioned golden dataset, objective checks first,
and a comparison that says *within noise* when that is the truth."

## 2. The dataset (40 s) - Datasets > acme-support

- 58 cases: factual, multi-document, unanswerable, retrieval traps, tool use, error recovery,
  adversarial.
- Point at the blue box: **people define correctness**. Generated cases wait in a review
  queue (show the *Generate & review* tab).
- Version badge: **v1 is frozen**, used by 2 runs. Edit any case: the change lands in a new
  draft v2 and the notice says so. Old runs keep pointing at v1.

## 3. The baseline (30 s) - Experiments > run #1

- 58 cases × 3 trials. Overall pass rate 49.4%, with its interval and N.
- **Repeated trials**: pass@3 51.7% vs pass^3 44.8%. The gap is flakiness, and the flaky cases
  are listed.

## 4. The candidate and the comparison (60 s) - Compare #1 vs #2

- Hybrid retrieval + reranking + prompt v2: overall **+23.6pp, 95% CI [+10.3, +36.8]**, tool
  accuracy +26.2pp, McNemar p = 0.003.
- But the same table shows answer correctness, must-mention and refusal rows as
  **within noise**: GaugeLab does not overclaim.
- Costs are visible: **+140% tokens, +98% estimated cost, p95 +8%**. It is a trade-off,
  not a free win.
- Category chart: tool use improved a lot, retrieval traps did not move.

## 5. A regression (40 s) - click `multi_08` in "Regressed"

- "I bought something in Northvale on 20 December. Until when can I return it?"
- The candidate now calls `get_return_policy`, answers "30 days", and drops the holiday rule
  (returnable until 31 January). `must_mention` fails: the new tool rule made a correct
  answer worse.
- A second regression, `fact_11`: the new refusal rule refuses "How quickly are refunds paid
  back?" because "quickly" and "paid" never occur in the docs.

## 6. The trace (30 s) - open the trial, Execution trace

- Request, retrieval with the documents and scores, the plan call, each tool call with
  arguments and result, the answer call, and the evaluators, each with its timing and
  tokens. Only observable data; no hidden reasoning needed.
- Show `fact_03` on the baseline: *"Expected installation, but it was not retrieved in the
  top 5"*, with the missing document listed in red.

## 7. Calibration (30 s) - Calibration

- The judge's verdict is hidden while you label. Label two or three answers. The panel
  switches from **Uncalibrated** to **Calibrated on N samples**, with accuracy, kappa, the
  confusion matrix and the disagreements.

## 8. The CI gate (30 s) - terminal

```bash
gaugelab ci benchmarks/acme_support/ci.yaml             # PASS, exit 0
gaugelab ci benchmarks/acme_support/ci-regression.yaml  # prompt v3 dropped the tool rules
```

The second run prints *REGRESSION DETECTED*: 6 cases regressed, tool accuracy dropped 14.3pp
against production, **Gate: FAIL**, and the exit code is 1. In GitHub Actions that fails the
build at zero API cost, and the Markdown summary is posted to the job summary.
