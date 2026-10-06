"""Regression gates: explicit thresholds on named metrics, each PASS / FAIL / NOT_EVALUATED.

Config (YAML or dict)::

    overall_pass_rate: {min: 0.85}
    groundedness:      {min: 0.90}
    p95_latency_ms:    {max: 3000}
    average_cost_usd:  {max: 0.01}
    regression:                      # relative to a baseline run
      overall_pass_rate: {maximum_drop: 0.03}
      tool_accuracy:     {maximum_drop: 0.02}

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
                    res = _check(f"regression:{metric}", metric, None, "max", drop, "relative", base)
                    if baseline_metrics is None:
                        res["reason"] = "no baseline run to compare against"
                else:
                    res = _check(f"regression:{metric}", metric, round(base - cur, 12), "max", drop, "relative", base)
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
