"""Extra money covers unpaid months (PRD ledger rule 10, `ledger.allocate`).

A payment first pays the month it was logged for. What's left over pays the oldest months not
fully paid (due months first, then later months: paid ahead), and anything still left is
credit. Payments are never changed: this is worked out every time, from the payments as typed.
"""

from __future__ import annotations

import datetime as dt
import random

from fastapi.testclient import TestClient
from helpers import make_student, pay
from hypothesis import given, settings
from hypothesis import strategies as st

from app.months import add_months, month_range
from app.schemas import BalanceStatus, MonthStatus
from app.services import ledger
from app.services.ledger import CreditSource, ExtraSent, FeeChange, Payment, StudentRecord

JUN, JUL, AUG, SEP, OCT, NOV, DEC = (dt.date(2026, m, 1) for m in range(6, 13))
FEE = 1500_00


def day(month: dt.date, d: int) -> dt.date:
    return month.replace(day=d)


def record(
    *pays: Payment,
    joined: dt.date = JUN,
    left: dt.date | None = None,
    fees: tuple[tuple[dt.date, int], ...] = (),
) -> StudentRecord:
    return StudentRecord(
        id=1,
        name="Ananya Rao",
        joined_month=joined,
        left_month=left,
        fee_changes=(FeeChange(joined, FEE), *(FeeChange(m, a) for m, a in fees)),
        payments=pays,
    )


def p(id_: int, month: dt.date, amount: int, paid_on: dt.date | None = None) -> Payment:
    return Payment(month, amount, paid_on or day(month, 5), id_)


def lines(s: StudentRecord, current: dt.date) -> dict[dt.date, ledger.MonthLine]:
    return {line.month: line for line in ledger.student_ledger(s, current).months}


# --------------------------------------------------------------------------- the real case


def test_the_real_case_september_paid_double_august_unpaid() -> None:
    """September logged at twice the fee while August was unpaid: August is paid with credit
    from the 5 Sep payment, and September says where its extra went."""
    s = record(p(1, JUN, FEE), p(2, JUL, FEE), p(3, SEP, 2 * FEE, day(SEP, 5)))
    by = lines(s, SEP)

    aug, sep = by[AUG], by[SEP]
    assert aug.status is MonthStatus.paid
    assert (aug.paid_paise, aug.paid_direct_paise, aug.covered_by_credit_paise) == (0, 0, FEE)
    assert aug.credit_sources == (CreditSource(3, day(SEP, 5), SEP, FEE),)
    assert aug.remaining_paise == 0

    assert sep.status is MonthStatus.paid
    assert (sep.paid_paise, sep.paid_direct_paise, sep.excess_paise) == (2 * FEE, FEE, FEE)
    assert sep.extra_sent == (ExtraSent(AUG, FEE),)
    assert sep.extra_unused_paise == 0

    led = ledger.student_ledger(s, SEP)
    assert (led.owed_paise, led.credit_paise, led.paid_ahead_paise) == (0, 0, 0)
    assert led.status is BalanceStatus.up_to_date
    assert led.suggestion == ledger.Suggestion(ledger.SuggestionReason.next_unpaid, OCT, FEE)

    # The dashboard: August isn't owed any more, and each month says what moved.
    now = ledger.build_dashboard([s], SEP, SEP)
    assert now.backlog == () and now.yet_to_pay == () and now.overpaid == ()
    assert [
        (e.move.payment.id, e.move.to_month, e.move.amount_paise) for e in now.credit_moves
    ] == [(3, AUG, FEE)]
    august = ledger.build_dashboard([s], AUG, SEP)
    assert august.yet_to_pay == ()
    assert (august.summary.collected_paise, august.summary.still_due_paise) == (FEE, 0)
    assert [e.move.to_month for e in august.credit_moves] == [AUG]
    # September counts only what pays September.
    assert ledger.build_dashboard([s], SEP, SEP).summary.collected_paise == FEE


def test_the_payment_itself_says_where_its_money_went() -> None:
    s = record(p(1, JUN, FEE), p(2, JUL, FEE), p(3, SEP, 2 * FEE))
    uses = {u.payment.id: u for u in ledger.payment_uses(s, SEP)}
    assert (uses[3].direct_paise, uses[3].sent, uses[3].unused_paise) == (
        FEE,
        (ExtraSent(AUG, FEE),),
        0,
    )
    assert (uses[1].direct_paise, uses[1].sent, uses[1].unused_paise) == (FEE, (), 0)


