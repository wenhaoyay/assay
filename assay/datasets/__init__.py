"""Load, validate, hash and export golden datasets (YAML, JSON, CSV).

Errors name the exact place: ``cases[4] (id warranty_018) > expected > tool_calls > 0 > name:
Field required`` or ``CSV row 7, column 'refusal_expected'``.

A dataset file looks like::

    name: acme-support
    description: ...
    cases:
      - id: warranty_018
        input: {message: "Is order 18372 still covered by warranty?"}
        expected:
          required_tools: [lookup_order, check_warranty]
          ...

A few friendly aliases are accepted on import (``expected.answer: "text"`` -> reference,
``expected.forbidden_claims`` -> ``answer.must_not_claim``, ``input: "text"`` -> message).
"""

from __future__ import annotations

import copy
import csv
import hashlib
import io
import json
import re
from dataclasses import dataclass, field
from typing import Any

import yaml
from pydantic import ValidationError

from assay.schemas import CaseInput, TestCase
from assay.textutil import plural


class DatasetError(ValueError):
    def __init__(self, errors: list[str]):
        super().__init__("; ".join(errors[:5]) + (f" (+{len(errors) - 5} more)" if len(errors) > 5 else ""))
        self.errors = errors


@dataclass
class DatasetFile:
    name: str
    description: str = ""
    cases: list[TestCase] = field(default_factory=list)
    metadata: dict[str, Any] = field(default_factory=dict)


def _normalize_case(raw: dict[str, Any]) -> dict[str, Any]:
    c = copy.deepcopy(raw)
    if isinstance(c.get("input"), str):
        c["input"] = {"message": c["input"]}
    if "message" in c and "input" not in c:
        c["input"] = {"message": c.pop("message")}
    exp = c.get("expected") or {}
    c["expected"] = exp
    if isinstance(exp.get("answer"), str):
        exp["answer"] = {"reference": exp["answer"]}
    ans = exp.get("answer") or {}
    exp["answer"] = ans
    for alias, target in (("forbidden_claims", "must_not_claim"), ("must_mention", "must_mention"),
                          ("must_not_claim", "must_not_claim"), ("reference_answer", "reference"),
                          ("expected_label", "label")):
        if alias in exp:
            ans[target] = exp.pop(alias)
    if "relevant_docs" in exp:
        exp["relevant_documents"] = exp.pop("relevant_docs")
    if isinstance(c.get("evaluators"), dict):
        c["evaluator_config"] = c.pop("evaluators")
    return c


def _fmt_loc(loc: tuple[Any, ...]) -> str:
    return " > ".join(str(x) for x in loc)


def validate_cases(raw_cases: list[Any], where: str = "cases") -> list[TestCase]:
    errors: list[str] = []
    cases: list[TestCase] = []
    seen: set[str] = set()
    for i, raw in enumerate(raw_cases):
        label = f"{where}[{i}]"
        if not isinstance(raw, dict):
            errors.append(f"{label}: expected a set of named fields (a mapping), not a single value.")
            continue
        if raw.get("id"):
            label += f" (id {raw['id']})"
            if str(raw["id"]) in seen:
                errors.append(f"{label}: duplicate id {raw['id']!r}")
            seen.add(str(raw["id"]))
        try:
            case = TestCase.model_validate(_normalize_case(raw))
        except ValidationError as exc:
            errors.extend(f"{label} > {_fmt_loc(e['loc'])}: {e['msg']}" for e in exc.errors())
            continue
        cases.append(case)
    if errors:
        raise DatasetError(errors)
    return cases


CSV_COLUMNS = {"id", "question", "message", "reference_answer", "expected_answer", "category", "difficulty", "tags",
               "must_mention", "must_not_claim", "relevant_documents", "required_tools", "refusal_expected"}


def short_title(text: str, limit: int = 80) -> str:
    """A title from longer text: its first sentence if that fits, else cut at a word with an ellipsis."""
    text = " ".join((text or "").split())
    first = re.split(r"(?<=[.!?])\s", text, maxsplit=1)[0]
    if len(first) <= limit:
        return first
    cut = first[: limit - 1].rsplit(" ", 1)[0].rstrip(" ,;:")
    return cut + "…"


# Plain column names (the spreadsheet template for colleagues) and their technical names.
BOM = "\ufeff"  # Excel writes one at the start of a UTF-8 CSV

CSV_ALIASES = {
    "question_people_ask": "question", "questions": "question",
    "must_say": "must_mention", "must_contain": "must_mention", "must_mention_comma_separated": "must_mention",
    "must_never_say": "must_not_claim", "must_not_say": "must_not_claim", "never_say": "must_not_claim",
    "should_refuse": "refusal_expected", "should_refuse_yes_no": "refusal_expected", "refuse": "refusal_expected",
    "correct_answer": "reference_answer", "reference": "reference_answer", "model_answer": "reference_answer",
    "documents": "relevant_documents", "source_documents": "relevant_documents", "sources": "relevant_documents",
    "tools": "required_tools", "type": "category", "topic": "category",
}


def _column(header: str) -> str:
    """'Must mention (comma-separated)' -> 'must_mention'; unknown names come back normalised."""
    h = re.sub(r"[^a-z0-9]+", "_", re.sub(r"\(.*?\)", "", header.strip().lstrip(BOM)).lower()).strip("_")
    full = re.sub(r"[^a-z0-9]+", "_", header.strip().lstrip(BOM).lower()).strip("_")
    for key in (full, h):
        if key in CSV_COLUMNS:
            return key
        if key in CSV_ALIASES:
            return CSV_ALIASES[key]
    return h or header


