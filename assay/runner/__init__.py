"""Run every (case, trial) against a target, trace it, grade it.

The runner knows nothing about databases or HTTP servers: persistence is a callback
(``on_trial``), cancellation is a callable (``should_stop``). The API and the CLI both
drive it, so a CI run and a UI run execute exactly the same code.

Semantics worth knowing:
* Transient target failures (timeouts, 429, 5xx) are retried with bounded exponential
  backoff. A wrong answer is never retried - that would hide flakiness.
* A trial PASSES when no gating evaluator says FAIL or ERROR and the target did not error.
  UNKNOWN / not-applicable / not-evaluated do not fail a trial - and do not pass a check.
* Cancelling (or hitting the cost budget) stops scheduling; finished trials are kept, the
  rest are reported as ``cancelled``.
"""

from __future__ import annotations

import asyncio
import random
import zlib
from collections.abc import Awaitable, Callable
from dataclasses import dataclass, field
from typing import Any

from assay.adapters.base import AdapterContext, TargetAdapter, TargetCall, TransientTargetError, now
from assay.evaluators import get_evaluator
from assay.evaluators.base import EvalContext
from assay.schemas import EvalStatus, EvaluationResult, NormalizedTargetResult, TestCase, Trace
from assay.traces import add_evaluator_spans, build_trace, redact


@dataclass
class RunSpec:
    cases: list[TestCase]
    adapter: TargetAdapter
    evaluators: list[str]
    judge: Any = None
    pricing: Any = None
    trials: int = 1
    concurrency: int = 4
    seed: int = 7
    k: int = 5
    options: dict[str, Any] = field(default_factory=dict)  # max_latency_ms, max_total_tokens, ...
    budget_usd: float | None = None
    # Stop after this many questions were sent to the bot: a limit that works without a price.
    max_answers: int | None = None
    # What one answer costs when the bot reports no token counts (the user's estimate), so the
    # spend cap can count answers it otherwise could not price.
    cost_per_answer_usd: float | None = None
    redact_fields: set[str] = field(default_factory=set)
    max_retries: int = 3
    run_id: str | None = None


@dataclass
class TrialRecord:
    case_id: str
    trial_index: int
    status: str  # passed | failed | error | unscored | cancelled
    result: NormalizedTargetResult | None
    trace: Trace | None
    scores: list[EvaluationResult]
    raw: Any = None
    attempts: int = 1
    cost_usd: float | None = None  # target + judge, estimated; None when unknown
    target_cost_usd: float | None = None
    judge_cost_usd: float | None = None


def trial_status(result: NormalizedTargetResult, scores: list[EvaluationResult]) -> str:
    if result.error and not result.answer:
        return "error"
    gating = [s for s in scores if s.metadata.get("gating", True)]
    if any(s.status in (EvalStatus.FAIL, EvalStatus.ERROR) for s in gating):
        return "failed"
    if any(s.status == EvalStatus.PASS for s in gating):
        return "passed"
    return "unscored"


async def call_with_retry(adapter: TargetAdapter, test_input: dict[str, Any], ctx: AdapterContext,
                          max_retries: int) -> tuple[TargetCall, int]:
    delay = 0.5
    for attempt in range(1, max_retries + 2):
        try:
            return await adapter.call(test_input, ctx), attempt
        except TransientTargetError as exc:
            if attempt > max_retries:
                t = now()
                res = NormalizedTargetResult(error=f"{exc} (gave up after {attempt} attempts)")
                return TargetCall(result=res, started_at=t, ended_at=t), attempt
            await asyncio.sleep(delay + random.random() * 0.1)
            delay = min(delay * 2, 8)
    raise AssertionError("unreachable")


async def evaluate_trial(case: TestCase, result: NormalizedTargetResult, trace: Trace | None,
                         evaluator_ids: list[str], ctx: EvalContext) -> list[EvaluationResult]:
    ids = case.evaluators if case.evaluators is not None else evaluator_ids
    scores = []
    for eid in ids:
        try:
            ev = get_evaluator(eid)
        except KeyError:
            scores.append(EvaluationResult(evaluator_id=eid, evaluator_version="?", kind="unknown",
                                           status=EvalStatus.ERROR, explanation=f"Unknown evaluator {eid!r}"))
            continue
        scores.append(await ev.run(case, result, trace, ctx))
    return scores


