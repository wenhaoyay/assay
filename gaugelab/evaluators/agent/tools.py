"""Agent / tool-use checks. They judge outcomes and required behaviour, not one fixed path:
by default the required tools must be called (any order, extra calls allowed up to a
configured limit). ``tool_policy: exact`` or ``ordered`` tightens that only where order or
the exact set genuinely matters.
"""

from __future__ import annotations

from typing import Any

from gaugelab.evaluators.base import Evaluator, register
from gaugelab.schemas import EvalStatus, NormalizedTargetResult, ToolCall
from gaugelab.text import contains_phrase, normalize

# --------------------------------------------------------------------------------------
# Pure helpers
# --------------------------------------------------------------------------------------


def values_match(expected: Any, actual: Any, rel_tol: float = 1e-6) -> bool:
    if isinstance(expected, bool) or isinstance(actual, bool):
        return type(expected) is type(actual) and expected == actual
    if isinstance(expected, str) and isinstance(actual, int | float):
        return values_match(actual, expected, rel_tol)  # "18372" vs 18372: compare as numbers
    if isinstance(expected, int | float) and isinstance(actual, int | float):
        return abs(expected - actual) <= rel_tol * max(1.0, abs(expected))
    if isinstance(expected, int | float) and isinstance(actual, str):
        try:
            return values_match(expected, float(actual), rel_tol)
        except ValueError:
            return False
    if isinstance(expected, str) and isinstance(actual, str):
        return normalize(expected) == normalize(actual)
    if isinstance(expected, dict) and isinstance(actual, dict):
        return all(k in actual and values_match(v, actual[k], rel_tol) for k, v in expected.items())
    if isinstance(expected, list) and isinstance(actual, list):
        return len(expected) == len(actual) and all(values_match(e, a, rel_tol) for e, a in zip(expected, actual, strict=True))
    return expected == actual


def argument_diff(expected: dict[str, Any], actual: dict[str, Any], ignore: list[str],
                  rel_tol: float = 1e-6, symmetric: list[list[str]] | None = None) -> list[str]:
    problems = []
    grouped: set[str] = set()
    for group in symmetric or []:
        fields = [f for f in group if f in expected]
        grouped.update(fields)
        exp_vals = sorted(normalize(str(expected[f])) for f in fields)
        act_vals = sorted(normalize(str(actual.get(f, ""))) for f in fields)
        if exp_vals != act_vals:
            problems.append(f"{'/'.join(fields)}: expected {exp_vals} in any order, got {act_vals}")
    for key, val in expected.items():
        if key in ignore or key in grouped:
            continue
        if key not in actual:
            problems.append(f"{key}: missing (expected {val!r})")
        elif not values_match(val, actual[key], rel_tol):
            problems.append(f"{key}: expected {val!r}, got {actual[key]!r}")
    return problems


def tool_selection(required: list[str], called: list[str], policy: str = "contains") -> tuple[bool, list[str]]:
    problems: list[str] = []
    missing = [t for t in required if t not in called]
    if missing:
        problems.append(f"missing required: {', '.join(missing)}")
    if policy == "exact" and set(called) != set(required):
        extra = sorted(set(called) - set(required))
        if extra:
            problems.append(f"not in the exact set: {', '.join(extra)}")
    if policy == "ordered" and not missing:
        positions = [called.index(t) for t in required]
        if positions != sorted(positions):
            problems.append(f"order: expected {' -> '.join(required)}, got {' -> '.join(called)}")
    return not problems, problems


def flatten(obj: Any, prefix: str = "") -> dict[str, Any]:
    if isinstance(obj, dict):
        out: dict[str, Any] = {}
        for k, v in obj.items():
            out.update(flatten(v, f"{prefix}{k}."))
        return out
    return {prefix.rstrip("."): obj}


# --------------------------------------------------------------------------------------
# Evaluators
# --------------------------------------------------------------------------------------


class _AgentEvaluator(Evaluator):
    kind = "agent"

    def calls(self, result: NormalizedTargetResult) -> list[ToolCall] | None:
        return result.tool_calls


