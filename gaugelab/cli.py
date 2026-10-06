"""The ``gaugelab`` command.

    gaugelab db upgrade                     apply migrations
    gaugelab serve [--port 8040]            API + built web app
    gaugelab demo-agent [--port 9040]       the fictional Acme agent over HTTP
    gaugelab seed [--run] [--fresh]         demo project, dataset, targets, gate (and runs)
    gaugelab validate dataset.yaml          check a dataset file
    gaugelab run experiment.yaml            run an experiment from config
    gaugelab compare <baseline> <candidate> paired comparison of two runs
    gaugelab export <run> --format json|md  machine-readable or Markdown result
    gaugelab gate <run> [--config g.yaml] [--baseline <run>]   exit 1 if a gate fails
    gaugelab ci ci.yaml                     baseline + candidate + gate, for CI pipelines
    gaugelab import results.jsonl --config import.yaml --name NAME
"""

from __future__ import annotations

import argparse
import asyncio
import json
import os
import sys
from pathlib import Path
from typing import Any

import yaml

ROOT = Path(__file__).resolve().parents[1]


def _out(obj: Any) -> None:
    print(json.dumps(obj, indent=2, default=str))


def _session():
    from gaugelab.store import db

    db.upgrade()
    return db.session


# --------------------------------------------------------------------------------------


def cmd_db(args) -> int:
    from gaugelab.store import db

    db.upgrade()
    print(f"Database at head: {db.database_url().split('?')[0]}")
    return 0


def cmd_serve(args) -> int:
    import uvicorn

    sys.path.insert(0, str(ROOT / "apps" / "api"))
    uvicorn.run("app.main:app", host=args.host, port=args.port, reload=False)
    return 0


def cmd_demo_agent(args) -> int:
    import uvicorn

    uvicorn.run("acme_support_agent.app.server:app", host=args.host, port=args.port)
    return 0


def cmd_validate(args) -> int:
    from gaugelab.datasets import DatasetError, content_hash, parse_dataset

    path = Path(args.file)
    try:
        ds = parse_dataset(path.read_text(encoding="utf-8"), path.name)
    except DatasetError as exc:
        print(f"INVALID: {path}")
        for e in exc.errors:
            print(f"  - {e}")
        return 1
    from collections import Counter

    print(f"VALID: {ds.name} - {len(ds.cases)} cases - sha256 {content_hash(ds.cases)[:12]}")
    for cat, n in sorted(Counter(c.category for c in ds.cases).items()):
        print(f"  {cat:20} {n}")
    return 0


async def _execute(run_id: int) -> None:
    from gaugelab.store import service as svc

    await svc.execute_run(run_id)


KEY_REFS = {"openai": "env:OPENAI_API_KEY", "anthropic": "env:ANTHROPIC_API_KEY"}


def judge_override(spec: str | None) -> dict[str, Any] | None:
    """"heuristic", "ollama:llama3.1:8b", "openai:<model>", "anthropic:<model>" -> a judge config."""
    if not spec:
        return None
    if spec == "heuristic":
        return {"provider": "heuristic"}
    provider, _, model = spec.partition(":")
    if provider not in ("ollama", "openai", "anthropic") or not model:
        raise SystemExit(f"--judge must be heuristic or provider:model (ollama|openai|anthropic), got {spec!r}")
    out: dict[str, Any] = {"provider": provider, "model": model}
    if provider in KEY_REFS:
        out["api_key_ref"] = KEY_REFS[provider]
    return out


def _run_config(path: str, judge: str | None = None) -> tuple[int, dict[str, Any]]:
    from gaugelab.config_run import load_yaml, prepare_run

    session = _session()
    cfg = load_yaml(path)
    if judge:
        cfg["judge"] = judge_override(judge)
    with session() as s:
        run, gates = prepare_run(s, cfg)
        run_id = run.id
    print(f"Run #{run_id}: {cfg.get('experiment', {}).get('name')} ...", file=sys.stderr)
    asyncio.run(_execute(run_id))
    return run_id, gates


def _header(run_id: int) -> dict[str, Any]:
    from gaugelab.store import models as m
    from gaugelab.store import service as svc

    with _session()() as s:
        return svc.run_header(s, svc.get(s, m.Run, run_id))


def cmd_run(args) -> int:
    run_id, gates = _run_config(args.config, args.judge)
    h = _header(run_id)
    met = h["metrics"]
    print(f"Run #{run_id} {h['status']}: {h['n_cases']} cases, overall pass rate "
          f"{(met.get('overall_pass_rate') or 0) * 100:.1f}%", file=sys.stderr)
    if gates:
        return _gate(run_id, gates, args.baseline)
    _out(h)
    return 0 if h["status"] in ("completed", "completed_with_errors") else 1


