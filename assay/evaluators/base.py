"""The evaluator interface and registry.

An evaluator looks at one trial (test case + target result + trace) and returns an
``EvaluationResult`` with a status. It must say ``not_applicable`` when the case does not
ask for its check and ``not_evaluated`` when the case asks but the target did not report
what is needed - never a guessed score.

``gating`` evaluators decide whether a trial passes overall. Diagnostic ones (precision@k,
MRR, nDCG, step counts) are reported but do not fail a trial on their own.
"""

from __future__ import annotations

import time
from abc import ABC, abstractmethod
from dataclasses import dataclass, field
from typing import Any, ClassVar

from assay.schemas import EvalStatus, EvaluationResult, NormalizedTargetResult, TestCase, Trace


@dataclass
class EvalContext:
    k: int = 5
    judge: Any = None  # assay.evaluators.llm_judge.judge.Judge | None
    pricing: Any = None  # assay.pricing.PricingRegistry | None
    target_model: str | None = None
    options: dict[str, Any] = field(default_factory=dict)


class Evaluator(ABC):
    id: ClassVar[str]
    name: ClassVar[str]
    version: ClassVar[str] = "1.0.0"
    kind: ClassVar[str]
    gating: ClassVar[bool] = True
    description: ClassVar[str] = ""
    failure_type: ClassVar[str | None] = None

    def config(self, case: TestCase) -> dict[str, Any]:
        return case.evaluator_config.get(self.id, {})

    def result(self, status: EvalStatus, **kw: Any) -> EvaluationResult:
        if status == EvalStatus.FAIL and "failure_type" not in kw:
            kw["failure_type"] = self.failure_type
        return EvaluationResult(evaluator_id=self.id, evaluator_version=self.version, kind=self.kind,
                                status=status, **kw)

    def na(self, why: str) -> EvaluationResult:
        return self.result(EvalStatus.NOT_APPLICABLE, explanation=why)

    def missing(self, what: str) -> EvaluationResult:
        return self.result(EvalStatus.NOT_EVALUATED, explanation=f"The target did not report {what}.")

    def passed(self, ok: bool, **kw: Any) -> EvaluationResult:
        return self.result(EvalStatus.PASS if ok else EvalStatus.FAIL, **kw)

    @abstractmethod
    async def evaluate(self, case: TestCase, result: NormalizedTargetResult, trace: Trace | None,
                       ctx: EvalContext) -> EvaluationResult: ...

    async def run(self, case: TestCase, result: NormalizedTargetResult, trace: Trace | None,
                  ctx: EvalContext) -> EvaluationResult:
        t0 = time.perf_counter()
        try:
            out = await self.evaluate(case, result, trace, ctx)
        except Exception as exc:  # an evaluator bug must not crash a run
            out = self.result(EvalStatus.ERROR, explanation=f"{type(exc).__name__}: {exc}")
        out.duration_ms = (time.perf_counter() - t0) * 1000
        out.metadata.setdefault("gating", self.gating)
        return out

    @classmethod
    def describe(cls) -> dict[str, Any]:
        return {"id": cls.id, "name": cls.name, "version": cls.version, "kind": cls.kind,
                "gating": cls.gating, "description": cls.description}


REGISTRY: dict[str, type[Evaluator]] = {}


def register(cls: type[Evaluator]) -> type[Evaluator]:
    REGISTRY[cls.id] = cls
    return cls


def get_evaluator(evaluator_id: str) -> Evaluator:
    from assay import evaluators as _  # noqa: F401 - populate the registry

    if evaluator_id not in REGISTRY:
        raise KeyError(f"Unknown evaluator {evaluator_id!r}")
    return REGISTRY[evaluator_id]()


def all_evaluators() -> list[type[Evaluator]]:
    from assay import evaluators as _  # noqa: F401

    return list(REGISTRY.values())
