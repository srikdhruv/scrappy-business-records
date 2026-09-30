"""Unit tests for the pure ledger rules (PRD "Ledger rules" and the dashboard)."""

from __future__ import annotations

import datetime as dt

import pytest
from hypothesis import given, settings
from hypothesis import strategies as st

from app.months import add_months, month_range
from app.schemas import BalanceStatus, MonthStatus
from app.services import ledger
from app.services.ledger import FeeChange, Payment, StudentRecord

JAN, FEB, MAR, APR, MAY, JUN = (dt.date(2026, m, 1) for m in range(1, 7))
JUL, AUG, SEP, OCT, NOV, DEC = (dt.date(2026, m, 1) for m in range(7, 13))
NOW = JUN  # the "current month" in most tests

PAID, PART, UNPAID, OVER, NA = (
    MonthStatus.paid,
    MonthStatus.partial,
    MonthStatus.unpaid,
    MonthStatus.overpaid,
    MonthStatus.not_applicable,
)


def student(
    joined: dt.date = JAN,
    fee: int = 1500_00,
    *,
    left: dt.date | None = None,
    fees: tuple[tuple[dt.date, int], ...] = (),
    pays: tuple[tuple[dt.date, int], ...] = (),
    id_: int = 1,
    name: str = "Ananya Rao",
) -> StudentRecord:
    return StudentRecord(
        id=id_,
        name=name,
        joined_month=joined,
        left_month=left,
        fee_changes=(FeeChange(joined, fee), *(FeeChange(m, a) for m, a in fees)),
        payments=tuple(Payment(m, a) for m, a in pays),
    )


def statuses(led: ledger.StudentLedger) -> dict[dt.date, MonthStatus]:
    return {line.month: line.status for line in led.months}


# --------------------------------------------------------------------------- rule 1: active


def test_active_months_left_month_is_inclusive() -> None:
    s = student(joined=FEB, left=APR)
    assert [m for m in month_range(JAN, MAY) if s.is_active(m)] == [FEB, MAR, APR]


def test_active_forever_without_left_month() -> None:
    s = student(joined=FEB)
    assert s.is_active(dt.date(2040, 1, 1))
    assert not s.is_active(JAN)


# --------------------------------------------------------------------------- rule 2: expected


def test_fee_change_mid_history() -> None:
    s = student(fee=1500_00, fees=((APR, 1800_00),))
    assert [s.expected(m) for m in (JAN, MAR, APR, JUN)] == [1500_00, 1500_00, 1800_00, 1800_00]


def test_fee_changes_in_any_order() -> None:
    s = StudentRecord(
        id=1,
        name="x",
        joined_month=JAN,
        fee_changes=(FeeChange(MAY, 3), FeeChange(JAN, 1), FeeChange(MAR, 2)),
    )
    assert [s.expected(m) for m in month_range(JAN, JUN)] == [1, 1, 2, 2, 3, 3]


def test_expected_is_zero_when_inactive_or_no_fee() -> None:
    s = student(joined=MAR, left=APR)
    assert s.expected(FEB) == 0
    assert s.expected(MAY) == 0
    assert s.fee_in_effect(MAY) == 1500_00  # the fee is still known, just not owed
    no_fee = StudentRecord(id=1, name="x", joined_month=JAN)
    assert no_fee.expected(MAR) == 0


# --------------------------------------------------------------------------- rule 3: paid


def test_multiple_payments_in_one_month_add_up() -> None:
    s = student(pays=((MAR, 500_00), (MAR, 700_00), (MAR, 300_00), (APR, 100_00)))
    assert s.paid(MAR) == 1500_00
    assert s.paid(APR) == 100_00
    assert s.paid(MAY) == 0
    assert ledger.month_line(s, MAR, NOW).status is PAID


# --------------------------------------------------------------------------- rule 4: status


@pytest.mark.parametrize(
    ("expected", "paid", "status"),
    [
        (1500, 1500, PAID),
        (1500, 1, PART),
        (1500, 1499, PART),
        (1500, 0, UNPAID),
        (1500, 1501, OVER),
        (0, 0, NA),
        (0, 1, OVER),
    ],
)
def test_month_status(expected: int, paid: int, status: MonthStatus) -> None:
    assert ledger.month_status(expected, paid) is status


