"""The ledger rules: every number the app shows comes from here.

Pure functions only. No database, no clock, no I/O. The caller passes in plain dataclasses and
the *current month* explicitly, so every rule can be unit-tested with fixed inputs.

The rules are the PRD's "Ledger rules" and "Dashboard for a selected month M"
(docs/product/prd.md). In short:

1. A student is **active** in month m if `joined_month <= m` and (no `left_month` or
   `m <= left_month`). The left month is the last month they owe.
2. **Expected** for an active month is the fee in effect (the fee change with the greatest
   `effective_month <= m`; 0 if there is none). For an inactive month it is 0.
3. **Paid** is the sum of the payments whose `for_month` is m, exactly as typed.
4. **Extra money covers unpaid months** (`allocate`). Computed, never stored: payments stay as
   typed. Pass 1: each payment, in `(paid_on, id)` order, pays its own month up to what's left
   of that month's fee. Pass 2: each payment's leftover, in the same order, pays the oldest
   months still not fully paid: due months (up to the current month) first, then later
   months ("paid ahead"), up to `left_month` or `MONTHS_AHEAD` months ahead. Months with a 0
   fee are skipped. Whatever is still left is **credit**.
5. **Status** of a month counts what's paid for it directly plus what extra money covers:
   Paid, Partial, Unpaid, Overpaid (some of this month's money is credit: no month needed it),
   Not applicable (fee 0 and no credit left in it).
6. Only months up to and including the current month are **due**. What covers a later month
   is "paid ahead".
7. **Owed** = what's left on due months after (4). **Balance** (net, for reference) = all
   payments - expected for every active month up to the current month.

All amounts are integer paise. All months are first-of-month `datetime.date`s.
"""

from __future__ import annotations

import bisect
import datetime as dt
from collections import defaultdict
from collections.abc import Iterable, Mapping
from dataclasses import dataclass, field
from functools import cached_property

from app.months import add_months, first_of_month, month_range
from app.schemas import BalanceStatus, MonthStatus, ReportStatus, SuggestionReason
from app.services.text import fold, search_fold

__all__ = [
    "Allocation",
    "BacklogEntry",
    "CreditMove",
    "CreditMoveEntry",
    "CreditSource",
    "Dashboard",
    "DashboardSummary",
    "ExtraSent",
    "FeeChange",
    "MonthLine",
    "OverpaidEntry",
    "Payment",
    "PaymentUse",
    "Report",
    "ReportRow",
    "StudentLedger",
    "StudentRecord",
    "Suggestion",
    "YetToPayEntry",
    "allocate",
    "build_dashboard",
    "build_report",
    "credit",
    "has_left",
    "month_status",
    "months_ahead",
    "needs_check",
    "owed",
    "paid_ahead",
    "payment_uses",
    "pays_until",
    "report_status",
    "standing_status",
    "student_ledger",
    "suggest_payment",
    "tenure_months",
]

MONTHS_AHEAD = 24
"""Payments can be logged for at most this many months after the current month (see
app/services/bounds.py), so nothing later is ever suggested, and extra money never covers a
month later than this ("paid ahead" stops here)."""

CHECK_MONTHS_AHEAD = 4
"""A payment that pays this many months after the current one (or more) is worth a glance: see
`needs_check`."""

# --------------------------------------------------------------------------- inputs


@dataclass(frozen=True, slots=True)
class FeeChange:
    effective_month: dt.date
    amount_paise: int