@register
class ToolSelection(_AgentEvaluator):
    id = "tool_selection"
    name = "Tool selection"
    failure_type = "incorrect_tool"
    description = "Required tools were called (policy: contains by default, or exact / ordered)."

    async def evaluate(self, case, result, trace, ctx):
        required = case.expected.required_tools or [t.name for t in case.expected.tool_calls]
        if not required and case.expected.tool_policy != "exact":
            return self.na("No tools required.")
        calls = self.calls(result)
        if calls is None:
            return self.missing("tool calls")
        called = [c.name for c in calls]
        ok, problems = tool_selection(required, called, case.expected.tool_policy)
        covered = sum(1 for t in required if t in called) / len(required) if required else 1.0
        return self.passed(ok, score=covered, explanation="Required tools called." if ok else "; ".join(problems),
                           evidence=[f"called: {', '.join(called) or '(none)'}"])


@register
class ForbiddenTools(_AgentEvaluator):
    id = "forbidden_tools"
    name = "Forbidden tools"
    failure_type = "incorrect_tool"
    description = "No tool on the case's forbidden list was called."

    async def evaluate(self, case, result, trace, ctx):
        if not case.expected.forbidden_tools:
            return self.na("No forbidden tools.")
        calls = self.calls(result)
        if calls is None:
            return self.missing("tool calls")
        bad = sorted({c.name for c in calls} & set(case.expected.forbidden_tools))
        return self.passed(not bad, score=0.0 if bad else 1.0,
                           explanation="No forbidden tool called." if not bad else f"Called forbidden: {', '.join(bad)}")


@register
class ToolArguments(_AgentEvaluator):
    id = "tool_arguments"
    name = "Tool arguments"
    failure_type = "incorrect_tool_arguments"
    description = ("Expected tool calls were made with the expected arguments (normalized strings, tolerant numbers, "
                   "ignored fields). Any call to that tool with matching arguments counts.")

    async def evaluate(self, case, result, trace, ctx):
        expected = [t for t in case.expected.tool_calls if t.arguments]
        if not expected:
            return self.na("No expected tool arguments.")
        calls = self.calls(result)
        if calls is None:
            return self.missing("tool calls")
        tol = float(self.config(case).get("rel_tol", 1e-6))
        problems, matched = [], 0
        for exp in expected:
            candidates = [c for c in calls if c.name == exp.name]
            if not candidates:
                problems.append(f"{exp.name}: not called")
                continue
            diffs = [argument_diff(exp.arguments, c.arguments, exp.ignore_fields, tol, exp.symmetric) for c in candidates]
            best = min(diffs, key=len)
            if best:
                problems.append(f"{exp.name}: " + "; ".join(best))
            else:
                matched += 1
        return self.passed(not problems, score=matched / len(expected),
                           explanation="Arguments match." if not problems else " | ".join(problems), evidence=problems)


@register
class UnnecessaryTools(_AgentEvaluator):
    id = "unnecessary_tools"
    name = "Unnecessary tool calls"
    failure_type = "unnecessary_tool"
    description = "Calls beyond the required tools stay within max_extra_tool_calls (only when configured)."

    async def evaluate(self, case, result, trace, ctx):
        limit = case.expected.max_extra_tool_calls
        if limit is None:
            return self.na("No extra-call limit set.")
        calls = self.calls(result)
        if calls is None:
            return self.missing("tool calls")
        remaining = list(case.expected.required_tools or [t.name for t in case.expected.tool_calls])
        extra = []
        for c in calls:
            if c.name in remaining:
                remaining.remove(c.name)
            else:
                extra.append(c.name)
        return self.passed(len(extra) <= limit, score=len(extra), threshold=limit,
                           explanation=f"{len(extra)} extra call(s), limit {limit}.", evidence=extra)


@register
class StepCount(_AgentEvaluator):
    id = "step_count"
    name = "Step count"
    gating = False
    failure_type = "unnecessary_tool"
    description = ("Tool calls, model calls and total observable steps. Fewer is not automatically better: it only "
                   "fails against a configured max_steps.")

    async def evaluate(self, case, result, trace, ctx):
        if result.tool_calls is None and result.steps is None:
            return self.missing("tool calls or steps")
        tools = len(result.tool_calls or [])
        models = sum(1 for s in (result.steps or []) if s.type == "model_call")
        total = tools + len(result.steps or [])
        meta = {"tool_calls": tools, "model_calls": models, "steps": total}
        limit = case.expected.max_steps
        if limit is None:
            return self.result(EvalStatus.NOT_APPLICABLE, score=total, metadata=meta,
                               explanation=f"{tools} tool call(s), {models} model call(s); no limit set.")
        return self.passed(total <= limit, score=total, threshold=limit, metadata=meta,
                           explanation=f"{total} steps vs limit {limit}.")