def test_month_line_remaining_and_excess() -> None:
    s = student(pays=((FEB, 1000_00), (MAR, 2000_00)))
    feb = ledger.month_line(s, FEB, NOW)
    mar = ledger.month_line(s, MAR, NOW)
    assert (feb.remaining_paise, feb.excess_paise, feb.status) == (500_00, 0, PART)
    assert (mar.remaining_paise, mar.excess_paise, mar.status) == (0, 500_00, OVER)


# --------------------------------------------------------------------------- rule 6: balance


def test_balance_and_status() -> None:
    assert ledger.balance_status(-1) is BalanceStatus.owes
    assert ledger.balance_status(0) is BalanceStatus.up_to_date
    assert ledger.balance_status(1) is BalanceStatus.credit

    s = student(pays=tuple((m, 1500_00) for m in month_range(JAN, JUN)))
    led = ledger.student_ledger(s, NOW)
    assert (led.balance_paise, led.status) == (0, BalanceStatus.up_to_date)

    owes = ledger.student_ledger(student(pays=((JAN, 1500_00),)), NOW)
    assert (owes.balance_paise, owes.status) == (-5 * 1500_00, BalanceStatus.owes)


def test_balance_uses_the_fee_in_effect_each_month() -> None:
    s = student(fee=1000_00, fees=((APR, 2000_00),))
    # Jan-Mar at 1000, Apr-Jun at 2000.
    assert ledger.balance(s, NOW) == -(3 * 1000_00 + 3 * 2000_00)


# --------------------------------------------------------------------------- rule 5: due months


def test_future_payment_is_paid_ahead_not_overpaid() -> None:
    pays = (*((m, 1500_00) for m in month_range(JAN, JUN)), (JUL, 1500_00), (SEP, 2000_00))
    s = student(pays=pays)
    led = ledger.student_ledger(s, NOW)
    # History runs to the last paid month; months after NOW aren't due.
    assert [line.month for line in led.months] == month_range(JAN, SEP)
    by_month = {line.month: line for line in led.months}
    assert by_month[JUN].is_due and not by_month[JUL].is_due
    assert by_month[JUL].status is PAID
    assert by_month[AUG].status is UNPAID and not by_month[AUG].is_due
    # Paid ahead counts towards the balance as credit ...
    assert (led.balance_paise, led.status) == (3500_00, BalanceStatus.credit)
    # ... but never shows up as overpaid or backlog, even on a future dashboard.
    for m in (JUN, JUL, SEP, DEC):
        board = ledger.build_dashboard([s], m, NOW)
        assert board.overpaid == ()
        assert board.backlog == ()


def test_expected_after_current_month_is_not_owed() -> None:
    s = student(joined=JAN)
    assert ledger.expected_to_date(s, NOW) == 6 * 1500_00
    assert ledger.due_months(s, NOW) == month_range(JAN, JUN)


# --------------------------------------------------------------------------- left student


def test_left_student() -> None:
    s = student(joined=JAN, left=MAR, pays=((JAN, 1500_00), (FEB, 1500_00)))
    led = ledger.student_ledger(s, NOW)
    assert statuses(led) == {JAN: PAID, FEB: PAID, MAR: UNPAID, APR: NA, MAY: NA, JUN: NA}
    assert led.balance_paise == -1500_00  # still owes for March, their last month
    board = ledger.build_dashboard([s], NOW, NOW)
    assert board.summary.active_student_count == 0
    assert board.yet_to_pay == ()
    assert [(b.student.id, [line.month for line in b.lines]) for b in board.backlog] == [(1, [MAR])]


# --------------------------------------------------------------------------- inactive months