@dataclass(frozen=True, slots=True)
class Payment:
    for_month: dt.date
    amount_paise: int
    paid_on: dt.date | None = None
    """When it was paid. Extra money is handed out in `(paid_on, id)` order; a payment with no
    date (only in tests) sorts as if paid on the first of its month."""
    id: int = 0

    @property
    def order_key(self) -> tuple[dt.date, int]:
        return (self.paid_on or self.for_month, self.id)


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
    batch_name: str | None = None
    _allocations: dict[dt.date, Allocation] = field(
        default_factory=dict, init=False, repr=False, compare=False
    )

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
        """Rule 3: the sum of payments for `month`, exactly as typed."""
        return self.paid_by_month.get(month, 0)

    def allocation(self, current_month: dt.date) -> Allocation:
        """Rule 4, worked out once per current month (see `allocate`)."""
        current_month = first_of_month(current_month)
        cached = self._allocations.get(current_month)
        if cached is None:
            cached = self._allocations[current_month] = allocate(self, current_month)
        return cached

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


# --------------------------------------------------------------------------- allocation


@dataclass(frozen=True, slots=True)
class CreditSource:
    """Extra money from one payment that covers (part of) another month."""

    payment_id: int
    paid_on: dt.date | None
    for_month: dt.date
    """The month the payment was logged for."""
    amount_paise: int


@dataclass(frozen=True, slots=True)
class ExtraSent:
    """Money paid above a month's fee that covers (part of) another month."""

    to_month: dt.date
    amount_paise: int


@dataclass(frozen=True, slots=True)
class CreditMove:
    """One payment's extra money covering one month (a `CreditSource` seen from both ends)."""

    payment: Payment
    to_month: dt.date
    amount_paise: int


@dataclass(frozen=True, slots=True)
class PaymentUse:
    """Where one payment's money went. `direct + Σ sent + unused = amount`."""

    payment: Payment
    direct_paise: int
    """The part that pays its own month (`for_month`), at most what was left of its fee."""
    sent: tuple[ExtraSent, ...]
    """The rest, covering other months, oldest month first."""
    unused_paise: int
    """What no month needed: credit."""


@dataclass(frozen=True)
class Allocation:
    """Rule 4 for one student and one current month. See `allocate`."""

    uses: tuple[PaymentUse, ...]
    """One per payment, in the same order as `StudentRecord.payments`."""
    moves: tuple[CreditMove, ...]
    """Every hand-out of extra money, in the order it happened."""

    @cached_property
    def direct_by_month(self) -> Mapping[dt.date, int]:
        totals: dict[dt.date, int] = defaultdict(int)
        for u in self.uses:
            totals[u.payment.for_month] += u.direct_paise
        return dict(totals)

    @cached_property
    def sources_by_month(self) -> Mapping[dt.date, tuple[CreditSource, ...]]:
        sources: dict[dt.date, list[CreditSource]] = defaultdict(list)
        for mv in self.moves:
            p = mv.payment
            sources[mv.to_month].append(CreditSource(p.id, p.paid_on, p.for_month, mv.amount_paise))
        return {m: tuple(v) for m, v in sources.items()}

    @cached_property
    def sent_by_month(self) -> Mapping[dt.date, tuple[ExtraSent, ...]]:
        """By the month the payments were logged for: where their extra went, one entry per
        month covered (payments for the same month added up), oldest month first."""
        sent: dict[dt.date, dict[dt.date, int]] = defaultdict(lambda: defaultdict(int))
        for mv in self.moves:
            sent[mv.payment.for_month][mv.to_month] += mv.amount_paise
        return {
            m: tuple(ExtraSent(to, amount) for to, amount in sorted(dests.items()))
            for m, dests in sent.items()
        }

    @cached_property
    def unused_by_month(self) -> Mapping[dt.date, int]:
        totals: dict[dt.date, int] = defaultdict(int)
        for u in self.uses:
            if u.unused_paise:
                totals[u.payment.for_month] += u.unused_paise
        return dict(totals)

    def covered_by_credit(self, month: dt.date) -> int:
        return sum(s.amount_paise for s in self.sources_by_month.get(month, ()))

    @property
    def last_covered_month(self) -> dt.date | None:
        return max(self.sources_by_month, default=None)


