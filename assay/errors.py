"""Error text for people: a sentence, never an exception class name."""

from __future__ import annotations

import httpx

GENERIC = "Something unexpected went wrong. The details are in the server log."
SLOW_MODEL = "The grading model did not answer in time. Check its address in Settings > Models & keys."
NO_MODEL = "The grading model could not be reached. Check its address in Settings > Models & keys."


def plain_error(exc: BaseException, limit: int = 500) -> str:
    """What to show for an exception: its own message when it is a sentence for people, else a generic line."""
    if isinstance(exc, (httpx.TimeoutException, TimeoutError)):
        return SLOW_MODEL
    if isinstance(exc, httpx.TransportError):
        return NO_MODEL
    text = str(exc).strip()
    if not text or isinstance(exc, (KeyError, AttributeError, TypeError, AssertionError, IndexError)):
        return GENERIC
    return text[:limit]
