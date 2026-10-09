# 0004. A check that cannot be measured is "not measured", never a pass

## Context

Targets report different amounts of detail. A black-box chatbot may return only text, with no
retrieved sources and no tool calls. Counting a retrieval check as passed in that case would
inflate the pass rate, and counting it as failed would blame the system for a gap in the
connection. Either way, a number would appear that nothing measured.

## Decision

Every evaluation has a status: `pass`, `fail`, `unknown` (the judge found the material
insufficient), `not_applicable` (the case does not ask for it), `not_evaluated` (the case asks,
but the target did not report what is needed), or `error`. Only `pass` and `fail` count towards
a rate. A check whose telemetry the connection does not map is listed as not measured, and the
pass rate rests on the other checks. An answer whose required check could not decide is
unscored, not passed. A gate on an unavailable metric is NOT_EVALUATED, and a run that includes
one is INCOMPLETE rather than PASS. A cost for a model missing from the price table is
*unknown*, not zero.

## Consequences

- A connection that reports little still yields honest results, and the wizard shows which
  checks each mapping unlocks.
- Pass rates can rest on different checks in different runs, so comparability includes each
  check's name and version hash (`assay/store/insights.py`); runs that differ are flagged.
- Users see more "not evaluated" than a tool that fills gaps, which is deliberate.

See [evaluation-methodology.md](../evaluation-methodology.md).