def allocation_months(student: StudentRecord, current_month: dt.date) -> list[dt.date]:
    """The months extra money can cover, oldest first: every enrolled month with a fee, up to
    `left_month` or `MONTHS_AHEAD` months after the current month. Being in date order, the due
    months (up to the current month) come before the later ones ("paid ahead")."""
    last = add_months(current_month, MONTHS_AHEAD)
    if student.left_month is not None:
        last = min(last, student.left_month)
    if student.joined_month > last:
        return []
    return [m for m in month_range(student.joined_month, last) if student.expected(m) > 0]


def allocate(student: StudentRecord, current_month: dt.date) -> Allocation:
    """Rule 4: where every payment's money goes. Pure and deterministic; never stored.

    Payments are taken in `(paid_on, id)` order (ties keep their order in `payments`).

    - **Pass 1.** Each payment pays its own month (`for_month`), up to what's still left of
      that month's fee. A month the student isn't enrolled in, or with a 0 fee, takes nothing.
    - **Pass 2.** Each payment's leftover, in the same order, pays the oldest month that isn't
      fully paid yet among `allocation_months`: the due months first (before *and* after the
      month it was logged for), then later months in order (paid ahead).
    - Whatever is still left is **credit** (`PaymentUse.unused_paise`).

    So `amount = direct + Σ sent + unused` for each payment, and no month is ever covered above
    its fee.
    """
    current_month = first_of_month(current_month)
    payments = student.payments
    order = sorted(range(len(payments)), key=lambda i: payments[i].order_key)
    covered: dict[dt.date, int] = defaultdict(int)
    direct = [0] * len(payments)
    for i in order:
        p = payments[i]
        use = min(p.amount_paise, max(0, student.expected(p.for_month) - covered[p.for_month]))
        covered[p.for_month] += use
        direct[i] = use

    targets = allocation_months(student, current_month)
    t = 0  # every month before targets[t] is full (covered only ever grows)
    sent: list[list[ExtraSent]] = [[] for _ in payments]
    unused = [0] * len(payments)
    moves: list[CreditMove] = []
    for i in order:
        p = payments[i]
        left = p.amount_paise - direct[i]
        while left > 0 and t < len(targets):
            m = targets[t]
            room = student.expected(m) - covered[m]
            if room <= 0:
                t += 1
                continue
            take = min(room, left)
            covered[m] += take
            left -= take
            sent[i].append(ExtraSent(m, take))
            moves.append(CreditMove(p, m, take))
        unused[i] = left

    return Allocation(
        uses=tuple(
            PaymentUse(p, direct[i], tuple(sent[i]), unused[i]) for i, p in enumerate(payments)
        ),
        moves=tuple(moves),
    )


def payment_uses(student: StudentRecord, current_month: dt.date) -> tuple[PaymentUse, ...]:
    """Where each payment's money went, in the order of `student.payments`."""
    return student.allocation(current_month).uses


def months_ahead(use: PaymentUse, current_month: dt.date) -> int:
    """How many months after the current one this payment pays (its own month, if it paid any
    of it, and the months its extra went to)."""
    months = {e.to_month for e in use.sent}
    if use.direct_paise:
        months.add(use.payment.for_month)
    return sum(1 for m in months if m > first_of_month(current_month))


def needs_check(use: PaymentUse, current_month: dt.date) -> bool:
    """A payment that may be a slip of the finger (an extra zero). Extra money quietly pays
    months ahead, so a typo would otherwise just look "paid ahead". Paying months owed (a
    catch-up, a top-up, a quarterly payment) is never flagged. Only when:

    - it pays `CHECK_MONTHS_AHEAD` or more months after the current one, or
    - some of it is kept as credit: no month needed it (this includes money logged for a month
      with no fee when nothing is owed).
    """
    return months_ahead(use, current_month) >= CHECK_MONTHS_AHEAD or use.unused_paise > 0


def pays_until(use: PaymentUse) -> dt.date:
    """The latest month this payment pays: its own month (if it paid any of it) or the last
    month its extra went to, whichever is later."""
    months = [e.to_month for e in use.sent]
    if use.direct_paise or not months:
        months.append(use.payment.for_month)
    return max(months)


