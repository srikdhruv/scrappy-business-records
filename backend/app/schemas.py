"""Pydantic request and response models: the API contract.

The frontend's TypeScript types are generated from these (`make gen-api`), so names here are
the names the UI uses. Conventions (see docs/data-model.md):

- Money is integer **paise** in fields ending `_paise`.
- Months are `"YYYY-MM"` strings (`Month`). Dates are ISO `"YYYY-MM-DD"` (`datetime.date`).
- Timestamps are timezone-aware UTC (`UtcDatetime`), serialized with a trailing "Z".
- Optional text fields turn blank strings into `null`.
- PATCH bodies are partial: only fields that are sent are changed. Use
  `model.model_fields_set` to tell "not sent" from "sent as null".
"""

from __future__ import annotations

import datetime as dt
import enum
import unicodedata
from typing import Annotated, Literal

from pydantic import (
    AfterValidator,
    BaseModel,
    BeforeValidator,
    ConfigDict,
    Field,
    ValidationInfo,
    field_validator,
)
from pydantic_core import PydanticCustomError

from app.models import PaymentMethod
from app.months import MONTH_PATTERN, format_month

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
    "StudentReturn",
    "StudentUpdate",
    "SuggestedPayment",
    "SuggestionReason",
    "YetToPayItem",
]


# --------------------------------------------------------------------------- shared types


_ALLOWED_CONTROL = frozenset("\t\n\r")


def _savable(value: str) -> str:
    # JSON can carry half of a character pair ("\ud800"), which the database can't store, and
    # invisible control characters (NUL and friends) that have no place in a name or note.
    # Tab and line breaks are fine.
    try:
        value.encode("utf-8")
    except UnicodeEncodeError:
        raise _field_error("This text has a character that can't be saved") from None
    if any(unicodedata.category(c) == "Cc" and c not in _ALLOWED_CONTROL for c in value):
        raise _field_error("This text has a character that can't be saved")
    return value


def _blank_to_none(value: object) -> object:
    if isinstance(value, str):
        value = _savable(value).strip()
        return value or None
    return value


def _strip(value: object) -> object:
    return _savable(value).strip() if isinstance(value, str) else value


def _date_to_month(value: object) -> object:
    # ORM rows hold months as first-of-month `date`s; the API speaks "YYYY-MM".
    return format_month(value) if isinstance(value, dt.date) else value


def _as_utc(value: dt.datetime) -> dt.datetime:
    # SQLite stores CURRENT_TIMESTAMP as naive UTC. Mark it as UTC so JSON gets a "Z" suffix.
    return value.replace(tzinfo=dt.UTC) if value.tzinfo is None else value.astimezone(dt.UTC)


Month = Annotated[
    str,
    BeforeValidator(_date_to_month),
    Field(pattern=MONTH_PATTERN, description='A month as "YYYY-MM".', examples=["2026-10"]),
]
"""A calendar month, e.g. "2026-10". Also accepts a `date` (from an ORM row) and converts it."""

UtcDatetime = Annotated[
    dt.datetime,
    AfterValidator(_as_utc),
    Field(description="UTC timestamp, e.g. 2026-10-05T09:30:00Z"),
]
"""A timestamp, always timezone-aware UTC (serialized with a trailing "Z")."""


def _field_error(message: str) -> PydanticCustomError:
    """A validation error whose `msg` is exactly `message` (no "Value error, " prefix).

    Raise it from a field validator so the 422's `loc` names the field. The UI shows `msg` to the
    person as-is, so write it in plain words.
    """
    return PydanticCustomError("value_error", message)


# Plain-words names for "... is required" messages.
_LABELS = {
    "name": "Name",
    "joined_month": "Joined month",
    "monthly_fee_paise": "Monthly fee",
    "student_id": "Student",
    "amount_paise": "Amount",
    "paid_on": "Paid-on date",
    "for_month": "Month",
    "method": "Payment method",
}


def _not_null(value: object, info: ValidationInfo) -> object:
    if value is None:
        raise _field_error(f"{_LABELS.get(info.field_name or '', 'This field')} is required")
    return value