# --------------------------------------------------------------------------- the rule's edges


def test_several_overpayments_fill_the_oldest_months_in_payment_order() -> None:
    # June and July unpaid. August +₹1,000 (paid 5 Aug), September +₹2,500 (paid 5 Sep).
    s = record(p(1, AUG, FEE + 1000_00), p(2, SEP, FEE + 2500_00))
    by = lines(s, SEP)
    # August's extra goes first (it was paid first): ₹1,000 of June.
    assert [(c.payment_id, c.amount_paise) for c in by[JUN].credit_sources] == [
        (1, 1000_00),
        (2, 500_00),
    ]
    assert [(c.payment_id, c.amount_paise) for c in by[JUL].credit_sources] == [(2, 1500_00)]
    # ₹500 of September's extra is left: every due month is paid, so it pays October ahead.
    assert by[SEP].extra_sent == (
        ExtraSent(JUN, 500_00),
        ExtraSent(JUL, FEE),
        ExtraSent(OCT, 500_00),
    )
    assert by[OCT].status is MonthStatus.partial and not by[OCT].is_due
    led = ledger.student_ledger(s, SEP)
    assert (led.owed_paise, led.paid_ahead_paise, led.credit_paise) == (0, 500_00, 0)


def test_the_order_is_by_date_paid_not_by_the_month_it_was_for() -> None:
    # The September payment was made before the August one, so its extra goes first.
    early = p(9, SEP, FEE + 500_00, day(AUG, 1))
    late = p(1, AUG, FEE + 500_00, day(AUG, 20))
    s = record(late, early)
    by = lines(s, SEP)
    assert [c.payment_id for c in by[JUN].credit_sources] == [9, 1]


def test_payments_on_the_same_day_go_in_the_order_they_were_entered() -> None:
    same_day = day(SEP, 3)
    s = record(p(7, SEP, FEE + 500_00, same_day), p(4, SEP, 700_00, same_day))
    by = lines(s, SEP)
    # Payment 4 was entered first (lower id): it pays September first...
    assert by[SEP].paid_direct_paise == FEE
    uses = {u.payment.id: u for u in ledger.payment_uses(s, SEP)}
    assert (uses[4].direct_paise, uses[7].direct_paise) == (700_00, 800_00)
    # ...and payment 7's leftover (₹700 + ₹500) pays June.
    assert uses[7].sent == (ExtraSent(JUN, 1200_00),)
    # The result doesn't depend on the order the payments are listed in.
    swapped = record(p(4, SEP, 700_00, same_day), p(7, SEP, FEE + 500_00, same_day))
    assert lines(swapped, SEP) == by


def test_a_partial_month_is_finished_by_later_extra_money() -> None:
    s = record(p(1, JUN, FEE), p(2, JUL, 1000_00), p(3, AUG, FEE), p(4, SEP, FEE + 500_00))
    by = lines(s, SEP)
    jul = by[JUL]
    assert (jul.paid_direct_paise, jul.covered_by_credit_paise, jul.status) == (
        1000_00,
        500_00,
        MonthStatus.paid,
    )
    assert ledger.owed(s, SEP) == 0


def test_a_partial_month_covered_partly_by_credit_shows_both_parts() -> None:
    s = record(p(1, JUN, FEE), p(2, JUL, 500_00), p(3, AUG, FEE), p(4, SEP, FEE + 400_00))
    jul = lines(s, SEP)[JUL]
    assert (jul.paid_direct_paise, jul.covered_by_credit_paise, jul.remaining_paise) == (
        500_00,
        400_00,
        600_00,
    )
    assert jul.status is MonthStatus.partial


def test_payments_before_joining_and_after_leaving_are_all_extra() -> None:
    # Joined July, left October. ₹1,000 logged for June (before joining) and ₹1,500 for
    # November (after leaving): no fee is due then, so all of it pays owed months.
    s = record(p(1, JUN, 1000_00), p(2, NOV, FEE, day(SEP, 10)), joined=JUL, left=OCT)
    by = lines(s, SEP)
    assert by[JUN].status is MonthStatus.not_applicable
    assert by[JUN].extra_sent == (ExtraSent(JUL, 1000_00),)
    assert by[NOV].extra_sent == (ExtraSent(JUL, 500_00), ExtraSent(AUG, 1000_00))
    assert (by[AUG].remaining_paise, by[SEP].remaining_paise) == (500_00, FEE)
    led = ledger.student_ledger(s, SEP)
    # A payment for a month after leaving is never "paid ahead", even for a later month.
    assert (led.paid_ahead_paise, led.credit_paise, led.owed_paise) == (0, 0, 500_00 + FEE)


