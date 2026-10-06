"""Map arbitrary JSON into GaugeLab's normalized result.

A path is dot-separated: ``data.answer``, ``sources.0.id``, ``choices[0].message.content``.
``a|b`` tries ``a`` then ``b``. ``*`` maps over a list: ``sources.*.id``.
A literal is written ``=value`` (``provider: "=acme"``).

A field mapping is either a path string, or for lists of objects::

    retrieved_documents:
      path: sources
      each: {id: "id|code", title: title, score: similarity, text: text}
      where: {type: passage}          # optional equality filter

``citations_from_markers`` builds citations from inline markers such as ``[3]``::

    citations_from_markers:
      pattern: "\\[(\\d+)\\]"
      lookup: sources                 # list to resolve the marker against
      key: n                          # field of each item that equals the marker
      each: {id: "id|code", title: title}
"""

from __future__ import annotations

import re
from typing import Any

_MISSING = object()


def _tokens(path: str) -> list[str]:
    # "choices[0].message" -> ["choices", "0", "message"]
    path = re.sub(r"\[(\d+|\*)\]", r".\1", path)
    return [t for t in path.split(".") if t != ""]


def _get_one(data: Any, path: str) -> Any:
    if path.startswith("="):
        return path[1:]
    if path in ("", "."):
        return data
    cur: Any = data
    tokens = _tokens(path)
    for i, tok in enumerate(tokens):
        if tok == "*":
            if not isinstance(cur, list):
                return _MISSING
            rest = ".".join(tokens[i + 1 :])
            out = [_get_one(item, rest) for item in cur]
            return [o for o in out if o is not _MISSING]
        if isinstance(cur, dict):
            if tok not in cur:
                return _MISSING
            cur = cur[tok]
        elif isinstance(cur, list) and tok.lstrip("-").isdigit():
            idx = int(tok)
            if idx >= len(cur) or idx < -len(cur):
                return _MISSING
            cur = cur[idx]
        else:
            return _MISSING
    return cur


def get_path(data: Any, path: str, default: Any = None) -> Any:
    """Resolve ``path`` (with ``|`` alternatives). Missing -> ``default``."""
    for alt in path.split("|"):
        val = _get_one(data, alt.strip())
        if val is not _MISSING and val is not None:
            return val
    return default


def set_path(data: dict[str, Any], path: str, value: Any) -> None:
    tokens = _tokens(path)
    cur = data
    for tok in tokens[:-1]:
        cur = cur.setdefault(tok, {})
    cur[tokens[-1]] = value


def _map_object(item: Any, each: dict[str, str]) -> dict[str, Any]:
    out: dict[str, Any] = {}
    for key, sub in each.items():
        val = get_path(item, sub)
        if val is not None:
            out[key] = val
    return out


def _matches(item: Any, where: dict[str, Any] | None) -> bool:
    if not where:
        return True
    return all(get_path(item, k) == v for k, v in where.items())


def map_field(data: Any, spec: Any) -> Any:
    if spec is None:
        return None
    if isinstance(spec, str):
        return get_path(data, spec)
    if isinstance(spec, dict) and "path" in spec:
        val = get_path(data, spec["path"])
        if val is None:
            return None
        if isinstance(val, list) and "each" in spec:
            return [_map_object(i, spec["each"]) for i in val if _matches(i, spec.get("where"))]
        return val
    raise ValueError(f"Unsupported mapping spec: {spec!r}")


def citations_from_markers(answer: str, data: Any, spec: dict[str, Any]) -> list[dict[str, Any]]:
    pattern = re.compile(spec.get("pattern", r"\[(\d+)\]"))
    pool = get_path(data, spec["lookup"]) or []
    key = spec.get("key", "n")
    each = spec.get("each", {"id": "id"})
    seen: list[str] = []
    out: list[dict[str, Any]] = []
    for m in pattern.finditer(answer or ""):
        marker = m.group(1)
        if marker in seen:
            continue
        seen.append(marker)
        hit = next((i for i in pool if str(get_path(i, key)) == marker), None)
        if hit is None:
            # A marker with nothing behind it is exactly what citation_validity looks for.
            out.append({"id": f"marker:{marker}", "dangling": True})
        else:
            out.append(_map_object(hit, each))
    return out
