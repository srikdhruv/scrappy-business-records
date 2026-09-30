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
import re
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

from app.models import FeeKind, PaymentMethod
from app.months import MONTH_PATTERN, format_month

__all__ = [
    "ApplyBatchFee",
    "BacklogItem",
    "BacklogMonth",
    "BalanceStatus",
    "BatchCreate",
    "BatchOverview",
    "BatchRead",
    "BatchSummary",
    "BatchUpdate",
    "CreditMoveItem",
    "CreditSource",
    "DashboardResponse",
    "DashboardSummary",
    "ErrorResponse",
    "ExtraSent",
    "FeeChangeRead",
    "FeeKind",
    "HealthResponse",
    "LabelConversion",
    "LabelGroup",
    "LabelPreview",
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
    "Weekday",
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
    "days": "Days",
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


BatchId = Annotated[int, Field(gt=0, strict=True, description="A batch's id.")]

_TIME = re.compile(r"([01][0-9]|2[0-3]):[0-5][0-9]")


def _clock_time(value: str) -> str:
    if not _TIME.fullmatch(value):
        raise _field_error("Enter a time like 17:30")
    return value


ClockTime = Annotated[
    Annotated[
        str,
        AfterValidator(_clock_time),
        Field(max_length=5, description='A time of day as "HH:MM", 24-hour, e.g. "17:30".'),
    ]
    | None,
    BeforeValidator(_blank_to_none),
]


def _check_times(start: str | None, end: str | None) -> None:
    # "HH:MM" strings compare correctly as text.
    if start is not None and end is not None and end <= start:
        raise _field_error("The end time must be after the start time")


def _weekdays(value: list[Weekday]) -> list[Weekday]:
    """Each day once, Monday first, whatever order they were sent in."""
    order = list(Weekday)
    return sorted(set(value), key=order.index)


class _Model(BaseModel):
    model_config = ConfigDict(extra="forbid")


class _ReadModel(BaseModel):
    model_config = ConfigDict(from_attributes=True)


# --------------------------------------------------------------------------- enums


class MonthStatus(enum.StrEnum):
    """Status of one student for one month (PRD "Ledger rules", rule 4), counting what was paid
    for the month itself plus extra money from other payments that covers it (rule 10).

    - `paid`: fully paid. It was paid **with credit** when `covered_by_credit_paise > 0`.
    - `partial`, `unpaid`: some, or none, of the fee is covered.
    - `overpaid`: some of the money paid for this month wasn't needed by any month, so it is
      credit (`extra_unused_paise > 0`).
    - `not_applicable`: no fee, and none of this month's money is left as credit.
    """

    paid = "paid"
    partial = "partial"
    unpaid = "unpaid"
    overpaid = "overpaid"
    not_applicable = "not_applicable"


class BalanceStatus(enum.StrEnum):
    """Overall standing of a student (PRD "Ledger rules", rule 6): `owes` if any due month is
    still short after extra money has covered what it can; else `credit` if some money wasn't
    needed by any month; else `up_to_date`."""

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


class Weekday(enum.StrEnum):
    """A day a batch meets. Always listed Monday first."""

    mon = "mon"
    tue = "tue"
    wed = "wed"
    thu = "thu"
    fri = "fri"
    sat = "sat"
    sun = "sun"


Weekdays = Annotated[list[Weekday], AfterValidator(_weekdays), Field(max_length=7)]


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
    batch_id: BatchId | None = Field(
        default=None, description="The batch they're in (see /batches), or null for no batch."
    )
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
    batch_id: BatchId | None = Field(
        default=None, description="Move them to this batch; null takes them out of their batch."
    )
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
    kind: FeeKind = Field(
        description="`fee`: set by the owner (₹0 is a month off or a free place). `away`: the "
        "₹0 for the months away, written by coming back after leaving."
    )


class StudentRead(_ReadModel):
    """A student as shown in lists, with their current fee and overall balance."""

    id: int
    name: str
    phone: str | None
    guardian_name: str | None
    batch_label: str | None = Field(
        description="Free text typed before batches existed (kept exactly as it was typed)."
    )
    batch_id: int | None = Field(description="The batch they're in, or null for no batch.")
    batch_name: str | None = Field(description="That batch's name, or null.")
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
        "`credit` if some money wasn't needed by any month (`credit_paise` > 0); otherwise "
        "`up_to_date`."
    )
    owed_paise: NonNegativePaise = Field(
        description="Still owed: the sum of what's left on every due month (active months up to "
        "and including the current month), after extra money has covered the oldest months."
    )
    paid_ahead_paise: NonNegativePaise = Field(
        description="Money that pays months after the current month that they're still "
        "enrolled in: what was logged for them, up to each fee, plus extra money from other "
        "payments that covers them."
    )
    credit_paise: NonNegativePaise = Field(
        description="Money no month needed: what's left of the payments once each has paid its "
        "own month and covered every unpaid month it could (due months, then later ones up to "
        "left_month or 24 months ahead). The sum of the months' extra_unused_paise."
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


class CreditSource(_ReadModel):
    """Extra money from one payment, logged for another month, that covers this month."""

    payment_id: int
    paid_on: dt.date
    for_month: Month = Field(description="The month that payment was logged for.")
    amount_paise: PositivePaise = Field(description="How much of it covers this month.")


class ExtraSent(_ReadModel):
    """Money paid above a month's fee that covers another month."""

    to_month: Month = Field(description="The month it covers.")
    amount_paise: PositivePaise


class LedgerMonth(_ReadModel):
    """One row of a student's month-by-month ledger, after extra money has been handed out
    (PRD ledger rule 10). For every month:
    `paid_paise = paid_direct_paise + Σ extra_sent + extra_unused_paise`, and
    `paid_direct_paise + covered_by_credit_paise + remaining_paise = expected_paise`."""

    month: Month
    expected_paise: NonNegativePaise
    paid_paise: NonNegativePaise = Field(
        description="Everything logged for this month, exactly as typed."
    )
    paid_direct_paise: NonNegativePaise = Field(
        description="The part of paid_paise that pays this month: at most its fee."
    )
    covered_by_credit_paise: NonNegativePaise = Field(
        description="Extra money from payments logged for other months that pays this month "
        "(the sum of credit_sources)."
    )
    credit_sources: list[CreditSource] = Field(
        description="Where covered_by_credit_paise came from, in the order it was handed out."
    )
    extra_sent: list[ExtraSent] = Field(
        description="Where the money paid for this month above its fee went, one entry per "
        "month covered, oldest first."
    )
    extra_unused_paise: NonNegativePaise = Field(
        description="Money paid for this month that no month needed: credit."
    )
    remaining_paise: NonNegativePaise = Field(
        description="What's still left: max(0, expected - paid_direct - covered_by_credit)."
    )
    excess_paise: NonNegativePaise = Field(
        description="max(0, paid - expected): what was paid for this month above its fee "
        "(extra_sent plus extra_unused_paise)."
    )
    status: MonthStatus
    is_due: bool = Field(
        description="True for months up to and including the current month. "
        "What pays a later month is 'paid ahead'."
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
    """A payment exactly as typed, plus where its money went (PRD ledger rule 10):
    `amount_paise = paid_direct_paise + Σ extra_sent + extra_unused_paise`."""

    id: int
    student_id: int
    student_name: str
    amount_paise: PositivePaise
    paid_on: dt.date
    for_month: Month
    method: PaymentMethod
    note: str | None
    paid_direct_paise: NonNegativePaise = Field(
        description="The part that pays for_month itself (at most what was left of its fee)."
    )
    needs_check: bool = Field(
        description="Worth a glance, in case of a typo: it pays 4 or more months after the "
        "current one (months_ahead), or some of it is kept as credit (extra_unused_paise > 0). "
        "Paying months owed never flags."
    )
    months_ahead: int = Field(
        ge=0,
        description="How many months after the current one it pays (its own, and where its "
        "extra went).",
    )
    extra_sent: list[ExtraSent] = Field(
        description="The rest, covering other unpaid months, oldest first."
    )
    extra_unused_paise: NonNegativePaise = Field(description="What no month needed: credit.")
    created_at: UtcDatetime
    updated_at: UtcDatetime


# --------------------------------------------------------------------------- dashboard


class DashboardSummary(_ReadModel):
    expected_paise: NonNegativePaise = Field(description="Expected for M from active students.")
    collected_paise: NonNegativePaise = Field(
        description="What pays M: payments logged for M, up to each fee, plus extra money from "
        "payments logged for other months that covers M (Σ paid_direct + covered_by_credit)."
    )
    paid_ahead_paise: NonNegativePaise = Field(
        description="For a month after the current one: the same as collected_paise (what pays "
        "it ahead of time). 0 for the current month and earlier ones."
    )
    still_due_paise: NonNegativePaise = Field(
        description="What's left on M, after extra money, over students active in M."
    )
    logged_paise: NonNegativePaise = Field(
        description="Every payment logged for M, as typed: the Payments page's total for M. "
        "collected = logged - sent_elsewhere - (kept as credit) + covered_by_credit."
    )
    covered_by_credit_paise: NonNegativePaise = Field(
        description="The part of collected_paise that came from payments logged for other months."
    )
    sent_elsewhere_paise: NonNegativePaise = Field(
        description="The part of logged_paise that paid other months (the rest above the fees "
        "is kept as credit)."
    )
    not_fully_paid_count: int = Field(ge=0, description="Students unpaid or partial for M.")
    active_student_count: int = Field(
        ge=0, description="Students with a fee due in M: active in M, with a fee above 0."
    )


class YetToPayItem(_ReadModel):
    """A student active in M who is Unpaid or Partial for M."""

    student_id: int
    student_name: str
    batch_label: str | None
    batch_name: str | None = Field(description="The name of the batch they're in, if any.")
    phone: str | None
    expected_paise: NonNegativePaise
    paid_paise: NonNegativePaise = Field(description="Logged for M, as typed.")
    covered_by_credit_paise: NonNegativePaise = Field(
        description="Extra money from payments logged for other months that covers M."
    )
    remaining_paise: PositivePaise
    status: Literal[MonthStatus.unpaid, MonthStatus.partial]
    credit_paise: NonNegativePaise = Field(
        description="The student's credit (see StudentRead.credit_paise). Almost always 0 "
        "here: extra money covers unpaid months first."
    )


class BacklogMonth(_ReadModel):
    month: Month
    expected_paise: NonNegativePaise
    paid_paise: NonNegativePaise = Field(description="Logged for this month, as typed.")
    covered_by_credit_paise: NonNegativePaise = Field(
        description="Extra money from payments logged for other months that covers it."
    )
    remaining_paise: PositivePaise
    status: Literal[MonthStatus.unpaid, MonthStatus.partial]


class BacklogItem(_ReadModel):
    """A student with Unpaid or Partial months before M."""

    student_id: int
    student_name: str
    batch_label: str | None
    batch_name: str | None = Field(description="The name of the batch they're in, if any.")
    phone: str | None
    months: list[BacklogMonth] = Field(description="Oldest first.")
    total_owed_paise: PositivePaise
    credit_paise: NonNegativePaise = Field(
        description="The student's credit (see StudentRead.credit_paise). Almost always 0 "
        "here: extra money covers unpaid months first."
    )


class OverpaidItem(_ReadModel):
    """A student-month up to M (or later, from the current month on) holding money that no
    month needed: credit (`extra_unused_paise > 0`)."""

    student_id: int
    student_name: str
    batch_label: str | None
    batch_name: str | None = Field(description="The name of the batch they're in, if any.")
    phone: str | None
    month: Month
    expected_paise: NonNegativePaise
    paid_paise: PositivePaise
    excess_paise: PositivePaise = Field(description="max(0, paid - expected), as on LedgerMonth.")
    extra_unused_paise: PositivePaise = Field(description="The part of it no month needed: credit.")


class CreditMoveItem(_ReadModel):
    """Extra money from a payment logged for one month (`from_month`) that covers another
    (`to_month`). On M's dashboard, one of the two is M."""

    student_id: int
    student_name: str
    batch_label: str | None
    batch_name: str | None = Field(description="The name of the batch they're in, if any.")
    phone: str | None
    payment_id: int
    paid_on: dt.date
    from_month: Month = Field(description="The month the payment was logged for.")
    to_month: Month = Field(description="The month its extra money covers.")
    amount_paise: PositivePaise
    payment_amount_paise: PositivePaise = Field(description="The whole payment, as typed.")
    payment_pays_until: Month = Field(
        description="The latest month the payment pays (so a screen can say 'pays up to …')."
    )
    payment_needs_check: bool = Field(description="See PaymentRead.needs_check.")
    payment_months_ahead: int = Field(ge=0, description="See PaymentRead.months_ahead.")
    payment_extra_unused_paise: NonNegativePaise = Field(
        description="The part of the payment no month needed (credit)."
    )


class DashboardResponse(_ReadModel):
    month: Month = Field(description="The month shown (M).")
    current_month: Month = Field(
        description="The server's current month. Months after it aren't due yet."
    )
    summary: DashboardSummary
    yet_to_pay: list[YetToPayItem]
    backlog: list[BacklogItem]
    overpaid: list[OverpaidItem] = Field(description="Months holding credit (money not used).")
    credit_moves: list[CreditMoveItem] = Field(
        description="Extra money moved out of M's payments, or into M from other months' "
        "payments. By student, then the month covered, then the payment's date."
    )


# --------------------------------------------------------------------------- batches


class BatchCreate(_Model):
    """A new batch. Only the name is required. `default_fee_paise` only prefills the fee of a
    student added to it: each student keeps their own fee."""

    name: Name
    location: ShortText = None
    days: Weekdays = Field(default_factory=list, description="The days it meets, Monday first.")
    start_time: ClockTime = None
    end_time: ClockTime = None
    default_fee_paise: FeePaise | None = Field(
        default=None, description="The usual monthly fee, prefilled for a new student in it."
    )
    notes: LongText = None

    @field_validator("end_time")
    @classmethod
    def _end_after_start(cls, value: str | None, info: ValidationInfo) -> str | None:
        _check_times(info.data.get("start_time"), value)
        return value


class ApplyBatchFee(_Model):
    """Also charge the batch's new default fee to some of its students, from a month on. Each
    gets a fee change from `from_month` (or from when they joined, if later), exactly like
    changing their fee in Edit. Without this, no student's fee changes."""

    from_month: Month = Field(description="The first month of the new fee.")
    student_ids: list[Annotated[int, Field(gt=0, strict=True)]] = Field(
        max_length=5000,
        description="The students to charge it to: all must be in this batch. The UI lists "
        "them first, so exactly those change.",
    )


class BatchUpdate(_Model):
    """Partial update: only the fields that are sent change. Changing `default_fee_paise` never
    changes a student's fee by itself; send `apply_fee` too for that."""

    name: Name | None = None
    location: ShortText = None
    days: Weekdays | None = None
    start_time: ClockTime = None
    end_time: ClockTime = None
    default_fee_paise: FeePaise | None = None
    notes: LongText = None
    apply_fee: ApplyBatchFee | None = Field(
        default=None,
        description="Also charge default_fee_paise (which must be sent too) to these students.",
    )

    @field_validator("name", "days")
    @classmethod
    def _not_null(cls, value: object, info: ValidationInfo) -> object:
        # Only runs for fields that were sent: omitting a field is fine, sending null isn't.
        return _not_null(value, info)

    @field_validator("end_time")
    @classmethod
    def _end_after_start(cls, value: str | None, info: ValidationInfo) -> str | None:
        # Only against a start_time sent in the same request; the service checks the stored one.
        _check_times(info.data.get("start_time"), value)
        return value

    @field_validator("apply_fee")
    @classmethod
    def _apply_needs_fee(
        cls, value: ApplyBatchFee | None, info: ValidationInfo
    ) -> ApplyBatchFee | None:
        if value is not None and info.data.get("default_fee_paise") is None:
            raise _field_error("Send the new fee together with the students to charge it to")
        return value


class BatchRead(_ReadModel):
    id: int
    name: str
    location: str | None
    days: list[Weekday] = Field(description="The days it meets, Monday first.")
    start_time: str | None = Field(description='"HH:MM", 24-hour.')
    end_time: str | None = Field(description='"HH:MM", 24-hour.')
    default_fee_paise: NonNegativePaise | None
    notes: str | None
    student_count: int = Field(ge=0, description="Everyone in it, including those who left.")
    active_student_count: int = Field(
        ge=0, description="Those in it who haven't left (is_active on StudentRead)."
    )
    created_at: UtcDatetime
    updated_at: UtcDatetime


class BatchSummary(_ReadModel):
    """One batch's fees for a month M (or the students in no batch, `batch_id` null): the
    dashboard's summary, counted over that batch's students only. Over every batch and "no
    batch", each number adds up to the dashboard's."""

    batch_id: int | None = Field(description="Null: the students in no batch.")
    student_count: int = Field(ge=0, description="Students in it who are active in M.")
    active_student_count: int = Field(
        ge=0, description="Of those, the ones with a fee above 0 in M (as on the dashboard)."
    )
    expected_paise: NonNegativePaise = Field(description="Their fees for M.")
    collected_paise: NonNegativePaise = Field(
        description="What pays M (as the dashboard's collected_paise)."
    )
    still_due_paise: NonNegativePaise = Field(description="What's still left on M.")
    paid_ahead_paise: NonNegativePaise = Field(
        description="For a month after the current one: what pays it ahead of time. 0 otherwise."
    )
    not_fully_paid_count: int = Field(ge=0, description="Students unpaid or partial for M.")
    paid_percent: int | None = Field(
        ge=0,
        le=100,
        description="(expected - still due) / expected, rounded down, so 100 only when every "
        "fee for M is paid. Null when nothing is expected.",
    )


class BatchOverview(_ReadModel):
    month: Month = Field(description="The month shown (M).")
    current_month: Month
    batches: list[BatchSummary] = Field(description="One per batch, in the order of /batches.")
    no_batch: BatchSummary = Field(description="The students who aren't in any batch.")


class LabelGroup(_ReadModel):
    """Students whose old "class or batch" text is the same, ignoring capitals and spaces."""

    name: str = Field(description="The batch's name: the way most of them spell it.")
    labels: list[str] = Field(description="Every spelling found, most used first.")
    student_count: int = Field(ge=1)
    student_names: list[str] = Field(description="Sorted by name.")
    existing_batch_id: int | None = Field(
        description="A batch with this name already exists, so they go into it."
    )


class LabelPreview(_ReadModel):
    """What "Create batches from existing labels" would do: students in no batch who have a
    label, grouped. Nothing changes until it is confirmed."""

    groups: list[LabelGroup] = Field(description="Sorted by name.")
    student_count: int = Field(ge=0)
    new_batch_count: int = Field(ge=0, description="Groups with no batch of that name yet.")


class LabelConversion(_ReadModel):
    batches_created: int = Field(ge=0)
    students_placed: int = Field(ge=0)
    backup_file: str | None = Field(
        description="The backup taken first (a file name), or null if nothing needed doing."
    )
