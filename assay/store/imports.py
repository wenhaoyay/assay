"""Turn imported results into a dataset + a replay target, ready for an experiment.

Imported conversations usually have no expected outcomes, so the dataset gets INPUT-ONLY
cases. Black-box checks (latency, citation validity, refusal phrasing, relevance and
groundedness judges) still apply; correctness needs expectations a person adds later.
"""

from __future__ import annotations

from pathlib import Path
from typing import Any

from sqlalchemy.orm import Session

from assay.adapters.importer import ImportConfig, import_records
from assay.schemas import CaseInput, TestCase
from assay.store import models as m
from assay.store import service as svc


def create_import(s: Session, project_id: int, name: str, filename: str, text: str, cfg: ImportConfig,
                  base_dir: Path | None = None) -> dict[str, Any]:
    skipped: list[int] = []
    records = import_records(text, filename, cfg, base_dir, skipped)
    if not records:
        raise ValueError("No records matched the import configuration")
    batch = m.ImportBatch(project_id=project_id, name=name, source_filename=filename,
                          config=cfg.model_dump(mode="json"), count=len(records))
    s.add(batch)
    s.flush()
    seen: set[str] = set()
    cases = []
    for rec in records:
        if rec.case_id in seen:
            continue
        seen.add(rec.case_id)
        s.add(m.ImportedResult(batch_id=batch.id, case_key=rec.case_id, message=rec.message,
                               result=rec.result.model_dump(mode="json")))
        cases.append(TestCase(id=rec.case_id, title=rec.message[:80], category=rec.category or "imported",
                              input=CaseInput(message=rec.message), tags=["imported"]))
    v = svc.create_dataset(s, project_id, f"{name} (imported)", cases,
                           f"Inputs imported from {filename}. No expected outcomes yet.", origin="import",
                           change_summary=f"Imported {len(cases)} records")
    tv = svc.create_target(s, project_id, f"{name} (imported results)", "replay", {"import_batch_id": batch.id},
                           f"Replays results imported from {filename}; the system is not called.", "imported")
    return {"batch_id": batch.id, "records": len(cases), "skipped_invalid_lines": skipped[:50], "dataset_id": v.dataset_id, "dataset_version_id": v.id,
            "target_id": tv.target_id, "target_version_id": tv.id}
