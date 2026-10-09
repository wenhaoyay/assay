# 0002. Objective checks first, a grading model only where meaning must be judged

## Context

An LLM grading a model's answer is cheap to write and easy to over-trust. It can be lenient on
fluent text, inconsistent between runs and wrong about a domain. In the Acme case study a local
8B judge and a phrase check disagreed on 18 of 60 answers, and the judge was right in 3 and
wrong in 15. Yet many questions do not need a model at all: was a tool called, were the
arguments right, did the citation point at a real document.

## Decision

If code can decide it, code decides it. Required phrases, forbidden claims, schemas, citations,
retrieval metrics, tool selection and arguments, outcomes, latency and cost are all checked
without a model. A judge rubric (correctness, groundedness, relevance, completeness,
instruction adherence, appropriate refusal) is used only where meaning decides.

Judges are constrained: PASS, FAIL or UNKNOWN with strict JSON output, versioned prompts with a
hash, and untrusted content fenced inside delimiters. Each judge model shows as *Uncalibrated*
until a person has labelled answers blind, then reports accuracy, F1, Cohen's kappa and a
confusion matrix (see [judge-calibration.md](../judge-calibration.md)).

## Consequences

- Most of the pass rate is free, fast and repeatable, and CI can run with the zero-cost
  heuristic judge.
- Semantic grading still needs an LLM judge and human labels; calibration is extra work.
- Agreement belongs to one judge model and one rubric version, so changing either means
  calibrating again.
- A judge that fails marks answers not evaluated rather than silently switching models.