def _check_left_month(left: str | None, joined: str | None) -> str | None:
    # "YYYY-MM" strings compare correctly as text.
    if left is not None and joined is not None and left < joined:
        raise _field_error("Left month can't be before the joined month")
    return left


def _name_not_blank(value: str) -> str:
    if not value:
        raise _field_error("Name is required")
    return value


Name = Annotated[
    str, BeforeValidator(_strip), AfterValidator(_name_not_blank), Field(max_length=200)
]
ShortText = Annotated[Annotated[str, Field(max_length=200)] | None, BeforeValidator(_blank_to_none)]
LongText = Annotated[Annotated[str, Field(max_length=5000)] | None, BeforeValidator(_blank_to_none)]

MAX_AMOUNT_PAISE = 100_000_000
"""₹10,00,000: the most a single payment or monthly fee can be. A typo guard (an extra zero or
two), not a business rule. Mirrored by `MAX_AMOUNT_PAISE` in frontend/src/lib/format.ts."""

# Response amounts. Not capped: totals (e.g. a student's whole backlog) can exceed the cap.
PositivePaise = Annotated[int, Field(gt=0, description="Amount in paise, more than 0.")]
NonNegativePaise = Annotated[int, Field(ge=0, description="Amount in paise, 0 or more.")]
SignedPaise = Annotated[int, Field(description="Amount in paise; may be negative.")]

# Request amounts: one payment or one monthly fee, capped at MAX_AMOUNT_PAISE.
PaymentAmountPaise = Annotated[
    int,
    Field(
        gt=0,
        le=MAX_AMOUNT_PAISE,
        strict=True,  # a whole number: not true/false, 1.5 or "100"
        description="Amount in paise: more than 0, at most 100000000 (₹10,00,000).",
    ),
]
FeePaise = Annotated[
    int,
    Field(
        ge=0,
        le=MAX_AMOUNT_PAISE,
        strict=True,
        description="Monthly fee in paise: 0 or more, at most 100000000 (₹10,00,000).",
    ),
]


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


class SuggestionReason(enum.StrEnum):
    """Why `SuggestedPayment` suggests what it does (PRD "Ledger rules", rule 9)."""

    owed = "owed"
    """The oldest month up to now that is Unpaid or Partial."""
    next_unpaid = "next_unpaid"
    """Nothing is owed yet: the first later month with a fee that isn't fully paid."""
    all_paid = "all_paid"
    """Nothing is left to pay in the months they are enrolled, up to the latest month a payment
    can be logged for (24 months ahead): they have left and paid up, or paid that far ahead."""


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
    """Error body for 404 (and other non-validation errors): `detail` is a sentence.

    422 responses use FastAPI's `HTTPValidationError` instead, where `detail` is a list of
    `{loc, msg, type}` items. Business-rule 422s raised by routers use the same list shape (see
    `app.errors.unprocessable`), so the UI handles one 422 format.
    """

    detail: str


# --------------------------------------------------------------------------- students


class StudentCreate(_Model):
    name: Name
    monthly_fee_paise: FeePaise
    joined_month: Month = Field(description="First month they owe.")
    phone: ShortText = None
    guardian_name: ShortText = None
    batch_label: ShortText = None
    notes: LongText = None
    left_month: Month | None = Field(
        default=None, description="Last month they owe. Setting it archives the student."
    )

    @field_validator("left_month")
    @classmethod
    def _left_not_before_joined(cls, value: str | None, info: ValidationInfo) -> str | None:
        return _check_left_month(value, info.data.get("joined_month"))


