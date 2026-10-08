"""One evaluator per rubric. Without a judge configured they report ``not_evaluated``."""

from __future__ import annotations

from assay.evaluators.base import EvalContext, Evaluator, register
from assay.evaluators.llm_judge.judge import load_rubric, missing_inputs
from assay.schemas import EvalStatus, EvaluationResult, NormalizedTargetResult, TestCase, Trace

_FAILURE_TYPES = {
    "correctness": "wrong_answer",
    "groundedness": "unsupported_claim",
    "relevance": "wrong_answer",
    "completeness": "incomplete_response",
    "instruction_adherence": "malformed_output",
    "appropriate_refusal": "should_have_refused",
}


class JudgeEvaluator(Evaluator):
    kind = "llm_judge"
    rubric_id: str

    async def evaluate(self, case: TestCase, result: NormalizedTargetResult, trace: Trace | None,
                       ctx: EvalContext) -> EvaluationResult:
        rubric = load_rubric(self.rubric_id)
        gap = missing_inputs(rubric, case, result)
        if gap:
            return self.result(EvalStatus(gap[0]), explanation=gap[1])
        if ctx.judge is None:
            return self.result(EvalStatus.NOT_EVALUATED, explanation="No judge configured for this experiment.")
        if result.error and not result.answer:
            return self.result(EvalStatus.NOT_EVALUATED, explanation="The target returned an error, not an answer.")
        v = await ctx.judge.grade(rubric, case, result)
        status = {"PASS": EvalStatus.PASS, "FAIL": EvalStatus.FAIL, "UNKNOWN": EvalStatus.UNKNOWN}.get(
            v.label, EvalStatus.ERROR)
        out = self.result(status, label=v.label, score=v.confidence, explanation=v.reason, evidence=v.evidence,
                          judge_usage=v.usage, judge_cost_usd=v.cost_usd, metadata=dict(v.meta))
        if getattr(ctx.judge, "kind", "llm") == "heuristic":
            out.metadata["gating"] = False  # lexical overlap is a signal, not grounds to fail a trial
        if self.rubric_id == "appropriate_refusal" and status == EvalStatus.FAIL and not case.expected.refusal_expected:
            out.failure_type = "wrong_answer"
        return out


def _make(rid: str) -> type[JudgeEvaluator]:
    rubric = load_rubric(rid)
    cls = type(f"Judge_{rid}", (JudgeEvaluator,), {
        "id": rid, "name": rubric.name, "version": rubric.version, "rubric_id": rid,
        "failure_type": _FAILURE_TYPES.get(rid, "unknown"),
        "description": f"LLM judge: {rubric.question}",
    })
    register(cls)
    return cls


for _rid in ("correctness", "groundedness", "relevance", "completeness", "instruction_adherence",
             "appropriate_refusal"):
    _make(_rid)