# --------------------------------------------------------------------------- outputs


@dataclass(frozen=True, slots=True)
class MonthLine:
    """One student, one month, after extra money has been handed out (rule 4)."""

    month: dt.date
    expected_paise: int
    paid_paise: int
    """Everything logged for this month, exactly as typed."""
    status: MonthStatus
    is_due: bool
    paid_direct_paise: int = 0
    """The part of `paid_paise` that pays this month: at most its fee."""
    covered_by_credit_paise: int = 0
    """Extra money from payments logged for other months that pays this month."""
    credit_sources: tuple[CreditSource, ...] = ()
    extra_sent: tuple[ExtraSent, ...] = ()
    """Where the rest of `paid_paise` went, oldest month first."""
    extra_unused_paise: int = 0
    """What's left of `paid_paise` that no month needed: credit."""

    @property
    def counted_paise(self) -> int:
        """What pays this month: direct plus credit (never more than the fee)."""
        return self.paid_direct_paise + self.covered_by_credit_paise

    @property
    def remaining_paise(self) -> int:
        return max(0, self.expected_paise - self.counted_paise)

    @property
    def excess_paise(self) -> int:
        """What was logged for this month above its fee: sent elsewhere, or credit."""
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
    """The net balance. Kept for reference; the headline is `status` (see `standing_status`)."""
    status: BalanceStatus
    owed_paise: int
    """See `owed`."""
    credit_paise: int
    """See `credit`."""
    paid_ahead_paise: int
    """See `paid_ahead`."""
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
    """What pays M: Σ (direct + credit) over every student, whatever month it was logged for."""
    paid_ahead_paise: int
    """For a month after the current one: the same as `collected_paise`; otherwise 0."""
    still_due_paise: int
    not_fully_paid_count: int
    active_student_count: int
    logged_paise: int = 0
    """Every payment logged for M, as typed (the Payments page's total for M)."""
    covered_by_credit_paise: int = 0
    """The part of `collected_paise` that came from payments logged for other months."""
    sent_elsewhere_paise: int = 0
    """The part of `logged_paise` that paid other months. What's left of `logged_paise` after
    this and what pays M directly is kept as credit."""


@dataclass(frozen=True, slots=True)
class YetToPayEntry:
    student: StudentRecord
    line: MonthLine
    credit_paise: int
    """The student's `credit`. Almost always 0: credit is only what no month needed."""


@dataclass(frozen=True, slots=True)
class BacklogEntry:
    student: StudentRecord
    lines: tuple[MonthLine, ...]
    """Unpaid or Partial months, oldest first."""
    credit_paise: int
    """The student's `credit`. Almost always 0: credit is only what no month needed."""

    @property
    def total_owed_paise(self) -> int:
        return sum(line.remaining_paise for line in self.lines)


@dataclass(frozen=True, slots=True)
class OverpaidEntry:
    """A month with money that no month needed (`line.extra_unused_paise > 0`)."""

    student: StudentRecord
    line: MonthLine


@dataclass(frozen=True, slots=True)
class CreditMoveEntry:
    """Extra money from a payment logged for one month covering another, shown on M's
    dashboard because one of the two months is M."""

    student: StudentRecord
    move: CreditMove
    use: PaymentUse | None = None
    """Everything the payment did (so the dashboard can say "pays up to …")."""
    needs_check: bool = False
    """See `needs_check`."""


@dataclass(frozen=True)
class Dashboard:
    month: dt.date
    summary: DashboardSummary
    yet_to_pay: tuple[YetToPayEntry, ...]
    backlog: tuple[BacklogEntry, ...]
    overpaid: tuple[OverpaidEntry, ...]
    credit_moves: tuple[CreditMoveEntry, ...] = ()


# --------------------------------------------------------------------------- single rules


