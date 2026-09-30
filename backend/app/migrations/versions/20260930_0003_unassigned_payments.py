"""unassigned_payments: uploaded payments whose student couldn't be matched

Revision ID: 0003
Revises: 0002
Create Date: 2026-09-30 10:48:06

Additive only: a new table, nothing existing is changed. `payments.student_id` stays NOT NULL;
a payment without a student waits here until the owner assigns it (which moves it into
`payments`) or deletes it.
"""

from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op

revision: str = "0003"
down_revision: str | Sequence[str] | None = "0002"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    op.create_table(
        "unassigned_payments",
        sa.Column("id", sa.Integer(), nullable=False),
        sa.Column("student_text", sa.String(), nullable=False),
        sa.Column("phone", sa.String(), nullable=True),
        sa.Column("amount_paise", sa.Integer(), nullable=False),
        sa.Column("paid_on", sa.Date(), nullable=False),
        sa.Column("for_month", sa.Date(), nullable=False),
        sa.Column(
            "method",
            sa.Enum("upi", "cash", "other", name="payment_method", native_enum=False, length=16),
            nullable=False,
        ),
        sa.Column("note", sa.Text(), nullable=True),
        sa.Column("source", sa.String(), nullable=True),
        sa.Column(
            "created_at",
            sa.DateTime(),
            server_default=sa.text("(CURRENT_TIMESTAMP)"),
            nullable=False,
        ),
        sa.CheckConstraint(
            "for_month IS date(for_month, 'start of month')",
            name=op.f("ck_unassigned_payments_for_month_first_of_month"),
        ),
        sa.CheckConstraint(
            "method IN ('upi', 'cash', 'other')", name=op.f("ck_unassigned_payments_method_valid")
        ),
        sa.CheckConstraint("amount_paise > 0", name=op.f("ck_unassigned_payments_amount_positive")),
        sa.CheckConstraint(
            "length(trim(student_text)) > 0",
            name=op.f("ck_unassigned_payments_student_text_not_blank"),
        ),
        sa.CheckConstraint(
            "paid_on IS date(paid_on)", name=op.f("ck_unassigned_payments_paid_on_valid_date")
        ),
        sa.PrimaryKeyConstraint("id", name=op.f("pk_unassigned_payments")),
    )


def downgrade() -> None:
    op.drop_table("unassigned_payments")
