"""Helpers for building golden sets faster without lowering the bar: the machine types, a
person vouches.

* ``suggest_terms``: phrases a correct answer can hardly avoid (codes, numbers with units,
  quoted names), proposed as must-mention chips; a person keeps or drops each one.
* ``lint``: weak cases (duplicates, must-mention phrases too generic to test anything, patterns
  that match everything or are invalid, expectations found in no document, cases that fail in
  every run).
* ``coverage``: how the set is spread over kinds of question, against a suggested mix.
* ``group_questions``: real questions from chat history, near-duplicates grouped and counted.
* ``typo_variant``: a deterministic misspelt copy of a question (robustness, nothing new to vouch).
"""

from __future__ import annotations

import csv
import io
import json
import re
from collections import Counter
from typing import Any

from assay.schemas import TestCase

GENERIC = {
    "the", "a", "an", "and", "or", "of", "to", "in", "is", "it", "yes", "no", "you", "your", "we", "our", "can",
    "please", "thanks", "answer", "question", "help", "system", "information", "data", "process", "sap", "use",
}

_CODE = re.compile(r"\b(?=[A-Z0-9-]*\d)(?=[A-Z0-9-]*[A-Z])[A-Z0-9][A-Z0-9-]{1,}\b")  # ZP17, PV7000, SMM1, T-20
_NUM_UNIT = re.compile(r"\b\d[\d,.]*[\s-]?(?:%|percent|days?|weeks?|months?|years?|hours?|minutes?|mins?|h|kg|g|mm|cm|m|nm|°c|usd|sgd|\$)\b", re.I)
_NUMBER = re.compile(r"(?<![\w.])\d{2,}(?:[.,]\d+)?(?!\w)(?!\.\d)")
_ACRONYM = re.compile(r"\b[A-Z]{3,6}\b")
_QUOTED = re.compile(r"[\"“']([^\"”']{3,40})[\"”']")
_NAME = re.compile(r"\b([A-Z][a-z]+(?:\s+[A-Z][a-z0-9]+){1,3})\b")


def suggest_terms(text: str, limit: int = 8) -> list[str]:
    """Phrases worth requiring in a correct answer, most specific first."""
    found: list[str] = []

    def add(x: str) -> None:
        x = x.strip(" .,;:()[]")
        inside = any(re.search(rf"(?<!\w){re.escape(x.lower())}(?!\w)", f.lower()) for f in found)
        if len(x) >= 2 and x.lower() not in GENERIC and not inside:
            found.append(x)

    for rx in (_CODE, _NUM_UNIT, _QUOTED, _NUMBER, _ACRONYM, _NAME):
        for mt in rx.finditer(text or ""):
            add(mt.group(1) if rx is _QUOTED or rx is _NAME else mt.group(0))
    return found[:limit]


def _norm(q: str) -> str:
    return re.sub(r"\s+", " ", re.sub(r"[^\w\s]", " ", q.lower())).strip()


def _tokens(q: str) -> set[str]:
    return {t for t in _norm(q).split() if t not in GENERIC and len(t) > 1}


def _similar(a: set[str], b: set[str]) -> float:
    return len(a & b) / len(a | b) if a and b else 0.0


def lint(cases: list[TestCase], documents: list[str] | None = None,
         always_fail: list[str] | None = None) -> list[dict[str, Any]]:
    issues: list[dict[str, Any]] = []

    def add(case_id: str, kind: str, message: str) -> None:
        issues.append({"case_id": case_id, "kind": kind, "message": message})

    seen: dict[str, str] = {}
    toks = {c.id: _tokens(c.input.message) for c in cases}
    for c in cases:
        n = _norm(c.input.message)
        if n in seen:
            add(c.id, "duplicate", f"Same question as {seen[n]}.")
        else:
            near = next((o.id for o in cases if o.id != c.id and o.id in seen.values()
                         and _similar(toks[c.id], toks[o.id]) >= 0.8), None)
            if near:
                add(c.id, "near_duplicate", f"Almost the same question as {near}: it may test nothing new.")
            seen[n] = c.id
        a = c.expected.answer
        for phrase in a.must_mention:
            parts = [p.strip() for p in phrase.split("|")]
            # A number is a specific fact ("32" days); only words can be too common to test anything.
            if any(p.lower() in GENERIC or (len(p) < 3 and not p.isdigit()) or (p.isdigit() and len(p) < 2) for p in parts):
                add(c.id, "too_generic", f"Must-mention \"{phrase}\" is too common to prove anything: almost any answer contains it.")
            elif _norm(phrase) and _norm(phrase) in _norm(c.input.message):
                add(c.id, "in_question", f"Must-mention \"{phrase}\" is already in the question: an answer that repeats the question passes.")
        for pattern in a.regex + a.forbidden_regex:
            try:
                rx = re.compile(pattern)
            except re.error as exc:
                add(c.id, "bad_pattern", f"Pattern {pattern!r} is not valid: {exc}.")
                continue
            if rx.search("") is not None:
                add(c.id, "match_all", f"Pattern {pattern!r} matches an empty answer: it can never fail.")
        if documents:
            corpus = " ".join(documents).lower()
            for phrase in a.must_mention:
                alts = [p.strip().lower() for p in phrase.split("|") if p.strip()]
                if alts and not any(p in corpus for p in alts):
                    add(c.id, "not_in_documents", f"\"{phrase}\" appears in none of this chatbot's uploaded documents: check the expected answer.")
        if not (a.reference or a.exact or a.must_mention or a.regex or a.must_not_claim or a.forbidden_regex
                or c.expected.relevant_documents or c.expected.required_tools or c.expected.tool_calls
                or c.expected.refusal_expected is not None or c.expected.min_citations is not None
                or c.expected.required_citations or a.json_schema):
            add(c.id, "no_expectations", "No expectations yet: only speed is checked. Add what a correct answer must say.")
    for cid in always_fail or []:
        add(cid, "always_fails", "Failed in every run, whatever the version: often the expected answer is wrong or outdated.")
    return issues


