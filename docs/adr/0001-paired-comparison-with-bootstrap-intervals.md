# 0001. Paired comparison with bootstrap intervals instead of two-sample tests

## Context

Assay compares two versions of a system on the same golden cases. Golden sets are small (the
Acme demo has 58 cases), outcomes are mostly pass or fail, and LLM systems vary between trials.
A two-sample test, or two independent confidence intervals, treats the two versions as unrelated
groups. That throws away the strongest fact available: every case was run on both, and hard
cases are hard for both versions.

## Decision

The unit of analysis is the case. Rates are averaged over trials per case first. The delta
between versions is the mean of the per-case differences, and its 95% interval comes from
resampling those differences with a bootstrap (2,000 resamples, fixed seed, so the numbers are
reproducible). See `paired_bootstrap_delta` in `assay/statistics`. McNemar's exact test is added
for cases whose pass/fail outcome changed, as a check on how surprising the split is.

The interface reads the result in plain words: *likely better* or *likely worse* only when the
interval excludes zero, otherwise *within noise*. It never says "significant".

## Consequences

- Intervals are tighter than comparing two independent intervals, and honest about case-level
  variation.
- Only cases present in both runs are paired; a different dataset content is flagged.
- Small differences on small sets read as noise (about ±13 percentage points at 58 cases). That
  is the intended answer.
- The bootstrap makes no distributional assumption, at the cost of a few thousand resamples per
  comparison.
- McNemar's test gives a p-value but no effect size, so it is shown beside the interval, not
  instead of it.
