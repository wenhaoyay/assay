"""Config-as-code: turn an experiment YAML into stored, versioned entities and run it.

    experiment: {name: hybrid-retrieval-v2}
    project: Acme Support Demo            # optional
    dataset:  {path: dataset.yaml}        # or {name: acme-support, version: 3}
    target:                               # inline config (versioned by content) or {name: ..., version: n}
      name: Acme agent - candidate
      adapter: python
      config: {callable: "acme_support_agent.app:run", options: {variant: candidate}}
    trials: 3
    evaluators: [must_mention, recall_at_k, tool_selection, correctness]
    judge: {provider: heuristic}          # or {provider: ollama, model: llama3.1:8b} or {provider_config: <name>}
    gates: {overall_pass_rate: {min: 0.85}, regression: {maximum_drop: 0.03}}

Re-running the same file reuses the same dataset/target versions when their content is
unchanged, and creates new versions when it changed - so runs stay comparable and honest.
"""

from __future__ import annotations

from pathlib import Path
from typing import Any

import yaml
from sqlalchemy import select
from sqlalchemy.orm import Session

from gaugelab.datasets import content_hash, parse_dataset
from gaugelab.evaluators import DEFAULT_EVALUATORS
from gaugelab.store import models as m
from gaugelab.store import service as svc


def load_yaml(path: str | Path) -> dict[str, Any]:
    data = yaml.safe_load(Path(path).read_text(encoding="utf-8"))
    if not isinstance(data, dict):
        raise ValueError(f"{path}: expected a mapping")
    data["_base"] = str(Path(path).resolve().parent)
    return data


def _resolve_path(base: str, p: str) -> Path:
    path = Path(p)
    return path if path.is_absolute() else Path(base) / path


def resolve_dataset(s: Session, project_id: int, spec: dict[str, Any], base: str) -> m.DatasetVersion:
    if "path" in spec:
        path = _resolve_path(base, spec["path"])
        parsed = parse_dataset(path.read_text(encoding="utf-8"), path.name)
        name = spec.get("name") or parsed.name
        ds = s.scalar(select(m.Dataset).where(m.Dataset.project_id == project_id, m.Dataset.name == name))
        if ds is None:
            return svc.create_dataset(s, project_id, name, parsed.cases, parsed.description,
                                      change_summary=f"Imported from {path.name}")
        latest = svc.latest_version(s, ds.id)
        if latest.content_hash == content_hash(parsed.cases):
            return latest
        # Content changed: a new version holding exactly the file's cases.
        v = svc.editable_version(s, latest.id, f"synced from {path.name}")
        rows = [svc._case_row(s, ds.id, c, "import") for c in parsed.cases]
        svc._set_membership(s, v, rows)
        return v
    ds = s.scalar(select(m.Dataset).where(m.Dataset.project_id == project_id, m.Dataset.name == spec["name"]))
    if ds is None:
        raise svc.NotFound(f"Dataset {spec['name']!r} not found")
    if "version" in spec:
        found = s.scalar(select(m.DatasetVersion).where(m.DatasetVersion.dataset_id == ds.id,
                                                        m.DatasetVersion.version == int(spec["version"])))
        if found is None:
            raise svc.NotFound(f"Dataset {spec['name']!r} has no version {spec['version']}")
        return found
    return svc.latest_version(s, ds.id)


def resolve_target(s: Session, project_id: int, spec: dict[str, Any]) -> m.TargetVersion:
    name = spec.get("name") or f"{spec.get('adapter', 'http')} target"
    t = s.scalar(select(m.Target).where(m.Target.project_id == project_id, m.Target.name == name))
    if "config" not in spec and "endpoint" not in spec:
        if t is None:
            raise svc.NotFound(f"Target {name!r} not found")
        if "version" in spec:
            tv = s.scalar(select(m.TargetVersion).where(m.TargetVersion.target_id == t.id,
                                                        m.TargetVersion.version == int(spec["version"])))
            if tv is None:
                raise svc.NotFound(f"Target {name!r} has no version {spec['version']}")
            return tv
        return svc.latest_target_version(s, t.id)
    adapter = spec.get("adapter", "http")
    config = spec.get("config")
    if config is None:  # the short form from the docs: {adapter: http, endpoint: http://host:9000/chat}
        from urllib.parse import urlsplit

        u = urlsplit(spec["endpoint"])
        config = {"base_url": f"{u.scheme}://{u.netloc}", "endpoint": u.path or "/"}
    if t is None:
        return svc.create_target(s, project_id, name, adapter, config, spec.get("description", ""),
                                 spec.get("variant_label", ""))
    return svc.update_target_config(s, t.id, config, spec.get("variant_label"))


def resolve_judge(s: Session, project_id: int, spec: dict[str, Any] | None) -> dict[str, Any] | None:
    if not spec:
        return None
    if spec.get("provider") == "heuristic":
        return {"provider": "heuristic"}
    if "provider_config" in spec:
        pc = s.scalar(select(m.ProviderConfig).where(m.ProviderConfig.name == spec["provider_config"]))
        if pc is None:
            raise svc.NotFound(f"Provider config {spec['provider_config']!r} not found")
        return {"provider_config_id": pc.id}
    name = spec.get("name") or f"{spec['provider']}:{spec['model']}"
    pc = s.scalar(select(m.ProviderConfig).where(m.ProviderConfig.name == name))
    if pc is None:
        pc = m.ProviderConfig(project_id=project_id, name=name, provider=spec["provider"], model=spec["model"],
                              base_url=spec.get("base_url"), api_key_ref=spec.get("api_key_ref"),
                              temperature=float(spec.get("temperature", 0.0)),
                              max_tokens=int(spec.get("max_tokens", 600)))
        s.add(pc)
        s.flush()
    return {"provider_config_id": pc.id}


def prepare_run(s: Session, cfg: dict[str, Any]) -> tuple[m.Run, dict[str, Any]]:
    base = cfg.get("_base", ".")
    project = svc.ensure_project(s, cfg.get("project", "Default"))
    dv = resolve_dataset(s, project.id, cfg["dataset"], base)
    tv = resolve_target(s, project.id, cfg["target"])
    judge = resolve_judge(s, project.id, cfg.get("judge"))
    evaluators = cfg.get("evaluators") or DEFAULT_EVALUATORS
    exp = cfg.get("experiment", {})
    e = svc.create_experiment(
        s, project.id, exp.get("name", "experiment"), tv.id, dv.id, evaluators, judge, None,
        description=exp.get("description", ""), trials=cfg.get("trials", 1), concurrency=cfg.get("concurrency", 4),
        seed=cfg.get("seed", 7), k=cfg.get("k", 5), options=cfg.get("options") or {},
        budget_usd=cfg.get("budget_usd"), redact_fields=cfg.get("redact_fields") or [],
        case_filter=cfg.get("case_filter"))
    run = svc.start_run(s, e.id)
    return run, cfg.get("gates") or {}
