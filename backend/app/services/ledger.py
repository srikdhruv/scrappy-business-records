"""The ledger rules: every number the app shows comes from here.

Pure functions only. No database, no clock, no I/O. The caller passes in plain dataclasses and
the *current month* explicitly, so every rule can be unit-tested with fixed inputs.

The rules are the PRD's "Ledger rules" and "Dashboard for a selected month M"
(docs/product/prd.md). In short:

1. A student is **active** in month m if `joined_month <= m` and (no `left_month` or
   `m <= left_month`). The left month is the last month they owe.
2. **Expected** for an active month is the fee in effect (the fee change with the greatest
   `effective_month <= m`; 0 if there is none). For an inactive month it is 0.
3. **Paid** is the sum of the payments whose `for_month` is m.
4. **Status**: Paid (paid = expected > 0), Partial (0 < paid < expected), Unpaid (paid = 0 <
   expected), Overpaid (paid > expected), Not applicable (expected = paid = 0).
5. Only months up to and including the current month are **due**. Payments for later months are
   "paid ahead": they never appear in the overpaid or backlog lists.
6. **Balance** = all payments - expected for every active month up to the current month.

All amounts are integer paise. All months are first-of-month `datetime.date`s.
"""

from __future__ import annotations

import bisect
import datetime as dt
from collections import defaultdict
from collections.abc import Iterable, Mapping
from dataclasses import dataclass
from functools import cached_property

from app.months import add_months, first_of_month, month_range
from app.schemas import BalanceStatus, MonthStatus, SuggestionReason
from app.services.text import fold

__all__ = [
    "BacklogEntry",
    "Dashboard",
    "DashboardSummary",
    "FeeChange",
    "MonthLine",
    "OverpaidEntry",
    "Payment",
    "StudentLedger",
    "StudentRecord",
    "Suggestion",
    "YetToPayEntry",
    "balance_status",
    "build_dashboard",
    "credit",
    "has_left",
    "month_status",
    "student_ledger",
    "suggest_payment",
    "tenure_months",
]

# --------------------------------------------------------------------------- inputs


@dataclass(frozen=True, slots=True)
class FeeChange:
    effective_month: dt.date
    amount_paise: int


@dataclass(frozen=True, slots=True)
class Payment:
    for_month: dt.date
    amount_paise: int


@dataclass(frozen=True)
class StudentRecord:
    """Everything the ledger needs to know about one student."""

    id: int
    name: str
    joined_month: dt.date
    left_month: dt.date | None = None
    fee_changes: tuple[FeeChange, ...] = ()
    payments: tuple[Payment, ...] = ()
    batch_label: str | None = None
    phone: str | None = None

    def is_active(self, month: dt.date) -> bool:
        """Rule 1. The left month is inclusive: it is the last month they owe."""
        return self.joined_month <= month and (self.left_month is None or month <= self.left_month)

    def fee_in_effect(self, month: dt.date) -> int:
        """The fee from the latest fee change on or before `month`, or 0 if there is none.

        This ignores whether the student is active; see `expected`.
        """
        i = bisect.bisect_right(self._fee_months, month)
        return self._fee_amounts[i - 1] if i else 0

    def expected(self, month: dt.date) -> int:
        """Rule 2: the fee in effect for an active month, 0 for an inactive one."""
        return self.fee_in_effect(month) if self.is_active(month) else 0

    def paid(self, month: dt.date) -> int:
        """Rule 3: the sum of payments for `month`."""
        return self.paid_by_month.get(month, 0)

    @cached_property
    def paid_by_month(self) -> Mapping[dt.date, int]:
        totals: dict[dt.date, int] = defaultdict(int)
        for p in self.payments:
            totals[p.for_month] += p.amount_paise
        return dict(totals)

    @cached_property
    def _sorted_fees(self) -> tuple[FeeChange, ...]:
        return tuple(sorted(self.fee_changes, key=lambda f: f.effective_month))

    @cached_property
    def _fee_months(self) -> list[dt.date]:
        return [f.effective_month for f in self._sorted_fees]

    @cached_property
    def _fee_amounts(self) -> list[int]:
        return [f.amount_paise for f in self._sorted_fees]


# --------------------------------------------------------------------------- outputs


@dataclass(frozen=True, slots=True)
class MonthLine:
    """One student, one month."""

    month: dt.date
    expected_paise: int
    paid_paise: int
    status: MonthStatus
    is_due: bool

    @property
    def remaining_paise(self) -> int:
        return max(0, self.expected_paise - self.paid_paise)

    @property
    def excess_paise(self) -> int:
        return max(0, self.paid_paise - self.expected_paise)

    @property
    def is_owing(self) -> bool:
        """Unpaid or Partial."""
        return self.status in (MonthStatus.unpaid, MonthStatus.partial)


@dataclass(frozen=True, slots=True)
class Suggestion:
    """See `suggest_payment`. Month and amount are None when nothing is left to pay; the amount
    is also None for a month whose fee is 0."""

    reason: SuggestionReason
    for_month: dt.date | None = None
    amount_paise: int | None = None