def test_months_away_and_no_fee_months_are_skipped() -> None:
    # Away (₹0 fee) in July and August; back in September. September's extra skips them.
    s = record(p(1, JUN, FEE), p(2, SEP, 2 * FEE), fees=((JUL, 0), (SEP, FEE)))
    by = lines(s, SEP)
    assert by[JUL].status is by[AUG].status is MonthStatus.not_applicable
    assert (by[JUL].covered_by_credit_paise, by[AUG].covered_by_credit_paise) == (0, 0)
    # Nothing is owed, so it pays October ahead.
    assert by[SEP].extra_sent == (ExtraSent(OCT, FEE),)


def test_extra_pays_later_months_in_order_up_to_the_left_month() -> None:
    s = record(p(1, JUN, 5 * FEE), left=AUG)  # June to August owed; ₹3,000 left over
    assert ledger.credit(s, JUN) == 2 * FEE
    led = ledger.student_ledger(s, JUN)
    assert (led.paid_ahead_paise, led.owed_paise) == (2 * FEE, 0)
    assert led.status is BalanceStatus.credit
    by = {line.month: line for line in led.months}
    assert by[JUN].extra_sent == (ExtraSent(JUL, FEE), ExtraSent(AUG, FEE))
    assert by[JUN].extra_unused_paise == 2 * FEE
    assert by[JUN].status is MonthStatus.overpaid  # some of June's money is credit


def test_extra_pays_ahead_no_further_than_24_months() -> None:
    far = add_months(JUN, ledger.MONTHS_AHEAD)
    s = record(p(1, JUN, 30 * FEE))  # June + 24 months ahead can take 25 fees
    led = ledger.student_ledger(s, JUN)
    assert led.months[-1].month == far
    assert (led.paid_ahead_paise, led.credit_paise) == (24 * FEE, 5 * FEE)
    # A month later the window has moved on, so one more month takes some.
    assert ledger.credit(s, JUL) == 4 * FEE


def test_more_than_everything_due_is_credit() -> None:
    s = record(p(1, JUN, FEE), p(2, JUL, FEE + 700_00), left=JUL)
    led = ledger.student_ledger(s, SEP)
    assert (led.owed_paise, led.credit_paise, led.status) == (0, 700_00, BalanceStatus.credit)
    board = ledger.build_dashboard([s], SEP, SEP)
    assert [(o.line.month, o.line.extra_unused_paise) for o in board.overpaid] == [(JUL, 700_00)]


def test_extra_money_first_pays_months_before_the_one_it_was_for_then_after() -> None:
    # Joined June; July paid; June and August unpaid; October logged with 3 fees in September.
    s = record(p(1, JUL, FEE), p(2, OCT, 3 * FEE, day(SEP, 2)))
    by = lines(s, SEP)
    assert by[OCT].extra_sent == (ExtraSent(JUN, FEE), ExtraSent(AUG, FEE))
    assert by[SEP].remaining_paise == FEE  # September is still owed: the money ran out


def test_paying_ahead_directly_never_covers_an_older_month() -> None:
    """Only money left over after its own month moves. October paid exactly: August stays owed."""
    s = record(p(1, JUN, FEE), p(2, JUL, FEE), p(3, SEP, FEE), p(4, OCT, FEE, day(SEP, 6)))
    assert lines(s, SEP)[AUG].status is MonthStatus.unpaid
    assert ledger.owed(s, SEP) == FEE


def test_a_month_typed_for_keeps_its_own_payment_before_extra_from_elsewhere() -> None:
    # The July payment is older and has extra; August's own payment still pays August first,
    # so July's extra moves on to September.
    s = record(p(1, JUN, FEE), p(2, JUL, 2 * FEE), p(3, AUG, FEE))
    by = lines(s, SEP)
    assert by[AUG].paid_direct_paise == FEE and by[AUG].covered_by_credit_paise == 0
    assert by[JUL].extra_sent == (ExtraSent(SEP, FEE),)


# --------------------------------------------------------------------------- edits and deletes


