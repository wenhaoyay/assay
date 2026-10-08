"""archived datasets, shared bots, a cost per answer, demo projects

Revision ID: 0003
Revises: 0002
"""

from __future__ import annotations

import sqlalchemy as sa
from alembic import op

revision = "0003"
down_revision = "0002"
branch_labels = None
depends_on = None


def upgrade() -> None:
    insp = sa.inspect(op.get_bind())

    def add(table: str, column: sa.Column) -> None:
        if column.name not in {c["name"] for c in insp.get_columns(table)}:
            op.add_column(table, column)

    add("datasets", sa.Column("archived", sa.Boolean(), nullable=False, server_default=sa.false()))
    add("targets", sa.Column("shared", sa.Boolean(), nullable=False, server_default=sa.false()))
    add("targets", sa.Column("cost_per_answer_usd", sa.Float(), nullable=True))
    add("projects", sa.Column("is_demo", sa.Boolean(), nullable=False, server_default=sa.false()))
    # The seeded demo chatbot predates the flag.
    op.execute(sa.text("UPDATE projects SET is_demo = TRUE WHERE name = 'Acme Support Demo'"))


def downgrade() -> None:
    with op.batch_alter_table("projects") as b:
        b.drop_column("is_demo")
    with op.batch_alter_table("targets") as b:
        b.drop_column("cost_per_answer_usd")
        b.drop_column("shared")
    with op.batch_alter_table("datasets") as b:
        b.drop_column("archived")
