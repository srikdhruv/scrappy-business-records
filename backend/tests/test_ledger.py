"""Unit tests for the pure ledger rules (PRD "Ledger rules" and the dashboard)."""

from __future__ import annotations

import datetime as dt

import pytest
from hypothesis import given, settings
from hypothesis import strategies as st

from app.months import add_months, month_range
from app.schemas import BalanceStatus, MonthStatus, SuggestionReason
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
    # March's ₹500 above its fee pays part of January, the oldest month not fully paid once
    # every payment has paid its own month (rule 10). February stays partly paid.
    s = student(pays=((FEB, 1000_00), (MAR, 2000_00)))
    jan = ledger.month_line(s, JAN, NOW)
    feb = ledger.month_line(s, FEB, NOW)
    mar = ledger.month_line(s, MAR, NOW)
    assert (jan.remaining_paise, jan.covered_by_credit_paise, jan.status) == (1000_00, 500_00, PART)
    assert (feb.remaining_paise, feb.excess_paise, feb.status) == (500_00, 0, PART)
    assert (mar.remaining_paise, mar.excess_paise, mar.status) == (0, 500_00, PAID)
    assert mar.extra_sent == (ledger.ExtraSent(JAN, 500_00),)
    assert mar.extra_unused_paise == 0


# --------------------------------------------------------------------------- rule 6: balance


def test_balance_and_status() -> None:
    assert ledger.standing_status(1, 0) is BalanceStatus.owes
    assert ledger.standing_status(1, 500) is BalanceStatus.owes  # owing wins over credit
    assert ledger.standing_status(0, 500) is BalanceStatus.credit
    assert ledger.standing_status(0, 0) is BalanceStatus.up_to_date

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
    assert not by_month[AUG].is_due  # partly paid ahead by September's extra (below)
    # Paid ahead counts towards the net balance, but it isn't credit.
    assert led.balance_paise == 3500_00
    # September: ₹2,000 against a ₹1,500 fee is ₹1,500 for September and ₹500 extra, which
    # pays part of August, the first later month not paid yet: all of it is paid ahead.
    assert by_month[AUG].status is PART and by_month[AUG].covered_by_credit_paise == 500_00
    assert (led.owed_paise, led.credit_paise, led.paid_ahead_paise) == (0, 0, 3500_00)
    assert led.status is BalanceStatus.up_to_date
    # A future month is never in the backlog, and nothing is left over as credit.
    for m in (MAY, JUN, JUL, SEP, DEC):
        board = ledger.build_dashboard([s], m, NOW)
        assert board.overpaid == ()
        assert board.backlog == ()
    # August's dashboard counts the ₹500 as paid ahead for August.
    aug = ledger.build_dashboard([s], AUG, NOW)
    assert (aug.summary.collected_paise, aug.summary.paid_ahead_paise) == (500_00, 500_00)
    assert [(e.move.payment.for_month, e.move.to_month) for e in aug.credit_moves] == [(SEP, AUG)]


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
    # January's ₹500 (before joining) and then May's ₹1,500 (after leaving) are all extra: they
    # pay April, their last month, oldest payment first. ₹500 of May's is left over: credit.
    assert statuses(led) == {JAN: NA, FEB: NA, MAR: PAID, APR: PAID, MAY: OVER, JUN: NA}
    jan = led.months[0]
    assert (jan.expected_paise, jan.excess_paise) == (0, 500_00)
    assert jan.extra_sent == (ledger.ExtraSent(APR, 500_00),)
    apr = led.months[3]
    assert [(c.for_month, c.amount_paise) for c in apr.credit_sources] == [
        (JAN, 500_00),
        (MAY, 1000_00),
    ]
    # 500 + 1500 + 1500 paid, 1500 + 1500 due.
    assert led.balance_paise == 500_00
    assert (led.owed_paise, led.credit_paise) == (0, 500_00)
    board = ledger.build_dashboard([s], NOW, NOW)
    assert [(o.line.month, o.line.extra_unused_paise) for o in board.overpaid] == [(MAY, 500_00)]
    # Collected for May is what pays May: nothing, as nothing was expected.
    may = ledger.build_dashboard([s], MAY, NOW).summary
    assert (may.expected_paise, may.collected_paise, may.still_due_paise) == (0, 0, 0)