def _gate(run_id: int, config: dict[str, Any], baseline: int | None) -> int:
    from gaugelab.store import service as svc

    with _session()() as s:
        gr = svc.apply_gate(s, run_id, config, baseline)
        res = gr.results
    for g in res["gates"]:
        print(f"  {g['status']:14} {g['gate']}: {g['value']} ({g['rule']} {g['limit']})", file=sys.stderr)
    print(f"Gate: {res['status']}", file=sys.stderr)
    _out(res)
    return 1 if res["status"] == "FAIL" else 0


def cmd_gate(args) -> int:
    from gaugelab.store import models as m
    from gaugelab.store import service as svc

    if args.config:
        config = yaml.safe_load(Path(args.config).read_text(encoding="utf-8"))
        config = config.get("gates", config)
    else:
        with _session()() as s:
            run = svc.get(s, m.Run, args.run_id)
            exp = svc.get(s, m.Experiment, run.experiment_id)
            if exp.gate_id is None:
                print("No --config given and the experiment has no gate.", file=sys.stderr)
                return 2
            config = svc.get(s, m.RegressionGate, exp.gate_id).config
    return _gate(args.run_id, config, args.baseline)


def cmd_compare(args) -> int:
    from gaugelab.report import markdown_summary
    from gaugelab.store import models as m
    from gaugelab.store import service as svc

    with _session()() as s:
        cmp = svc.compare_runs(s, args.baseline, args.candidate)
        if args.md:
            print(markdown_summary(cmp, None, svc.run_header(s, svc.get(s, m.Run, args.candidate))))
            return 0
    _out({k: v for k, v in cmp.items() if k not in ("baseline", "candidate")})
    return 0


def cmd_export(args) -> int:
    sys.path.insert(0, str(ROOT / "apps" / "api"))
    from app.routers.runs import export

    with _session()() as s:
        resp = export(args.run_id, args.format, args.baseline, s)
    text = bytes(resp.body).decode("utf-8")
    if args.out:
        Path(args.out).write_text(text, encoding="utf-8")
        print(f"Wrote {args.out}", file=sys.stderr)
    else:
        print(text)
    return 0


def cmd_ci(args) -> int:
    """Run baseline and candidate configs, compare, gate the candidate, write artifacts."""
    from gaugelab.report import markdown_summary
    from gaugelab.store import models as m
    from gaugelab.store import service as svc

    ci = yaml.safe_load(Path(args.config).read_text(encoding="utf-8"))
    base_dir = Path(args.config).resolve().parent
    b_id, _ = _run_config(str(base_dir / ci["baseline"]), args.judge)
    c_id, gates = _run_config(str(base_dir / ci["candidate"]), args.judge)
    gates = ci.get("gates") or gates
    with _session()() as s:
        gr = svc.apply_gate(s, c_id, gates, b_id)
        cmp = svc.compare_runs(s, b_id, c_id)
        header = svc.run_header(s, svc.get(s, m.Run, c_id))
        md = markdown_summary(cmp, gr.results, header)
        summary = {"baseline_run": b_id, "candidate_run": c_id, "gate": gr.results,
                   "metrics": {r["metric"]: {k: r[k] for k in ("baseline", "candidate", "delta")} | {"ci": r["ci"]}
                               for r in cmp["metrics"]},
                   "regressions": [r["case_id"] for r in cmp["regressions"]],
                   "improvements": [r["case_id"] for r in cmp["improvements"]],
                   "mcnemar": cmp["mcnemar"]}
    out = Path(args.out_dir)
    out.mkdir(parents=True, exist_ok=True)
    (out / "gaugelab-summary.json").write_text(json.dumps(summary, indent=2, default=str), encoding="utf-8")
    (out / "gaugelab-summary.md").write_text(md, encoding="utf-8")
    print(md)
    if os.environ.get("GITHUB_STEP_SUMMARY"):
        with open(os.environ["GITHUB_STEP_SUMMARY"], "a", encoding="utf-8") as fh:
            fh.write(md)
    print(f"Gate: {gr.results['status']}  (artifacts in {out})", file=sys.stderr)
    return 1 if gr.results["status"] == "FAIL" else 0


def cmd_import(args) -> int:
    from gaugelab.adapters.importer import ImportConfig
    from gaugelab.store import service as svc
    from gaugelab.store.imports import create_import

    cfg = ImportConfig.model_validate(yaml.safe_load(Path(args.config).read_text(encoding="utf-8")) or {})
    path = Path(args.file)
    with _session()() as s:
        project = svc.ensure_project(s, args.project)
        res = create_import(s, project.id, args.name, path.name, path.read_text(encoding="utf-8"), cfg,
                            base_dir=path.parent)
    _out(res)
    return 0


