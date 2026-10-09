"""Small helpers for the sentences the server writes to the screen."""
from __future__ import annotations


def plural(n: int, word: str, plural_word: str | None = None) -> str:
    """``plural(1, "run")`` is "1 run", ``plural(2, "run")`` is "2 runs": a real plural, never "run(s)"."""
    return f"{n:,} {word if n == 1 else plural_word or word + 's'}"


def noun(n: int, word: str, plural_word: str | None = None) -> str:
    """Just the noun in the right number: ``noun(2, "check")`` is "checks"."""
    return word if n == 1 else plural_word or word + "s"
