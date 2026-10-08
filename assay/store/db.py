"""Engine and sessions. ``DATABASE_URL`` picks the database:

* ``postgresql+psycopg://assay:assay@localhost:5432/assay`` (Docker Compose)
* ``sqlite:///./data/assay.db`` (default; zero setup)

Schema changes go through Alembic (``assay db upgrade``). ``create_all`` is used
only by tests on throwaway databases.
"""

from __future__ import annotations

import os
from collections.abc import Iterator
from contextlib import contextmanager
from pathlib import Path

from sqlalchemy import Engine, create_engine, event
from sqlalchemy.orm import Session, sessionmaker

ROOT = Path(__file__).resolve().parents[2]
# Before the rename the default file was data/gaugelab.db; keep using it when it is the one there.
_DEFAULT_DB = ROOT / "data" / "assay.db"
if not _DEFAULT_DB.exists() and (ROOT / "data" / "gaugelab.db").exists():
    _DEFAULT_DB = ROOT / "data" / "gaugelab.db"
DEFAULT_URL = f"sqlite:///{_DEFAULT_DB.as_posix()}"

_engine: Engine | None = None
_Session: sessionmaker[Session] | None = None


def database_url() -> str:
    return os.environ.get("DATABASE_URL") or DEFAULT_URL


def make_engine(url: str) -> Engine:
    if url.startswith("sqlite"):
        path = url.split("///", 1)[-1]
        if path and path != ":memory:":
            Path(path).parent.mkdir(parents=True, exist_ok=True)
        engine = create_engine(url, connect_args={"check_same_thread": False, "timeout": 30})

        @event.listens_for(engine, "connect")
        def _pragmas(dbapi_conn, _):  # pragma: no cover - trivial
            cur = dbapi_conn.cursor()
            cur.execute("PRAGMA foreign_keys=ON")
            cur.execute("PRAGMA journal_mode=WAL")
            cur.close()

        return engine
    return create_engine(url, pool_pre_ping=True)


def configure(url: str | None = None) -> Engine:
    global _engine, _Session
    _engine = make_engine(url or database_url())
    _Session = sessionmaker(_engine, expire_on_commit=False)
    return _engine


def engine() -> Engine:
    return _engine or configure()


@contextmanager
def session() -> Iterator[Session]:
    if _Session is None:
        configure()
    assert _Session is not None
    s = _Session()
    try:
        yield s
        s.commit()
    except Exception:
        s.rollback()
        raise
    finally:
        s.close()


def upgrade(url: str | None = None) -> None:
    """Apply Alembic migrations to the configured database."""
    from alembic import command
    from alembic.config import Config

    cfg = Config(str(ROOT / "apps" / "api" / "alembic.ini"))
    cfg.set_main_option("script_location", str(ROOT / "apps" / "api" / "migrations"))
    cfg.set_main_option("sqlalchemy.url", url or database_url())
    command.upgrade(cfg, "head")