# --------------------------------------------------------------------------- joins


def test_student_joining_this_month() -> None:
    s = student(joined=NOW)
    led = ledger.student_ledger(s, NOW)
    assert [(line.month, line.status) for line in led.months] == [(NOW, UNPAID)]
    assert led.balance_paise == -1500_00
    assert ledger.suggest_payment(s, NOW) == owed(NOW, 1500_00)
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
    assert ledger.suggest_payment(s, NOW) == next_unpaid(JUL, 1200_00)


# --------------------------------------------------------------------------- zero fee


def test_zero_fee() -> None:
    s = student(fee=0)
    led = ledger.student_ledger(s, NOW)
    assert set(statuses(led).values()) == {NA}
    assert (led.balance_paise, led.status) == (0, BalanceStatus.up_to_date)
    board = ledger.build_dashboard([s], NOW, NOW)
    assert board.summary.active_student_count == 0  # nobody with a fee due that month
    assert board.summary.expected_paise == 0
    assert board.yet_to_pay == ()
    # Nothing is ever owed, so nothing is suggested: a 0-fee month is never "next due".
    assert ledger.suggest_payment(s, NOW) == ALL_PAID
    tipped_ahead = student(fee=0, pays=((JUL, 100_00),))
    assert ledger.suggest_payment(tipped_ahead, NOW) == ALL_PAID
    # A zero fee that has left and paid nothing: nothing to suggest.
    assert ledger.suggest_payment(student(fee=0, left=MAR), NOW) == ALL_PAID

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


def owed(month: dt.date, amount: int | None) -> ledger.Suggestion:
    return ledger.Suggestion(SuggestionReason.owed, month, amount)


def next_unpaid(month: dt.date, amount: int | None) -> ledger.Suggestion:
    return ledger.Suggestion(SuggestionReason.next_unpaid, month, amount)


ALL_PAID = ledger.Suggestion(SuggestionReason.all_paid)


def test_suggest_oldest_unpaid_or_partial() -> None:
    s = student(pays=((JAN, 1500_00), (FEB, 1000_00), (APR, 1500_00)))
    assert ledger.suggest_payment(s, NOW) == owed(FEB, 500_00)
    s2 = student(pays=((JAN, 1500_00), (FEB, 1500_00)))
    assert ledger.suggest_payment(s2, NOW) == owed(MAR, 1500_00)


def test_suggest_next_unpaid_month_when_nothing_is_owed() -> None:
    # Paid up to and including this month: next month, at the fee in effect then.
    s = student(fees=((JUL, 1800_00),), pays=tuple((m, 1500_00) for m in month_range(JAN, JUN)))
    assert ledger.suggest_payment(s, NOW) == next_unpaid(JUL, 1800_00)


def test_suggest_skips_months_paid_ahead() -> None:
    upto_jun = tuple((m, 1500_00) for m in month_range(JAN, JUN))
    ahead = student(pays=(*upto_jun, (JUL, 1500_00), (AUG, 1500_00), (OCT, 1500_00)))
    assert ledger.suggest_payment(ahead, NOW) == next_unpaid(SEP, 1500_00)
    # A month partly paid ahead: what's left on it.
    part = student(pays=(*upto_jun, (JUL, 1500_00), (AUG, 500_00)))
    assert ledger.suggest_payment(part, NOW) == next_unpaid(AUG, 1000_00)


def test_suggest_prefers_owed_months_over_next_month() -> None:
    s = student(pays=(*((m, 1500_00) for m in month_range(JAN, MAY)), (JUL, 1500_00)))
    assert ledger.suggest_payment(s, NOW) == owed(JUN, 1500_00)
    # ₹9,000 for January pays January and, with its extra, February to June.
    six_months = student(pays=((JAN, 9000_00),))
    assert ledger.suggest_payment(six_months, NOW) == next_unpaid(JUL, 1500_00)
    # ₹8,000 leaves ₹1,000 still owed on June.
    short = student(pays=((JAN, 8000_00),))
    assert ledger.suggest_payment(short, NOW) == owed(JUN, 1000_00)


