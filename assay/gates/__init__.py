"""Regression gates: explicit thresholds on named metrics, each PASS / FAIL / NOT_EVALUATED.

Config (YAML or dict)::

    overall_pass_rate: {min: 0.85}
    groundedness:      {min: 0.90}
    p95_latency_ms:    {max: 3000}
    average_cost_usd:  {max: 0.01}
    regression:                      # vs a baseline run, in the metric's own units
      overall_pass_rate: {maximum_drop: 0.03}   # at most 3 points lower
      p95_latency_ms:    {maximum_drop: 250}    # "worse" = higher for latency, cost, tokens
    relative_regression:             # the same, as a fraction of the baseline value
      average_cost_usd:  {maximum_drop: 0.10}   # at most 10% more expensive

A metric is a key of ``aggregate()["metrics"]``: overall_pass_rate, tool_accuracy,
p50/p95_latency_ms, average_total_tokens, average_cost_usd, any evaluator id (its pass
rate) or ``<evaluator>.mean``. A metric the run could not compute is NOT_EVALUATED - and
the overall status becomes INCOMPLETE instead of passing quietly.
"""

from __future__ import annotations

from typing import Any


def _check(name: str, metric: str, value: float | None, rule: str, limit: float, kind: str = "absolute",
           baseline: float | None = None) -> dict[str, Any]:
    out: dict[str, Any] = {"gate": name, "metric": metric, "rule": rule, "limit": limit, "value": value,
                           "kind": kind, "baseline": baseline}
    if value is None:
        out["status"] = "NOT_EVALUATED"
        out["reason"] = "metric not available for this run"
        return out
    ok = value >= limit if rule == "min" else value <= limit
    out["status"] = "PASS" if ok else "FAIL"
    return out


LOWER_IS_BETTER = ("latency", "cost", "tokens")


def lower_is_better(metric: str) -> bool:
    return any(w in metric for w in LOWER_IS_BETTER)


def evaluate_gates(config: dict[str, Any], metrics: dict[str, Any],
                   baseline_metrics: dict[str, Any] | None = None) -> dict[str, Any]:
    results = []
    for name, rule in (config or {}).items():
        if name in ("regression", "relative_regression"):
            items = [("overall_pass_rate", rule)] if "maximum_drop" in rule else list(rule.items())
            for metric, r in items:
                drop = float(r["maximum_drop"])
                cur = metrics.get(metric)
                base = (baseline_metrics or {}).get(metric)
                if base is None or cur is None:
                    res = _check(f"{name}:{metric}", metric, None, "max", drop, "relative", base)
                    if baseline_metrics is None:
                        res["reason"] = "no baseline run to compare against"
                else:
                    # "Drop" = getting worse: a fall for rates, a rise for latency, cost and tokens.
                    worse = (cur - base) if lower_is_better(metric) else (base - cur)
                    if name == "relative_regression" and base:
                        worse = worse / abs(base)  # as a fraction of the baseline
                    res = _check(f"{name}:{metric}", metric, round(worse, 12), "max", drop, "relative", base)
                    res["candidate"] = cur
                results.append(res)
            continue
        if not isinstance(rule, dict):
            raise ValueError(f"Gate {name!r}: expected {{min: x}} or {{max: x}}")
        for op in ("min", "max"):
            if op in rule:
                results.append(_check(name, name, metrics.get(name), op, float(rule[op])))
    statuses = {r["status"] for r in results}
    if not results:
        overall = "NOT_EVALUATED"
    elif "FAIL" in statuses:
        overall = "FAIL"
    elif "NOT_EVALUATED" in statuses:
        overall = "INCOMPLETE"
    else:
        overall = "PASS"
    return {"status": overall, "gates": results}
