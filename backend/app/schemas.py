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

import base64
import binascii
import datetime as dt
import enum
import re
import unicodedata
import uuid
from typing import Annotated, Literal

from pydantic import (
    AfterValidator,
    BaseModel,
    BeforeValidator,
    ConfigDict,
    Field,
    ValidationInfo,
    field_validator,
    model_validator,
)
from pydantic_core import PydanticCustomError

from app.models import FeedbackCategory, FeedbackStatus, FeeKind, PaymentMethod
from app.months import MONTH_PATTERN, format_month

__all__ = [
    "AboutResponse",
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
    "FeePlan",
    "FeePlanStatus",
    "FeePlanStudent",
    "FeedbackCategory",
    "FeedbackClientError",
    "FeedbackClientInfo",
    "FeedbackCreate",
    "FeedbackRead",
    "FeedbackStatus",
    "HealthResponse",
    "LabelConversion",
    "LabelGroup",
    "LabelPreview",
    "LedgerMonth",
    "MonthStatus",
    "MoveResult",
    "MoveStudents",
    "NoFeeReason",
    "OverpaidItem",
    "PaymentCreate",
    "PaymentMethod",
    "PaymentRead",
    "PaymentSort",
    "PaymentUpdate",
    "ReportCheck",
    "ReportFilter",
    "ReportGroup",
    "ReportResponse",
    "ReportRow",
    "ReportSort",
    "ReportStatus",
    "ReportTotals",
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
# Excel download and upload, and unassigned payments (at the end of this file).
__all__ += [
    "ExportTemplateKind",
    "ImportBatchPreview",
    "ImportBatchStatus",
    "ImportCommit",
    "ImportFee",
    "ImportPayment",
    "ImportPaymentChoice",
    "ImportPaymentDecision",
    "ImportPaymentPreview",
    "ImportPaymentStatus",
    "ImportPreview",
    "ImportResult",
    "ImportStudent",
    "ImportStudentDecision",
    "ImportStudentPreview",
    "ImportStudentStatus",
    "UnassignedAssign",
    "UnassignedPaymentRead",
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


class ReportStatus(enum.StrEnum):
    """One student's status for month M on the monthly report, in the report's default order
    (whom to follow up with first). From the same numbers as `MonthStatus`:

    - `unpaid`, `partial`: a due month (up to the current month) that nothing, or not enough,
      pays.
    - `not_due_yet`: a month after the current one that isn't fully paid ahead yet.
    - `paid_with_credit`: fully paid, some of it by extra money from another payment
      (`covered_by_credit_paise > 0`).
    - `paid`: fully paid by money logged for M (for a later month: paid ahead).
    - `no_fee`: a ₹0 fee in M (a month off, a month away, a free place), or before they joined.
    - `left`: M is after their left month (they are on the report because of money or dues).
    """

    unpaid = "unpaid"
    partial = "partial"
    not_due_yet = "not_due_yet"
    paid_with_credit = "paid_with_credit"
    paid = "paid"
    no_fee = "no_fee"
    left = "left"


class NoFeeReason(enum.StrEnum):
    """Why a monthly report row says **No fee**."""

    not_joined = "not_joined"
    """M is before the month they joined."""
    away = "away"
    """A month away before they came back (an `away` fee change)."""
    zero_fee = "zero_fee"
    """A ₹0 fee the owner set: a month off, or a free place."""


class ReportFilter(enum.StrEnum):
    """Which rows of the monthly report: `all`; `owes` (anything owed now, any month);
    `short` (something left to pay for M); or one `ReportStatus`."""

    all = "all"
    owes = "owes"
    short = "short"
    unpaid = "unpaid"
    partial = "partial"
    not_due_yet = "not_due_yet"
    paid_with_credit = "paid_with_credit"
    paid = "paid"
    no_fee = "no_fee"
    left = "left"


class ReportGroup(enum.StrEnum):
    """How the monthly report's rows are grouped: `none`, or under a heading per `batch`
    (batches A to Z, "No batch" last; the order inside each group stays)."""

    none = "none"
    batch = "batch"


class ReportSort(enum.StrEnum):
    """A column of the monthly report to sort by (ties keep the report's usual order)."""

    student = "student"
    status = "status"
    fee = "fee"
    paid = "paid"
    short = "short"
    owed_now = "owed_now"
    covered = "covered"
    extra = "extra"
    owed_before = "owed_before"
    credit = "credit"
    batch = "batch"


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


# --------------------------------------------------------------------------- monthly report


class ReportCheck(_ReadModel):
    """A payment logged for M that is worth a glance in case of a typo (`ledger.needs_check`,
    as on the dashboard): it pays 4 or more months ahead, or some of it is kept as credit."""

    payment_id: int
    paid_on: dt.date
    amount_paise: PositivePaise
    pays_until: Month = Field(description="The latest month it pays (`ledger.pays_until`).")
    months_ahead: int = Field(ge=0, description="How many months after the current one it pays.")
    extra_unused_paise: NonNegativePaise = Field(description="The part no month needed.")


class ReportRow(_ReadModel):
    """One student on the monthly report for M. The M numbers are the student's `LedgerMonth`
    for M; the standing numbers are their `StudentRead` ones (as of the current month).
    `paid_paise = paid_direct_paise + extra_sent_paise + extra_unused_paise` and
    `paid_direct_paise + covered_by_credit_paise + short_paise = fee_paise`."""

    student_id: int
    student_name: str
    batch_label: str | None
    batch_name: str | None = Field(description="The name of the batch they're in, if any.")
    batch_id: int | None = Field(default=None, description="The batch they're in, if any.")
    phone: str | None
    joined_month: Month
    left_month: Month | None
    is_enrolled: bool = Field(description="Active in M (joined on or before M, not left before).")
    fee_paise: NonNegativePaise = Field(description="The fee for M (0 if not enrolled in M).")
    paid_paise: NonNegativePaise = Field(description="Everything logged for M, as typed.")
    paid_direct_paise: NonNegativePaise = Field(
        description="The part of paid_paise that pays M: at most its fee."
    )
    covered_by_credit_paise: NonNegativePaise = Field(
        description="Extra money from payments logged for other months that pays M."
    )
    credit_sources: list[CreditSource] = Field(
        description="Where covered_by_credit_paise came from."
    )
    extra_sent_paise: NonNegativePaise = Field(
        description="Money logged for M above its fee that paid other months (Σ extra_sent)."
    )
    extra_sent: list[ExtraSent] = Field(description="Where it went, oldest month first.")
    extra_unused_paise: NonNegativePaise = Field(
        description="Money logged for M that no month needed: kept as credit."
    )
    short_paise: NonNegativePaise = Field(
        description="What's left of M's fee: the LedgerMonth's remaining_paise."
    )
    status: ReportStatus
    no_fee_reason: NoFeeReason | None = Field(
        description="Why the status is `no_fee` (null for any other status)."
    )
    checks: list[ReportCheck] = Field(
        description="Payments logged for M worth a glance in case of a typo, as on the dashboard."
    )
    owed_before_paise: NonNegativePaise = Field(
        description="Still owed for due months before M (the dashboard's backlog total)."
    )
    owed_before_months: list[Month] = Field(description="Those months, oldest first.")
    owed_now_paise: NonNegativePaise = Field(
        description="Everything still owed as of the current month (StudentRead.owed_paise)."
    )
    credit_paise: NonNegativePaise = Field(description="StudentRead.credit_paise.")
    paid_ahead_paise: NonNegativePaise = Field(description="StudentRead.paid_ahead_paise.")


class ReportTotals(_ReadModel):
    """Sums over every row. They are the dashboard summary for M: `fee_paise` is its
    `expected_paise`, `paid_paise` its `logged_paise`, `extra_sent_paise` its
    `sent_elsewhere_paise`, `short_paise` its `still_due_paise`, and `collected_paise`,
    `covered_by_credit_paise`, `not_fully_paid_count` and `active_student_count` are the same."""

    student_count: int = Field(ge=0, description="How many rows.")
    fee_paise: NonNegativePaise
    paid_paise: NonNegativePaise
    paid_direct_paise: NonNegativePaise
    covered_by_credit_paise: NonNegativePaise
    collected_paise: NonNegativePaise = Field(
        description="What pays M: Σ paid_direct_paise + covered_by_credit_paise."
    )
    extra_sent_paise: NonNegativePaise
    extra_unused_paise: NonNegativePaise
    short_paise: NonNegativePaise
    owed_before_paise: NonNegativePaise
    owed_now_paise: NonNegativePaise
    credit_paise: NonNegativePaise
    paid_ahead_paise: NonNegativePaise
    not_fully_paid_count: int = Field(ge=0, description="Rows with something short on M.")
    active_student_count: int = Field(ge=0, description="Rows enrolled in M with a fee above 0.")


class ReportResponse(_ReadModel):
    month: Month = Field(description="The month reported on (M).")
    current_month: Month = Field(
        description="The server's current month. Months after it aren't due yet."
    )
    today: dt.date = Field(description="The server's date, to print on the report.")
    rows: list[ReportRow] = Field(
        description="Every student relevant to M (see ledger.build_report): enrolled in M, money "
        "logged for or paying M, still owing an earlier month, money kept as credit up to M, or "
        "(from the current month on) any credit or money paid ahead. Unpaid first (in "
        "ReportStatus order), then by name."
    )
    totals: ReportTotals
    unassigned_count: int = Field(
        default=0,
        ge=0,
        description="Unassigned payments (from an upload, no student yet) for M. They belong to "
        "no student, so no row or total counts them: the report says so in a line.",
    )
    unassigned_paise: NonNegativePaise = Field(
        default=0, description="What those unassigned payments add up to."
    )


# --------------------------------------------------------------------------- unassigned payments


class UnassignedPaymentRead(_ReadModel):
    """A payment from an uploaded file whose student couldn't be matched. It belongs to no
    student, so no total counts it, until it is assigned (`POST .../assign`)."""

    id: int
    student_text: str = Field(description="The student as written in the file.")
    phone: str | None
    amount_paise: PositivePaise
    paid_on: dt.date
    for_month: Month
    method: PaymentMethod
    note: str | None
    source: str | None = Field(description='Where it came from, e.g. "Upload: fees.xlsx".')
    created_at: UtcDatetime
    suggested_student_ids: list[int] = Field(
        description="Students it may be, best first: the same name or phone, then anyone the "
        "Students search finds for the name as written."
    )


class UnassignedAssign(_Model):
    student_id: int = Field(gt=0, strict=True)


# --------------------------------------------------------------------------- Excel upload


class ExportTemplateKind(enum.StrEnum):
    students = "students"
    payments = "payments"


class ImportStudentStatus(enum.StrEnum):
    """What adding an uploaded student row would do."""

    new = "new"
    """Will be added."""
    exists = "exists"
    """Already here (same name and phone, or same name and neither has a phone), or the same as
    an earlier row in the file. Skipped; nothing is changed."""
    similar = "similar"
    """Same name with a different phone, or the same phone with a different name. Skipped
    unless the owner chooses to add it as a new student."""
    problem = "problem"
    """Can't be added (see `reason`). Skipped."""


class ImportPaymentStatus(enum.StrEnum):
    """What adding an uploaded payment row would do."""

    ready = "ready"
    """Its student was found (or is being added from the same file): it will be added."""
    needs_student = "needs_student"
    """No student, or more than one, matches: kept as unassigned unless the owner picks a
    student or skips it."""
    follows_student = "follows_student"
    """Its student is a "similar" row in the same file: it goes to them if they're added, and
    is kept as unassigned if not."""
    unassigned = "unassigned"
    """From the file's Unassigned payments sheet: kept as unassigned."""
    duplicate = "duplicate"
    """Exactly like a payment already here, or an earlier row of the file: the same student,
    amount, paid-on date, month, method and note. Skipped unless the owner says Add anyway."""
    possible_duplicate = "possible_duplicate"
    """The same student, amount, paid-on date and month as a payment already here (or an
    earlier row), but a different method or note. Skipped unless the owner says Add anyway."""
    problem = "problem"
    """Can't be added (see `reason`). Skipped."""


class ImportPaymentChoice(enum.StrEnum):
    auto = "auto"
    """What the status says: add `ready` rows, keep `needs_student` and `unassigned` rows as
    unassigned, and let `follows_student` rows follow their student."""
    student = "student"
    """Give it to `student_id`."""
    unassigned = "unassigned"
    """Keep it as unassigned."""
    skip = "skip"
    """Don't add it."""
    add = "add"
    """Add it anyway, even though it looks like a duplicate (two instalments on one day)."""


class ImportFee(_Model):
    """One row of a student's fee history, from the file's Fee history sheet."""

    effective_month: Month
    amount_paise: FeePaise
    kind: FeeKind = FeeKind.fee


MAX_IMPORT_ROWS = 300_000
MAX_UPLOAD_BASE64 = (5 * 1024 * 1024 * 4) // 3 + 8  # a 5 MB file, base64-encoded


class ImportStudent(_Model):
    """An uploaded student row, read and checked like `StudentCreate`."""

    row: int = Field(ge=1, description="Its row number in the file's sheet.")
    ref: ShortText = Field(
        default=None, description="The file's Student ID, which links its fee history and payments."
    )
    name: Name
    phone: ShortText = None
    guardian_name: ShortText = None
    batch_label: ShortText = None
    batch_name: ShortText = Field(
        default=None, description="The file's Batch (or Class/batch) column: a batch's name."
    )
    notes: LongText = None
    joined_month: Month
    left_month: Month | None = None
    monthly_fee_paise: FeePaise
    fees: list[ImportFee] | None = Field(
        default=None,
        max_length=1200,
        description="Their fee history from the file, oldest first, restored exactly. Without "
        "it they get `monthly_fee_paise` from `joined_month`.",
    )

    @field_validator("left_month")
    @classmethod
    def _left_not_before_joined(cls, value: str | None, info: ValidationInfo) -> str | None:
        return _check_left_month(value, info.data.get("joined_month"))


class ImportPayment(_Model):
    """An uploaded payment row, read and checked like `PaymentCreate`."""

    row: int = Field(ge=1, description="Its row number in the file's sheet.")
    student_text: Name = Field(description="The student as written in the file.")
    phone: ShortText = None
    student_ref: ShortText = Field(
        default=None, description="The file's Student ID, from a Download everything file."
    )
    amount_paise: PaymentAmountPaise
    paid_on: dt.date
    for_month: Month
    method: PaymentMethod
    note: LongText = None
    unassigned: bool = Field(
        default=False, description="From the file's Unassigned payments sheet."
    )
    source: ShortText = Field(default=None, description="An unassigned payment's Came from.")
    sheet: str = Field(default="", max_length=200, description="The sheet it's on.")


class ImportStudentPreview(_ReadModel):
    row: int
    sheet: str
    name: str = Field(description="As written (may be blank for a problem row).")
    phone: str | None
    monthly_fee_paise: int | None
    joined_month: Month | None
    status: ImportStudentStatus
    reason: str | None = Field(description="Why, in plain words (not for `new`).")
    student_id: int | None = Field(
        description="The student already here that it is (`exists`) or looks like (`similar`)."
    )
    add_by_default: bool = Field(
        description="`similar` only: added unless the owner says Skip (a brother or sister "
        "sharing a phone with an earlier row of the file)."
    )
    batch_name: str | None = Field(
        default=None, description="Their batch, as written in the file's Batch column."
    )


class ImportBatchStatus(enum.StrEnum):
    """What an uploaded file's batch (a Batches sheet row, or a name in the students' Batch
    column) would do."""

    new = "new"
    """On the file's Batches sheet, and not here yet: will be added, with its details."""
    exists = "exists"
    """Already here (same name, ignoring capitals and spaces): its students go into it. The
    batch itself is left as it is."""
    not_found = "not_found"
    """Only named in the Batch column, and not here: those students are left without a batch
    (the name is kept in their old class label, next to any label the row has), unless the
    owner chooses to create it (only offered when a student being added names it)."""
    problem = "problem"
    """A Batches sheet row that can't be added (see `reason`)."""


class ImportBatchPreview(_ReadModel):
    name: str
    status: ImportBatchStatus
    reason: str | None = Field(description="Why, in plain words (not for `new` or `exists`).")
    row: int | None = Field(description="Its row on the Batches sheet, if it's there.")
    student_count: int = Field(
        ge=0,
        description="Student rows naming it that will be added (not those already here, "
        "skipped or with a problem). A `not_found` batch with 0 can't be created.",
    )
    batch_id: int | None = Field(description="`exists`: the batch already here.")


class ImportPaymentPreview(_ReadModel):
    row: int
    sheet: str
    student_text: str = Field(description="The student as written.")
    amount_paise: int | None
    paid_on: dt.date | None
    for_month: Month | None
    method: PaymentMethod | None
    note: str | None
    status: ImportPaymentStatus
    reason: str | None
    student_id: int | None = Field(description="`ready`: the student already here it goes to.")
    student_row: int | None = Field(
        description="`ready` or `follows_student`: the row of the student in this file it goes to."
    )
    candidate_ids: list[int] = Field(
        description="`needs_student`: students it may be, best first, to offer first."
    )


class ImportPreview(_ReadModel):
    """What adding an uploaded file would do. Nothing has been saved."""

    filename: str | None
    sheets: list[str] = Field(description="The sheets that were read.")
    ignored_sheets: list[str] = Field(description="Sheets that weren't students or payments.")
    hidden_sheets: list[str] = Field(description="Hidden sheets, which are never read.")
    students: list[ImportStudentPreview] = Field(
        description="Every row that needs a choice (`similar`), and the first rows of each other "
        "status (all of them unless `all_rows_shown` is false)."
    )
    payments: list[ImportPaymentPreview] = Field(
        description="Every row that needs a choice (`needs_student`, `follows_student`, "
        "`possible_duplicate`), and the first rows of each other status."
    )
    student_counts: dict[str, int] = Field(description="How many student rows have each status.")
    payment_counts: dict[str, int] = Field(description="How many payment rows have each status.")
    all_rows_shown: bool = Field(
        description="False for a long file: some rows that need no choice aren't listed, only "
        "counted."
    )
    fee_changes: int = Field(
        ge=0, description="Fee-history rows that come with the new students (restored exactly)."
    )
    batches: list[ImportBatchPreview] = Field(
        default_factory=list,
        description="Every batch the file names (its Batches sheet, and the students' Batch "
        "column), by name.",
    )
    current_month: Month
    file_sha256: str = Field(
        description="The SHA-256 of the file previewed (hex). Add sends it back: the file sent "
        "with Add must be this very file."
    )


class ImportStudentDecision(_Model):
    row: int = Field(ge=1, description="The student's row in the file's students sheet.")
    add: bool = Field(
        description="`true` adds a `similar` row as a new student; `false` skips any row."
    )


class ImportPaymentDecision(_Model):
    sheet: str = Field(max_length=200, description="The payment's sheet, as in the preview.")
    row: int = Field(ge=1)
    choice: ImportPaymentChoice = ImportPaymentChoice.auto
    student_id: int | None = Field(default=None, gt=0, strict=True)

    @model_validator(mode="after")
    def _student_for_choice(self) -> ImportPaymentDecision:
        if self.student_id is None and self.choice is ImportPaymentChoice.student:
            raise ValueError("Choose a student")
        return self


class ImportCommit(_Model):
    """The same file again, and the owner's choices (only for the rows she chose something
    for; every other row does what its status says). The file is read and every row checked
    again, against the records as they are now, before anything is added."""

    file: str = Field(
        max_length=MAX_UPLOAD_BASE64,
        description="The .xlsx file, base64-encoded (at most 5 MB before encoding).",
    )
    file_sha256: str = Field(
        pattern=r"^[0-9a-f]{64}$",
        description="The preview's `file_sha256`: Add is refused if the file isn't the one "
        "previewed.",
    )
    filename: ShortText = None
    students: list[ImportStudentDecision] = Field(default=[], max_length=MAX_IMPORT_ROWS)
    payments: list[ImportPaymentDecision] = Field(default=[], max_length=MAX_IMPORT_ROWS)
    create_batches: list[Annotated[str, Field(max_length=200)]] = Field(
        default=[],
        max_length=10_000,
        description="Batches the preview said `not_found` that the owner chose to create (by "
        "name, as in the preview). Any other not-found batch is never created.",
    )


class ImportResult(_ReadModel):
    students_added: int = Field(ge=0)
    fee_changes_added: int = Field(
        ge=0, description="Fee-history rows added with the new students, first fees included."
    )
    payments_added: int = Field(ge=0)
    unassigned_added: int = Field(ge=0)
    skipped: int = Field(ge=0, description="Rows not added (already here, problems, skipped).")
    batches_added: int = Field(default=0, ge=0, description="Batches created.")
    backup_file: str | None = Field(
        description="The backup taken first (records-pre-import-…), or null if nothing was added."
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
        "them first (GET /batches/{id}/fee-plan), so exactly those change.",
    )
    confirm_planned: list[Annotated[int, Field(gt=0, strict=True)]] = Field(
        default_factory=list,
        max_length=5000,
        description="Of student_ids, those with a fee change of their own from the start month "
        "on (status `planned`) that the owner ticked anyway. Any other such student is a 422.",
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
    left_student_names: list[str] = Field(
        description="Those of student_names whose last month has passed (they have left)."
    )
    active_student_count: int = Field(
        ge=0, description="Those still coming. 0: the batch would have nobody coming now."
    )
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


class FeePlanStatus(enum.StrEnum):
    """What "Also charge the new usual fee" would do to one student (`GET /batches/{id}/fee-plan`).

    - `usual`: every month that would change has the usual fee (the batch's old one, or the
      most common one if it had none): ticked at first.
    - `own_fee`: those months have a fee of their own (a discount, a free place): not ticked.
    - `planned` (shown as "has its own fee change"): a fee change of theirs from the start
      month on, set earlier (a discount for July and August, a month off, the fee they came
      back on) or planned for a later month; the new fee would end at it, or replace it. Not
      ticked at first, and only changed with `confirm_planned`.
    - `already`: they'd already pay it from that month: nothing changes.
    - `not_affected`: they leave before it would start: nothing changes.
    """

    usual = "usual"
    own_fee = "own_fee"
    planned = "planned"
    already = "already"
    not_affected = "not_affected"


class FeePlanStudent(_ReadModel):
    student_id: int
    student_name: str
    current_fee_paise: NonNegativePaise = Field(description="Their fee this month.")
    start_month: Month | None = Field(
        description="The month the new fee would start for them (their joining month if later; "
        "the month they came back if the chosen month is one of their months away). Null if "
        "they leave before it."
    )
    status: FeePlanStatus
    selected: bool = Field(description="Ticked at first (status `usual`).")
    due_months: int = Field(
        ge=0, description="Months already due (up to the current month) whose fee would change."
    )
    due_change_paise: SignedPaise = Field(
        description="How much more those months would owe in total (less, if below 0)."
    )
    fee_history: list[FeeChangeRead] = Field(
        description="Their fee changes, oldest first, so the UI can say how long it would last."
    )


class FeePlan(_ReadModel):
    batch_id: int
    fee_paise: NonNegativePaise
    from_month: Month
    current_month: Month
    usual_fee_paise: NonNegativePaise | None = Field(
        description="The fee counted as the usual one: the batch's usual fee, or if it has "
        "none, the fee most of its students pay (null on a tie)."
    )
    students: list[FeePlanStudent] = Field(description="Everyone in it who hasn't left, A to Z.")


class MoveStudents(_Model):
    """Put students in a batch (or none) at once. Their fees don't change."""

    student_ids: list[Annotated[int, Field(gt=0, strict=True)]] = Field(
        min_length=1, max_length=5000
    )
    batch_id: BatchId | None = Field(description="The batch, or null for no batch.")


class MoveResult(_ReadModel):
    moved: int = Field(ge=0)


# --------------------------------------------------------------------------- about / feedback


class AboutResponse(_ReadModel):
    """Settings → About: which version this is, and where the data lives."""

    version: str = Field(examples=["0.1.0"])
    build_id: str = Field(
        description="The git commit the app was built from (or 'unknown').",
        examples=["9386553c1482655b37649a823a653f113dfd26b4"],
    )
    data_dir: str = Field(description="The folder holding records.db.")
    backup_dir: str = Field(description="Where the daily backups go.")
    log_dir: str = Field(description="The folder holding server.log.")
    feedback_sending: bool = Field(
        description="Whether this copy sends feedback (a relay URL is set)."
    )
    feedback_waiting: int = Field(ge=0, description="Feedback saved here, not sent yet.")


SCREENSHOT_MAX_BYTES = 700_000
"""The biggest picture of the screen feedback may carry: the same as the dialog's limit, which
keeps the relay's work per request well inside Cloudflare's free-plan CPU limit. The dialog
shrinks the picture to fit; a bigger one is a 422."""
_SCREENSHOT_MAX_CHARS = 4 * ((SCREENSHOT_MAX_BYTES + 2) // 3) + 64  # base64, plus a data: prefix
_IMAGE_SIGNATURES = {b"\xff\xd8\xff": "image/jpeg", b"\x89PNG\r\n\x1a\n": "image/png"}


def screenshot_type(data: bytes) -> str | None:
    """ "image/jpeg" or "image/png" from the file's first bytes, or None for anything else."""
    for signature, content_type in _IMAGE_SIGNATURES.items():
        if data.startswith(signature):
            return content_type
    return None


def decode_screenshot(value: str) -> bytes:
    """The picture's bytes, from base64 (optionally a `data:image/...;base64,` URL)."""
    if value.startswith("data:"):
        value = value.partition(",")[2]
    return base64.b64decode(value, validate=True)


def _clip(limit: int):  # type: ignore[no-untyped-def]
    """Diagnostics are best effort: text that is too long is cut, and characters that can't be
    saved become "?", instead of refusing the owner's feedback."""

    def clip(value: object) -> object:
        if not isinstance(value, str):
            return value
        value = value.encode("utf-8", "replace").decode("utf-8")
        value = "".join(
            "?" if unicodedata.category(c) == "Cc" and c not in _ALLOWED_CONTROL else c
            for c in value
        )
        return value[:limit]

    return BeforeValidator(clip)


def _last(limit: int):  # type: ignore[no-untyped-def]
    def last(value: object) -> object:
        return value[-limit:] if isinstance(value, list) else value

    return BeforeValidator(last)


class FeedbackClientError(_Model):
    """One entry of the browser's recent-errors list (a script error, or an API call that
    failed)."""

    at: Annotated[str, _clip(40)] = ""
    kind: Annotated[str, _clip(20)] = ""
    message: Annotated[str, _clip(1000)] = ""


class FeedbackClientInfo(_Model):
    """What the browser knows: when and where, and the last errors it saw."""

    local_time: Annotated[str, _clip(64)] = Field("", description="The laptop's local time.")
    timezone: Annotated[str, _clip(64)] = ""
    language: Annotated[str, _clip(32)] = ""
    user_agent: Annotated[str, _clip(500)] = ""
    screen: Annotated[str, _clip(32)] = Field("", examples=["1440x900"])
    window: Annotated[str, _clip(32)] = Field("", examples=["1280x800"])
    ui_build: Annotated[str, _clip(64)] = Field("", description="The build ID the UI was built at.")
    errors: Annotated[list[FeedbackClientError], _last(20)] = Field(
        default_factory=list, description="The last errors (at most 20; older ones are dropped)."
    )


def _path_only(value: str) -> str:
    return value.split("?")[0].split("#")[0]


def _message_required(value: str) -> str:
    if not value:
        raise _field_error("Please write a message")
    return value


def _valid_screenshot(value: str | None) -> str | None:
    if value is None:
        return None
    try:
        data = decode_screenshot(value)
    except (binascii.Error, ValueError):
        raise _field_error("The picture of the screen couldn't be read") from None
    if screenshot_type(data) is None:
        raise _field_error("The picture of the screen couldn't be read")
    if len(data) > SCREENSHOT_MAX_BYTES:
        raise _field_error("The picture of the screen is too big to send")
    return value


class FeedbackCreate(_Model):
    id: uuid.UUID | None = Field(
        None,
        description="Made by the dialog when it opens. Sending the same id again returns the "
        "feedback already saved (a double click saves it once). The server makes one if absent.",
    )
    category: FeedbackCategory
    message: Annotated[
        str,
        BeforeValidator(_strip),
        AfterValidator(_message_required),
        Field(max_length=5000, description="What the owner wrote. Required."),
    ]
    route: Annotated[str, _clip(500), AfterValidator(_path_only)] = Field(
        "",
        description="The page it was sent from: the path only. A query or #fragment (a search "
        "could hold a name) is dropped.",
        examples=["/students"],
    )
    client: FeedbackClientInfo = Field(default_factory=FeedbackClientInfo)
    screenshot: Annotated[
        Annotated[str, Field(max_length=_SCREENSHOT_MAX_CHARS)] | None,
        AfterValidator(_valid_screenshot),
    ] = Field(
        None,
        description="A JPEG or PNG of the page, base64 (a data: URL is fine), at most "
        f"{SCREENSHOT_MAX_BYTES} bytes.",
    )


class FeedbackRead(_ReadModel):
    id: str
    category: FeedbackCategory
    status: FeedbackStatus
    created_at: UtcDatetime
    sent_at: UtcDatetime | None
    attempts: int = Field(ge=0, description="How many times sending was tried.")
    sending: bool = Field(
        description="Whether this copy is trying to send it (sending is on and it isn't done). "
        "If false and still pending, it waits for a version that sends."
    )