def target_cost(result: NormalizedTargetResult, pricing: Any) -> float | None:
    if pricing is None or result.provider is None or result.usage is None:
        return None
    return pricing.cost(result.provider.provider, result.provider.model, result.usage)


def _sum(values: list[float | None]) -> float | None:
    known = [v for v in values if v is not None]
    return sum(known) if known else None


async def run_trials(spec: RunSpec, on_trial: Callable[[TrialRecord], Awaitable[None]] | None = None,
                     should_stop: Callable[[], bool] | None = None) -> tuple[list[TrialRecord], str | None]:
    """Returns (records, stop_reason). stop_reason is None, 'cancelled', 'budget' or 'max_answers'."""
    ctx = EvalContext(k=spec.k, judge=spec.judge, pricing=spec.pricing, options=spec.options)
    sem = asyncio.Semaphore(max(1, spec.concurrency))
    spent = 0.0
    asked = 0  # questions sent to the bot so far
    stop_reason: str | None = None
    lock = asyncio.Lock()
    records: list[TrialRecord] = []

    def stopping() -> bool:
        nonlocal stop_reason
        if stop_reason:
            return True
        if should_stop and should_stop():
            stop_reason = "cancelled"
        elif spec.budget_usd is not None and spent >= spec.budget_usd:
            stop_reason = "budget"
        elif spec.max_answers is not None and asked >= spec.max_answers:
            stop_reason = "max_answers"
        return stop_reason is not None

    async def one(case: TestCase, trial: int) -> None:
        nonlocal spent, asked
        async with sem:
            if stopping():
                rec = TrialRecord(case.id, trial, "cancelled", None, None, [])
            else:
                asked += 1
                test_input = case.input.model_dump()
                actx = AdapterContext(case_id=case.id, trial_index=trial,
                                      seed=zlib.crc32(f"{spec.seed}:{case.id}:{trial}".encode()), run_id=spec.run_id)
                try:
                    call, attempts = await call_with_retry(spec.adapter, test_input, actx, spec.max_retries)
                except Exception as exc:  # a target bug or an unmappable reply is this trial's error, not the run's
                    t = now()
                    call = TargetCall(result=NormalizedTargetResult(error=f"{type(exc).__name__}: {exc}"[:500]),
                                      started_at=t, ended_at=t)
                    attempts = 1
                result = call.result
                t_cost = target_cost(result, spec.pricing)
                if t_cost is None and spec.cost_per_answer_usd is not None and not result.error:
                    t_cost = spec.cost_per_answer_usd
                    result.metadata["cost_source"] = "cost per answer set on the connection"
                if t_cost is not None:
                    result.metadata["estimated_cost_usd"] = t_cost
                trace = build_trace(test_input, call, spec.pricing)
                scores = await evaluate_trial(case, result, trace, spec.evaluators, ctx)
                add_evaluator_spans(trace, scores)
                j_cost = _sum([s.judge_cost_usd for s in scores])
                total = _sum([t_cost, j_cost])
                rec = TrialRecord(case.id, trial, trial_status(result, scores), result, trace, scores,
                                  raw=redact(call.raw, spec.redact_fields), attempts=attempts, cost_usd=total,
                                  target_cost_usd=t_cost, judge_cost_usd=j_cost)
                if total:
                    spent += total
            async with lock:
                records.append(rec)
                if on_trial:
                    await on_trial(rec)

    # A TaskGroup cancels every sibling if one trial fails unexpectedly (e.g. the database), so no
    # orphaned task keeps writing after the run has been marked failed.
    async with asyncio.TaskGroup() as tg:
        for c in spec.cases:
            if c.enabled:
                for t in range(spec.trials):
                    tg.create_task(one(c, t))
    records.sort(key=lambda r: ([c.id for c in spec.cases].index(r.case_id), r.trial_index))
    return records, stop_reason
