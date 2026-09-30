"""batches: a new table, and students.batch_id (the batch a student is in, or none)

Revision ID: 0005
Revises: 0004
Create Date: 2026-09-30 13:00:00

Additive only (ADR 0004): a new `batches` table, a new nullable `students.batch_id` and an index
on it. No row is changed: every student starts in no batch, and their free-text `batch_label`
stays exactly as it was. Turning labels into batches is something the owner chooses to do in
the app (it takes a backup first), never a migration.

`batch_id` is added with a plain ADD COLUMN, so the students table isn't copied. Its link to
`batches` is written inline (`REFERENCES batches (id) ON DELETE SET NULL`), since SQLite can't
add a separate constraint to an existing table.
"""

from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op

revision: str = "0005"
down_revision: str | Sequence[str] | None = "0004"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    op.create_table(
        "batches",
        sa.Column("id", sa.Integer(), nullable=False),
        sa.Column("name", sa.String(collation="NOCASE"), nullable=False),
        sa.Column("location", sa.String(), nullable=True),
        sa.Column("days", sa.String(length=7), server_default="0000000", nullable=False),
        sa.Column("start_time", sa.String(length=5), nullable=True),
        sa.Column("end_time", sa.String(length=5), nullable=True),
        sa.Column("default_fee_paise", sa.Integer(), nullable=True),
        sa.Column("notes", sa.Text(), nullable=True),
        sa.Column(
            "created_at",
            sa.DateTime(),
            server_default=sa.text("(CURRENT_TIMESTAMP)"),
            nullable=False,
        ),
        sa.Column(
            "updated_at",
            sa.DateTime(),
            server_default=sa.text("(CURRENT_TIMESTAMP)"),
            nullable=False,
        ),
        sa.CheckConstraint(
            "end_time IS NULL OR (end_time GLOB '[0-2][0-9]:[0-5][0-9]' AND end_time <= '23:59')",
            name=op.f("ck_batches_end_time_valid"),
        ),
        sa.CheckConstraint(
            "length(days) = 7 AND days NOT GLOB '*[^01]*'", name=op.f("ck_batches_days_mask")
        ),
        sa.CheckConstraint(
            "start_time IS NULL OR "
            "(start_time GLOB '[0-2][0-9]:[0-5][0-9]' AND start_time <= '23:59')",
            name=op.f("ck_batches_start_time_valid"),
        ),
        sa.CheckConstraint(
            "default_fee_paise IS NULL OR "
            "(default_fee_paise >= 0 AND default_fee_paise <= 100000000)",
            name=op.f("ck_batches_default_fee_range"),
        ),
        sa.CheckConstraint("length(trim(name)) > 0", name=op.f("ck_batches_name_not_blank")),
        sa.PrimaryKeyConstraint("id", name=op.f("pk_batches")),
        sa.UniqueConstraint("name", name=op.f("uq_batches_name")),
    )
    # A plain ADD COLUMN (nullable, no default): every student is in no batch until the owner
    # places them. The link is declared with the column, so the students table isn't rebuilt.
    op.add_column(
        "students",
        sa.Column(
            "batch_id",
            sa.Integer(),
            sa.ForeignKey("batches.id", ondelete="SET NULL"),
            nullable=True,
        ),
        inline_references=True,
    )
    op.create_index(op.f("ix_students_batch_id"), "students", ["batch_id"], unique=False)


def downgrade() -> None:
    op.drop_index(op.f("ix_students_batch_id"), table_name="students")
    with op.batch_alter_table("students", schema=None) as batch_op:
        batch_op.drop_column("batch_id")

    op.drop_table("batches")
