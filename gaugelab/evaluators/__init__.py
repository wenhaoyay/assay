"""Importing this package registers every built-in evaluator."""

from gaugelab.evaluators.agent import tools as _agent  # noqa: F401
from gaugelab.evaluators.base import REGISTRY, EvalContext, Evaluator, all_evaluators, get_evaluator, register
from gaugelab.evaluators.deterministic import checks as _deterministic  # noqa: F401
from gaugelab.evaluators.llm_judge import evaluators as _judges  # noqa: F401
from gaugelab.evaluators.retrieval import metrics as _retrieval  # noqa: F401

__all__ = ["REGISTRY", "EvalContext", "Evaluator", "all_evaluators", "get_evaluator", "register"]

# Sensible defaults: every check that the case's own expectations switch on.
DEFAULT_EVALUATORS = [
    "exact_match", "must_mention", "forbidden_claims", "regex", "json_schema", "citation_validity",
    "refusal_check", "recall_at_k", "precision_at_k", "mrr", "ndcg_at_k", "tool_selection",
    "forbidden_tools", "tool_arguments", "unnecessary_tools", "step_count", "task_success",
    "tool_result_consistency", "error_recovery", "latency", "token_budget", "cost_budget",
]
JUDGE_EVALUATORS = ["correctness", "groundedness", "relevance", "completeness", "instruction_adherence",
                    "appropriate_refusal"]