def month_status(expected_paise: int, paid_paise: int) -> MonthStatus:
    """Rule 5. `paid_paise` is what pays the month (direct + credit) plus any of its own money
    that no month needed, so `paid_paise > expected_paise` means some of it is credit."""
    if paid_paise > expected_paise:
        return MonthStatus.overpaid
    if expected_paise == 0:
        return MonthStatus.not_applicable  # and paid == 0
    if paid_paise == expected_paise:
        return MonthStatus.paid
    if paid_paise == 0:
        return MonthStatus.unpaid
    return MonthStatus.partial


def standing_status(owed_paise: int, credit_paise: int) -> BalanceStatus:
    """A student who still owes for any due month **owes**; otherwise money no month needed is
    **credit**; otherwise **up to date**. Paid ahead is neither (see `paid_ahead`)."""
    if owed_paise > 0:
        return BalanceStatus.owes
    if credit_paise > 0:
        return BalanceStatus.credit
    return BalanceStatus.up_to_date


def month_line(student: StudentRecord, month: dt.date, current_month: dt.date) -> MonthLine:
    month = first_of_month(month)
    current_month = first_of_month(current_month)
    alloc = student.allocation(current_month)
    expected = student.expected(month)
    direct = alloc.direct_by_month.get(month, 0)
    by_credit = alloc.covered_by_credit(month)
    unused = alloc.unused_by_month.get(month, 0)
    return MonthLine(
        month=month,
        expected_paise=expected,
        paid_paise=student.paid(month),
        status=month_status(expected, direct + by_credit + unused),
        is_due=month <= current_month,
        paid_direct_paise=direct,
        covered_by_credit_paise=by_credit,
        credit_sources=alloc.sources_by_month.get(month, ()),
        extra_sent=alloc.sent_by_month.get(month, ()),
        extra_unused_paise=unused,
    )


def due_months(student: StudentRecord, current_month: dt.date) -> list[dt.date]:
    """Active months up to and including the current month (rules 1 and 6)."""
    last = current_month if student.left_month is None else min(current_month, student.left_month)
    return month_range(student.joined_month, last) if student.joined_month <= last else []


def expected_to_date(student: StudentRecord, current_month: dt.date) -> int:
    """Everything expected from the student up to and including the current month."""
    return sum(student.expected(m) for m in due_months(student, current_month))


def balance(student: StudentRecord, current_month: dt.date) -> int:
    """The net: all payments (including paid-ahead ones) minus everything due so far."""
    return sum(p.amount_paise for p in student.payments) - expected_to_date(student, current_month)


def owed(student: StudentRecord, current_month: dt.date) -> int:
    """What's still owed: the sum of what's left on every due month (active months up to and
    including the current month) after extra money has covered what it can (rule 4)."""
    return sum(
        month_line(student, m, current_month).remaining_paise
        for m in due_months(student, current_month)
    )


def paid_ahead(student: StudentRecord, current_month: dt.date) -> int:
    """Money that pays months after the current month: what was logged for them, up to each
    fee, plus extra money from other payments that covers them (rule 4). Months after
    `left_month`, or with a 0 fee, never take any."""
    current_month = first_of_month(current_month)
    alloc = student.allocation(current_month)
    direct = sum(a for m, a in alloc.direct_by_month.items() if m > current_month)
    by_credit = sum(mv.amount_paise for mv in alloc.moves if mv.to_month > current_month)
    return direct + by_credit


def credit(student: StudentRecord, current_month: dt.date) -> int:
    """Money no month needed: what's left of every payment once it has paid its own month and
    covered every other month it could (rule 4). Only possible once every enrolled month with a
    fee, up to `left_month` or `MONTHS_AHEAD` ahead, is fully paid."""
    return sum(u.unused_paise for u in student.allocation(current_month).uses)


