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
import logging
import random
import time
import zlib
from collections.abc import Awaitable, Callable
from dataclasses import dataclass, field
from typing import Any

from assay.adapters.base import AdapterContext, TargetAdapter, TargetCall, TransientTargetError, now
from assay.errors import plain_error
from assay.evaluators import get_evaluator
from assay.evaluators.base import EvalContext
from assay.schemas import EvalStatus, EvaluationResult, NormalizedTargetResult, TestCase, Trace
from assay.traces import add_evaluator_spans, build_trace, redact

log = logging.getLogger("assay")


@dataclass
class JobState:
    """What a running job is doing right now, in this process: the stop request, the tasks that can
    be cancelled, and the counters the screen's progress bar reads."""

    loop: asyncio.AbstractEventLoop | None = None
    cancel: bool = False
    tasks: set[asyncio.Future[Any]] = field(default_factory=set)
    total: int = 0
    asked: int = 0
    graded: int = 0  # answers fully graded; stopped ones never count
    in_bot: int = 0
    in_grading: int = 0
    judge: Any = None
    judge_total: int | None = None
    grading_model: str | None = None
    seed_s: float | None = None  # the estimate made when the job started
    started: float = field(default_factory=time.monotonic)

    def request_cancel(self) -> None:
        """Safe from any thread: stop asking, and drop every call in flight."""
        self.cancel = True
        if self.loop is not None and not self.loop.is_closed():
            self.loop.call_soon_threadsafe(self._drop_tasks)

    def _drop_tasks(self) -> None:
        for task in list(self.tasks):
            task.cancel()

    def eta_s(self) -> int | None:
        left = max(0, self.total - self.graded)
        if self.graded >= 3:
            return round((time.monotonic() - self.started) / self.graded * left)
        if self.seed_s is not None and self.total:
            return round(self.seed_s * left / self.total)
        return None

    def progress(self) -> dict[str, Any]:
        waiting = ("grading_model" if self.in_grading and self.in_grading >= self.in_bot
                   else "bot" if self.in_bot else None)
        return {"total": self.total, "asked": self.asked, "graded": self.graded,
                "judge_calls_done": getattr(self.judge, "calls_done", 0) if self.judge is not None else 0,
                "judge_calls_total": self.judge_total, "waiting_on": waiting,
                "grading_model": self.grading_model, "eta_s": self.eta_s()}


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
    not_measured: set[str] = field(default_factory=set)
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
    # A required check that could not decide (no telemetry this time, judge said UNKNOWN) leaves the
    # answer incomplete: "unscored", outside the pass rate, never a pass.
    if any(s.status in (EvalStatus.NOT_EVALUATED, EvalStatus.UNKNOWN) for s in gating):
        return "unscored"
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
                                           status=EvalStatus.ERROR, explanation=f"Unknown check {eid!r}."))
            continue
        sc = await ev.run(case, result, trace, ctx)
        if eid in ctx.not_measured and sc.status == EvalStatus.NOT_EVALUATED:
            sc.metadata.update(gating=False, not_measured=True)
        scores.append(sc)
    return scores


def redact_record(result: NormalizedTargetResult, trace: Trace | None, scores: list[EvaluationResult],
                  fields: set[str]) -> tuple[NormalizedTargetResult, Trace | None, list[EvaluationResult]]:
    """What is stored: the result, trace and verdicts with configured field names and key-like
    strings masked at any depth (tool arguments and results, metadata, errors, explanations).
    Called after grading, so the checks saw the real values."""
    result = NormalizedTargetResult.model_validate(redact(result.model_dump(mode="json"), fields))
    if trace is not None:
        trace = Trace.model_validate(redact(trace.model_dump(mode="json"), fields))
    scores = [EvaluationResult.model_validate(redact(sc.model_dump(mode="json"), fields)) for sc in scores]
    return result, trace, scores


def target_cost(result: NormalizedTargetResult, pricing: Any) -> float | None:
    if pricing is None or result.provider is None or result.usage is None:
        return None
    return pricing.cost(result.provider.provider, result.provider.model, result.usage)


def _sum(values: list[float | None]) -> float | None:
    known = [v for v in values if v is not None]
    return sum(known) if known else None