def test_payment_in_an_inactive_month() -> None:
    s = student(joined=MAR, left=APR, pays=((JAN, 500_00), (MAY, 1500_00), (MAR, 1500_00)))
    led = ledger.student_ledger(s, NOW)
    # History starts at the earliest paid month when that's before joining.
    assert [line.month for line in led.months] == month_range(JAN, JUN)
    assert statuses(led) == {JAN: OVER, FEB: NA, MAR: PAID, APR: UNPAID, MAY: OVER, JUN: NA}
    jan = led.months[0]
    assert (jan.expected_paise, jan.excess_paise) == (0, 500_00)
    # 500 + 1500 + 1500 paid, 1500 + 1500 due.
    assert led.balance_paise == 500_00
    board = ledger.build_dashboard([s], NOW, NOW)
    assert [(o.line.month, o.line.excess_paise) for o in board.overpaid] == [
        (JAN, 500_00),
        (MAY, 1500_00),
    ]
    # The payment for May still counts as collected for May, though nothing was expected.
    may = ledger.build_dashboard([s], MAY, NOW).summary
    assert (may.expected_paise, may.collected_paise, may.still_due_paise) == (0, 1500_00, 0)


# --------------------------------------------------------------------------- joins


def test_student_joining_this_month() -> None:
    s = student(joined=NOW)
    led = ledger.student_ledger(s, NOW)
    assert [(line.month, line.status) for line in led.months] == [(NOW, UNPAID)]
    assert led.balance_paise == -1500_00
    assert ledger.suggest_payment(s, NOW) == ledger.Suggestion(NOW, 1500_00)
    board = ledger.build_dashboard([s], NOW, NOW)
    assert [e.student.id for e in board.yet_to_pay] == [1]
    assert board.backlog == ()
    assert ledger.build_dashboard([s], MAY, NOW).summary.active_student_count == 0


def test_student_joining_next_month() -> None:
    s = student(joined=JUL, fee=1200_00)
    led = ledger.student_ledger(s, NOW)
    assert [(line.month, line.is_due) for line in led.months] == [(JUL, False)]
    assert (led.balance_paise, led.status) == (0, BalanceStatus.up_to_date)
    assert led.monthly_fee_paise == 1200_00
    assert ledger.suggest_payment(s, NOW) == ledger.Suggestion(JUL, 1200_00)


# --------------------------------------------------------------------------- zero fee


def test_zero_fee() -> None:
    s = student(fee=0)
    led = ledger.student_ledger(s, NOW)
    assert set(statuses(led).values()) == {NA}
    assert (led.balance_paise, led.status) == (0, BalanceStatus.up_to_date)
    board = ledger.build_dashboard([s], NOW, NOW)
    assert board.summary.active_student_count == 1
    assert board.summary.expected_paise == 0
    assert board.yet_to_pay == ()
    assert ledger.suggest_payment(s, NOW) == ledger.Suggestion(NOW, 0)

    tipped = student(fee=0, pays=((MAR, 100_00),))
    assert statuses(ledger.student_ledger(tipped, NOW))[MAR] is OVER


# --------------------------------------------------------------------------- student ledger


def test_student_ledger_totals_and_current_fee() -> None:
    s = student(fee=1500_00, fees=((MAY, 1800_00), (AUG, 2000_00)), pays=((JAN, 1500_00),))
    led = ledger.student_ledger(s, NOW)
    assert led.monthly_fee_paise == 1800_00  # the fee in effect now, not a scheduled one
    assert (led.total_paid_paise, led.payment_count) == (1500_00, 1)
    assert [line.month for line in led.months] == month_range(JAN, JUN)


def test_history_for_left_student_runs_to_current_month() -> None:
    s = student(joined=JAN, left=FEB)
    assert ledger.history_range(s, NOW) == month_range(JAN, NOW)


# --------------------------------------------------------------------------- suggest payment


def test_suggest_oldest_unpaid_or_partial() -> None:
    s = student(pays=((JAN, 1500_00), (FEB, 1000_00), (APR, 1500_00)))
    assert ledger.suggest_payment(s, NOW) == ledger.Suggestion(FEB, 500_00)
    s2 = student(pays=((JAN, 1500_00), (FEB, 1500_00)))
    assert ledger.suggest_payment(s2, NOW) == ledger.Suggestion(MAR, 1500_00)


def test_suggest_current_month_when_all_paid() -> None:
    s = student(fees=((JUN, 1800_00),), pays=tuple((m, 1500_00) for m in month_range(JAN, MAY)))
    assert ledger.suggest_payment(s, NOW) == ledger.Suggestion(JUN, 1800_00)
    done = student(pays=tuple((m, 1500_00) for m in month_range(JAN, JUN)))
    assert ledger.suggest_payment(done, NOW) == ledger.Suggestion(JUN, 1500_00)