def test_suggest_for_students_who_are_leaving_or_left() -> None:
    upto_jun = tuple((m, 1500_00) for m in month_range(JAN, JUN))
    # Leaving after August: July is still to pay.
    leaving = student(left=AUG, pays=upto_jun)
    assert ledger.suggest_payment(leaving, NOW) == next_unpaid(JUL, 1500_00)
    # Leaving after August, July and August paid ahead: nothing is left.
    prepaid = student(left=AUG, pays=(*upto_jun, (JUL, 1500_00), (AUG, 1500_00)))
    assert ledger.suggest_payment(prepaid, NOW) == ALL_PAID
    # Leaving after June and fully paid: nothing is left.
    done = student(left=JUN, pays=upto_jun)
    assert ledger.suggest_payment(done, NOW) == ALL_PAID
    # Left in March and settled.
    left = student(left=MAR, pays=tuple((m, 1500_00) for m in month_range(JAN, MAR)))
    assert ledger.suggest_payment(left, NOW) == ALL_PAID
    # Left in March still owing March: that month.
    owing = student(left=MAR, pays=((JAN, 1500_00), (FEB, 1500_00)))
    assert ledger.suggest_payment(owing, NOW) == owed(MAR, 1500_00)


def test_suggest_never_beyond_the_months_that_can_be_logged() -> None:
    latest = add_months(NOW, ledger.MONTHS_AHEAD)  # June 2028
    upto = tuple((m, 1500_00) for m in month_range(JAN, add_months(latest, -1)))
    assert ledger.suggest_payment(student(pays=upto), NOW) == next_unpaid(latest, 1500_00)
    everything = (*upto, (latest, 1500_00))
    assert ledger.suggest_payment(student(pays=everything), NOW) == ALL_PAID


def test_suggest_skips_months_with_no_fee() -> None:
    # Away from July to September (a 0 fee), back from October: October is next, not July.
    s = student(joined=JUN, fees=((JUL, 0), (OCT, 1500_00)), pays=((JUN, 1500_00),))
    assert ledger.suggest_payment(s, NOW) == next_unpaid(OCT, 1500_00)


def test_suggest_for_future_joiner() -> None:
    s = student(joined=AUG)
    assert ledger.suggest_payment(s, NOW) == next_unpaid(AUG, 1500_00)
    paid_first = student(joined=AUG, pays=((AUG, 1500_00),))
    assert ledger.suggest_payment(paid_first, NOW) == next_unpaid(SEP, 1500_00)


# --------------------------------------------------------------------------- credit, tenure


def test_credit_is_only_money_no_month_needed() -> None:
    pays = (
        (JAN, 300_00),  # before joining: all of it is extra
        (FEB, 2000_00),  # 500 over
        (MAR, 1000_00),  # partial
        (JUN, 700_00),  # after leaving (and due): all extra
        (JUL, 1500_00),  # after leaving, though not due yet: all extra, never paid ahead
    )
    s = student(joined=FEB, left=MAY, pays=pays)
    # ₹3,000 of extra money pays March's last ₹500, April and ₹1,000 of May. None is left.
    led = ledger.student_ledger(s, NOW)
    assert (led.credit_paise, led.paid_ahead_paise, led.owed_paise) == (0, 0, 500_00)
    # Another ₹1,000 for June: ₹500 pays the rest of May, and ₹500 is left over: credit.
    more = student(joined=FEB, left=MAY, pays=(*pays, (JUN, 1000_00)))
    assert ledger.credit(more, NOW) == 500_00
    led = ledger.student_ledger(more, NOW)
    assert (led.credit_paise, led.paid_ahead_paise, led.owed_paise) == (500_00, 0, 0)
    assert led.status is BalanceStatus.credit
    # A month later, when July is due, nothing changes.
    assert ledger.credit(more, JUL) == 500_00

    # Paying ahead while still enrolled is not credit.
    staying = student(joined=FEB, pays=((JUL, 1500_00),))
    assert ledger.credit(staying, NOW) == 0
    assert ledger.student_ledger(staying, NOW).paid_ahead_paise == 1500_00
    assert ledger.credit(student(), NOW) == 0


