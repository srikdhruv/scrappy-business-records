"""Pydantic request and response models: the API contract.

The frontend's TypeScript types are generated from these (`make gen-api`), so names here are
the names the UI uses. Conventions (see docs/data-model.md):

- Money is integer **paise** in fields ending `_paise`.
- Months are `"YYYY-MM"` strings (`Month`). Dates are ISO `"YYYY-MM-DD"` (`datetime.date`).
- Timestamps are UTC.
- Optional text fields turn blank strings into `null`.
- PATCH bodies are partial: only fields that are sent are changed. Use
  `model.model_fields_set` to tell "not sent" from "sent as null".
"""

from __future__ import annotations

import datetime as dt
import enum
from typing import Annotated, Literal

from pydantic import BaseModel, BeforeValidator, ConfigDict, Field, model_validator

from app.models import PaymentMethod
from app.months import MONTH_PATTERN

__all__ = [
    "BacklogItem",
    "BacklogMonth",
    "BalanceStatus",
    "DashboardResponse",
    "DashboardSummary",
    "ErrorResponse",
    "FeeChangeRead",
    "HealthResponse",
    "LedgerMonth",
    "MonthStatus",
    "OverpaidItem",
    "PaymentCreate",
    "PaymentMethod",
    "PaymentRead",
    "PaymentSort",
    "PaymentUpdate",
    "SortOrder",
    "StudentCreate",
    "StudentDetail",
    "StudentListFilter",
    "StudentRead",
    "StudentUpdate",
    "SuggestedPayment",
    "YetToPayItem",
]


# --------------------------------------------------------------------------- shared types


def _blank_to_none(value: object) -> object:
    if isinstance(value, str):
        value = value.strip()
        return value or None
    return value


def _strip(value: object) -> object:
    return value.strip() if isinstance(value, str) else value


Month = Annotated[
    str,
    Field(pattern=MONTH_PATTERN, description='A month as "YYYY-MM".', examples=["2026-10"]),
]
"""A calendar month, e.g. "2026-10"."""

Name = Annotated[str, BeforeValidator(_strip), Field(min_length=1, max_length=200)]
ShortText = Annotated[Annotated[str, Field(max_length=200)] | None, BeforeValidator(_blank_to_none)]
LongText = Annotated[Annotated[str, Field(max_length=5000)] | None, BeforeValidator(_blank_to_none)]

PositivePaise = Annotated[int, Field(gt=0, description="Amount in paise, more than 0.")]
NonNegativePaise = Annotated[int, Field(ge=0, description="Amount in paise, 0 or more.")]
SignedPaise = Annotated[int, Field(description="Amount in paise; may be negative.")]


class _Model(BaseModel):
    model_config = ConfigDict(extra="forbid")


class _ReadModel(BaseModel):
    model_config = ConfigDict(from_attributes=True)


# --------------------------------------------------------------------------- enums


class MonthStatus(enum.StrEnum):
    """Status of one student for one month (PRD "Ledger rules", rule 4)."""

    paid = "paid"
    partial = "partial"
    unpaid = "unpaid"
    overpaid = "overpaid"
    not_applicable = "not_applicable"


class BalanceStatus(enum.StrEnum):
    """Overall standing of a student (PRD "Ledger rules", rule 6)."""

    up_to_date = "up_to_date"
    owes = "owes"
    credit = "credit"


class StudentListFilter(enum.StrEnum):
    """`status` filter for `GET /api/students`. `left` means archived."""

    active = "active"
    left = "left"
    all = "all"


class PaymentSort(enum.StrEnum):
    paid_on = "paid_on"
    for_month = "for_month"
    amount = "amount"
    student = "student"
    method = "method"


class SortOrder(enum.StrEnum):
    asc = "asc"
    desc = "desc"


# --------------------------------------------------------------------------- health / errors


class HealthResponse(_ReadModel):
    app: Literal["scrappy-records"]
    version: str = Field(examples=["0.1.0"])
    status: Literal["ok"]


class ErrorResponse(_ReadModel):
    """FastAPI's standard error body for 404 and similar errors."""

    detail: str


# --------------------------------------------------------------------------- students


class StudentCreate(_Model):
    name: Name
    monthly_fee_paise: NonNegativePaise
    joined_month: Month = Field(description="First month they owe.")
    phone: ShortText = None
    guardian_name: ShortText = None
    batch_label: ShortText = None
    notes: LongText = None
    left_month: Month | None = Field(
        default=None, description="Last month they owe. Setting it archives the student."
    )

    @model_validator(mode="after")
    def _left_not_before_joined(self) -> StudentCreate:
        if self.left_month is not None and self.left_month < self.joined_month:
            raise ValueError("left_month cannot be before joined_month")
        return self


class StudentUpdate(_Model):
    """Partial update. Only fields that are sent change.

    To change the fee, send `monthly_fee_paise`, and optionally `fee_effective_month` (defaults
    to the current month). Earlier months keep their old fee. Send `left_month: null` to
    un-archive a student.
    """

    name: Name | None = None
    phone: ShortText = None
    guardian_name: ShortText = None
    batch_label: ShortText = None
    notes: LongText = None
    joined_month: Month | None = None
    left_month: Month | None = None
    monthly_fee_paise: NonNegativePaise | None = None
    fee_effective_month: Month | None = Field(
        default=None,
        description="Month the new fee starts. Only with monthly_fee_paise. Defaults to now.",
    )

    @model_validator(mode="after")
    def _check(self) -> StudentUpdate:
        sent = self.model_fields_set
        if "name" in sent and self.name is None:
            raise ValueError("name cannot be empty")
        if "joined_month" in sent and self.joined_month is None:
            raise ValueError("joined_month cannot be empty")
        if "monthly_fee_paise" in sent and self.monthly_fee_paise is None:
            raise ValueError("monthly_fee_paise cannot be empty")
        if self.fee_effective_month is not None and self.monthly_fee_paise is None:
            raise ValueError("fee_effective_month needs monthly_fee_paise")
        if (
            self.left_month is not None
            and self.joined_month is not None
            and self.left_month < self.joined_month
        ):
            raise ValueError("left_month cannot be before joined_month")
        return self


