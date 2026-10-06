"""Objective checks. If code can decide it, code decides it - no judge call."""

from __future__ import annotations

import re

import jsonschema

from gaugelab.evaluators.base import EvalContext, Evaluator, register
from gaugelab.schemas import EvalStatus, EvaluationResult, NormalizedTargetResult, TestCase, Trace
from gaugelab.text import contains_phrase, looks_like_refusal, normalize


@register
class ExactMatch(Evaluator):
    id = "exact_match"
    name = "Exact match"
    kind = "deterministic"
    failure_type = "wrong_answer"
    description = "Normalized answer (or label) equals the expected exact value."

    async def evaluate(self, case: TestCase, result: NormalizedTargetResult, trace: Trace | None,
                       ctx: EvalContext) -> EvaluationResult:
        exp = case.expected.answer
        target = exp.exact if exp.exact is not None else exp.label
        if target is None:
            return self.na("No exact answer or label expected.")
        actual = result.structured_output.get("label") if (
            exp.exact is None and isinstance(result.structured_output, dict)) else result.answer
        ok = normalize(str(actual)) == normalize(target)
        return self.passed(ok, score=1.0 if ok else 0.0, explanation=f"Expected {target!r}.",
                           evidence=[f"actual: {str(actual)[:200]}"])


@register
class MustMention(Evaluator):
    id = "must_mention"
    name = "Must mention"
    version = "1.1.0"
    kind = "deterministic"
    failure_type = "incomplete_response"
    description = "Every configured phrase appears in the answer (whole words, case-insensitive)."

    async def evaluate(self, case, result, trace, ctx):
        terms = case.expected.answer.must_mention
        if not terms:
            return self.na("No required phrases.")
        if result.error and not result.answer:
            return self.missing("an answer")
        # A term may list alternatives: "covered|active".
        missing = [t for t in terms if not any(contains_phrase(result.answer, alt) for alt in t.split("|"))]
        score = 1 - len(missing) / len(terms)
        return self.passed(not missing, score=score,
                           explanation="All required phrases present." if not missing else f"Missing: {', '.join(missing)}",
                           evidence=missing)


@register
class ForbiddenClaims(Evaluator):
    id = "forbidden_claims"
    name = "Must not claim"
    kind = "deterministic"
    failure_type = "unsupported_claim"
    description = "None of the configured forbidden phrases appear in the answer."

    async def evaluate(self, case, result, trace, ctx):
        terms = case.expected.answer.must_not_claim
        if not terms:
            return self.na("No forbidden phrases.")
        found = [t for t in terms if contains_phrase(result.answer, t)]
        return self.passed(not found, score=0.0 if found else 1.0,
                           explanation="No forbidden phrase found." if not found else f"Found: {', '.join(found)}",
                           evidence=found)


@register
class RegexCheck(Evaluator):
    id = "regex"
    name = "Regex"
    kind = "deterministic"
    failure_type = "malformed_output"
    description = "The answer matches every configured regex and none of the forbidden ones."

    async def evaluate(self, case, result, trace, ctx):
        patterns = case.expected.answer.regex
        forbidden = case.expected.answer.forbidden_regex
        if not patterns and not forbidden:
            return self.na("No patterns configured.")
        failed = [p for p in patterns if re.search(p, result.answer or "") is None]
        matched = [p for p in forbidden if re.search(p, result.answer or "") is not None]
        problems = [f"no match for {p}" for p in failed] + [f"forbidden match {p}" for p in matched]
        out = self.passed(not problems, score=1 - len(problems) / (len(patterns) + len(forbidden)),
                          explanation="All patterns satisfied." if not problems else "; ".join(problems),
                          evidence=problems)
        if matched and not failed:
            out.failure_type = "unsupported_claim"
        return out


@register
class JsonSchemaCheck(Evaluator):
    id = "json_schema"
    name = "JSON schema"
    kind = "deterministic"
    failure_type = "malformed_output"
    description = "Structured output validates against the expected JSON Schema."

    async def evaluate(self, case, result, trace, ctx):
        schema = case.expected.answer.json_schema
        if not schema:
            return self.na("No schema configured.")
        payload = result.structured_output
        if payload is None:
            import json

            try:
                payload = json.loads(result.answer)
            except (ValueError, TypeError):
                return self.passed(False, score=0.0, explanation="No structured output and the answer is not JSON.")
        errors = sorted(jsonschema.Draft202012Validator(schema).iter_errors(payload), key=lambda e: list(e.path))
        msgs = [f"{'/'.join(map(str, e.path)) or '(root)'}: {e.message}" for e in errors[:5]]
        return self.passed(not errors, score=0.0 if errors else 1.0,
                           explanation="Valid." if not errors else f"{len(errors)} schema error(s).", evidence=msgs)


