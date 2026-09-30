"""fee_changes.kind: 'fee' (set by the owner) or 'away' (the months away after coming back)

Revision ID: 0002
Revises: 0001
Create Date: 2026-09-30 10:00:00

Every existing row becomes 'fee'. Nothing has been released with coming back yet, so there are
no 'away' rows to find, and a ₹0 row can't be told apart from a month off the owner set. It
stays a fee, which the owner can see and correct in Fee history.
"""

from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op

revision: str = "0002"
down_revision: str | Sequence[str] | None = "0001"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    with op.batch_alter_table("fee_changes", schema=None) as batch_op:
        batch_op.add_column(
            sa.Column(
                "kind",
                sa.Enum("fee", "away", name="fee_kind", native_enum=False, length=8),
                server_default="fee",
                nullable=False,
            )
        )
        batch_op.create_check_constraint(
            op.f("ck_fee_changes_kind_valid"), "kind IN ('fee', 'away')"
        )
        batch_op.create_check_constraint(
            op.f("ck_fee_changes_away_is_no_fee"), "kind = 'fee' OR amount_paise = 0"
        )


def downgrade() -> None:
    with op.batch_alter_table("fee_changes", schema=None) as batch_op:
        batch_op.drop_constraint(op.f("ck_fee_changes_away_is_no_fee"), type_="check")
        batch_op.drop_constraint(op.f("ck_fee_changes_kind_valid"), type_="check")
        batch_op.drop_column("kind")
