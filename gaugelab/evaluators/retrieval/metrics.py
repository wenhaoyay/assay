"""Information-retrieval metrics over document ids. Need ground-truth relevant ids.

Pure functions first (tested directly), evaluators on top. Relevance is binary. An entry of
``expected.relevant_documents`` may name equivalent documents as ``"a|b"``: the requirement
is met by either one (both contain the answer), and it counts once.
"""

from __future__ import annotations

import math

from gaugelab.evaluators.base import EvalContext, Evaluator, register
from gaugelab.schemas import EvaluationResult, NormalizedTargetResult, TestCase, Trace


def _dedupe(ids: list[str]) -> list[str]:
    seen: set[str] = set()
    out = []
    for i in ids:
        if i not in seen:
            seen.add(i)
            out.append(i)
    return out


Groups = list[frozenset[str]]


def groups(relevant: set[str] | list[str]) -> Groups:
    return [frozenset(x.strip() for x in r.split("|") if x.strip()) for r in sorted(relevant)]


def _gains(retrieved: list[str], gs: Groups, k: int | None = None) -> list[bool]:
    """For each ranked doc: does it satisfy a requirement not yet satisfied?"""
    open_ = list(gs)
    out = []
    ranked = _dedupe(retrieved)
    for d in ranked[:k] if k is not None else ranked:
        hit = next((g for g in open_ if d in g), None)
        if hit is not None:
            open_.remove(hit)
        out.append(hit is not None)
    return out


def precision_at_k(retrieved: list[str], relevant: set[str] | list[str], k: int) -> float:
    if k <= 0:
        return 0.0
    every: set[str] = set().union(*groups(relevant)) if relevant else set()
    return sum(1 for d in _dedupe(retrieved)[:k] if d in every) / k


def recall_at_k(retrieved: list[str], relevant: set[str] | list[str], k: int) -> float:
    gs = groups(relevant)
    return sum(_gains(retrieved, gs, k)) / len(gs) if gs else 0.0


def reciprocal_rank(retrieved: list[str], relevant: set[str] | list[str]) -> float:
    for rank, hit in enumerate(_gains(retrieved, groups(relevant)), start=1):
        if hit:
            return 1.0 / rank
    return 0.0


def ndcg_at_k(retrieved: list[str], relevant: set[str] | list[str], k: int) -> float:
    gs = groups(relevant)
    dcg = sum(1.0 / math.log2(i + 2) for i, hit in enumerate(_gains(retrieved, gs, k)) if hit)
    ideal = sum(1.0 / math.log2(i + 2) for i in range(min(len(gs), k)))
    return dcg / ideal if ideal else 0.0


class _RetrievalEvaluator(Evaluator):
    kind = "retrieval"
    failure_type = "retrieval_miss"
    default_threshold: float = 0.0

    def compute(self, retrieved: list[str], relevant: set[str], k: int) -> float:
        raise NotImplementedError

    async def evaluate(self, case: TestCase, result: NormalizedTargetResult, trace: Trace | None,
                       ctx: EvalContext) -> EvaluationResult:
        relevant = set(case.expected.relevant_documents)
        if not relevant:
            return self.na("No relevant documents labelled for this case.")
        if result.retrieved_documents is None:
            return self.missing("retrieved documents")
        k = int(self.config(case).get("k", ctx.k))
        ids = [d.id for d in result.retrieved_documents]
        score = self.compute(ids, relevant, k)
        threshold = float(self.config(case).get("threshold", self.default_threshold))
        top = _dedupe(ids)[:k]
        missed = [" or ".join(sorted(g)) for g in groups(relevant) if not g & set(top)]
        expl = f"{self.name} = {score:.2f} (k={k})."
        if missed:
            expl += f" Expected {', '.join(missed)}, but it was not retrieved in the top {k}."
        ranks = {d: (top.index(d) + 1 if d in top else None) for g in groups(relevant) for d in sorted(g)}
        return self.passed(score >= threshold, score=score, threshold=threshold, explanation=expl,
                           evidence=[f"retrieved: {', '.join(top) or '(none)'}"],
                           metadata={"k": k, "expected": sorted(relevant), "ranks": ranks})


@register
class RecallAtK(_RetrievalEvaluator):
    id = "recall_at_k"
    name = "Recall@k"
    default_threshold = 1.0
    description = "Share of the labelled relevant documents found in the top k. Gating: all must be found."

    def compute(self, retrieved, relevant, k):
        return recall_at_k(retrieved, relevant, k)


@register
class PrecisionAtK(_RetrievalEvaluator):
    id = "precision_at_k"
    name = "Precision@k"
    gating = False
    description = "Share of the top k that is relevant (diagnostic)."

    def compute(self, retrieved, relevant, k):
        return precision_at_k(retrieved, relevant, k)


@register
class MRR(_RetrievalEvaluator):
    id = "mrr"
    name = "MRR"
    gating = False
    description = "1 / rank of the first relevant document (diagnostic)."

    def compute(self, retrieved, relevant, k):
        return reciprocal_rank(retrieved, relevant)


@register
class NDCGAtK(_RetrievalEvaluator):
    id = "ndcg_at_k"
    name = "nDCG@k"
    gating = False
    description = "Rank-discounted gain of relevant documents in the top k, normalized (diagnostic)."

    def compute(self, retrieved, relevant, k):
        return ndcg_at_k(retrieved, relevant, k)
