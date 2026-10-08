"""settings, secrets in the OS store, connection wizard, judge bake-off

Revision ID: 0002
Revises: 0001
"""

from __future__ import annotations

import sqlalchemy as sa
from alembic import op

revision = "0002"
down_revision = "0001"
branch_labels = None
depends_on = None


def upgrade() -> None:
    # Plain ADD COLUMN: SQLite supports it, and a batch rebuild of a referenced table would
    # trip the foreign keys of existing rows.
    insp = sa.inspect(op.get_bind())

    def add(table: str, column: sa.Column) -> None:
        if column.name not in {c["name"] for c in insp.get_columns(table)}:
            op.add_column(table, column)

    add("projects", sa.Column("color", sa.String(length=20), nullable=False, server_default=""))
    add("projects", sa.Column("icon", sa.String(length=40), nullable=False, server_default=""))
    add("targets", sa.Column("local_judges_only", sa.Boolean(), nullable=False, server_default=sa.false()))
    add("targets", sa.Column("last_check", sa.JSON(none_as_null=True), nullable=True))
    op.create_table(
        "app_settings",
        sa.Column("key", sa.String(length=80), nullable=False),
        sa.Column("value", sa.JSON(none_as_null=True), nullable=True),
        sa.PrimaryKeyConstraint("key"),
    )
    op.create_table(
        "connector_templates",
        sa.Column("id", sa.Integer(), nullable=False),
        sa.Column("name", sa.String(length=200), nullable=False),
        sa.Column("description", sa.Text(), nullable=False),
        sa.Column("adapter", sa.String(length=20), nullable=False),
        sa.Column("config", sa.JSON(), nullable=False),
        sa.Column("created_at", sa.DateTime(timezone=True), nullable=False),
        sa.PrimaryKeyConstraint("id"),
    )
    op.create_table(
        "judge_bakeoffs",
        sa.Column("id", sa.Integer(), nullable=False),
        sa.Column("dimension", sa.String(length=80), nullable=False),
        sa.Column("status", sa.String(length=20), nullable=False),
        sa.Column("judges", sa.JSON(), nullable=False),
        sa.Column("progress_done", sa.Integer(), nullable=False),
        sa.Column("progress_total", sa.Integer(), nullable=False),
        sa.Column("results", sa.JSON(none_as_null=True), nullable=True),
        sa.Column("error", sa.Text(), nullable=True),
        sa.Column("created_at", sa.DateTime(timezone=True), nullable=False),
        sa.PrimaryKeyConstraint("id"),
    )


def downgrade() -> None:
    op.drop_table("judge_bakeoffs")
    op.drop_table("connector_templates")
    op.drop_table("app_settings")
    with op.batch_alter_table("targets") as b:
        b.drop_column("last_check")
        b.drop_column("local_judges_only")
    with op.batch_alter_table("projects") as b:
        b.drop_column("icon")
        b.drop_column("color")
