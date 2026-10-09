"""Error text for people: a sentence, never an exception class name."""

from __future__ import annotations

import httpx

GENERIC = "Something unexpected went wrong. The details are in the server log."
SLOW_MODEL = "The grading model did not answer in time. Check its address in Settings > Models & keys."
NO_MODEL = "The grading model could not be reached. Check its address in Settings > Models & keys."


def reach_error(exc: BaseException, where: str = "the address") -> str:
    """A sentence for a request that never got an answer. It keeps the words the load checks look for."""
    if isinstance(exc, (httpx.ConnectError, httpx.ConnectTimeout)):
        return f"Could not connect to {where}."
    if isinstance(exc, (httpx.TimeoutException, TimeoutError)):
        return f"No reply from {where}: the request timed out."
    return f"Could not connect to {where}."


def settings_error(exc: BaseException, generic: str) -> str:
    """Why a connection's settings were refused: our own sentence when we wrote one, else a generic line.
    A validation library's message names fields and classes, so it never reaches the screen."""
    from pydantic import ValidationError

    if isinstance(exc, ValueError) and not isinstance(exc, ValidationError):
        text = str(exc).strip()
        if text:
            return text[:500]
    return generic


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