class StudentUpdate(_Model):
    """Partial update. Only fields that are sent change.

    To change the fee, send `monthly_fee_paise`, and optionally `fee_effective_month` (defaults
    to the current month). Earlier months keep their fee, and the new fee lasts until the next
    fee change already set after it, if any. Send `left_month: null` to un-archive a student
    as if they never left (every month since counts); `POST /students/{id}/return` instead
    skips the months they were away.

    Edit rules. This model checks what it can on its own. The router checks the rest against the
    stored student and answers **422** in the standard validation shape (`app.errors`), never a
    500 from a database CHECK:

    1. **Moving `joined_month`** moves the earliest fee change's `effective_month` with it, so
       the first owed month always has a fee. If the new joined month is on or after a later
       fee change, answer 422, because the earliest fee would disappear.
    2. **`fee_effective_month` before `joined_month`** (the new one if sent, else the stored
       one) → 422. A fee change for a month that already has one replaces its amount.
    3. **`left_month`** is checked against `joined_month` (the new one if sent, else the
       stored one): `left_month < joined_month` → 422.
    """

    name: Name | None = None
    phone: ShortText = None
    guardian_name: ShortText = None
    batch_label: ShortText = None
    notes: LongText = None
    joined_month: Month | None = None
    left_month: Month | None = None
    monthly_fee_paise: FeePaise | None = None
    fee_effective_month: Month | None = Field(
        default=None,
        description="Month the new fee starts. Only with monthly_fee_paise. Defaults to now.",
    )

    # Field-level checks, so a 422's `loc` names the field (["body", "left_month"]) and the UI
    # can show the message next to it. Fields are validated in declaration order, so
    # `info.data` holds the already-valid fields declared above the one being checked.

    @field_validator("name", "joined_month", "monthly_fee_paise")
    @classmethod
    def _not_null(cls, value: object, info: ValidationInfo) -> object:
        # Only runs for fields that were sent: omitting a field is fine, sending null isn't.
        return _not_null(value, info)

    @field_validator("left_month")
    @classmethod
    def _left_not_before_joined(cls, value: str | None, info: ValidationInfo) -> str | None:
        # Only against a joined_month sent in the same request; the router checks the stored one.
        return _check_left_month(value, info.data.get("joined_month"))

    @field_validator("fee_effective_month")
    @classmethod
    def _fee_month_needs_fee(cls, value: str | None, info: ValidationInfo) -> str | None:
        # A monthly_fee_paise that failed its own validation is absent from info.data (the
        # default 0 here); don't pile a second error on top of that one.
        if value is not None and info.data.get("monthly_fee_paise", 0) is None:
            raise _field_error("Send the new monthly fee together with the month it starts")
        return value


class StudentReturn(_Model):
    """Body of `POST /students/{id}/return`: a student who left is coming again (PRD ledger
    rule 11). The months between `left_month` and `from_month` get a 0 fee, so they are never
    owed; their fee carries on from `from_month`."""

    from_month: Month = Field(
        description="The first month they owe again: after left_month, at most 24 months "
        "after the current month."
    )
    monthly_fee_paise: FeePaise | None = Field(
        default=None,
        description="Their fee from from_month. Defaults to the fee their schedule has for that "
        "month, ignoring ₹0 fees left by an earlier return.",
    )