KIND_MIX = [  # share of a set, and how a case is recognised
    ("lookup", "Simple lookups", 0.40),
    ("multi_source", "Need two or more sources", 0.20),
    ("specific", "Depend on a field (plant, region, product)", 0.15),
    ("refusal", "Should be declined", 0.15),
    ("confusable", "Easy to confuse", 0.10),
]


def case_kind(c: TestCase) -> str:
    tags = {t.lower() for t in c.tags} | {c.category.lower()}
    if c.expected.refusal_expected is True or tags & {"refusal", "unanswerable", "out of scope", "out_of_scope"}:
        return "refusal"
    if tags & {"confusable", "retrieval_confusion", "confusion", "tricky"}:
        return "confusable"
    if len(c.expected.relevant_documents) >= 2 or tags & {"multi_source", "multi_document", "multi-source", "multi"}:
        return "multi_source"
    if c.input.fields or tags & {"specific", "plant", "region", "office"}:
        return "specific"
    return "lookup"


def coverage(cases: list[TestCase], documents: list[str] | None = None,
             cited_documents: set[str] | None = None) -> dict[str, Any]:
    counts = Counter(case_kind(c) for c in cases if c.enabled)
    total = sum(counts.values())
    target_total = max(20, total)
    kinds = [{"id": k, "label": label, "count": counts.get(k, 0), "target": max(1, round(share * target_total))}
             for k, label, share in KIND_MIX]
    cats = Counter(c.category for c in cases)
    out: dict[str, Any] = {"total": total, "kinds": kinds, "categories": dict(cats.most_common())}
    if documents is not None:
        out["documents_without_cases"] = [d for d in documents if d not in (cited_documents or set())]
    return out


def _question_of(row: Any) -> str | None:
    if isinstance(row, str):
        return row.strip() or None
    if isinstance(row, dict):
        for k in ("question", "message", "q", "query", "input", "user", "prompt", "text", "content"):
            v = row.get(k)
            if isinstance(v, str) and v.strip():
                return v.strip()
            if isinstance(v, dict):
                inner = _question_of(v)
                if inner:
                    return inner
    return None


def read_questions(filename: str, text: str) -> list[str]:
    """Questions from chat history: JSONL/JSON (a question-like field), CSV (a question column) or plain lines."""
    name = filename.lower()
    out: list[str] = []
    if name.endswith((".jsonl", ".ndjson")):
        for line in text.splitlines():
            try:
                q = _question_of(json.loads(line))
            except json.JSONDecodeError:
                continue
            if q:
                out.append(q)
    elif name.endswith(".json"):
        data = json.loads(text)
        rows = data if isinstance(data, list) else next((v for v in data.values() if isinstance(v, list)), [])
        out = [q for q in (_question_of(r) for r in rows) if q]
    elif name.endswith(".csv"):
        reader = csv.DictReader(io.StringIO(text.lstrip("﻿")))
        out = [q for q in (_question_of({k.lower().strip(): v for k, v in r.items() if k}) for r in reader) if q]
    else:
        out = [ln.strip() for ln in text.splitlines() if ln.strip()]
    return [q[:500] for q in out if len(q) >= 4]


def group_questions(questions: list[str], threshold: float = 0.6) -> list[dict[str, Any]]:
    """Near-identical questions grouped (word overlap), most asked first."""
    groups: list[dict[str, Any]] = []
    for q in questions:
        t = _tokens(q)
        for g in groups:
            if _similar(t, g["_t"]) >= threshold or _norm(q) == _norm(g["question"]):
                g["count"] += 1
                if len(g["examples"]) < 5 and q not in g["examples"]:
                    g["examples"].append(q)
                break
        else:
            groups.append({"question": q, "count": 1, "examples": [q], "_t": t})
    groups.sort(key=lambda g: -g["count"])
    return [{k: v for k, v in g.items() if k != "_t"} for g in groups]


def typo_variant(question: str) -> str:
    """Swap two letters inside the longest word and drop the final punctuation: a realistic slip."""
    words = question.split()
    if not words:
        return question
    i = max(range(len(words)), key=lambda k: len(re.sub(r"\W", "", words[k])))
    w = words[i]
    letters = [k for k, ch in enumerate(w) if ch.isalpha()]
    if len(letters) >= 4:
        a, b = letters[len(letters) // 2 - 1], letters[len(letters) // 2]
        w = w[:a] + w[b] + w[a] + w[b + 1:]
    words[i] = w
    return " ".join(words).rstrip("?.!").lower()
