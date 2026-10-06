"""Seed the fictional Acme demo: project, golden dataset, two target variants (+ an HTTP one),
a local Ollama judge config, a release gate - and optionally real baseline/candidate runs."""

from __future__ import annotations

import asyncio
from pathlib import Path
from typing import Any

import yaml
from sqlalchemy import select

from gaugelab.config_run import load_yaml, prepare_run, resolve_dataset, resolve_target
from gaugelab.store import db
from gaugelab.store import models as m
from gaugelab.store import service as svc

ROOT = Path(__file__).resolve().parents[1]
BENCH = ROOT / "benchmarks" / "acme_support"
PROJECT = "Acme Support Demo"


def seed(run: bool = False, trials: int = 3) -> dict[str, Any]:
    db.upgrade()
    out: dict[str, Any] = {}
    with db.session() as s:
        p = svc.ensure_project(s, PROJECT, "Fictional Acme Devices support agent - the GaugeLab demo system.")
        dv = resolve_dataset(s, p.id, {"path": "dataset.yaml"}, str(BENCH))
        out["dataset_version_id"] = dv.id
        for name in ("baseline", "candidate"):
            cfg = load_yaml(BENCH / "variants" / f"{name}.yaml")
            tv = resolve_target(s, p.id, cfg["target"])
            out[f"{name}_target_version_id"] = tv.id
        resolve_target(s, p.id, {
            "name": "Acme agent - HTTP (demo server)", "adapter": "http", "variant_label": "candidate over HTTP",
            "description": "The candidate agent behind `gaugelab demo-agent` on :9040 - exercises the HTTP adapter.",
            "config": {"base_url": "http://127.0.0.1:9040", "endpoint": "/chat", "method": "POST",
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
    if run:
        ids = {}
        for name in ("baseline", "candidate"):
            cfg = load_yaml(BENCH / "variants" / f"{name}.yaml")
            cfg["trials"] = trials
            with db.session() as s:
                r, _ = prepare_run(s, cfg)
                svc.get(s, m.Experiment, r.experiment_id).gate_id = out["gate_id"]
                ids[name] = r.id
            asyncio.run(svc.execute_run(ids[name]))
        with db.session() as s:
            gr = svc.apply_gate(s, ids["candidate"], gate_cfg, ids["baseline"], out["gate_id"])
            out["runs"] = ids
            out["candidate_gate"] = gr.status
    return out