def _split(v: str | None) -> list[str]:
    """'a | b' or 'a; b' always split; plain 'a, b' splits on comma-space ("1,000" stays whole)."""
    if not v:
        return []
    parts = v.replace(";", "|").split("|") if "|" in v or ";" in v else re.split(r",\s+", v)
    return [x.strip() for x in parts if x.strip()]


def cases_from_csv(text: str) -> list[TestCase]:
    reader = csv.DictReader(io.StringIO(text.lstrip(BOM)))
    if reader.fieldnames:
        reader.fieldnames = [_column(h) for h in reader.fieldnames]
    cols = set(reader.fieldnames or [])
    if not cols & {"question", "message"}:
        raise DatasetError(["CSV header: needs a 'question' (or 'message') column"])
    unknown = cols - CSV_COLUMNS
    if unknown:
        raise DatasetError([f"CSV header: unknown {plural(len(unknown), 'column')} {', '.join(sorted(unknown))}; "
                            f"allowed: {', '.join(sorted(CSV_COLUMNS))}"])
    raw_cases, errors = [], []
    for row_no, row in enumerate(reader, start=2):  # row 1 is the header
        q = (row.get("question") or row.get("message") or "").strip()
        if not q:
            errors.append(f"CSV row {row_no}, column 'question': empty")
            continue
        refusal = (row.get("refusal_expected") or "").strip().lower()
        if refusal and refusal not in ("true", "false", "yes", "no", "1", "0"):
            errors.append(f"CSV row {row_no}, column 'refusal_expected': {refusal!r} is not true/false")
            continue
        ref = (row.get("reference_answer") or row.get("expected_answer") or "").strip()
        raw_cases.append({
            "id": (row.get("id") or f"row_{row_no}").strip(),
            "category": (row.get("category") or "general").strip(),
            "difficulty": (row.get("difficulty") or "medium").strip(),
            "tags": _split(row.get("tags")),
            "input": {"message": q},
            "expected": {
                "answer": {"reference": ref or None, "must_mention": _split(row.get("must_mention")),
                           "must_not_claim": _split(row.get("must_not_claim"))},
                "relevant_documents": _split(row.get("relevant_documents")),
                "required_tools": _split(row.get("required_tools")),
                "refusal_expected": None if not refusal else refusal in ("true", "yes", "1"),
            },
        })
    if errors:
        raise DatasetError(errors)
    return validate_cases(raw_cases, "CSV rows")


def parse_dataset(text: str, filename: str) -> DatasetFile:
    name = filename.lower()
    if name.endswith(".csv"):
        return DatasetFile(name=filename.rsplit(".", 1)[0], cases=cases_from_csv(text))
    try:
        data = json.loads(text) if name.endswith(".json") else yaml.safe_load(text)
    except (json.JSONDecodeError, yaml.YAMLError) as exc:
        kind = "JSON" if name.endswith(".json") else "YAML"
        raise DatasetError([f"{filename}: not valid {kind}: {exc}"]) from exc
    if isinstance(data, list):
        data = {"name": filename.rsplit(".", 1)[0], "cases": data}
    if not isinstance(data, dict) or not isinstance(data.get("cases"), list):
        raise DatasetError([f"{filename}: expected a 'cases' list at the top level"])
    return DatasetFile(name=str(data.get("name") or filename.rsplit(".", 1)[0]),
                       description=str(data.get("description") or ""), cases=validate_cases(data["cases"]),
                       metadata=data.get("metadata") or {})


def case_to_dict(case: TestCase) -> dict[str, Any]:
    """Compact export: drop empty/default fields so files stay readable (and re-import identically)."""
    full = case.model_dump(mode="json")
    default = TestCase(id=case.id, input=CaseInput(message=case.input.message)).model_dump(mode="json")

    def prune(cur: Any, dflt: Any) -> Any:
        if not isinstance(cur, dict):
            return cur
        out = {}
        for k, v in cur.items():
            d = dflt.get(k) if isinstance(dflt, dict) else None
            if k == "input":  # always kept whole: the message is the case
                out[k] = {ik: iv for ik, iv in v.items() if iv not in ([], {}, None)}
                continue
            if k != "id" and isinstance(dflt, dict) and k in dflt and v == d:
                continue
            pv = prune(v, d)
            if pv in ({}, []) or pv is None:
                continue
            out[k] = pv
        return out

    return prune(full, default)


def export_dataset(name: str, cases: list[TestCase], fmt: str = "yaml", description: str = "",
                   version: int | None = None) -> str:
    doc: dict[str, Any] = {"name": name}
    if version is not None:
        doc["version"] = version
    if description:
        doc["description"] = description
    doc["cases"] = [case_to_dict(c) for c in cases]
    if fmt == "json":
        return json.dumps(doc, indent=2, ensure_ascii=False)
    return yaml.safe_dump(doc, sort_keys=False, allow_unicode=True, width=110)


def content_hash(cases: list[TestCase]) -> str:
    """Order-independent checksum of case content: identical content, identical hash."""
    blobs = sorted(json.dumps(c.model_dump(mode="json"), sort_keys=True) for c in cases)
    return hashlib.sha256("\n".join(blobs).encode()).hexdigest()
