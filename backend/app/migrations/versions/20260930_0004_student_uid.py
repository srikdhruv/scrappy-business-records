"""students.uid: a random id that stays with a student across Excel downloads and uploads

Revision ID: 0004
Revises: 0003
Create Date: 2026-09-30 16:00:00

Additive only: a new, empty (nullable) column and a unique index on it. `ALTER TABLE ... ADD
COLUMN` in place: the students table isn't rebuilt, and no row is changed. The app gives each
student their id the first time they're in a Download everything file.
"""

from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op

revision: str = "0004"
down_revision: str | Sequence[str] | None = "0003"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    op.add_column("students", sa.Column("uid", sa.String(), nullable=True))
    op.create_index("ix_students_uid", "students", ["uid"], unique=True)


def downgrade() -> None:
    with op.batch_alter_table("students", schema=None) as batch_op:
        batch_op.drop_index("ix_students_uid")
        batch_op.drop_column("uid")