def test_changing_the_source_payment_changes_what_it_covers(api: TestClient) -> None:
    """Allocation is worked out from the payments every time, so an edit or delete of the
    payment with the extra money updates the months it covered straight away."""
    s = make_student(api, joined_month="2026-03")
    for m in ("2026-03", "2026-04"):
        pay(api, s["id"], m)
    double = pay(api, s["id"], "2026-06", 300000)  # May unpaid; June paid twice

    def month(m: str) -> dict[str, object]:
        detail = api.get(f"/api/students/{s['id']}").json()
        return next(x for x in detail["months"] if x["month"] == m)

    may = month("2026-05")
    assert (may["status"], may["covered_by_credit_paise"]) == ("paid", 150000)
    assert may["credit_sources"] == [
        {
            "payment_id": double["id"],
            "paid_on": double["paid_on"],
            "for_month": "2026-06",
            "amount_paise": 150000,
        }
    ]
    assert double["extra_sent"] == [{"to_month": "2026-05", "amount_paise": 150000}]
    assert api.get(f"/api/payments/{double['id']}").json()["extra_sent"] == double["extra_sent"]

    # Less money: May is only partly covered.
    edited = api.patch(f"/api/payments/{double['id']}", json={"amount_paise": 200000}).json()
    assert edited["extra_sent"] == [{"to_month": "2026-05", "amount_paise": 50000}]
    assert (month("2026-05")["status"], month("2026-05")["remaining_paise"]) == ("partial", 100000)

    # Moved to May: it pays May itself, and its extra now pays June.
    moved = api.patch(f"/api/payments/{double['id']}", json={"for_month": "2026-05"}).json()
    assert (moved["paid_direct_paise"], moved["extra_sent"]) == (
        150000,
        [{"to_month": "2026-06", "amount_paise": 50000}],
    )
    assert month("2026-06")["covered_by_credit_paise"] == 50000

    # Deleted: May and June are owed again. The payments as typed never changed.
    assert api.delete(f"/api/payments/{double['id']}").status_code == 204
    assert (month("2026-05")["status"], month("2026-06")["status"]) == ("unpaid", "unpaid")
    detail = api.get(f"/api/students/{s['id']}").json()
    assert (detail["owed_paise"], detail["credit_paise"]) == (300000, 0)
    assert [p["amount_paise"] for p in api.get("/api/payments").json()] == [150000, 150000]


def test_moving_the_source_payment_to_another_student(api: TestClient) -> None:
    a = make_student(api, joined_month="2026-05")
    b = make_student(api, name="Kabir Mehta", joined_month="2026-05")
    double = pay(api, a["id"], "2026-06", 300000)  # pays June, and May with its extra
    assert api.get(f"/api/students/{a['id']}").json()["owed_paise"] == 0
    moved = api.patch(f"/api/payments/{double['id']}", json={"student_id": b["id"]}).json()
    assert moved["extra_sent"] == [{"to_month": "2026-05", "amount_paise": 150000}]
    assert api.get(f"/api/students/{a['id']}").json()["owed_paise"] == 300000
    assert api.get(f"/api/students/{b['id']}").json()["owed_paise"] == 0


def test_the_payments_list_says_where_each_payment_went(api: TestClient) -> None:
    s = make_student(api, joined_month="2026-04")
    pay(api, s["id"], "2026-04")
    pay(api, s["id"], "2026-06", 400000)  # May, and ₹1,000 of July ahead
    rows = api.get("/api/payments", params={"student_id": s["id"]}).json()
    june = next(r for r in rows if r["for_month"] == "2026-06")
    assert (june["paid_direct_paise"], june["extra_sent"], june["extra_unused_paise"]) == (
        150000,
        [
            {"to_month": "2026-05", "amount_paise": 150000},
            {"to_month": "2026-07", "amount_paise": 100000},
        ],
        0,
    )
    # The same answer however the list is filtered.
    filtered = api.get("/api/payments", params={"month": "2026-06", "q": "ananya"}).json()
    assert filtered == [june]


# --------------------------------------------------------------------------- properties

months = st.integers(0, 23).map(lambda i: add_months(dt.date(2025, 1, 1), i))
fees = st.sampled_from([0, 500_00, 1200_00, 1500_00, 2000_00])