@dataclass(frozen=True)
class StudentLedger:
    """A student's standing as of the current month."""

    student: StudentRecord
    current_month: dt.date
    months: tuple[MonthLine, ...]
    """History: see `history_range`."""
    is_active: bool
    """False once the left month has passed (see `has_left`)."""
    balance_paise: int
    status: BalanceStatus
    credit_paise: int
    """See `credit`."""
    tenure_months: int
    """See `tenure_months`."""
    monthly_fee_paise: int
    total_paid_paise: int
    payment_count: int
    suggestion: Suggestion


@dataclass(frozen=True, slots=True)
class DashboardSummary:
    expected_paise: int
    collected_paise: int
    still_due_paise: int
    not_fully_paid_count: int
    active_student_count: int


@dataclass(frozen=True, slots=True)
class YetToPayEntry:
    student: StudentRecord
    line: MonthLine
    credit_paise: int
    """The student's `credit` (money in overpaid due months)."""


@dataclass(frozen=True, slots=True)
class BacklogEntry:
    student: StudentRecord
    lines: tuple[MonthLine, ...]
    """Unpaid or Partial months, oldest first."""
    credit_paise: int
    """The student's `credit` (money in overpaid due months)."""

    @property
    def total_owed_paise(self) -> int:
        return sum(line.remaining_paise for line in self.lines)


@dataclass(frozen=True, slots=True)
class OverpaidEntry:
    student: StudentRecord
    line: MonthLine


@dataclass(frozen=True)
class Dashboard:
    month: dt.date
    summary: DashboardSummary
    yet_to_pay: tuple[YetToPayEntry, ...]
    backlog: tuple[BacklogEntry, ...]
    overpaid: tuple[OverpaidEntry, ...]


# --------------------------------------------------------------------------- single rules


def month_status(expected_paise: int, paid_paise: int) -> MonthStatus:
    """Rule 4."""
    if paid_paise > expected_paise:
        return MonthStatus.overpaid
    if expected_paise == 0:
        return MonthStatus.not_applicable  # and paid == 0
    if paid_paise == expected_paise:
        return MonthStatus.paid
    if paid_paise == 0:
        return MonthStatus.unpaid
    return MonthStatus.partial


def balance_status(balance_paise: int) -> BalanceStatus:
    """Rule 6: negative owes, positive is credit, zero is up to date."""
    if balance_paise < 0:
        return BalanceStatus.owes
    if balance_paise > 0:
        return BalanceStatus.credit
    return BalanceStatus.up_to_date


def month_line(student: StudentRecord, month: dt.date, current_month: dt.date) -> MonthLine:
    month = first_of_month(month)
    expected = student.expected(month)
    paid = student.paid(month)
    return MonthLine(
        month=month,
        expected_paise=expected,
        paid_paise=paid,
        status=month_status(expected, paid),
        is_due=month <= current_month,
    )


def due_months(student: StudentRecord, current_month: dt.date) -> list[dt.date]:
    """Active months up to and including the current month (rules 1 and 5)."""
    last = current_month if student.left_month is None else min(current_month, student.left_month)
    return month_range(student.joined_month, last) if student.joined_month <= last else []


def expected_to_date(student: StudentRecord, current_month: dt.date) -> int:
    """Everything expected from the student up to and including the current month."""
    return sum(student.expected(m) for m in due_months(student, current_month))


def balance(student: StudentRecord, current_month: dt.date) -> int:
    """Rule 6: all payments (including paid-ahead ones) minus everything due so far."""
    return sum(p.amount_paise for p in student.payments) - expected_to_date(student, current_month)


def credit(student: StudentRecord, current_month: dt.date) -> int:
    """Money in overpaid months: the sum of max(0, paid - expected) over months up to and
    including the current month. That includes payments for months the student isn't active
    in. Payments for later months are "paid ahead", not credit."""
    return sum(
        max(0, paid - student.expected(m))
        for m, paid in student.paid_by_month.items()
        if m <= current_month
    )


def tenure_months(student: StudentRecord, current_month: dt.date) -> int:
    """How many months they have been a student: `joined_month` up to the current month (or
    `left_month`, if earlier), counting both. 0 if they haven't joined yet."""
    return len(due_months(student, current_month))


def history_range(student: StudentRecord, current_month: dt.date) -> list[dt.date]:
    """The months shown on a student's profile, oldest first.

    From `joined_month` (or the earliest month with a payment, if earlier) through the latest of
    the current month, the latest month with a payment and `joined_month`. That includes months
    outside the active range that have payments, and a future joining month.
    """
    paid_months = student.paid_by_month.keys()
    start = min([student.joined_month, *paid_months])
    end = max([current_month, student.joined_month, *paid_months])
    return month_range(start, end)


def current_fee(student: StudentRecord, current_month: dt.date) -> int:
    """The fee shown as the student's monthly fee: the one in effect this month, or in their
    joining month if they haven't joined yet."""
    return student.fee_in_effect(max(current_month, student.joined_month))