class StudentRead(_ReadModel):
    """A student as shown in lists, with their current fee and overall balance."""

    id: int
    name: str
    phone: str | None
    guardian_name: str | None
    batch_label: str | None
    joined_month: Month
    left_month: Month | None
    notes: str | None
    is_active: bool = Field(description="False once the student is archived (has left).")
    monthly_fee_paise: NonNegativePaise = Field(description="Fee in effect this month.")
    balance_paise: SignedPaise = Field(
        description="All payments minus everything expected up to this month. "
        "Negative means they owe; positive means credit."
    )
    status: BalanceStatus
    created_at: dt.datetime
    updated_at: dt.datetime


class FeeChangeRead(_ReadModel):
    id: int
    effective_month: Month
    amount_paise: NonNegativePaise


class LedgerMonth(_ReadModel):
    """One row of a student's month-by-month ledger."""

    month: Month
    expected_paise: NonNegativePaise
    paid_paise: NonNegativePaise
    remaining_paise: NonNegativePaise = Field(description="max(0, expected - paid)")
    excess_paise: NonNegativePaise = Field(description="max(0, paid - expected)")
    status: MonthStatus
    is_due: bool = Field(
        description="True for months up to and including the current month. "
        "Payments for later months are 'paid ahead'."
    )


class StudentDetail(StudentRead):
    fee_history: list[FeeChangeRead] = Field(description="Oldest first.")
    months: list[LedgerMonth] = Field(
        description="From joined_month to the current month (or the last paid month, if later)."
        " Oldest first."
    )
    payment_count: int = Field(ge=0)
    total_paid_paise: NonNegativePaise


class SuggestedPayment(_ReadModel):
    """Prefill for the Log payment form: the oldest unpaid or partial month and what's left on
    it, otherwise the current month and its fee."""

    for_month: Month
    amount_paise: NonNegativePaise


# --------------------------------------------------------------------------- payments


class PaymentCreate(_Model):
    student_id: int = Field(gt=0)
    amount_paise: PositivePaise
    paid_on: dt.date
    for_month: Month
    method: PaymentMethod
    note: LongText = None


class PaymentUpdate(_Model):
    """Partial update. Only fields that are sent change."""

    student_id: int | None = Field(default=None, gt=0)
    amount_paise: PositivePaise | None = None
    paid_on: dt.date | None = None
    for_month: Month | None = None
    method: PaymentMethod | None = None
    note: LongText = None

    @model_validator(mode="after")
    def _required_stay_set(self) -> PaymentUpdate:
        for field in ("student_id", "amount_paise", "paid_on", "for_month", "method"):
            if field in self.model_fields_set and getattr(self, field) is None:
                raise ValueError(f"{field} cannot be empty")
        return self


class PaymentRead(_ReadModel):
    id: int
    student_id: int
    student_name: str
    amount_paise: PositivePaise
    paid_on: dt.date
    for_month: Month
    method: PaymentMethod
    note: str | None
    created_at: dt.datetime
    updated_at: dt.datetime


# --------------------------------------------------------------------------- dashboard


class DashboardSummary(_ReadModel):
    expected_paise: NonNegativePaise = Field(description="Expected for M from active students.")
    collected_paise: NonNegativePaise = Field(description="Payments whose for_month is M.")
    still_due_paise: NonNegativePaise = Field(description="Sum of max(0, expected - paid).")
    not_fully_paid_count: int = Field(ge=0, description="Students unpaid or partial for M.")
    active_student_count: int = Field(ge=0, description="Students active in M.")


class YetToPayItem(_ReadModel):
    """A student active in M who is Unpaid or Partial for M."""

    student_id: int
    student_name: str
    batch_label: str | None
    phone: str | None
    expected_paise: NonNegativePaise
    paid_paise: NonNegativePaise
    remaining_paise: PositivePaise
    status: Literal[MonthStatus.unpaid, MonthStatus.partial]


class BacklogMonth(_ReadModel):
    month: Month
    expected_paise: NonNegativePaise
    paid_paise: NonNegativePaise
    remaining_paise: PositivePaise
    status: Literal[MonthStatus.unpaid, MonthStatus.partial]


class BacklogItem(_ReadModel):
    """A student with Unpaid or Partial months before M."""

    student_id: int
    student_name: str
    batch_label: str | None
    phone: str | None
    months: list[BacklogMonth] = Field(description="Oldest first.")
    total_owed_paise: PositivePaise


class OverpaidItem(_ReadModel):
    """A student-month up to M where paid > expected."""

    student_id: int
    student_name: str
    month: Month
    expected_paise: NonNegativePaise
    paid_paise: PositivePaise
    excess_paise: PositivePaise


class DashboardResponse(_ReadModel):
    month: Month
    summary: DashboardSummary
    yet_to_pay: list[YetToPayItem]
    backlog: list[BacklogItem]
    overpaid: list[OverpaidItem]
