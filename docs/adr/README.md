# Architecture decision records

Short records of the decisions that shape Assay, each with its context and consequences.

| # | Decision |
|---|---|
| [0001](0001-paired-comparison-with-bootstrap-intervals.md) | Paired comparison with bootstrap intervals instead of two-sample tests |
| [0002](0002-objective-checks-first.md) | Objective checks first; a grading model only where meaning must be judged, and calibrated |
| [0003](0003-local-first-single-user-workbench.md) | A local-first, single-user workbench |
| [0004](0004-not-measured-is-never-a-pass.md) | A check that cannot be measured is "not measured", never a pass |
| [0005](0005-datasets-freeze-on-first-use.md) | Datasets freeze on first use; edits branch a new version |

Each record has three parts: context (the problem), decision (what Assay does) and consequences
(what that costs and buys). See also [evaluation-methodology.md](../evaluation-methodology.md)
and [security-and-privacy.md](../security-and-privacy.md).