def test_dashboard_entries_carry_credit() -> None:
    # ₹1,000 over in January pays ₹1,000 of March; April to June are unpaid. Nothing is left
    # over, so there is no credit to show next to what's owed.
    s = student(pays=((JAN, 2500_00), (FEB, 1500_00)))
    board = ledger.build_dashboard([s], NOW, NOW)
    assert [e.credit_paise for e in board.yet_to_pay] == [0]
    [entry] = board.backlog
    assert entry.credit_paise == 0
    assert [(m.month, m.covered_by_credit_paise, m.remaining_paise) for m in entry.lines] == [
        (MAR, 1000_00, 500_00),
        (APR, 0, 1500_00),
        (MAY, 0, 1500_00),
    ]


@pytest.mark.parametrize(
    ("joined", "left", "tenure"),
    [
        (JAN, None, 5),  # still coming: months since joining
        (NOW, None, 0),  # joined this month
        (JUL, None, 0),  # hasn't joined yet
        (JAN, MAR, 3),  # left: January to March, both counted
        (MAY, MAY, 1),  # joined and left in May
        (MAR, NOW, 3),  # leaving after this month: still coming, months since joining
    ],
)
def test_tenure_months(joined: dt.date, left: dt.date | None, tenure: int) -> None:
    s = student(joined=joined, left=left)
    assert ledger.tenure_months(s, NOW) == tenure
    assert ledger.student_ledger(s, NOW).tenure_months == tenure


# --------------------------------------------------------------------------- active / left


@pytest.mark.parametrize(
    ("left", "active"),
    [(None, True), (DEC, True), (JUL, True), (JUN, True), (MAY, False), (JAN, False)],
)
def test_active_until_the_left_month_has_passed(left: dt.date | None, active: bool) -> None:
    s = student(left=left)
    assert ledger.has_left(s, NOW) is not active
    assert ledger.student_ledger(s, NOW).is_active is active


def test_leaving_after_december_moves_to_left_in_january() -> None:
    s = student(joined=JAN, left=DEC)
    assert ledger.student_ledger(s, DEC).is_active
    assert not ledger.student_ledger(s, dt.date(2027, 1, 1)).is_active


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
    # Meera paid April twice: the second ₹1,200 pays June, the only month she owed.
    assert board.summary == ledger.DashboardSummary(
        expected_paise=1500_00 + 2000_00 + 1200_00,
        collected_paise=1500_00 + 500_00 + 1200_00,
        paid_ahead_paise=0,
        still_due_paise=1500_00,
        not_fully_paid_count=1,
        active_student_count=3,
        logged_paise=1500_00 + 500_00,
        covered_by_credit_paise=1200_00,
        sent_elsewhere_paise=0,
    )
    assert [(e.student.id, e.line.status, e.line.remaining_paise) for e in board.yet_to_pay] == [
        (2, PART, 1500_00),
    ]
    assert [
        (b.student.id, [m.month for m in b.lines], b.total_owed_paise) for b in board.backlog
    ] == [
        (2, [MAR, APR, MAY], 3 * 2000_00),
        (4, [APR], 1500_00),
    ]
    assert board.overpaid == ()
    assert [
        (e.student.id, e.move.payment.for_month, e.move.to_month, e.move.amount_paise)
        for e in board.credit_moves
    ] == [(3, APR, JUN, 1200_00)]


