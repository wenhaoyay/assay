"""Alembic environment: target metadata is GaugeLab's models; URL from DATABASE_URL."""

from __future__ import annotations

import os

from alembic import context

from gaugelab.store.db import make_engine
from gaugelab.store.models import Base

config = context.config
target_metadata = Base.metadata


def _url() -> str:
    explicit = config.get_main_option("sqlalchemy.url")
    return os.environ.get("DATABASE_URL") or explicit


def run_offline() -> None:
    context.configure(url=_url(), target_metadata=target_metadata, literal_binds=True, render_as_batch=True)
    with context.begin_transaction():
        context.run_migrations()


def run_online() -> None:
    engine = make_engine(_url())
    with engine.connect() as conn:
        context.configure(connection=conn, target_metadata=target_metadata,
                          render_as_batch=conn.dialect.name == "sqlite")
        with context.begin_transaction():
            context.run_migrations()


if context.is_offline_mode():
    run_offline()
else:
    run_online()
