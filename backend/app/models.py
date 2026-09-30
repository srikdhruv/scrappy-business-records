"""SQLAlchemy models. See docs/data-model.md.

Conventions:
- Money is integer paise.
- Months (`joined_month`, `left_month`, `effective_month`, `for_month`) are first-of-month
  `DATE`s. A CHECK constraint enforces the "first of the month" part.
- Timestamps are UTC, set by the database.

Changing anything here needs a new Alembic migration (see docs/runbooks/development.md).
"""

from __future__ import annotations

import datetime as dt
import enum

from sqlalchemy import (
    CheckConstraint,
    Date,
    DateTime,
    Enum,
    ForeignKey,
    Index,
    Integer,
    MetaData,
    String,
    Text,
    UniqueConstraint,
    func,
)
from sqlalchemy.orm import DeclarativeBase, Mapped, mapped_column, relationship

# Named constraints make future `batch_alter_table` migrations on SQLite predictable.
NAMING_CONVENTION = {
    "ix": "ix_%(column_0_label)s",
    "uq": "uq_%(table_name)s_%(column_0_N_name)s",
    "ck": "ck_%(table_name)s_%(constraint_name)s",
    "fk": "fk_%(table_name)s_%(column_0_name)s_%(referred_table_name)s",
    "pk": "pk_%(table_name)s",
}


class Base(DeclarativeBase):
    metadata = MetaData(naming_convention=NAMING_CONVENTION)


class PaymentMethod(enum.StrEnum):
    upi = "upi"
    cash = "cash"
    other = "other"


def _first_of_month(column: str) -> str:
    return f"CAST(strftime('%d', {column}) AS INTEGER) = 1"


class TimestampMixin:
    created_at: Mapped[dt.datetime] = mapped_column(
        DateTime, nullable=False, server_default=func.current_timestamp()
    )
    updated_at: Mapped[dt.datetime] = mapped_column(
        DateTime,
        nullable=False,
        server_default=func.current_timestamp(),
        onupdate=func.current_timestamp(),
    )


class Student(TimestampMixin, Base):
    __tablename__ = "students"

    id: Mapped[int] = mapped_column(Integer, primary_key=True)
    name: Mapped[str] = mapped_column(String, nullable=False)
    phone: Mapped[str | None] = mapped_column(String)
    guardian_name: Mapped[str | None] = mapped_column(String)
    batch_label: Mapped[str | None] = mapped_column(String)
    # First month they owe.
    joined_month: Mapped[dt.date] = mapped_column(Date, nullable=False)
    # Last month they owe. Set means the student is archived ("left").
    left_month: Mapped[dt.date | None] = mapped_column(Date)
    notes: Mapped[str | None] = mapped_column(Text)

    fee_changes: Mapped[list[FeeChange]] = relationship(
        back_populates="student",
        cascade="all, delete-orphan",
        passive_deletes=True,
        order_by="FeeChange.effective_month",
    )
    payments: Mapped[list[Payment]] = relationship(
        back_populates="student",
        cascade="all, delete-orphan",
        passive_deletes=True,
        order_by="Payment.for_month",
    )

    __table_args__ = (
        CheckConstraint("length(trim(name)) > 0", name="name_not_blank"),
        CheckConstraint(_first_of_month("joined_month"), name="joined_month_first_of_month"),
        CheckConstraint(
            f"left_month IS NULL OR {_first_of_month('left_month')}",
            name="left_month_first_of_month",
        ),
        CheckConstraint(
            "left_month IS NULL OR left_month >= joined_month", name="left_after_joined"
        ),
        Index("ix_students_name", "name"),
    )


class FeeChange(Base):
    """The fee for month m is the row with the greatest `effective_month <= m`."""

    __tablename__ = "fee_changes"

    id: Mapped[int] = mapped_column(Integer, primary_key=True)
    student_id: Mapped[int] = mapped_column(
        ForeignKey("students.id", ondelete="CASCADE"), nullable=False
    )
    effective_month: Mapped[dt.date] = mapped_column(Date, nullable=False)
    amount_paise: Mapped[int] = mapped_column(Integer, nullable=False)
    created_at: Mapped[dt.datetime] = mapped_column(
        DateTime, nullable=False, server_default=func.current_timestamp()
    )

    student: Mapped[Student] = relationship(back_populates="fee_changes")

    __table_args__ = (
        UniqueConstraint("student_id", "effective_month"),
        CheckConstraint("amount_paise >= 0", name="amount_non_negative"),
        CheckConstraint(_first_of_month("effective_month"), name="effective_month_first_of_month"),
    )


class Payment(TimestampMixin, Base):
    __tablename__ = "payments"

    id: Mapped[int] = mapped_column(Integer, primary_key=True)
    student_id: Mapped[int] = mapped_column(
        ForeignKey("students.id", ondelete="CASCADE"), nullable=False
    )
    amount_paise: Mapped[int] = mapped_column(Integer, nullable=False)
    paid_on: Mapped[dt.date] = mapped_column(Date, nullable=False)
    for_month: Mapped[dt.date] = mapped_column(Date, nullable=False)
    method: Mapped[PaymentMethod] = mapped_column(
        Enum(
            PaymentMethod,
            name="payment_method",
            native_enum=False,
            # The CHECK is declared explicitly below so autogenerate doesn't duplicate it.
            create_constraint=False,
            length=16,
            values_callable=lambda e: [m.value for m in e],
        ),
        nullable=False,
    )
    note: Mapped[str | None] = mapped_column(Text)

    student: Mapped[Student] = relationship(back_populates="payments")

    __table_args__ = (
        CheckConstraint(
            "method IN ({})".format(", ".join(f"'{m.value}'" for m in PaymentMethod)),
            name="method_valid",
        ),
        CheckConstraint("amount_paise > 0", name="amount_positive"),
        CheckConstraint(_first_of_month("for_month"), name="for_month_first_of_month"),
        Index("ix_payments_student_id_for_month", "student_id", "for_month"),
        Index("ix_payments_for_month", "for_month"),
        Index("ix_payments_paid_on", "paid_on"),
    )
