"""Turn trials into run metrics, compare two runs, and name failures.

Unit of analysis: the CASE. Trials of one case are repeated measurements, so rates are
averaged per case first, and confidence intervals resample cases. With one trial per
case this is the ordinary trial pass rate.

No single "quality score": every metric is reported on its own, with its N.
"""

from __future__ import annotations

import statistics as st
from collections import Counter, defaultdict
from dataclasses import dataclass, field
from typing import Any

from assay.statistics import (
    bootstrap_ci,
    mcnemar_exact,
    paired_bootstrap_delta,
    pass_at_k,
    pass_hat_k,
    percentile,
)

FAILURE_TYPES = [
    "retrieval_miss", "wrong_answer", "unsupported_claim", "should_have_refused", "incorrect_tool",
    "incorrect_tool_arguments", "unnecessary_tool", "tool_result_misused", "citation_error", "malformed_output",
    "incomplete_response", "latency_regression", "cost_regression", "judge_disagreement", "execution_error",
    "unknown",
]

DECIDED = ("pass", "fail")
TOOL_EVALUATORS = ("tool_selection", "tool_arguments", "forbidden_tools")


@dataclass
class TrialView:
    case_id: str
    trial_index: int
    status: str
    scores: list[dict[str, Any]]
    latency_ms: float | None = None
    total_tokens: int | None = None
    target_cost_usd: float | None = None
    judge_cost_usd: float | None = None
    failure_types_override: list[str] | None = None

    def score(self, evaluator_id: str) -> dict[str, Any] | None:
        return next((s for s in self.scores if s["evaluator_id"] == evaluator_id), None)

    @property
    def failure_types(self) -> list[str]:
        if self.failure_types_override is not None:
            return self.failure_types_override
        if self.status == "error":
            return ["execution_error"]
        if self.status != "failed":
            return []
        types = [s.get("failure_type") or "unknown" for s in self.scores
                 if s["status"] in ("fail", "error") and s.get("metadata", {}).get("gating", True)]
        return sorted(set(types)) or ["unknown"]


@dataclass
class CaseInfo:
    category: str = "general"
    difficulty: str = "medium"
    tags: list[str] = field(default_factory=list)
    title: str = ""


def _mean(vals: list[float]) -> float | None:
    return st.fmean(vals) if vals else None


def _case_groups(trials: list[TrialView]) -> dict[str, list[TrialView]]:
    groups: dict[str, list[TrialView]] = defaultdict(list)
    for t in trials:
        if t.status != "cancelled":
            groups[t.case_id].append(t)
    return groups


def case_pass_rate(ts: list[TrialView]) -> float | None:
    scored = [t for t in ts if t.status in ("passed", "failed", "error")]
    return sum(t.status == "passed" for t in scored) / len(scored) if scored else None


def _evaluator_case_rate(ts: list[TrialView], eid: str) -> float | None:
    decided = [s["status"] == "pass" for t in ts if (s := t.score(eid)) and s["status"] in DECIDED]
    return sum(decided) / len(decided) if decided else None


def _tool_accuracy_case_rate(ts: list[TrialView]) -> float | None:
    vals = []
    for t in ts:
        decided = [s for e in TOOL_EVALUATORS if (s := t.score(e)) and s["status"] in DECIDED]
        if decided:
            vals.append(all(s["status"] == "pass" for s in decided))
    return sum(vals) / len(vals) if vals else None


def _rate_metric(groups: dict[str, list[TrialView]], fn) -> dict[str, Any]:
    per_case = {cid: r for cid, ts in groups.items() if (r := fn(ts)) is not None}
    ci = bootstrap_ci(list(per_case.values()))
    return {"value": ci.estimate, "ci_low": ci.low, "ci_high": ci.high, "n": ci.n, "per_case": per_case}


def evaluator_ids(trials: list[TrialView]) -> list[str]:
    seen: dict[str, None] = {}
    for t in trials:
        for s in t.scores:
            seen.setdefault(s["evaluator_id"], None)
    return list(seen)