def tenure_months(student: StudentRecord, current_month: dt.date) -> int:
    """How long they have been (or were) a student, in months.

    - Still coming: whole months since joining, `current_month - joined_month`. Joined in
      August, now September: 1. 0 in the joining month, or if they haven't joined yet.
    - Left (`left_month` before the current month): the months they were enrolled, both ends
      counted, `left_month - joined_month + 1`. March to June: 4; joined and left in May: 1.
    """

    def months(a: dt.date, b: dt.date) -> int:
        return (b.year - a.year) * 12 + b.month - a.month

    if student.left_month is not None and student.left_month < current_month:
        return max(0, months(student.joined_month, student.left_month) + 1)
    return max(0, months(student.joined_month, current_month))


def history_range(student: StudentRecord, current_month: dt.date) -> list[dt.date]:
    """The months shown on a student's profile, oldest first.

    From `joined_month` (or the earliest month with a payment, if earlier) through the latest of
    the current month, the latest month with a payment, the latest month extra money covers
    and `joined_month`. That includes months outside the active range that have payments, a
    future joining month, and later months paid ahead with extra money.
    """
    paid_months = student.paid_by_month.keys()
    covered = student.allocation(current_month).last_covered_month
    start = min([student.joined_month, *paid_months])
    end = max([current_month, student.joined_month, *paid_months, *([covered] if covered else [])])
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
    already fully paid (by its own payments or by extra money), or one outside the months the
    student is enrolled in.

    1. `owed`: the oldest due month (up to the current month) that is Unpaid or Partial, with
       what's left on it.
    2. `next_unpaid`: otherwise the first enrolled month after the current month that has a
       fee and isn't fully paid (Unpaid or Partial), with what's left on it: usually next
       month, or the month after what they've paid ahead. Months with a 0 fee (a free place,
       or the months away before they came back) are skipped: nothing is ever due for them.
    3. `all_paid`: nothing is left in the enrolled months up to the latest month a payment
       can be logged for (`MONTHS_AHEAD` after the current month): they have left and paid
       up, paid that far ahead, or have no fee to pay.
    """
    for m in due_months(student, current_month):
        line = month_line(student, m, current_month)
        if line.is_owing:
            return Suggestion(SuggestionReason.owed, m, line.remaining_paise)

    start = max(add_months(current_month, 1), student.joined_month)
    end = add_months(current_month, MONTHS_AHEAD)  # never a month that can't be logged
    if student.left_month is not None:
        end = min(end, student.left_month)
    for m in month_range(start, end) if start <= end else []:
        line = month_line(student, m, current_month)
        if line.is_owing:  # a fee is due and isn't fully paid; 0-fee months never are
            return Suggestion(SuggestionReason.next_unpaid, m, line.remaining_paise)
    return Suggestion(SuggestionReason.all_paid)


def student_ledger(student: StudentRecord, current_month: dt.date) -> StudentLedger:
    """Everything the student list and profile show about one student."""
    current_month = first_of_month(current_month)
    owed_paise = owed(student, current_month)
    credit_paise = credit(student, current_month)
    return StudentLedger(
        student=student,
        current_month=current_month,
        months=tuple(
            month_line(student, m, current_month) for m in history_range(student, current_month)
        ),
        is_active=not has_left(student, current_month),
        balance_paise=balance(student, current_month),
        status=standing_status(owed_paise, credit_paise),
        owed_paise=owed_paise,
        credit_paise=credit_paise,
        paid_ahead_paise=paid_ahead(student, current_month),
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
    """The dashboard for month M (PRD "Dashboard for a selected month M"), after extra money
    has covered what it can (rule 4, worked out as of the current month, whichever M).

    - **Summary**: expected for M from students active in M; collected = what pays M (money
      logged for M, up to each fee, plus extra money from other payments covering M); still
      due = what's left on M, over students active in M; the number of students who are Unpaid
      or Partial for M; the number of students active in M with a fee above 0.
    - **Yet to pay**: students active in M who are Unpaid or Partial for M. For a future M this
      is who hasn't paid ahead yet.
    - **Backlog**: students with Unpaid or Partial months before M. Only due months count
      (rule 6), so for a future M it stops at the current month.
    - **Overpaid** (credit): student-months up to M holding money no month needed. Looking at
      the current month or a later one, it also lists later months, so every credit on the
      students list can be found here.
    - **Credit moves**: extra money logged for M that covers another month, and extra money
      logged for another month that covers M.

    Lists are sorted by student name (ignoring case and accents); overpaid months oldest first
    within a student; credit moves by the month covered, then the payment's date.
    """
    month = first_of_month(month)
    current_month = first_of_month(current_month)
    ordered = sorted(students, key=_sort_key)

    expected_total = collected = paid_ahead_total = still_due = active_count = 0
    logged = covered_total = sent_total = 0
    yet_to_pay: list[YetToPayEntry] = []
    backlog: list[BacklogEntry] = []
    overpaid: list[OverpaidEntry] = []
    moves: list[CreditMoveEntry] = []

    backlog_end = min(add_months(month, -1), current_month)
    overpaid_end = min(month, current_month)

    for s in ordered:
        line = month_line(s, month, current_month)
        collected += line.counted_paise
        logged += line.paid_paise
        covered_total += line.covered_by_credit_paise
        sent_total += sum(e.amount_paise for e in line.extra_sent)
        if s.is_active(month):
            if line.expected_paise > 0:  # a ₹0 month (a month off, a free place) isn't counted
                active_count += 1
            expected_total += line.expected_paise
            if month > current_month:
                paid_ahead_total += line.counted_paise
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

        alloc = s.allocation(current_month)
        for m in sorted(alloc.unused_by_month):
            later = m > current_month and month >= current_month
            if m > overpaid_end and not later:
                continue
            overpaid.append(OverpaidEntry(s, month_line(s, m, current_month)))

        mine = [mv for mv in alloc.moves if month in (mv.to_month, mv.payment.for_month)]
        mine.sort(key=lambda mv: (mv.to_month, mv.payment.order_key))
        use_of = {id(u.payment): u for u in alloc.uses}
        for mv in mine:
            use = use_of[id(mv.payment)]
            moves.append(CreditMoveEntry(s, mv, use, needs_check(use, current_month)))

    return Dashboard(
        month=month,
        summary=DashboardSummary(
            expected_paise=expected_total,
            collected_paise=collected,
            paid_ahead_paise=paid_ahead_total,
            still_due_paise=still_due,
            not_fully_paid_count=len(yet_to_pay),
            active_student_count=active_count,
            logged_paise=logged,
            covered_by_credit_paise=covered_total,
            sent_elsewhere_paise=sent_total,
        ),
        yet_to_pay=tuple(yet_to_pay),
        backlog=tuple(backlog),
        overpaid=tuple(overpaid),
        credit_moves=tuple(moves),
    )


# --------------------------------------------------------------------------- monthly report


REPORT_STATUS_ORDER: tuple[ReportStatus, ...] = tuple(ReportStatus)
"""The report's default order: whom to follow up with first (unpaid), then the rest."""