def test_dashboard_past_month(school: list[StudentRecord]) -> None:
    board = ledger.build_dashboard(school, MAR, JUN)
    assert board.summary == ledger.DashboardSummary(
        expected_paise=1500_00 + 2000_00 + 1200_00 + 1500_00,
        collected_paise=1500_00 + 1200_00 + 1500_00,
        paid_ahead_paise=0,
        still_due_paise=2000_00,
        not_fully_paid_count=1,
        active_student_count=4,
        logged_paise=1500_00 + 1200_00 + 1500_00,
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
    # Meera's June is paid by April's extra, so she owes nothing from before August.
    assert [(b.student.id, [m.month for m in b.lines]) for b in board.backlog] == [
        (2, [MAR, APR, MAY, JUN]),
        (4, [APR]),
    ]
    assert board.overpaid == ()
    assert board.credit_moves == ()  # nothing moved into or out of August


def test_dashboard_empty() -> None:
    board = ledger.build_dashboard([], JUN, JUN)
    assert board.summary == ledger.DashboardSummary(0, 0, 0, 0, 0, 0)
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
    owed_lines = [ln for ln in due if s.is_active(ln.month)]
    assert led.owed_paise == sum(ln.remaining_paise for ln in owed_lines)
    # Paid ahead: what pays later months (never after leaving: those have no fee).
    assert led.paid_ahead_paise == sum(ln.counted_paise for ln in led.months if not ln.is_due)
    # Credit: what no month needed.
    assert led.credit_paise == sum(ln.extra_unused_paise for ln in led.months)
    # Every rupee paid is exactly one of: counted against a due month, paid ahead, or credit.
    assert led.total_paid_paise == (
        sum(ln.counted_paise for ln in led.months if ln.is_due)
        + led.paid_ahead_paise
        + led.credit_paise
    )
    assert led.status is ledger.standing_status(led.owed_paise, led.credit_paise)
    if led.owed_paise:
        assert led.status is BalanceStatus.owes  # nothing can hide a month still owed
    # The history is contiguous and covers joining, the current month and every paid month.
    ms = [line.month for line in led.months]
    assert ms == month_range(ms[0], ms[-1])
    assert s.joined_month in ms and ms[-1] >= current
    assert all(p.for_month in ms for p in s.payments)
    for line in led.months:
        assert line.remaining_paise >= 0 and line.excess_paise >= 0
        assert line.counted_paise + line.remaining_paise == line.expected_paise
        sent = sum(e.amount_paise for e in line.extra_sent)
        assert line.paid_paise == line.paid_direct_paise + sent + line.extra_unused_paise
        assert line.excess_paise == sent + line.extra_unused_paise
        assert line.is_due == (line.month <= current)
        if not s.is_active(line.month):
            assert line.expected_paise == 0
    assert led.is_active == (s.left_month is None or s.left_month >= current)
    sug = led.suggestion
    owing = [line for line in due if line.is_owing]
    if owing:
        assert sug == owed(owing[0].month, owing[0].remaining_paise)
    elif sug.reason is SuggestionReason.all_paid:
        assert (sug.for_month, sug.amount_paise) == (None, None)
        # Every enrolled month from next month up to the last loggable one is paid.
        last = add_months(current, ledger.MONTHS_AHEAD)
        if s.left_month is not None:
            last = min(last, s.left_month)
        start = max(add_months(current, 1), s.joined_month)
        remaining = month_range(start, last) if start <= last else []
        assert not any(ledger.month_line(s, m, current).is_owing for m in remaining)
    else:
        assert sug.reason is SuggestionReason.next_unpaid and sug.for_month is not None
        line = ledger.month_line(s, sug.for_month, current)
        # Later than now, enrolled, with a fee that isn't fully paid.
        assert sug.for_month > current and s.is_active(sug.for_month)
        assert sug.for_month <= add_months(current, ledger.MONTHS_AHEAD)
        assert line.status in (UNPAID, PART)
        assert sug.amount_paise == line.remaining_paise > 0
        start = max(add_months(current, 1), s.joined_month)
        skipped = month_range(start, add_months(sug.for_month, -1))
        assert not any(ledger.month_line(s, m, current).is_owing for m in skipped)


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
    assert summary.active_student_count == len([s for s in active if lines[s.id].expected_paise])
    assert summary.expected_paise == sum(lines[s.id].expected_paise for s in active)
    assert summary.collected_paise == sum(lines[s.id].counted_paise for s in students)
    # What was logged for M = what of it pays M + what paid other months + credit; and what
    # pays M = what of it was logged for M + what other months' payments sent.
    unused = sum(lines[s.id].extra_unused_paise for s in students)
    direct = sum(lines[s.id].paid_direct_paise for s in students)
    assert summary.logged_paise == sum(s.paid(month) for s in students)
    assert summary.logged_paise == direct + summary.sent_elsewhere_paise + unused
    assert summary.collected_paise == direct + summary.covered_by_credit_paise
    assert summary.still_due_paise == sum(e.line.remaining_paise for e in board.yet_to_pay)
    assert summary.not_fully_paid_count == len(board.yet_to_pay)
    for b in board.backlog:
        assert b.total_owed_paise > 0
        assert all(line.month < month and line.month <= current for line in b.lines)
    for o in board.overpaid:
        assert o.line.extra_unused_paise > 0
        assert o.line.month <= min(month, current) or (o.line.month > current <= month)
    # From the current month on, the list holds every credit.
    if month >= current:
        for s in students:
            listed = sum(o.line.extra_unused_paise for o in board.overpaid if o.student.id == s.id)
            assert listed == ledger.credit(s, current)
    for e in board.credit_moves:
        assert month in (e.move.to_month, e.move.payment.for_month)
        assert e.move.amount_paise > 0


# --------------------------------------------------------------------------- rule 6: standing


def test_paying_ahead_never_hides_months_owed() -> None:
    """March and April unpaid, May to August paid: the net balance is 0, but they owe."""
    s = student(joined=MAR, pays=tuple((m, 1500_00) for m in month_range(MAY, add_months(NOW, 2))))
    led = ledger.student_ledger(s, NOW)
    assert led.balance_paise == 0
    assert (led.owed_paise, led.paid_ahead_paise, led.credit_paise) == (3000_00, 3000_00, 0)
    assert led.status is BalanceStatus.owes


def test_paying_a_month_twice_pays_the_month_missed() -> None:
    """May paid twice instead of June: the second payment's money pays June (rule 10)."""
    s = student(joined=MAY, pays=((MAY, 1500_00), (MAY, 1500_00)))
    led = ledger.student_ledger(s, NOW)
    assert led.balance_paise == 0
    assert (led.owed_paise, led.credit_paise) == (0, 0)
    assert led.status is BalanceStatus.up_to_date
    assert ledger.month_line(s, JUN, NOW).covered_by_credit_paise == 1500_00


def test_a_payment_from_before_joining_pays_the_first_month_owed() -> None:
    """The joined month moved past a payment: that payment pays April, the oldest month owed;
    May and June are still owed."""
    s = student(joined=APR, pays=((MAR, 1500_00),))
    led = ledger.student_ledger(s, NOW)
    assert (led.owed_paise, led.credit_paise) == (2 * 1500_00, 0)
    assert led.status is BalanceStatus.owes
    assert statuses(led)[APR] is PAID and statuses(led)[MAR] is NA


def test_paid_ahead_only_is_up_to_date() -> None:
    s = student(joined=NOW, pays=((NOW, 1500_00), (JUL, 1500_00)))
    led = ledger.student_ledger(s, NOW)
    assert (led.owed_paise, led.credit_paise, led.paid_ahead_paise) == (0, 0, 1500_00)
    assert led.status is BalanceStatus.up_to_date


def test_a_payment_for_a_month_after_leaving_pays_what_is_owed_never_paid_ahead() -> None:
    """Left in April; ₹1,500 logged for July (after the current month): nothing is due in July,
    so it pays April, the month still owed. It's never paid ahead for July."""
    s = student(joined=MAR, left=APR, pays=((MAR, 1500_00), (JUL, 1500_00)))
    led = ledger.student_ledger(s, NOW)
    assert (led.paid_ahead_paise, led.credit_paise, led.owed_paise) == (0, 0, 0)
    assert led.status is BalanceStatus.up_to_date
    assert statuses(led)[JUL] is NA