def test_suggest_ignores_future_and_inactive_months() -> None:
    s = student(joined=JAN, left=MAR, pays=tuple((m, 1500_00) for m in month_range(JAN, MAR)))
    # Nothing owed; the current month's fee is offered (the UI can change it).
    assert ledger.suggest_payment(s, NOW) == ledger.Suggestion(JUN, 1500_00)
    overpaid = student(pays=((JAN, 9000_00),))
    assert ledger.suggest_payment(overpaid, NOW) == ledger.Suggestion(FEB, 1500_00)


# --------------------------------------------------------------------------- dashboard


@pytest.fixture
def school() -> list[StudentRecord]:
    """Five students, current month June."""
    return [
        # Always pays on time.
        student(id_=1, name="Ananya Rao", pays=tuple((m, 1500_00) for m in month_range(JAN, JUN))),
        # Paid nothing since March; partial in June.
        student(
            id_=2,
            name="kabir Mehta",  # lower-case: sorting ignores case
            fee=2000_00,
            pays=((JAN, 2000_00), (FEB, 2000_00), (JUN, 500_00)),
        ),
        # Overpaid in April, hasn't paid June yet.
        student(
            id_=3,
            name="Meera Iyer",
            fee=1200_00,
            pays=((APR, 2400_00), *((m, 1200_00) for m in (JAN, FEB, MAR, MAY))),
        ),
        # Left in April, owes for April.
        student(
            id_=4,
            name="Rohan Desai",
            left=APR,
            pays=tuple((m, 1500_00) for m in month_range(JAN, MAR)),
        ),
        # Joins in August; has paid for August already.
        student(id_=5, name="Diya Nair", joined=AUG, fee=3000_00, pays=((AUG, 3000_00),)),
    ]


def test_dashboard_present_month(school: list[StudentRecord]) -> None:
    board = ledger.build_dashboard(school, JUN, JUN)
    assert board.month == JUN
    assert board.summary == ledger.DashboardSummary(
        expected_paise=1500_00 + 2000_00 + 1200_00,
        collected_paise=1500_00 + 500_00,
        still_due_paise=1500_00 + 1200_00,
        not_fully_paid_count=2,
        active_student_count=3,
    )
    assert [(e.student.id, e.line.status, e.line.remaining_paise) for e in board.yet_to_pay] == [
        (2, PART, 1500_00),
        (3, UNPAID, 1200_00),
    ]
    assert [
        (b.student.id, [m.month for m in b.lines], b.total_owed_paise) for b in board.backlog
    ] == [
        (2, [MAR, APR, MAY], 3 * 2000_00),
        (4, [APR], 1500_00),
    ]
    assert [(o.student.id, o.line.month, o.line.excess_paise) for o in board.overpaid] == [
        (3, APR, 1200_00)
    ]


def test_dashboard_past_month(school: list[StudentRecord]) -> None:
    board = ledger.build_dashboard(school, MAR, JUN)
    assert board.summary == ledger.DashboardSummary(
        expected_paise=1500_00 + 2000_00 + 1200_00 + 1500_00,
        collected_paise=1500_00 + 1200_00 + 1500_00,
        still_due_paise=2000_00,
        not_fully_paid_count=1,
        active_student_count=4,
    )
    assert [e.student.id for e in board.yet_to_pay] == [2]
    # Backlog is only months before March.
    assert board.backlog == ()
    # April's overpayment is after March, so it isn't listed yet.
    assert board.overpaid == ()


def test_dashboard_future_month(school: list[StudentRecord]) -> None:
    board = ledger.build_dashboard(school, AUG, JUN)
    # Students 1-3 are active, plus Diya who joins in August and has paid ahead.
    assert board.summary.active_student_count == 4
    assert board.summary.expected_paise == 1500_00 + 2000_00 + 1200_00 + 3000_00
    assert board.summary.collected_paise == 3000_00
    assert [e.student.id for e in board.yet_to_pay] == [1, 2, 3]
    # Backlog stops at the current month: July isn't due yet.
    assert [(b.student.id, [m.month for m in b.lines]) for b in board.backlog] == [
        (2, [MAR, APR, MAY, JUN]),
        (3, [JUN]),
        (4, [APR]),
    ]
    assert [(o.student.id, o.line.month) for o in board.overpaid] == [(3, APR)]