@dataclass(frozen=True, slots=True)
class ReportRow:
    """One student on the monthly report for M."""

    student: StudentRecord
    line: MonthLine
    """M, after extra money has been handed out (rule 4)."""
    status: ReportStatus
    is_enrolled: bool
    """Active in M (rule 1)."""
    owed_before: tuple[MonthLine, ...]
    """Due months before M that are still Unpaid or Partial: the dashboard's backlog."""
    owed_now_paise: int
    """`owed` as of the current month: the students list and profile headline."""
    credit_paise: int
    """`credit` as of the current month."""
    paid_ahead_paise: int
    """`paid_ahead` as of the current month."""
    checks: tuple[PaymentUse, ...] = ()
    """Payments logged for M that are worth a glance in case of a typo (`needs_check`)."""

    @property
    def owed_before_paise(self) -> int:
        return sum(line.remaining_paise for line in self.owed_before)

    @property
    def extra_sent_paise(self) -> int:
        return sum(e.amount_paise for e in self.line.extra_sent)


@dataclass(frozen=True)
class Report:
    month: dt.date
    rows: tuple[ReportRow, ...]


def report_status(student: StudentRecord, line: MonthLine, current_month: dt.date) -> ReportStatus:
    """One word for M, from what pays it (rule 4):

    - not enrolled in M: **left** after `left_month`; **no fee** before `joined_month`;
    - a 0 fee (a month off, a month away, a free place): **no fee**;
    - fully paid: **paid with credit** if some of it came from another payment's extra money,
      else **paid** (for a month after the current one, that means paid ahead);
    - otherwise, for a month after the current one: **not due yet**;
    - otherwise **unpaid** (nothing pays it) or **partial**.
    """
    month = line.month
    if not student.is_active(month):
        left = student.left_month is not None and month > student.left_month
        return ReportStatus.left if left else ReportStatus.no_fee
    if line.expected_paise == 0:
        return ReportStatus.no_fee
    if line.remaining_paise == 0:
        return ReportStatus.paid_with_credit if line.covered_by_credit_paise else ReportStatus.paid
    if month > first_of_month(current_month):
        return ReportStatus.not_due_yet
    return ReportStatus.unpaid if line.counted_paise == 0 else ReportStatus.partial


