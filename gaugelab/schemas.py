"""The shapes every part of GaugeLab agrees on.

Three families live here:

* what a target returns (``NormalizedTargetResult``) - every field but ``answer`` optional,
  so a black-box chatbot that only returns text is still evaluable;
* what a golden test case expects (``TestCase``) - again, almost everything optional;
* what an evaluator says (``EvaluationResult``) - always with a status, so a metric that
  cannot be computed is ``not_applicable``/``not_evaluated`` rather than a made-up number.
"""

from __future__ import annotations

from enum import StrEnum
from typing import Any

from pydantic import BaseModel, ConfigDict, Field

# --------------------------------------------------------------------------------------
# Target results
# --------------------------------------------------------------------------------------


class RetrievedDocument(BaseModel):
    model_config = ConfigDict(extra="allow")

    id: str
    title: str | None = None
    score: float | None = None
    text: str | None = None


class Citation(BaseModel):
    model_config = ConfigDict(extra="allow")

    id: str
    title: str | None = None
    quote: str | None = None


class ToolCall(BaseModel):
    model_config = ConfigDict(extra="allow")

    name: str
    arguments: dict[str, Any] = Field(default_factory=dict)
    result: Any = None
    status: str = "success"  # success | error
    duration_ms: float | None = None


class Usage(BaseModel):
    input_tokens: int | None = None
    output_tokens: int | None = None
    total_tokens: int | None = None

    def filled(self) -> Usage:
        total = self.total_tokens
        if total is None and self.input_tokens is not None and self.output_tokens is not None:
            total = self.input_tokens + self.output_tokens
        return Usage(input_tokens=self.input_tokens, output_tokens=self.output_tokens, total_tokens=total)


class ProviderInfo(BaseModel):
    model_config = ConfigDict(extra="allow")

    provider: str | None = None
    model: str | None = None


class TargetStep(BaseModel):
    """An observable step the target chose to report (retrieval, model call, ...).

    Targets that only return a final answer report none; the trace then has a single
    target-request span. Never hidden reasoning - only what the system exposed.
    """

    model_config = ConfigDict(extra="allow")

    type: str  # retrieval | model_call | tool_call | post_processing | other
    name: str
    duration_ms: float | None = None
    status: str = "ok"
    input_summary: str | None = None
    output_summary: str | None = None
    usage: Usage | None = None
    metadata: dict[str, Any] = Field(default_factory=dict)


class NormalizedTargetResult(BaseModel):
    """What GaugeLab evaluates. ``None`` means 'the target did not report it'."""

    answer: str = ""
    citations: list[Citation] | None = None
    retrieved_documents: list[RetrievedDocument] | None = None
    tool_calls: list[ToolCall] | None = None
    usage: Usage | None = None
    provider: ProviderInfo | None = None
    structured_output: Any = None
    steps: list[TargetStep] | None = None
    metadata: dict[str, Any] = Field(default_factory=dict)
    error: str | None = None
    latency_ms: float | None = None

    def missing_telemetry(self) -> list[str]:
        missing = []
        for name in ("citations", "retrieved_documents", "tool_calls", "usage", "provider"):
            if getattr(self, name) is None:
                missing.append(name)
        return missing


# --------------------------------------------------------------------------------------
# Golden test cases
# --------------------------------------------------------------------------------------


class ConversationTurn(BaseModel):
    role: str
    content: str


class CaseInput(BaseModel):
    model_config = ConfigDict(extra="forbid")

    message: str
    history: list[ConversationTurn] = Field(default_factory=list)
    fields: dict[str, Any] = Field(default_factory=dict)


class ExpectedToolCall(BaseModel):
    model_config = ConfigDict(extra="forbid")

    name: str
    arguments: dict[str, Any] = Field(default_factory=dict)
    ignore_fields: list[str] = Field(default_factory=list)
    # Fields whose values may come in any order, e.g. [[product_a, product_b]] for a symmetric tool.
    symmetric: list[list[str]] = Field(default_factory=list)


