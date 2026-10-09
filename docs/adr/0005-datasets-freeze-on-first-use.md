# 0005. Datasets freeze on first use; edits branch a new version

## Context

A comparison is only meaningful if both runs saw the same questions and expectations. If a
golden dataset can be edited in place, a run from last week and a run from today may differ in
more than the system. Fixing a wrong golden answer is also a legitimate and frequent need, so
editing cannot simply be forbidden.

## Decision

A dataset version is a draft until a run uses it, then frozen for good (`freeze` in
`assay/store/service.py`). Test cases are immutable rows: editing one writes a new row. An edit
to a frozen version goes to a child draft version, and the interface says so. Target
configurations are versioned in the same way, and each run stores a snapshot: dataset version
and content hash, target configuration hash, evaluator versions (judges include rubric version
and prompt hash), judge model and settings, and experiment settings.

## Consequences

- An old run stays interpretable after the dataset, target or rubric changes.
- Comparing runs on different dataset content is detected by content hash and flagged, and only
  shared case ids are paired.
- Runs with different comparability keys form separate lineages in a chatbot's trend, instead
  of one line that hides a change of test.
- Many small edits create many versions. That is the price of reproducibility.

See [architecture.md](../architecture.md).