@register
class TaskSuccess(_AgentEvaluator):
    id = "task_success"
    name = "Task success"
    failure_type = "wrong_answer"
    description = ("The expected outcome fields are found in the structured output or in a successful tool "
                   "result - decided by code, no judge.")

    async def evaluate(self, case, result, trace, ctx):
        expected = case.expected.expected_outcome
        if not expected:
            return self.na("No structured outcome expected.")
        sources: list[dict[str, Any]] = []
        if isinstance(result.structured_output, dict):
            sources.append(flatten(result.structured_output))
        for c in result.tool_calls or []:
            if c.status == "success" and isinstance(c.result, dict):
                sources.append(flatten(c.result))
        if not sources:
            if result.tool_calls is None and result.structured_output is None:
                return self.missing("tool results or structured output")
            return self.passed(False, score=0.0, explanation="No successful tool result or structured output to check.")
        found, problems = 0, []
        for key, val in expected.items():
            actuals = [s[key] for s in sources if key in s]
            if any(values_match(val, a) for a in actuals):
                found += 1
            else:
                problems.append(f"{key}: expected {val!r}, got {actuals[0]!r}" if actuals else f"{key}: not produced")
        return self.passed(not problems, score=found / len(expected),
                           explanation="Outcome reached." if not problems else "; ".join(problems))


@register
class ToolResultConsistency(_AgentEvaluator):
    id = "tool_result_consistency"
    name = "Tool-result consistency"
    failure_type = "tool_result_misused"
    description = ("The answer states what the tool returned. Configured per case: a result field and the phrases "
                   "that express each value; the answer must use the phrase for the actual value and none for the others.")

    async def evaluate(self, case, result, trace, ctx):
        cfg = self.config(case)
        if not cfg.get("field") or not cfg.get("phrases"):
            return self.na("No consistency rule configured.")
        if result.tool_calls is None:
            return self.missing("tool calls")
        calls = [c for c in result.tool_calls if c.status == "success" and isinstance(c.result, dict)
                 and (not cfg.get("tool") or c.name == cfg["tool"])]
        values = [flatten(c.result).get(cfg["field"]) for c in calls]
        values = [v for v in values if v is not None]
        if not values:
            return self.result(EvalStatus.NOT_APPLICABLE,
                               explanation=f"No successful tool result reported {cfg['field']!r}.")
        actual = str(values[-1])
        phrases: dict[str, list[str]] = cfg["phrases"]
        says_actual = any(contains_phrase(result.answer, p) for p in phrases.get(actual, [actual]))
        contradicting = [p for v, ps in phrases.items() if v != actual for p in ps if contains_phrase(result.answer, p)]
        ok = says_actual and not contradicting
        expl = f"Tool returned {cfg['field']} = {actual!r}."
        if not says_actual:
            expl += " The answer does not say so."
        if contradicting:
            expl += f" The answer says: {', '.join(contradicting)}."
        return self.passed(ok, score=1.0 if ok else 0.0, explanation=expl)


@register
class ErrorRecovery(_AgentEvaluator):
    id = "error_recovery"
    name = "Error recovery"
    failure_type = "tool_result_misused"
    description = ("When a tool call failed, the answer admits it (or a retry succeeded) and does not claim the "
                   "failed lookup's result.")

    DEFAULT_ADMIT = ["unable", "couldn't", "could not", "not able", "unavailable", "try again", "temporarily",
                     "can't", "cannot"]

    async def evaluate(self, case, result, trace, ctx):
        if result.tool_calls is None:
            return self.na("Target does not report tool calls.")
        failed = [c for c in result.tool_calls if c.status != "success"]
        if not failed:
            return self.na("No tool call failed.")
        cfg = self.config(case)
        recovered = any(c.status == "success" and c.name == f.name for f in failed for c in result.tool_calls)
        admits = any(contains_phrase(result.answer, p) for p in cfg.get("admit_phrases", self.DEFAULT_ADMIT))
        fabricated = [p for p in cfg.get("success_claims", []) if contains_phrase(result.answer, p)]
        ok = (recovered or admits) and not (fabricated and not recovered)
        expl = (f"{len(failed)} failed call(s); " + ("retried successfully; " if recovered else "") +
                ("answer acknowledges the failure; " if admits else "answer does not acknowledge it; ") +
                (f"claims: {', '.join(fabricated)}" if fabricated else "no fabricated result"))
        return self.passed(ok, score=1.0 if ok else 0.0, explanation=expl.strip("; "))
