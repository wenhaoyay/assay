"""Seed the fictional Acme demo: project, golden dataset, two target variants (+ an HTTP one),
a local Ollama judge config, a release gate - and optionally real baseline/candidate runs."""

from __future__ import annotations

import asyncio
import os
from pathlib import Path
from typing import Any

import yaml
from sqlalchemy import select

from assay.config_run import load_yaml, prepare_run, resolve_dataset, resolve_target
from assay.store import db
from assay.store import models as m
from assay.store import service as svc

ROOT = Path(__file__).resolve().parents[1]
BENCH = ROOT / "benchmarks" / "acme_support"
PROJECT = "Acme Support Demo"


# Three weeks of the demo bot's life, oldest first, so the timeline and trends have something to
# say: a weak start, steady gains, one regression (a reranker that kept 3 passages, not 5) and its
# fix. Every run is real - the Acme agent with different settings - not invented numbers.
# (base variant, overrides, variant label, run name, days ago); overrides None = the variant as is.
HISTORY: list[tuple[str, dict[str, Any] | None, str | None, str | None, int]] = [
    ("baseline", {"top_k": 3, "context_docs": 1, "tool_skip_rate": 0.25}, "lexical BM25 top-3 / prompt v0", "acme-v0", 21),
    ("baseline", {"top_k": 3, "context_docs": 1, "tool_skip_rate": 0.25, "_seed": 11},
     "lexical BM25 top-3 / prompt v0", "acme-v0-rerun", 19),
    ("baseline", {"context_docs": 1, "tool_skip_rate": 0.18}, "lexical BM25 top-5 / prompt v0", "acme-top5", 17),
    ("baseline", None, None, None, 14),
    ("baseline", {"prompt": "v2", "refuse": True, "refuse_coverage": 0.5, "injection_guard": True},
     "lexical BM25 top-5 / prompt v2", "acme-prompt-v2", 12),
    ("candidate", {"context_docs": 2, "retry_tools": False, "use_return_tool": False},
     "hybrid + RRF / prompt v2", "acme-hybrid", 8),
    ("candidate", {"pool": 3, "top_k": 3, "context_docs": 1, "retry_tools": False, "admit_failures": False,
                   "tool_skip_rate": 0.15}, "hybrid + RRF + rerank (k=3 bug) / prompt v2", "acme-rerank-k3", 6),
    ("candidate", {"tool_skip_rate": 0.1}, "hybrid + RRF + rerank / prompt v2 (fix)", "acme-rerank-fixed", 4),
    ("candidate", None, None, None, 2),
]


def _backdate(run_id: int, days_ago: int) -> None:
    """Place a history run on its day (same duration), so the timeline reads like three weeks."""
    from datetime import timedelta

    with db.session() as s:
        r = svc.get(s, m.Run, run_id)
        shift = timedelta(days=days_ago)
        for attr in ("created_at", "started_at", "finished_at"):
            if getattr(r, attr):
                setattr(r, attr, getattr(r, attr) - shift)


def seed(run: bool = False, trials: int = 3, force_runs: bool = False, history: bool = False) -> dict[str, Any]:
    db.upgrade()
    out: dict[str, Any] = {}
    with db.session() as s:
        p = svc.ensure_project(s, PROJECT, "Fictional Acme Devices support agent - the Assay demo system.")
        p.is_demo = True
        dv = resolve_dataset(s, p.id, {"path": "dataset.yaml"}, str(BENCH))
        out["dataset_version_id"] = dv.id
        for name in ("baseline", "candidate"):
            cfg = load_yaml(BENCH / "variants" / f"{name}.yaml")
            tv = resolve_target(s, p.id, cfg["target"])
            out[f"{name}_target_version_id"] = tv.id
        resolve_target(s, p.id, {
            "name": "Acme agent - HTTP (demo server)", "adapter": "http", "variant_label": "candidate over HTTP",
            "description": "The candidate agent behind `assay demo-agent` on :9040 - exercises the HTTP adapter.",
            "config": {"base_url": os.environ.get("ASSAY_DEMO_AGENT_URL")
                                   or os.environ.get("GAUGELAB_DEMO_AGENT_URL", "http://127.0.0.1:9040"),
                       "endpoint": "/chat", "method": "POST",
                       "body": {"message": "{{input.message}}", "variant": "candidate", "seed": "{{trial}}"},
                       "timeout_s": 30,
                       "response": {"answer": "reply.text", "citations": {"path": "reply.sources", "each": {"id": "doc"}},
                                    "retrieved_documents": {"path": "retrieval.hits",
                                                            "each": {"id": "doc", "title": "title", "score": "score",
                                                                     "text": "snippet"}},
                                    "tool_calls": {"path": "trace.tools",
                                                   "each": {"name": "tool", "arguments": "args", "result": "output",
                                                            "status": "status"}},
                                    "usage": {"input_tokens": "usage.prompt", "output_tokens": "usage.completion"},
                                    "provider": {"provider": "model.vendor", "model": "model.name"}}}})
        if not s.scalar(select(m.ProviderConfig).where(m.ProviderConfig.name == "Local judge - Ollama llama3.1:8b")):
            s.add(m.ProviderConfig(project_id=p.id, name="Local judge - Ollama llama3.1:8b", provider="ollama",
                                   model="llama3.1:8b", base_url="http://localhost:11434"))
        gate_cfg = yaml.safe_load((BENCH / "gates.yaml").read_text(encoding="utf-8"))["gates"]
        gate = s.scalar(select(m.RegressionGate).where(m.RegressionGate.name == "Acme release gate"))
        if gate is None:
            gate = m.RegressionGate(project_id=p.id, name="Acme release gate", config=gate_cfg)
            s.add(gate)
            s.flush()
        out["gate_id"] = gate.id
        out["project_id"] = p.id
    with db.session() as s:
        has_runs = s.scalar(select(m.Run.id).join(m.Experiment).where(m.Experiment.project_id == out["project_id"]))
    if run and has_runs and not force_runs:
        out["runs"] = "skipped: the demo project already has runs (use --force-runs to add more)"
    elif run:
        ids = {}
        plain: list[tuple[str, dict[str, Any] | None, str | None, str | None, int]] = [
            ("baseline", None, None, None, 0), ("candidate", None, None, None, 0)]
        steps = HISTORY if history else plain
        for base, overrides, label, run_name, days_ago in steps:
            cfg = load_yaml(BENCH / "variants" / f"{base}.yaml")
            cfg["trials"] = trials
            if overrides is not None:
                overrides = dict(overrides)
                if "_seed" in overrides:  # a re-run of the same version with a different seed
                    cfg["seed"] = overrides.pop("_seed")
                cfg["target"]["config"]["options"]["overrides"] = overrides
                cfg["target"]["variant_label"] = label
                cfg["experiment"]["name"] = run_name
            with db.session() as s:
                r, _ = prepare_run(s, cfg)
                svc.get(s, m.Experiment, r.experiment_id).gate_id = out["gate_id"]
                rid = r.id
            asyncio.run(svc.execute_run(rid))
            if overrides is None:
                ids[base] = rid
            if history:
                _backdate(rid, days_ago)
        with db.session() as s:
            gr = svc.apply_gate(s, ids["candidate"], gate_cfg, ids["baseline"], out["gate_id"])
            out["runs"] = ids
            out["candidate_gate"] = gr.status
    return out
