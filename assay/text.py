"""Small text helpers shared by evaluators (normalization, phrase search)."""

from __future__ import annotations

import re
import unicodedata

_WS = re.compile(r"\s+")
_PUNCT = re.compile(r"[^\w\s%$.-]")


def normalize(text: str | None) -> str:
    """Case-fold, unify unicode, drop punctuation that rarely changes meaning, squeeze spaces."""
    if not text:
        return ""
    text = unicodedata.normalize("NFKC", text).casefold()
    text = text.replace("’", "'")
    text = _PUNCT.sub(" ", text)
    return _WS.sub(" ", text).strip().rstrip(".")


def contains_phrase(haystack: str, phrase: str) -> bool:
    """Whole-word containment on normalized text ("active" does not match "inactive")."""
    h, p = normalize(haystack), normalize(phrase)
    if not p:
        return True
    return re.search(rf"(?<!\w){re.escape(p)}(?!\w)", h) is not None


REFUSAL_PHRASES = [
    "i don't know", "i do not know", "i don't have", "i do not have", "not able to find",
    "unable to find", "couldn't find", "could not find", "no information", "not in the documentation",
    "isn't covered in", "is not covered in", "can't help with", "cannot help with", "can't share",
    "cannot share", "i can't", "i cannot", "unable to", "not something i can", "outside what i can",
    "not available in", "don't have information", "do not have information",
]


def looks_like_refusal(text: str, phrases: list[str] | None = None) -> bool:
    return any(contains_phrase(text, p) for p in (phrases or REFUSAL_PHRASES))