def aggregate(trials: list[TrialView], cases: dict[str, CaseInfo] | None = None) -> dict[str, Any]:
    cases = cases or {}
    groups = _case_groups(trials)
    live = [t for t in trials if t.status != "cancelled"]
    status_counts = Counter(t.status for t in trials)

    overall = _rate_metric(groups, case_pass_rate)
    per_eval: dict[str, Any] = {}
    for eid in evaluator_ids(live):
        ss = [s for t in live if (s := t.score(eid))]
        counts = Counter(s["status"] for s in ss)
        numeric = [float(s["score"]) for s in ss if s.get("score") is not None and s["status"] in DECIDED]
        rate = _rate_metric(groups, lambda ts, e=eid: _evaluator_case_rate(ts, e))
        first = ss[0] if ss else {}
        per_eval[eid] = {
            "pass_rate": rate["value"], "ci_low": rate["ci_low"], "ci_high": rate["ci_high"], "n_cases": rate["n"],
            "n_decided": counts.get("pass", 0) + counts.get("fail", 0), "counts": dict(counts),
            "mean_score": _mean(numeric), "kind": first.get("kind"), "version": first.get("evaluator_version"),
            "gating": first.get("metadata", {}).get("gating", True),
        }

    latencies = [t.latency_ms for t in live if t.latency_ms is not None]
    tokens = [t.total_tokens for t in live if t.total_tokens is not None]
    tcost = [t.target_cost_usd for t in live if t.target_cost_usd is not None]
    jcost = [t.judge_cost_usd for t in live if t.judge_cost_usd is not None]

    # Repeated trials
    reliability: dict[str, Any] = {}
    trial_counts = {len([t for t in ts if t.status in ("passed", "failed", "error")]) for ts in groups.values()}
    n_trials = min(trial_counts) if trial_counts else 0
    if n_trials >= 1:
        for k in sorted({1, n_trials} | ({3} if n_trials >= 3 else set())):
            at, hat = [], []
            for ts in groups.values():
                scored = [t for t in ts if t.status in ("passed", "failed", "error")]
                n, c = len(scored), sum(t.status == "passed" for t in scored)
                if n >= k:
                    at.append(pass_at_k(n, c, k))
                    hat.append(pass_hat_k(n, c, k))
            reliability[f"k{k}"] = {"k": k, "pass_at_k": _mean(at), "pass_hat_k": _mean(hat), "n_cases": len(at)}
        flaky = [cid for cid, ts in groups.items()
                 if len({t.status for t in ts if t.status in ("passed", "failed")}) > 1]
        reliability["flaky_cases"] = sorted(flaky)

    # Failure taxonomy (each failed trial counts once per failure type)
    failures = Counter(ft for t in live for ft in t.failure_types)

    # Breakdowns
    def breakdown(key) -> dict[str, Any]:
        buckets: dict[str, list[float]] = defaultdict(list)
        for cid, ts in groups.items():
            info = cases.get(cid, CaseInfo())
            r = case_pass_rate(ts)
            if r is None:
                continue
            for b in key(info):
                buckets[b].append(r)
        return {b: {"pass_rate": _mean(v), "n": len(v)} for b, v in sorted(buckets.items())}

    metrics = {
        "overall_pass_rate": overall["value"],
        "tool_accuracy": _rate_metric(groups, _tool_accuracy_case_rate)["value"],
        "p50_latency_ms": percentile(latencies, 50),
        "p95_latency_ms": percentile(latencies, 95),
        "mean_latency_ms": _mean(latencies),
        "average_total_tokens": _mean([float(x) for x in tokens]),
        "average_cost_usd": _mean(tcost) if tcost and len(tcost) == len(live) else None,
        "total_judge_cost_usd": sum(jcost) if jcost else None,
    }
    for eid, m in per_eval.items():
        metrics[eid] = m["pass_rate"]
        if m["mean_score"] is not None:
            metrics[f"{eid}.mean"] = m["mean_score"]

    return {
        "n_cases": len(groups),
        "n_trials": len(trials),
        "trials_per_case": n_trials,
        "status_counts": dict(status_counts),
        "overall": {k: v for k, v in overall.items() if k != "per_case"},
        "metrics": metrics,
        "evaluators": per_eval,
        "reliability": reliability,
        "failures": dict(failures.most_common()),
        "failed_trials": status_counts.get("failed", 0) + status_counts.get("error", 0),
        "by_category": breakdown(lambda i: [i.category]),
        "by_difficulty": breakdown(lambda i: [i.difficulty]),
        "by_tag": breakdown(lambda i: i.tags),
        "telemetry": {
            "latency_n": len(latencies), "tokens_n": len(tokens), "target_cost_n": len(tcost),
            "judge_cost_n": len(jcost), "trials_n": len(live),
        },
    }


# --------------------------------------------------------------------------------------
# Comparison
# --------------------------------------------------------------------------------------

HEADLINE = [
    ("overall_pass_rate", "Overall pass rate", "rate"),
    ("correctness", "Answer correctness (grading model)", "rate"),
    ("groundedness", "Groundedness (grading model)", "rate"),
    ("must_mention", "Must-mention check", "rate"),
    ("refusal_check", "Refusal behaviour", "rate"),
    ("recall_at_k.mean", "Recall@k (mean)", "score"),
    ("mrr.mean", "MRR (mean)", "score"),
    ("tool_accuracy", "Tool accuracy", "rate"),
    ("task_success", "Task success", "rate"),
    ("p50_latency_ms", "p50 latency", "latency"),
    ("p95_latency_ms", "p95 latency", "latency"),
    ("average_total_tokens", "Tokens / query", "count"),
    ("average_cost_usd", "Est. cost / query", "cost"),
]


