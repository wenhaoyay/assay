"""Shared API plumbing: one DB session per request (committed on success)."""

from __future__ import annotations

from collections.abc import Iterator

from sqlalchemy.orm import Session

from gaugelab.store import db


def get_session() -> Iterator[Session]:
    with db.session() as s:
        yield s
