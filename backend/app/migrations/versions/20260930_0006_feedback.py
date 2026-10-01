"""feedback: in-app feedback, saved here first and then sent (a new table; nothing else changes)

Revision ID: 0006
Revises: 0005
Create Date: 2026-09-30 20:00:00

Only adds a table (ADR 0004). The owner's records are untouched.
"""

from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op

revision: str = "0006"
down_revision: str | Sequence[str] | None = "0005"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    op.create_table(
        "feedback",
        sa.Column("id", sa.String(length=36), nullable=False),
        sa.Column(
            "created_at",
            sa.DateTime(),
            server_default=sa.text("(CURRENT_TIMESTAMP)"),
            nullable=False,
        ),
        sa.Column(
            "category",
            sa.Enum(
                "problem",
                "idea",
                "question",
                name="feedback_category",
                native_enum=False,
                length=16,
            ),
            nullable=False,
        ),
        sa.Column("message", sa.Text(), nullable=False),
        sa.Column("route", sa.String(), nullable=True),
        sa.Column("diagnostics", sa.Text(), server_default="{}", nullable=False),
        sa.Column("screenshot_file", sa.String(), nullable=True),
        sa.Column(
            "status",
            sa.Enum(
                "pending", "sent", "failed", name="feedback_status", native_enum=False, length=16
            ),
            server_default="pending",
            nullable=False,
        ),
        sa.Column("attempts", sa.Integer(), server_default="0", nullable=False),
        sa.Column("last_error", sa.Text(), nullable=True),
        sa.Column("sent_at", sa.DateTime(), nullable=True),
        sa.Column("remote_ref", sa.String(), nullable=True),
        sa.CheckConstraint(
            "category IN ('problem', 'idea', 'question')",
            name=op.f("ck_feedback_category_valid"),
        ),
        sa.CheckConstraint(
            "status IN ('pending', 'sent', 'failed')", name=op.f("ck_feedback_status_valid")
        ),
        sa.CheckConstraint("length(trim(message)) > 0", name=op.f("ck_feedback_message_not_blank")),
        sa.CheckConstraint("attempts >= 0", name=op.f("ck_feedback_attempts_non_negative")),
        sa.PrimaryKeyConstraint("id", name=op.f("pk_feedback")),
    )
    op.create_index("ix_feedback_status", "feedback", ["status"], unique=False)


def downgrade() -> None:
    op.drop_index("ix_feedback_status", table_name="feedback")
    op.drop_table("feedback")