def compare(base_trials: list[TrialView], cand_trials: list[TrialView], cases: dict[str, CaseInfo] | None = None,
            score_change: float = 0.25) -> dict[str, Any]:
    cases = cases or {}
    a, b = aggregate(base_trials, cases), aggregate(cand_trials, cases)
    ga, gb = _case_groups(base_trials), _case_groups(cand_trials)
    shared = sorted(set(ga) & set(gb))

    def paired(fn) -> dict[str, Any] | None:
        pairs = [(x, y) for cid in shared if (x := fn(ga[cid])) is not None and (y := fn(gb[cid])) is not None]
        if not pairs:
            return None
        ci = paired_bootstrap_delta(pairs)
        return {"delta": ci.estimate, "ci_low": ci.low, "ci_high": ci.high, "n": ci.n,
                "excludes_zero": ci.low is not None and ci.high is not None and (ci.low > 0 or ci.high < 0)}

    rows = []
    for key, label, unit in HEADLINE:
        va, vb = a["metrics"].get(key), b["metrics"].get(key)
        row: dict[str, Any] = {"metric": key, "label": label, "unit": unit, "baseline": va, "candidate": vb,
                               "delta": None, "relative": None, "ci": None}
        if va is not None and vb is not None:
            row["delta"] = vb - va
            row["relative"] = (vb - va) / va if va else None
        if key == "overall_pass_rate":
            row["ci"] = paired(case_pass_rate)
        elif key == "tool_accuracy":
            row["ci"] = paired(_tool_accuracy_case_rate)
        elif unit == "rate" and va is not None:
            row["ci"] = paired(lambda ts, e=key: _evaluator_case_rate(ts, e))
        if va is None and vb is None:
            continue
        rows.append(row)

    # Case-level changes
    def strict_pass(ts: list[TrialView]) -> bool:
        return bool(ts) and all(t.status == "passed" for t in ts)

    regressions, improvements, changed = [], [], []
    for cid in shared:
        ra, rb = case_pass_rate(ga[cid]), case_pass_rate(gb[cid])
        info = cases.get(cid, CaseInfo())
        entry = {"case_id": cid, "title": info.title, "category": info.category, "baseline_pass_rate": ra,
                 "candidate_pass_rate": rb,
                 "candidate_failure_types": sorted({f for t in gb[cid] for f in t.failure_types}),
                 "baseline_failure_types": sorted({f for t in ga[cid] for f in t.failure_types})}
        if ra is not None and rb is not None and rb < ra:
            regressions.append(entry)
        elif ra is not None and rb is not None and rb > ra:
            improvements.append(entry)
        for eid in sorted(set(evaluator_ids(ga[cid])) & set(evaluator_ids(gb[cid]))):
            sa = _mean([float(s["score"]) for t in ga[cid] if (s := t.score(eid)) and s.get("score") is not None
                        and s["status"] in DECIDED])
            sb = _mean([float(s["score"]) for t in gb[cid] if (s := t.score(eid)) and s.get("score") is not None
                        and s["status"] in DECIDED])
            if sa is not None and sb is not None and abs(sb - sa) >= score_change and eid not in ("latency",):
                if get_kind(ga[cid], eid) in ("performance", "llm_judge"):  # judge score = confidence
                    continue
                changed.append({"case_id": cid, "evaluator_id": eid, "baseline": sa, "candidate": sb})

    mc = mcnemar_exact([(strict_pass(ga[c]), strict_pass(gb[c])) for c in shared])

    cats = sorted(set(a["by_category"]) | set(b["by_category"]))
    by_category = [{"category": c, "baseline": a["by_category"].get(c, {}).get("pass_rate"),
                    "candidate": b["by_category"].get(c, {}).get("pass_rate"),
                    "n": b["by_category"].get(c, {}).get("n") or a["by_category"].get(c, {}).get("n")} for c in cats]
    for row in by_category:
        row["delta"] = (row["candidate"] - row["baseline"]
                        if row["candidate"] is not None and row["baseline"] is not None else None)

    return {
        "n_shared_cases": len(shared),
        "only_in_baseline": sorted(set(ga) - set(gb)),
        "only_in_candidate": sorted(set(gb) - set(ga)),
        "metrics": rows,
        "regressions": regressions,
        "improvements": improvements,
        "score_changes": changed,
        "mcnemar": mc.as_dict(),
        "by_category": by_category,
        "baseline": a,
        "candidate": b,
    }


def get_kind(ts: list[TrialView], eid: str) -> str | None:
    for t in ts:
        if s := t.score(eid):
            return s.get("kind")
    return None


def describe_delta(row: dict[str, Any]) -> str:
    """Plain-language reading that does not overclaim."""
    ci = row.get("ci")
    if row.get("delta") is None:
        return "not available"
    if not ci or ci.get("ci_low") is None:
        return "no interval (too few paired questions)"
    if ci["excludes_zero"]:
        return "interval excludes zero"
    return "within noise (interval includes zero)"
