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
from typing import Any, ClassVar

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


class FeeKind(enum.StrEnum):
    """What a fee change is. `fee`: a fee the owner set (₹0 means a month off or a free place).
    `away`: the ₹0 for the months away, written by coming back after leaving (PRD ledger rule
    11), and managed by the app: cleaned up when the left month changes or they come back
    again."""

    fee = "fee"
    away = "away"


def _first_of_month(column: str) -> str:
    # `IS` (not `=`) so a value SQLite can't parse as a date (date() -> NULL) fails the CHECK
    # instead of passing it: rejects 'garbage', '2026-10', 20261001 and '2026-10-05'.
    return f"{column} IS date({column}, 'start of month')"


def _valid_date(column: str) -> str:
    return f"{column} IS date({column})"


class TimestampMixin:
    # Read the database-set timestamps back in the INSERT/UPDATE itself (RETURNING), so they are
    # loaded before a response is built and never lazy-loaded later.
    __mapper_args__: ClassVar[dict[str, Any]] = {"eager_defaults": True}

    created_at: Mapped[dt.datetime] = mapped_column(
        DateTime, nullable=False, server_default=func.current_timestamp()
    )
    updated_at: Mapped[dt.datetime] = mapped_column(
        DateTime,
        nullable=False,
        server_default=func.current_timestamp(),
        onupdate=func.current_timestamp(),
    )


WEEKDAYS = ("mon", "tue", "wed", "thu", "fri", "sat", "sun")
"""The order of `Batch.days`: one character per weekday, Monday first."""

MAX_FEE_PAISE = 100_000_000
"""₹10,00,000, as `schemas.MAX_AMOUNT_PAISE`: a batch's default fee is capped like any fee."""


def _clock_time(column: str) -> str:
    # "HH:MM", 00:00 to 23:59. GLOB checks the shape, the comparison the range.
    return f"{column} IS NULL OR ({column} GLOB '[0-2][0-9]:[0-5][0-9]' AND {column} <= '23:59')"


class Batch(TimestampMixin, Base):
    """A class the students come to: a name, an optional location, the days and times it
    meets, and the fee new students in it usually pay (`default_fee_paise`, which only
    prefills the form: each student keeps their own fee)."""

    __tablename__ = "batches"

    id: Mapped[int] = mapped_column(Integer, primary_key=True)
    # NOCASE: two batches can't share a name that differs only in capitals (A-Z; the API also
    # checks other letters, ignoring case and spaces).
    name: Mapped[str] = mapped_column(String(collation="NOCASE"), nullable=False)
    location: Mapped[str | None] = mapped_column(String)
    # Seven characters, Monday first: "1010100" is Mon, Wed, Fri. "0000000" is no days set.
    days: Mapped[str] = mapped_column(
        String(7), nullable=False, default="0000000", server_default="0000000"
    )
    start_time: Mapped[str | None] = mapped_column(String(5))
    end_time: Mapped[str | None] = mapped_column(String(5))
    default_fee_paise: Mapped[int | None] = mapped_column(Integer)
    notes: Mapped[str | None] = mapped_column(Text)

    __table_args__ = (
        UniqueConstraint("name"),
        CheckConstraint("length(trim(name)) > 0", name="name_not_blank"),
        CheckConstraint("length(days) = 7 AND days NOT GLOB '*[^01]*'", name="days_mask"),
        CheckConstraint(_clock_time("start_time"), name="start_time_valid"),
        CheckConstraint(_clock_time("end_time"), name="end_time_valid"),
        CheckConstraint(
            "default_fee_paise IS NULL OR "
            f"(default_fee_paise >= 0 AND default_fee_paise <= {MAX_FEE_PAISE})",
            name="default_fee_range",
        ),
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
    # The batch they're in, or none. Deleting a batch leaves its students in no batch: the
    # database says `ON DELETE SET NULL` (migration 0005), and `services.batches.delete_batch`
    # also clears them itself first. The migration adds the column in place (no table copy),
    # so the link is written inline, and SQLite can't read an inline link's name or ON DELETE
    # back: `ondelete` is left out here so the models still match what the database reports.
    batch_id: Mapped[int | None] = mapped_column(ForeignKey("batches.id"), index=True)
    # Loaded with the student (a join, `services.students.LEDGER_ROWS`), never on its own.
    batch: Mapped[Batch | None] = relationship(lazy="raise")
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
    kind: Mapped[FeeKind] = mapped_column(
        Enum(
            FeeKind,
            name="fee_kind",
            native_enum=False,
            create_constraint=False,  # declared below, like payments.method
            length=8,
            values_callable=lambda e: [m.value for m in e],
        ),
        nullable=False,
        default=FeeKind.fee,
        server_default=FeeKind.fee.value,
    )
    created_at: Mapped[dt.datetime] = mapped_column(
        DateTime, nullable=False, server_default=func.current_timestamp()
    )

    student: Mapped[Student] = relationship(back_populates="fee_changes")

    __table_args__ = (
        UniqueConstraint("student_id", "effective_month"),
        CheckConstraint(
            "kind IN ({})".format(", ".join(f"'{k.value}'" for k in FeeKind)), name="kind_valid"
        ),
        CheckConstraint("kind = 'fee' OR amount_paise = 0", name="away_is_no_fee"),
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

    # `raise`: reading `payment.student` without loading it first (joinedload/selectinload) is
    # an error, not a hidden query per row.
    student: Mapped[Student] = relationship(back_populates="payments", lazy="raise")

    @property
    def student_name(self) -> str:
        """So `PaymentRead.model_validate(payment)` works straight from an ORM row. Load the
        student with the payment (`joinedload(Payment.student)`) first."""
        return self.student.name

    __table_args__ = (
        CheckConstraint(
            "method IN ({})".format(", ".join(f"'{m.value}'" for m in PaymentMethod)),
            name="method_valid",
        ),
        CheckConstraint("amount_paise > 0", name="amount_positive"),
        CheckConstraint(_first_of_month("for_month"), name="for_month_first_of_month"),
        CheckConstraint(_valid_date("paid_on"), name="paid_on_valid_date"),
        Index("ix_payments_student_id_for_month", "student_id", "for_month"),
        Index("ix_payments_for_month", "for_month"),
        Index("ix_payments_paid_on", "paid_on"),
    )