@register
class CitationValidity(Evaluator):
    id = "citation_validity"
    name = "Citation validity"
    kind = "deterministic"
    failure_type = "citation_error"
    description = ("Every cited id refers to a retrieved/available document, and required citations are present. "
                   "Whether a citation SUPPORTS the claim is a judge question (groundedness), not this check.")

    async def evaluate(self, case, result, trace, ctx):
        required = case.expected.required_citations
        minimum = case.expected.min_citations
        if result.citations is None:
            if required or minimum is not None:
                return self.missing("citations")
            return self.na("Target does not report citations.")
        if minimum is not None:
            n = len(result.citations)
            if (minimum == 0 and n > 0) or n < minimum:
                return self.passed(False, score=0.0, evidence=[c.id for c in result.citations],
                                   explanation=f"{n} citation(s); expected " + ("none." if minimum == 0 else f"at least {minimum}."))
        if not result.citations and not required:
            if minimum is not None:
                return self.passed(True, score=1.0, explanation="No citations, as expected.")
            return self.na("No citations claimed and none required.")
        known = {d.id for d in (result.retrieved_documents or [])}
        known |= set(self.config(case).get("available_ids", []))
        dangling = [c.id for c in result.citations
                    if getattr(c, "dangling", False) or (result.retrieved_documents is not None and c.id not in known)]
        cited = {c.id for c in result.citations}
        missing = [r for r in required if r not in cited]
        problems = [f"dangling: {d}" for d in dangling] + [f"missing required: {m}" for m in missing]
        return self.passed(not problems, score=0.0 if problems else 1.0,
                           explanation="Citations resolve." if not problems else "; ".join(problems),
                           evidence=sorted(cited))


@register
class RefusalCheck(Evaluator):
    id = "refusal_check"
    name = "Refusal (phrase-based)"
    kind = "deterministic"
    failure_type = "should_have_refused"
    description = ("Heuristic: does the answer decline when a refusal is expected, and not decline when an answer "
                   "is expected? Phrase-based; use the appropriate_refusal judge for semantic cases.")

    async def evaluate(self, case, result, trace, ctx):
        exp = case.expected.refusal_expected
        if exp is None:
            return self.na("Refusal behaviour not specified.")
        refused = looks_like_refusal(result.answer, self.config(case).get("phrases"))
        ok = refused == exp
        out = self.passed(ok, score=1.0 if ok else 0.0,
                          explanation=("Declined as expected." if exp else "Answered as expected.") if ok else
                          ("Answered instead of declining." if exp else "Declined a question it should answer."),
                          label="refused" if refused else "answered")
        if not ok and not exp:
            out.failure_type = "wrong_answer"
        return out


@register
class LatencyThreshold(Evaluator):
    id = "latency"
    name = "Latency"
    kind = "performance"
    failure_type = "latency_regression"
    description = "Trial latency is within the case's (or experiment's) maximum."

    async def evaluate(self, case, result, trace, ctx):
        limit = case.expected.max_latency_ms or ctx.options.get("max_latency_ms")
        if not limit:
            return self.result(EvalStatus.NOT_APPLICABLE, score=result.latency_ms, explanation="No latency limit set.")
        if result.latency_ms is None:
            return self.missing("latency")
        return self.passed(result.latency_ms <= limit, score=result.latency_ms, threshold=limit,
                           explanation=f"{result.latency_ms:.0f} ms vs limit {limit:.0f} ms")


@register
class TokenBudget(Evaluator):
    id = "token_budget"
    name = "Token budget"
    kind = "performance"
    failure_type = "cost_regression"
    description = "Total tokens within the configured maximum."

    async def evaluate(self, case, result, trace, ctx):
        limit = case.expected.max_total_tokens or ctx.options.get("max_total_tokens")
        if not limit:
            return self.na("No token limit set.")
        if result.usage is None or result.usage.total_tokens is None:
            return self.missing("token usage")
        total = result.usage.total_tokens
        return self.passed(total <= limit, score=total, threshold=limit, explanation=f"{total} tokens vs limit {limit}")


@register
class CostBudget(Evaluator):
    id = "cost_budget"
    name = "Cost budget"
    kind = "performance"
    failure_type = "cost_regression"
    description = "Estimated target cost within the configured maximum (unknown pricing -> not evaluated)."

    async def evaluate(self, case, result, trace, ctx):
        limit = case.expected.max_cost_usd or ctx.options.get("max_cost_usd")
        if not limit:
            return self.na("No cost limit set.")
        cost = result.metadata.get("estimated_cost_usd")
        if cost is None:
            return self.result(EvalStatus.NOT_EVALUATED, explanation="Cost unknown (no usage or no pricing).")
        return self.passed(cost <= limit, score=cost, threshold=limit, explanation=f"${cost:.5f} vs limit ${limit:.5f}")


_NUMBER = re.compile(r"(?<![\w.])\d+(?:[.,]\d+)?(?![\w])")


def numbers_in(text: str) -> set[str]:
    return {n.replace(",", ".") for n in _NUMBER.findall(text or "")}


@register
class NumbersGrounded(Evaluator):
    id = "numbers_grounded"
    name = "Numbers grounded"
    kind = "deterministic"
    failure_type = "unsupported_claim"
    description = ("Every number in the answer also appears in the retrieved text or tool results (a cheap, objective "
                   "hallucination check for specs, prices, dates). The case may allow a few with max_ungrounded_numbers.")

    async def evaluate(self, case, result, trace, ctx):
        from gaugelab.evaluators.llm_judge.judge import context_text

        evidence = context_text(result, limit=200_000)
        if not evidence:
            return self.missing("retrieved text or tool results")
        allowed = case.expected.max_ungrounded_numbers
        allowed = 0 if allowed is None else allowed
        known = numbers_in(evidence) | numbers_in(case.input.message)
        loose = sorted(numbers_in(result.answer) - known, key=lambda x: (len(x), x))
        return self.passed(len(loose) <= allowed, score=float(len(loose)), threshold=allowed,
                           explanation=("All numbers appear in the evidence." if not loose else
                                        f"{len(loose)} number(s) not in the evidence: {', '.join(loose[:8])}"
                                        + f" (allowed {allowed})."), evidence=loose[:20])
