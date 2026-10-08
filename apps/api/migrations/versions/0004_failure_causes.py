"""why a failure happened: a person's cause, and a grading model's explanation

Revision ID: 0004
Revises: 0003
"""

from __future__ import annotations

import sqlalchemy as sa
from alembic import op

revision = "0004"
down_revision = "0003"
branch_labels = None
depends_on = None


def upgrade() -> None:
    insp = sa.inspect(op.get_bind())
    have = {c["name"] for c in insp.get_columns("trials")}
    if "cause_override" not in have:
        op.add_column("trials", sa.Column("cause_override", sa.String(40), nullable=True))
    if "cause_ai" not in have:
        op.add_column("trials", sa.Column("cause_ai", sa.JSON(), nullable=True))


def downgrade() -> None:
    with op.batch_alter_table("trials") as b:
        b.drop_column("cause_ai")
        b.drop_column("cause_override")