async def run_trials(spec: RunSpec, on_trial: Callable[[TrialRecord], Awaitable[None]] | None = None,
                     should_stop: Callable[[], bool] | None = None,
                     live: JobState | None = None) -> tuple[list[TrialRecord], str | None]:
    """Returns (records, stop_reason). stop_reason is None, 'cancelled', 'budget' or 'max_answers'.

    With ``live``, a stop request also cancels the answers in flight (the call to the bot or to the
    grading model is dropped) and they are kept as ``cancelled``."""
    ctx = EvalContext(k=spec.k, judge=spec.judge, pricing=spec.pricing, options=spec.options,
                      not_measured=frozenset(spec.not_measured))
    sem = asyncio.Semaphore(max(1, spec.concurrency))
    spent = 0.0
    reserved = 0.0  # expected cost of answers in flight
    costs: list[float] = []  # finished answers' actual costs
    asked = 0  # questions sent to the bot so far

    def expected() -> float:
        """One answer's expected cost: the average so far, else the connection's cost per answer."""
        return sum(costs) / len(costs) if costs else (spec.cost_per_answer_usd or 0.0)
    stop_reason: str | None = None
    lock = asyncio.Lock()
    records: list[TrialRecord] = []
    seen: set[tuple[str, int]] = set()

    def stopping() -> bool:
        nonlocal stop_reason
        if stop_reason:
            return True
        if (should_stop and should_stop()) or (live and live.cancel):
            stop_reason = "cancelled"
        elif spec.budget_usd is not None and (spent >= spec.budget_usd or
                                              (expected() > 0 and spent + reserved + expected() > spec.budget_usd)):
            stop_reason = "budget"
        elif spec.max_answers is not None and asked >= spec.max_answers:
            stop_reason = "max_answers"
        return stop_reason is not None

    async def save(rec: TrialRecord) -> None:
        async with lock:
            records.append(rec)
            if on_trial:
                await on_trial(rec)
        seen.add((rec.case_id, rec.trial_index))
        if live and rec.status != "cancelled":
            live.graded += 1

    async def answer(case: TestCase, trial: int) -> TrialRecord:
        nonlocal spent, asked, reserved
        async with sem:
            if stopping():
                return TrialRecord(case.id, trial, "cancelled", None, None, [])
            asked += 1
            if live:
                live.asked = asked
            hold = expected()
            reserved += hold  # no await between the check and this: no other answer can slip in
            test_input = case.input.model_dump()
            actx = AdapterContext(case_id=case.id, trial_index=trial,
                                  seed=zlib.crc32(f"{spec.seed}:{case.id}:{trial}".encode()), run_id=spec.run_id)
            if live:
                live.in_bot += 1
            try:
                call, attempts = await call_with_retry(spec.adapter, test_input, actx, spec.max_retries)
            except Exception as exc:  # a target bug or an unmappable reply is this trial's error, not the run's
                log.warning("The bot raised while answering a question", exc_info=True)
                t = now()
                call = TargetCall(result=NormalizedTargetResult(error=f"The bot failed: {plain_error(exc)}"),
                                  started_at=t, ended_at=t)
                attempts = 1
            finally:
                if live:
                    live.in_bot -= 1
            result = call.result
            t_cost = target_cost(result, spec.pricing)
            if t_cost is None and spec.cost_per_answer_usd is not None and not result.error:
                t_cost = spec.cost_per_answer_usd
                result.metadata["cost_source"] = "cost per answer set on the connection"
            if t_cost is not None:
                result.metadata["estimated_cost_usd"] = t_cost
            trace = build_trace(test_input, call, spec.pricing)
            if live:
                live.in_grading += 1
            try:
                scores = await evaluate_trial(case, result, trace, spec.evaluators, ctx)
            finally:
                if live:
                    live.in_grading -= 1
            add_evaluator_spans(trace, scores)
            j_cost = _sum([s.judge_cost_usd for s in scores])
            total = _sum([t_cost, j_cost])
            result, stored_trace, scores = redact_record(result, trace, scores, spec.redact_fields)
            rec = TrialRecord(case.id, trial, trial_status(result, scores), result, stored_trace, scores,
                              raw=redact(call.raw, spec.redact_fields), attempts=attempts, cost_usd=total,
                              target_cost_usd=t_cost, judge_cost_usd=j_cost)
            reserved -= hold
            costs.append(total or 0.0)
            if total:
                spent += total
            return rec

    async def one(case: TestCase, trial: int) -> None:
        saving: list[asyncio.Future[None]] = []  # the save in progress, once the answer is done
        try:
            rec = await answer(case, trial)
            saving.append(asyncio.ensure_future(save(rec)))
            await asyncio.shield(saving[0])  # a stop never leaves a half-saved answer
        except asyncio.CancelledError:
            if not (live and live.cancel):
                raise
            if task := asyncio.current_task():
                task.uncancel()  # a stop request ends this answer, not the whole run
            if saving:
                await saving[0]
            else:
                await save(TrialRecord(case.id, trial, "cancelled", None, None, []))

    # A TaskGroup cancels every sibling if one trial fails unexpectedly (e.g. the database), so no
    # orphaned task keeps writing after the run has been marked failed.
    async with asyncio.TaskGroup() as tg:
        for c in spec.cases:
            if c.enabled:
                for t in range(spec.trials):
                    task = tg.create_task(one(c, t))
                    if live:
                        live.tasks.add(task)
                        task.add_done_callback(live.tasks.discard)
    if live and live.cancel:  # an answer stopped before it even began leaves no record: add it
        for c in spec.cases:
            for t in range(spec.trials if c.enabled else 0):
                if (c.id, t) not in seen:
                    await save(TrialRecord(c.id, t, "cancelled", None, None, []))
    order = {c.id: i for i, c in enumerate(spec.cases)}
    records.sort(key=lambda r: (order[r.case_id], r.trial_index))
    return records, stop_reason
