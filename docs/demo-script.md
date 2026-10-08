# Demo script (5 minutes)

Setup, before the demo (stop any running server first):

```bash
assay seed --run --fresh   # an empty database, then the dataset, two variants, gate and both runs (~10 s)
assay demo-agent           # optional: the Acme bot over HTTP on :9040, for the connect wizard
assay serve                # http://localhost:8040
```

Short on time? Press **Take the tour** on the home page: it walks through the same story in
eight steps. The script below is the longer version, with what to say.

## 1. The question (20 s) - Home

"I changed my retriever and my prompt. Is the support bot actually better, or just
different?" The home page has one card per chatbot: latest pass rate, the change since the
last *comparable* run, a trend line, the release gate. Nothing here is specific to one bot.

## 2. The verdict (40 s) - open the Acme card

- One sentence at the top, written from the statistics: **Better: pass rate up +23.6pp,
  beyond noise. 4 cases regressed, 20 improved. Also: tokens up 140%, cost up 98%.**
- The needle shows the change; the grey arc is its 95% interval. It stays clear of the middle,
  so the improvement is unlikely to be chance - and the cost of it is in the same sentence.
- *Where failures start*: the pipeline stages, with the failure kinds behind them.
- The trend only joins runs with the same cases, checks and judge. A run graded by a
  different judge becomes a separate line, never a misleading dip.

## 3. Compare (60 s) - "Every metric, every case" (or Runs, tick #1 and #2, Compare)

- McNemar p = 0.003: of the questions where the versions disagree, the split is lopsided.
- The forest plot: each metric's interval against zero. Answer correctness, must-mention and
  refusal cross zero: Assay does not overclaim. Hatched rows come from the heuristic judge.
- Measured once: tokens +140%, cost +98%, p95 +8% - arrow up, coloured worse. A trade-off,
  not a free win.
- Open `multi_08` under *Regressed*: both answers side by side. The candidate now calls
  `get_return_policy`, answers "30 days", and drops the holiday rule.

## 4. Why it failed (40 s) - Run #1 > Failures

- Failures by kind (click *Retrieval miss* to filter) and by case: three red dots = fails every
  try, consistently.
- J/K to move, Enter to open. The trial page starts with the reason: *recall_at_k - Expected
  installation, but it was not retrieved in the top 5*. The answer is not tinted red: the
  answer was fine, retrieval failed.
- Required phrases are marked in the answer; the reference sits beside it. Shift+J jumps to
  the next failing case.

## 5. The dataset (30 s) - Datasets > acme-support > Results across runs

- Every case in every run. Cases that fail in every run whatever the version (marked *always
  fails*) are often a sign the golden answer is wrong, not the bot. People define correctness; Assay
  shows where to look.

## 6. Can you trust the judge? (40 s) - Calibration

- Flashcards: label with P / F / U; the judge's verdict stays hidden until you have labelled.
- Progress toward 30 labels and an agreement meter (Cohen's kappa) fill in as you go.
- *Judge bake-off*: run the heuristic judge and the local Ollama model (or OpenAI) over your
  labels; Assay ranks them by agreement with you, speed and cost.

## 7. Bring your own model and your own bot (40 s)

- Settings > **Models & keys**: connect OpenAI by pasting a key - it goes to the OS credential
  store, never the database; the model list comes from OpenAI; *Check* reports speed, JSON
  reliability and the cost of 100 grading calls. A new model starts uncalibrated.
- Targets > **Connect a chatbot**: paste a curl command for `http://127.0.0.1:9040/chat`, send
  a question, and the reply's answer, sources, tool calls and tokens are already mapped -
  confirm with a click and see what checks that unlocks.

## 8. The CI gate (30 s) - terminal

```bash
assay ci benchmarks/acme_support/ci.yaml             # PASS, exit 0
assay ci benchmarks/acme_support/ci-regression.yaml  # prompt v3 dropped the tool rules
```

The second run prints *REGRESSION DETECTED*: tool accuracy dropped 14.3pp against
production, **Gate: FAIL**, and the exit code is 1. In GitHub Actions that fails the build at
zero API cost, and the Markdown summary is posted to the job summary.