class FeeChangeRead(_ReadModel):
    id: int
    effective_month: Month
    amount_paise: NonNegativePaise


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
    is_active: bool = Field(
        description="True until the left month has passed (no left_month, or left_month is "
        "this month or later). False means Left (archived)."
    )
    monthly_fee_paise: NonNegativePaise = Field(description="Fee in effect this month.")
    balance_paise: SignedPaise = Field(
        description="Net: all payments minus everything expected up to this month. For "
        "reference only: money paid ahead or paid twice can cancel out months still owed, so "
        "headlines use `status` and `owed_paise`."
    )
    status: BalanceStatus = Field(
        description="`owes` if anything is owed for a due month (`owed_paise` > 0); otherwise "
        "`credit` if a due month was paid too much (`credit_paise` > 0); otherwise `up_to_date`."
    )
    owed_paise: NonNegativePaise = Field(
        description="Still owed: the sum of what's left on every due month (active months up to "
        "and including the current month) that is Unpaid or Partial."
    )
    paid_ahead_paise: NonNegativePaise = Field(
        description="Money paid for months after the current month that they're still enrolled "
        "in (not due yet; not credit). Months after left_month count as credit instead."
    )
    credit_paise: NonNegativePaise = Field(
        description="Money in overpaid months up to this month: the sum of max(0, paid - "
        "expected) over months up to and including the current month. Payments for later "
        "months (paid ahead) are not credit."
    )
    next_fee_change: FeeChangeRead | None = Field(
        description="The first fee change after the month monthly_fee_paise is for, if any "
        '(so the UI can say "No fee until December 2026, then ₹1,000").'
    )
    tenure_months: int = Field(
        ge=0,
        description="How long they have been a student, in months. Still coming: whole months "
        "since joined_month (0 in the joining month or before). Left (left_month before the "
        "current month): the months enrolled, both ends counted (left_month - joined_month + 1).",
    )
    current_month: Month = Field(
        description="The server's current month, which every number here is worked out for."
    )
    created_at: UtcDatetime
    updated_at: UtcDatetime


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
    """Prefill for the Log payment form (PRD "Ledger rules", rule 9). Never a month that is
    already fully paid, and never one outside the months the student is enrolled in.

    - `owed`: the oldest month up to now that is Unpaid or Partial, and what's left on it.
    - `next_unpaid`: the first later month with a fee that isn't fully paid, and what's left on
      it. Months with a 0 fee are skipped.
    - `all_paid`: nothing left to pay; `for_month` and `amount_paise` are null.
    """

    for_month: Month | None
    amount_paise: PositivePaise | None
    reason: SuggestionReason


# --------------------------------------------------------------------------- payments


class PaymentCreate(_Model):
    student_id: int = Field(gt=0, strict=True)
    amount_paise: PaymentAmountPaise
    paid_on: dt.date
    for_month: Month
    method: PaymentMethod
    note: LongText = None


class PaymentUpdate(_Model):
    """Partial update. Only fields that are sent change."""

    student_id: int | None = Field(default=None, gt=0, strict=True)
    amount_paise: PaymentAmountPaise | None = None
    paid_on: dt.date | None = None
    for_month: Month | None = None
    method: PaymentMethod | None = None
    note: LongText = None

    @field_validator("student_id", "amount_paise", "paid_on", "for_month", "method")
    @classmethod
    def _not_null(cls, value: object, info: ValidationInfo) -> object:
        # Only runs for fields that were sent: omitting a field is fine, sending null isn't.
        return _not_null(value, info)


class PaymentRead(_ReadModel):
    id: int
    student_id: int
    student_name: str
    amount_paise: PositivePaise
    paid_on: dt.date
    for_month: Month
    method: PaymentMethod
    note: str | None
    created_at: UtcDatetime
    updated_at: UtcDatetime


# --------------------------------------------------------------------------- dashboard


class DashboardSummary(_ReadModel):
    expected_paise: NonNegativePaise = Field(description="Expected for M from active students.")
    collected_paise: NonNegativePaise = Field(description="Payments whose for_month is M.")
    still_due_paise: NonNegativePaise = Field(description="Sum of max(0, expected - paid).")
    not_fully_paid_count: int = Field(ge=0, description="Students unpaid or partial for M.")
    active_student_count: int = Field(
        ge=0, description="Students with a fee due in M: active in M, with a fee above 0."
    )


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
    credit_paise: NonNegativePaise = Field(
        description="The student's money in overpaid months up to the current month (see "
        "StudentRead.credit_paise), so the UI can say they have credit."
    )


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
    credit_paise: NonNegativePaise = Field(
        description="The student's money in overpaid months up to the current month (see "
        "StudentRead.credit_paise), so the UI can say they have credit."
    )


class OverpaidItem(_ReadModel):
    """A student-month up to M where paid > expected."""

    student_id: int
    student_name: str
    batch_label: str | None
    phone: str | None
    month: Month
    expected_paise: NonNegativePaise
    paid_paise: PositivePaise
    excess_paise: PositivePaise


class DashboardResponse(_ReadModel):
    month: Month = Field(description="The month shown (M).")
    current_month: Month = Field(
        description="The server's current month. Months after it aren't due yet."
    )
    summary: DashboardSummary
    yet_to_pay: list[YetToPayItem]
    backlog: list[BacklogItem]
    overpaid: list[OverpaidItem]