def _fresh_sqlite() -> None:
    """Delete the SQLite database file (a clean demo). Refuses anything that is not SQLite."""
    from pathlib import Path

    from gaugelab.store import db

    url = db.database_url()
    if not url.startswith("sqlite:///"):
        raise SystemExit("--fresh only deletes a SQLite database; drop other databases yourself.")
    path = Path(url.split("///", 1)[1])
    if db._engine is not None:
        db._engine.dispose()
    for suffix in ("", "-wal", "-shm"):
        f = Path(str(path) + suffix)
        try:
            f.unlink(missing_ok=True)
        except PermissionError as exc:
            raise SystemExit(f"{f} is in use: stop `gaugelab serve` first, then run this again.") from exc
    print(f"Deleted {path}")


def cmd_seed(args) -> int:
    from gaugelab.seed import seed

    if args.fresh:
        _fresh_sqlite()
    res = seed(run=args.run, trials=args.trials, force_runs=args.force_runs)
    _out(res)
    return 0


def main(argv: list[str] | None = None) -> int:
    p = argparse.ArgumentParser(prog="gaugelab", description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    sub = p.add_subparsers(dest="cmd", required=True)

    d = sub.add_parser("db", help="database commands")
    d.add_argument("action", choices=["upgrade"])
    d.set_defaults(fn=cmd_db)

    sv = sub.add_parser("serve", help="run the API and web app")
    sv.add_argument("--host", default="127.0.0.1")
    sv.add_argument("--port", type=int, default=8040)
    sv.set_defaults(fn=cmd_serve)

    da = sub.add_parser("demo-agent", help="run the fictional Acme agent over HTTP")
    da.add_argument("--host", default="127.0.0.1")
    da.add_argument("--port", type=int, default=9040)
    da.set_defaults(fn=cmd_demo_agent)

    sd = sub.add_parser("seed", help="create the Acme demo project")
    sd.add_argument("--run", action="store_true", help="also run baseline and candidate experiments")
    sd.add_argument("--trials", type=int, default=3)
    sd.add_argument("--force-runs", action="store_true", help="run again even if demo runs exist")
    sd.add_argument("--fresh", action="store_true",
                    help="start from an empty SQLite database (deletes it first) - a clean demo in one command")
    sd.set_defaults(fn=cmd_seed)

    v = sub.add_parser("validate", help="validate a dataset file")
    v.add_argument("file")
    v.set_defaults(fn=cmd_validate)

    r = sub.add_parser("run", help="run an experiment YAML")
    r.add_argument("config")
    r.add_argument("--baseline", type=int, help="baseline run id for regression gates")
    r.add_argument("--judge", help="override the judge: heuristic | ollama:<model> | openai:<model> | anthropic:<model>")
    r.set_defaults(fn=cmd_run)

    c = sub.add_parser("compare", help="compare two runs")
    c.add_argument("baseline", type=int)
    c.add_argument("candidate", type=int)
    c.add_argument("--md", action="store_true", help="Markdown instead of JSON")
    c.set_defaults(fn=cmd_compare)

    e = sub.add_parser("export", help="export a run")
    e.add_argument("run_id", type=int)
    e.add_argument("--format", choices=["json", "md"], default="json")
    e.add_argument("--baseline", type=int)
    e.add_argument("--out")
    e.set_defaults(fn=cmd_export)

    g = sub.add_parser("gate", help="apply regression gates to a run (exit 1 on FAIL)")
    g.add_argument("run_id", type=int)
    g.add_argument("--config", help="YAML with gate thresholds")
    g.add_argument("--baseline", type=int)
    g.set_defaults(fn=cmd_gate)

    ci = sub.add_parser("ci", help="baseline + candidate + gates; writes summary artifacts")
    ci.add_argument("config")
    ci.add_argument("--out-dir", default="gaugelab-artifacts")
    ci.add_argument("--judge", help="override the judge for both runs (see run --judge)")
    ci.set_defaults(fn=cmd_ci)

    im = sub.add_parser("import", help="import results a system already produced")
    im.add_argument("file")
    im.add_argument("--config", required=True)
    im.add_argument("--name", required=True)
    im.add_argument("--project", default="Imported")
    im.set_defaults(fn=cmd_import)

    args = p.parse_args(argv)
    from gaugelab.env import load_dotenv

    load_dotenv()
    return int(args.fn(args) or 0)


if __name__ == "__main__":
    sys.exit(main())
