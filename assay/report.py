"""Machine-readable and Markdown summaries (CI artifacts, PR comments)."""

from __future__ import annotations

from typing import Any

from assay.textutil import plural

UNITS = {"rate": "pp", "score": "", "latency": "ms", "count": "", "cost": "$"}


def fmt_value(unit: str, v: float | None) -> str:
    if v is None:
        return "n/a"
    if unit == "rate":
        return f"{v * 100:.1f}%"
    if unit == "latency":
        return f"{v / 1000:.2f}s" if v >= 1000 else f"{v:.0f}ms"
    if unit == "cost":
        return f"${v:.5f}"
    if unit == "count":
        return f"{v:.0f}"
    return f"{v:.3f}"


def fmt_delta(row: dict[str, Any]) -> str:
    d = row.get("delta")
    if d is None:
        return "n/a"
    if row["unit"] == "rate":
        return f"{d * 100:+.1f}pp"
    if row["unit"] == "score":
        return f"{d:+.3f}"
    rel = row.get("relative")
    return f"{rel * 100:+.1f}%" if rel is not None else f"{d:+.3g}"


LOWER_IS_BETTER = {"latency", "cost", "count"}


def direction(row: dict[str, Any]) -> str:
    d = row.get("delta")
    if d is None or d == 0:
        return "="
    better = d < 0 if row["unit"] in LOWER_IS_BETTER else d > 0
    return "better" if better else "worse"


def markdown_summary(comparison: dict[str, Any] | None, gate: dict[str, Any] | None, run: dict[str, Any]) -> str:
    lines = ["## Assay evaluation", ""]
    lines.append(f"Run **#{run['id']}**: {run.get('experiment') or ''}, connection `{run.get('target')}` "
                 f"v{run.get('target_version')}, dataset `{run.get('dataset')}` v{run.get('dataset_version')}, "
                 f"{plural(run.get('n_cases') or 0, 'question')} × {plural(run.get('trials_per_case') or 1, 'try', 'tries')}")
    judge = run.get("judge")
    if judge:
        lines.append(f"Grading model: {judge.get('provider')}/{judge.get('model')}"
                     + (" (heuristic, no model involved)" if judge.get("provider") == "heuristic" else ""))
    lines.append("")
    if comparison:
        lines += ["| | Metric | Baseline | Candidate | Delta | 95% CI (paired) |", "|---|---|---|---|---|---|"]
        for r in comparison["metrics"]:
            mark = {"better": "+", "worse": "-", "=": " "}[direction(r)]
            ci = r.get("ci")
            ci_s = (f"[{ci['ci_low'] * 100:+.1f}, {ci['ci_high'] * 100:+.1f}]pp" if ci and ci.get("ci_low") is not None
                    and r["unit"] == "rate" else "")
            lines.append(f"| {mark} | {r['label']} | {fmt_value(r['unit'], r['baseline'])} | "
                         f"{fmt_value(r['unit'], r['candidate'])} | {fmt_delta(r)} | {ci_s} |")
        mc = comparison["mcnemar"]
        lines += ["", f"Paired questions: {comparison['n_shared_cases']}. Improved: {len(comparison['improvements'])}, "
                      f"regressed: {len(comparison['regressions'])}. McNemar exact p = "
                      + (f"{mc['p_value']:.3f}" if mc.get("p_value") is not None else "n/a (no questions changed result)")
                      + ". An interval that includes 0 means the difference is within noise at this sample size."]
        if comparison["regressions"]:
            lines += ["", "**Regressed questions**", ""]
            for c in comparison["regressions"][:15]:
                lines.append(f"- `{c['case_id']}` {c.get('title') or ''} - "
                             f"{(c['baseline_pass_rate'] or 0) * 100:.0f}% -> {(c['candidate_pass_rate'] or 0) * 100:.0f}% "
                             f"({', '.join(c['candidate_failure_types']) or 'n/a'})")
    if gate:
        lines += ["", f"### Gate: {gate['status']}", ""]
        for g in gate["gates"]:
            icon = {"PASS": "PASS", "FAIL": "FAIL", "NOT_EVALUATED": "N/A"}[g["status"]]
            val = g.get("value")
            vs = f"{val:.4g}" if isinstance(val, float) else str(val)
            lines.append(f"- **{icon}** `{g['gate']}`: {vs} ({g['rule']} {g['limit']})"
                         + (f" - {g['reason']}" if g.get("reason") else ""))
        if gate["status"] == "FAIL":
            lines += ["", "**REGRESSION DETECTED**"]
    return "\n".join(lines) + "\n"