def build_report(
    students: Iterable[StudentRecord], month: dt.date, current_month: dt.date
) -> Report:
    """The monthly report for M: one row per student relevant to M, worked out from the same
    allocation as the dashboard and the profiles (rule 4, as of the current month, whichever M).

    A student is on it if any of these is true (so students who have left are listed whenever
    they still matter):

    - they are enrolled in M (a 0 fee included);
    - money was logged for M, or extra money from another payment pays M;
    - they still owe for a due month before M (the dashboard's *Earlier months still owed*);
    - money they logged for M or an earlier month is kept as credit (the dashboard's *Extra
      kept as credit* for M);
    - M is the current month or later, and they have any credit or money paid ahead. So the
      current month's report lists everyone the Students list shows as owing, with credit or
      paid ahead, and its totals match it.

    Rows are in `REPORT_STATUS_ORDER` (unpaid first), then by name ignoring case and accents.
    """
    month = first_of_month(month)
    current_month = first_of_month(current_month)
    backlog_end = min(add_months(month, -1), current_month)
    rows: list[ReportRow] = []
    for s in students:
        line = month_line(s, month, current_month)
        owing = tuple(
            ml
            for m in due_months(s, backlog_end)
            if (ml := month_line(s, m, current_month)).is_owing
        )
        credit_paise = credit(s, current_month)
        paid_ahead_paise = paid_ahead(s, current_month)
        # Money logged for M (whatever it paid) or extra money paying M.
        touched = line.paid_paise > 0 or line.covered_by_credit_paise > 0
        held = any(m <= month for m in s.allocation(current_month).unused_by_month)
        standing = month >= current_month and (credit_paise > 0 or paid_ahead_paise > 0)
        enrolled = s.is_active(month)
        if not (enrolled or touched or owing or held or standing):
            continue
        rows.append(
            ReportRow(
                student=s,
                line=line,
                status=report_status(s, line, current_month),
                is_enrolled=enrolled,
                owed_before=owing,
                owed_now_paise=owed(s, current_month),
                credit_paise=credit_paise,
                paid_ahead_paise=paid_ahead_paise,
                checks=tuple(
                    u
                    for u in s.allocation(current_month).uses
                    if u.payment.for_month == month and needs_check(u, current_month)
                ),
            )
        )
    # The screen's name order (`search_fold`, as `lib/report.ts`), so ties sort the same in the
    # Excel download as on screen.
    rows.sort(
        key=lambda r: (
            REPORT_STATUS_ORDER.index(r.status),
            search_fold(r.student.name),
            r.student.id,
        )
    )
    return Report(month=month, rows=tuple(rows))