@st.composite
def records(draw: st.DrawFn) -> StudentRecord:
    joined = draw(months)
    left = draw(st.none() | months.filter(lambda m: m >= joined))
    changes = draw(st.lists(st.tuples(months.filter(lambda m: m > joined), fees), max_size=3))
    pays = draw(
        st.lists(
            st.tuples(months, st.integers(1, 6000_00), st.integers(0, 40)),
            max_size=12,
        )
    )
    return StudentRecord(
        id=1,
        name="x",
        joined_month=joined,
        left_month=left,
        fee_changes=(
            FeeChange(joined, draw(fees)),
            *(FeeChange(m, a) for m, a in dict(changes).items()),
        ),
        payments=tuple(
            Payment(m, a, add_months(dt.date(2025, 1, 1), 0) + dt.timedelta(days=d * 17), i + 1)
            for i, (m, a, d) in enumerate(pays)
        ),
    )


@settings(max_examples=400, deadline=None)
@given(s=records(), current=months)
def test_allocation_balances(s: StudentRecord, current: dt.date) -> None:
    alloc = ledger.allocate(s, current)
    targets = ledger.allocation_months(s, current)
    led = ledger.student_ledger(s, current)
    by = {line.month: line for line in led.months}

    # Each payment: its own month + what it sent + credit = what was paid.
    for use in alloc.uses:
        sent = sum(e.amount_paise for e in use.sent)
        assert use.direct_paise + sent + use.unused_paise == use.payment.amount_paise
        assert min(use.direct_paise, sent, use.unused_paise) >= 0
        assert all(e.to_month in targets and e.to_month != use.payment.for_month for e in use.sent)
        # Money only leaves a month with a fee once that month is paid in full.
        if use.direct_paise < use.payment.amount_paise and s.expected(use.payment.for_month):
            assert by[use.payment.for_month].remaining_paise == 0

    # The whole: total paid = used for its own month + used for other months + credit.
    total = sum(p.amount_paise for p in s.payments)
    direct = sum(u.direct_paise for u in alloc.uses)
    moved = sum(mv.amount_paise for mv in alloc.moves)
    assert total == direct + moved + led.credit_paise
    assert moved == sum(line.covered_by_credit_paise for line in led.months)
    assert moved == sum(sum(e.amount_paise for e in line.extra_sent) for line in led.months)

    for line in led.months:
        # Never more than the fee; never anything for a month with no fee.
        assert line.counted_paise <= line.expected_paise
        if line.covered_by_credit_paise:
            # Oldest first: every earlier month extra money could pay is paid in full.
            assert all(by[m].remaining_paise == 0 for m in targets if m < line.month)

    # Credit only once every month extra money could pay is paid in full.
    if led.credit_paise:
        assert all(by[m].remaining_paise == 0 for m in targets)
        assert led.owed_paise == 0
    # Owed is what's left on due months after allocation.
    assert led.owed_paise == sum(by[m].remaining_paise for m in ledger.due_months(s, current))


@settings(max_examples=200, deadline=None)
@given(s=records(), current=months, seed=st.integers())
def test_allocation_is_deterministic_whatever_order_payments_come_in(
    s: StudentRecord, current: dt.date, seed: int
) -> None:
    shuffled = list(s.payments)
    random.Random(seed).shuffle(shuffled)
    other = StudentRecord(
        id=s.id,
        name=s.name,
        joined_month=s.joined_month,
        left_month=s.left_month,
        fee_changes=s.fee_changes,
        payments=tuple(shuffled),
    )
    a = ledger.student_ledger(s, current)
    b = ledger.student_ledger(other, current)
    assert a.months == b.months
    assert (a.owed_paise, a.credit_paise, a.paid_ahead_paise) == (
        b.owed_paise,
        b.credit_paise,
        b.paid_ahead_paise,
    )


@settings(max_examples=200, deadline=None)
@given(s=records(), current=months, month=months, amount=st.integers(1, 6000_00))
def test_another_payment_never_makes_anything_more_owed(
    s: StudentRecord, current: dt.date, month: dt.date, amount: int
) -> None:
    more = StudentRecord(
        id=s.id,
        name=s.name,
        joined_month=s.joined_month,
        left_month=s.left_month,
        fee_changes=s.fee_changes,
        payments=(*s.payments, Payment(month, amount, dt.date(2027, 1, 1), 10_000)),
    )
    before = {line.month: line for line in ledger.student_ledger(s, current).months}
    after = {line.month: line for line in ledger.student_ledger(more, current).months}
    assert ledger.owed(more, current) <= ledger.owed(s, current)
    for m, line in before.items():
        assert after[m].remaining_paise <= line.remaining_paise
    assert month_range(min(after), max(after)) == list(after)