def has_left(student: StudentRecord, current_month: dt.date) -> bool:
    """True once the student's left month has passed: they show as Left rather than Active.

    A student leaving after December is still Active in December, and Left from January.
    """
    return student.left_month is not None and student.left_month < current_month


def suggest_payment(student: StudentRecord, current_month: dt.date) -> Suggestion:
    """Prefill for the Log payment form (PRD ledger rule 9). It never suggests a month that is
    already fully paid, or one outside the months the student is enrolled in.

    1. `owed`: the oldest due month (up to the current month) that is Unpaid or Partial, with
       what's left on it.
    2. `next_unpaid`: otherwise the first enrolled month after the current month that isn't
       paid yet (Unpaid, Partial, or a 0 fee with nothing paid), with what's left on it: usually
       next month, or the month after what they've paid ahead. The amount is None if the fee
       for that month is 0.
    3. `all_paid`: nothing is left in the enrolled months (they have left and paid up).
    """
    for m in due_months(student, current_month):
        line = month_line(student, m, current_month)
        if line.is_owing:
            return Suggestion(SuggestionReason.owed, m, line.remaining_paise)

    start = max(add_months(current_month, 1), student.joined_month)
    if student.left_month is not None:
        end = student.left_month
    else:
        # The month after the last paid one has nothing paid, so the search always ends.
        end = max(start, add_months(max(student.paid_by_month, default=start), 1))
    for m in month_range(start, end) if start <= end else []:
        line = month_line(student, m, current_month)
        if line.is_owing or line.status is MonthStatus.not_applicable:
            return Suggestion(SuggestionReason.next_unpaid, m, line.remaining_paise or None)
    return Suggestion(SuggestionReason.all_paid)


def student_ledger(student: StudentRecord, current_month: dt.date) -> StudentLedger:
    """Everything the student list and profile show about one student."""
    current_month = first_of_month(current_month)
    bal = balance(student, current_month)
    return StudentLedger(
        student=student,
        current_month=current_month,
        months=tuple(
            month_line(student, m, current_month) for m in history_range(student, current_month)
        ),
        is_active=not has_left(student, current_month),
        balance_paise=bal,
        status=balance_status(bal),
        credit_paise=credit(student, current_month),
        tenure_months=tenure_months(student, current_month),
        monthly_fee_paise=current_fee(student, current_month),
        total_paid_paise=sum(p.amount_paise for p in student.payments),
        payment_count=len(student.payments),
        suggestion=suggest_payment(student, current_month),
    )


# --------------------------------------------------------------------------- dashboard


def _sort_key(student: StudentRecord) -> tuple[str, int]:
    return (fold(student.name), student.id)


def build_dashboard(
    students: Iterable[StudentRecord], month: dt.date, current_month: dt.date
) -> Dashboard:
    """The dashboard for month M (PRD "Dashboard for a selected month M").

    - **Summary**: expected for M from students active in M; collected = every payment for M;
      still due = sum of max(0, expected - paid) over students active in M; the number of
      students who are Unpaid or Partial for M; the number of students active in M.
    - **Yet to pay**: students active in M who are Unpaid or Partial for M. For a future M this
      is who hasn't paid ahead yet.
    - **Backlog**: students with Unpaid or Partial months before M. Only due months count
      (rule 5), so for a future M it stops at the current month.
    - **Overpaid**: student-months up to M with paid > expected. Only due months count, so
      payments made ahead never show here.

    Lists are sorted by student name (ignoring case and accents); overpaid months are oldest
    first within a student. Yet-to-pay and backlog entries carry the student's `credit`.
    """
    month = first_of_month(month)
    current_month = first_of_month(current_month)
    ordered = sorted(students, key=_sort_key)

    expected_total = collected = still_due = active_count = 0
    yet_to_pay: list[YetToPayEntry] = []
    backlog: list[BacklogEntry] = []
    overpaid: list[OverpaidEntry] = []

    backlog_end = min(add_months(month, -1), current_month)
    overpaid_end = min(month, current_month)

    for s in ordered:
        line = month_line(s, month, current_month)
        collected += line.paid_paise
        if s.is_active(month):
            active_count += 1
            expected_total += line.expected_paise
            still_due += line.remaining_paise
            if line.is_owing:
                yet_to_pay.append(YetToPayEntry(s, line, credit(s, current_month)))

        owing = tuple(
            ml
            for m in due_months(s, backlog_end)
            if (ml := month_line(s, m, current_month)).is_owing
        )
        if owing:
            backlog.append(BacklogEntry(s, owing, credit(s, current_month)))

        for m in sorted(s.paid_by_month):
            if m > overpaid_end:
                break
            ml = month_line(s, m, current_month)
            if ml.status is MonthStatus.overpaid:
                overpaid.append(OverpaidEntry(s, ml))

    return Dashboard(
        month=month,
        summary=DashboardSummary(
            expected_paise=expected_total,
            collected_paise=collected,
            still_due_paise=still_due,
            not_fully_paid_count=len(yet_to_pay),
            active_student_count=active_count,
        ),
        yet_to_pay=tuple(yet_to_pay),
        backlog=tuple(backlog),
        overpaid=tuple(overpaid),
    )
