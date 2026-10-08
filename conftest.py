"""Shared pytest fixtures for the core and API test suites."""

import os
import sys
from pathlib import Path

import pytest

ROOT = Path(__file__).resolve().parent
sys.path.insert(0, str(ROOT / "apps" / "api"))
sys.path.insert(0, str(ROOT / "apps" / "api" / "tests"))


@pytest.fixture()
def fresh_db(tmp_path, monkeypatch):
    """A migrated, empty SQLite database for one test."""
    from assay.store import db

    url = f"sqlite:///{(tmp_path / 'test.db').as_posix()}"
    monkeypatch.setenv("DATABASE_URL", url)
    db.configure(url)
    db.upgrade(url)
    yield url
    db.engine().dispose()
    db.configure(os.environ.get("DATABASE_URL"))