class ExpectedAnswer(BaseModel):
    model_config = ConfigDict(extra="forbid")

    reference: str | None = None
    exact: str | None = None
    label: str | None = None
    must_mention: list[str] = Field(default_factory=list)
    must_not_claim: list[str] = Field(default_factory=list)
    regex: list[str] = Field(default_factory=list)
    json_schema: dict[str, Any] | None = None


class Expected(BaseModel):
    model_config = ConfigDict(extra="forbid")

    answer: ExpectedAnswer = Field(default_factory=ExpectedAnswer)
    relevant_documents: list[str] = Field(default_factory=list)
    required_citations: list[str] = Field(default_factory=list)
    required_tools: list[str] = Field(default_factory=list)
    tool_calls: list[ExpectedToolCall] = Field(default_factory=list)
    forbidden_tools: list[str] = Field(default_factory=list)
    tool_policy: str = "contains"  # contains | exact | ordered
    max_extra_tool_calls: int | None = None
    max_steps: int | None = None
    expected_outcome: dict[str, Any] = Field(default_factory=dict)
    structured_output: Any = None
    refusal_expected: bool | None = None
    max_latency_ms: float | None = None
    max_total_tokens: int | None = None
    max_cost_usd: float | None = None


class TestCase(BaseModel):
    """One golden case. ``expected`` is written or approved by a person - never inferred."""

    __test__ = False  # not a pytest class
    model_config = ConfigDict(extra="forbid")

    id: str
    title: str = ""
    category: str = "general"
    description: str = ""
    difficulty: str = "medium"
    tags: list[str] = Field(default_factory=list)
    input: CaseInput
    expected: Expected = Field(default_factory=Expected)
    evaluators: list[str] | None = None  # None -> the experiment's evaluator list
    evaluator_config: dict[str, dict[str, Any]] = Field(default_factory=dict)
    enabled: bool = True
    metadata: dict[str, Any] = Field(default_factory=dict)


# --------------------------------------------------------------------------------------
# Traces
# --------------------------------------------------------------------------------------


class SpanType(StrEnum):
    TARGET_REQUEST = "target_request"
    RETRIEVAL = "retrieval"
    MODEL_CALL = "model_call"
    TOOL_CALL = "tool_call"
    TOOL_RESULT = "tool_result"
    POST_PROCESSING = "post_processing"
    EVALUATOR = "evaluator"
    ERROR = "error"


class Span(BaseModel):
    span_id: str
    parent_span_id: str | None = None
    type: SpanType
    name: str
    start_time: float  # epoch seconds
    end_time: float
    duration_ms: float
    status: str = "ok"  # ok | error
    input_summary: str | None = None
    output_summary: str | None = None
    metadata: dict[str, Any] = Field(default_factory=dict)
    usage: Usage | None = None
    cost_usd: float | None = None
    error: str | None = None


class Trace(BaseModel):
    trace_id: str
    spans: list[Span] = Field(default_factory=list)

    def root(self) -> Span | None:
        return next((s for s in self.spans if s.parent_span_id is None), None)


# --------------------------------------------------------------------------------------
# Evaluation results
# --------------------------------------------------------------------------------------


class EvalStatus(StrEnum):
    PASS = "pass"
    FAIL = "fail"
    UNKNOWN = "unknown"  # the evaluator ran and could not decide (e.g. judge said UNKNOWN)
    NOT_APPLICABLE = "not_applicable"  # the case does not ask for this check
    NOT_EVALUATED = "not_evaluated"  # it would apply, but telemetry/config is missing
    ERROR = "error"  # the evaluator itself failed


class EvaluationResult(BaseModel):
    evaluator_id: str
    evaluator_version: str
    kind: str  # deterministic | retrieval | agent | llm_judge | performance
    status: EvalStatus
    score: float | None = None
    label: str | None = None
    threshold: float | None = None
    explanation: str = ""
    evidence: list[str] = Field(default_factory=list)
    failure_type: str | None = None
    duration_ms: float = 0.0
    judge_cost_usd: float | None = None
    judge_usage: Usage | None = None
    metadata: dict[str, Any] = Field(default_factory=dict)

    @property
    def decided(self) -> bool:
        return self.status in (EvalStatus.PASS, EvalStatus.FAIL)