def test_dashboard_empty() -> None:
    board = ledger.build_dashboard([], JUN, JUN)
    assert board.summary == ledger.DashboardSummary(0, 0, 0, 0, 0)
    assert (board.yet_to_pay, board.backlog, board.overpaid) == ((), (), ())


def test_dashboard_accepts_any_day_of_month() -> None:
    s = student()
    assert ledger.build_dashboard([s], dt.date(2026, 6, 17), dt.date(2026, 6, 30)).month == JUN


# --------------------------------------------------------------------------- invariants

months = st.integers(0, 23).map(lambda i: add_months(dt.date(2025, 1, 1), i))
amounts = st.integers(0, 5000_00)


@st.composite
def records(draw: st.DrawFn) -> StudentRecord:
    joined = draw(months)
    left = draw(st.none() | months.filter(lambda m: m >= joined))
    fees = draw(st.lists(st.tuples(months.filter(lambda m: m > joined), amounts), max_size=3))
    pays = draw(st.lists(st.tuples(months, st.integers(1, 5000_00)), max_size=15))
    return StudentRecord(
        id=draw(st.integers(1, 10_000)),
        name=draw(st.text(min_size=1, max_size=5)),
        joined_month=joined,
        left_month=left,
        fee_changes=(
            FeeChange(joined, draw(amounts)),
            *(FeeChange(m, a) for m, a in dict(fees).items()),
        ),
        payments=tuple(Payment(m, a) for m, a in pays),
    )


@settings(max_examples=300, deadline=None)
@given(s=records(), current=months)
def test_student_invariants(s: StudentRecord, current: dt.date) -> None:
    led = ledger.student_ledger(s, current)
    due = [line for line in led.months if line.is_due]
    # balance = everything paid - everything expected in due months
    total_paid = sum(p.amount_paise for p in s.payments)
    assert led.balance_paise == total_paid - sum(line.expected_paise for line in due)
    assert led.total_paid_paise == total_paid == sum(line.paid_paise for line in led.months)
    assert led.status is ledger.balance_status(led.balance_paise)
    # The history is contiguous and covers joining, the current month and every paid month.
    ms = [line.month for line in led.months]
    assert ms == month_range(ms[0], ms[-1])
    assert s.joined_month in ms and ms[-1] >= current
    assert all(p.for_month in ms for p in s.payments)
    for line in led.months:
        assert line.remaining_paise >= 0 and line.excess_paise >= 0
        assert line.expected_paise - line.paid_paise == line.remaining_paise - line.excess_paise
        assert line.is_due == (line.month <= current)
        if not s.is_active(line.month):
            assert line.expected_paise == 0
    sug = led.suggestion
    owing = [line for line in due if line.is_owing]
    if owing:
        assert (sug.for_month, sug.amount_paise) == (owing[0].month, owing[0].remaining_paise)
    else:
        assert sug.for_month == max(current, s.joined_month)


@settings(max_examples=200, deadline=None)
@given(
    students=st.lists(records(), max_size=6, unique_by=lambda s: s.id),
    month=months,
    current=months,
)
def test_dashboard_invariants(
    students: list[StudentRecord], month: dt.date, current: dt.date
) -> None:
    board = ledger.build_dashboard(students, month, current)
    summary = board.summary
    lines = {s.id: ledger.month_line(s, month, current) for s in students}
    active = [s for s in students if s.is_active(month)]
    assert summary.still_due_paise >= 0
    assert summary.active_student_count == len(active)
    assert summary.expected_paise == sum(lines[s.id].expected_paise for s in active)
    assert summary.collected_paise == sum(s.paid(month) for s in students)
    assert summary.still_due_paise == sum(e.line.remaining_paise for e in board.yet_to_pay)
    assert summary.not_fully_paid_count == len(board.yet_to_pay)
    for b in board.backlog:
        assert b.total_owed_paise > 0
        assert all(line.month < month and line.month <= current for line in b.lines)
    for o in board.overpaid:
        assert o.line.excess_paise > 0 and o.line.month <= min(month, current)
