"""Copy lint for the sentences the server writes to the screen.

docs/design.md, "Words": one name per thing, real plurals, no exception class names. The web app has
the same lint (apps/web/src/test/copy.test.ts). This one reads the server's source (not its output)
and checks the strings that reach a person: HTTPException details, ``explanation=`` and friends, the
descriptions and notes in API payloads, and the messages of the errors the routers turn into text.
"""

from __future__ import annotations

import ast
import re
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
FILES = sorted([*(ROOT / "assay").rglob("*.py"), *(ROOT / "apps" / "api" / "app").rglob("*.py")])
# The command line is for developers, the seed is demo content, and this file is the lint itself.
SKIP = {"cli.py", "seed.py", "textutil.py"}

# Dictionary keys whose string values are shown to people.
SHOWN_KEYS = {"note", "hint", "message", "explanation", "error", "blurb", "description", "title", "reason", "label"}
# Keyword arguments whose string values are shown to people.
SHOWN_KWARGS = {"explanation", "note", "hint", "message", "reason", "detail", "fix"}
# Calls whose string arguments are shown to people (an error, a result with its explanation).
SHOWN_CALLS = {"HTTPException", "NotFound", "DatasetError", "ProviderError", "TransientTargetError", "na", "ValueError"}

BANNED = [
    (re.compile(r"\(s\)"), 'a "(s)" plural: use plural() from assay.textutil'),
    (re.compile(r"\b(trials?|evaluators?|experiments?|targets?|judges?|graders?)\b", re.I), "an old name (see docs/design.md, Words)"),
    (re.compile(r"\bthis (PC|machine)\b", re.I), '"this PC" / "this machine": say "this computer"'),
    (re.compile(r"\b(golden|question sets?|test cases?|cases?)\b", re.I), 'say "dataset" and "questions"'),
    (re.compile(r"\.\.\.|—"), 'an ASCII "..." or an em dash'),
]
ALLOWED_PHRASES = [
    "case-insensitive",
    "'cases'",
    # A name that is also a value on the wire or a file format, not a sentence.
    "ASSAY_PYTHON_TARGETS",
]


def _text(node: ast.AST) -> str | None:
    """The literal text of a string or f-string (placeholders removed), else None."""
    if isinstance(node, ast.Constant) and isinstance(node.value, str):
        return node.value
    if isinstance(node, ast.JoinedStr):
        return "".join(p.value if isinstance(p, ast.Constant) else "{}" for p in node.values)
    return None


def _strings(node: ast.AST):
    """Every literal string below a node (the fixed parts of an f-string included), with its line.
    A string used as a dictionary key (``row['judge']``) is code, not a sentence, so it is skipped."""
    keys = {id(n.slice) for n in ast.walk(node) if isinstance(n, ast.Subscript)}
    for n in ast.walk(node):
        if id(n) in keys:
            continue
        if isinstance(n, ast.Constant) and isinstance(n.value, str) and n.value.strip():
            yield n.lineno, n.value


def _name(call: ast.Call) -> str:
    f = call.func
    return f.attr if isinstance(f, ast.Attribute) else f.id if isinstance(f, ast.Name) else ""


def _shown(tree: ast.AST):
    """(line, text) of every string in the file that a person reads."""
    for node in ast.walk(tree):
        if isinstance(node, ast.Call):
            if _name(node) == "append" and isinstance(node.func, ast.Attribute) and getattr(node.func.value, "id", "") == "issues":
                for a in node.args:
                    yield from _strings(a)
            if _name(node) in SHOWN_CALLS | {"verdict"}:
                for a in node.args:
                    yield from _strings(a)
            for kw in node.keywords:
                if kw.arg in SHOWN_KWARGS:
                    yield from _strings(kw.value)
        elif isinstance(node, ast.Dict):
            for k, v in zip(node.keys, node.values, strict=True):
                if isinstance(k, ast.Constant) and k.value in SHOWN_KEYS:
                    yield from _strings(v)
        elif isinstance(node, ast.Assign):
            for t in node.targets:
                if isinstance(t, ast.Name) and t.id in ("description", "hint", "note"):
                    yield from _strings(node.value)
                if isinstance(t, ast.Subscript) and isinstance(t.slice, ast.Constant) and t.slice.value in SHOWN_KEYS:
                    yield from _strings(node.value)


def _class_name_interpolations(tree: ast.AST):
    """f-strings that print ``type(x).__name__``: an exception class name on screen (``__repr__`` aside)."""
    reprs = {id(n) for f in ast.walk(tree) if isinstance(f, ast.FunctionDef) and f.name == "__repr__" for n in ast.walk(f)}
    for node in ast.walk(tree):
        if isinstance(node, ast.JoinedStr) and id(node) not in reprs:
            for n in ast.walk(node):
                if isinstance(n, ast.Attribute) and n.attr == "__name__":
                    yield node.lineno


def test_server_sentences_follow_the_words() -> None:
    problems: list[str] = []
    for path in FILES:
        if path.name in SKIP or "__pycache__" in path.parts:
            continue
        tree = ast.parse(path.read_text(encoding="utf-8"))
        rel = path.relative_to(ROOT)
        for line, text in _shown(tree):
            clean = text
            for ok in ALLOWED_PHRASES:
                clean = clean.replace(ok, "")
            for pattern, why in BANNED:
                if pattern.search(clean):
                    problems.append(f"{rel}:{line}: {why}: {text.strip()[:90]!r}")
                    break
    assert not problems, "\n" + "\n".join(problems)


def test_no_exception_class_names_in_messages() -> None:
    problems = []
    for path in FILES:
        if path.name in SKIP or "__pycache__" in path.parts:
            continue
        tree = ast.parse(path.read_text(encoding="utf-8"))
        for line in _class_name_interpolations(tree):
            problems.append(f"{path.relative_to(ROOT)}:{line}: an f-string prints a class name (type(x).__name__)")
    assert not problems, "\n" + "\n".join(problems)
