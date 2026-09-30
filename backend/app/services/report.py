"""The monthly report for one month: loads every student and shapes `ledger.build_report`.

The screen (`GET /api/report`) and the Excel download (`GET /api/report.xlsx`,
`app/services/report_xlsx.py`) both come from `get_report`, so they always agree. The download
also takes the screen's filter, search and sort (`shown`), which work exactly as the Report page's
(`frontend/src/lib/report.ts` and `lib/search.ts`), so the file has the rows on screen.
"""

from __future__ import annotations

import datetime as dt
import re

from sqlalchemy import func, select
from sqlalchemy.orm import Session

from app.models import FeeKind, Student, UnassignedPayment
from app.months import format_month, parse_month
from app.schemas import (
    NoFeeReason,
    ReportCheck,
    ReportFilter,
    ReportResponse,
    ReportRow,
    ReportSort,
    ReportStatus,
    ReportTotals,
    SortOrder,
)
from app.services import ledger
from app.services.students import all_students, credit_sources_read, extra_sent_read, to_record
from app.services.text import search_fold


def _no_fee_reason(student: Student, r: ledger.ReportRow) -> NoFeeReason | None:
    if r.status is not ReportStatus.no_fee:
        return None
    month = r.line.month
    if month < student.joined_month:
        return NoFeeReason.not_joined
    in_effect = max(
        (f for f in student.fee_changes if f.effective_month <= month),
        key=lambda f: f.effective_month,
        default=None,
    )
    return (
        NoFeeReason.away
        if in_effect is not None and in_effect.kind == FeeKind.away
        else NoFeeReason.zero_fee
    )


def _check(use: ledger.PaymentUse, current_month: dt.date) -> ReportCheck:
    return ReportCheck(
        payment_id=use.payment.id,
        paid_on=use.payment.paid_on,  # type: ignore[arg-type]  # set when stored
        amount_paise=use.payment.amount_paise,
        pays_until=format_month(ledger.pays_until(use)),
        months_ahead=ledger.months_ahead(use, current_month),
        extra_unused_paise=use.unused_paise,
    )


def _row(student: Student, r: ledger.ReportRow, current_month: dt.date) -> ReportRow:
    s, line = r.student, r.line
    return ReportRow(
        student_id=s.id,
        student_name=s.name,
        batch_label=s.batch_label,
        phone=s.phone,
        joined_month=format_month(s.joined_month),
        left_month=format_month(s.left_month) if s.left_month else None,
        is_enrolled=r.is_enrolled,
        fee_paise=line.expected_paise,
        paid_paise=line.paid_paise,
        paid_direct_paise=line.paid_direct_paise,
        covered_by_credit_paise=line.covered_by_credit_paise,
        credit_sources=credit_sources_read(line.credit_sources),
        extra_sent_paise=r.extra_sent_paise,
        extra_sent=extra_sent_read(line.extra_sent),
        extra_unused_paise=line.extra_unused_paise,
        short_paise=line.remaining_paise,
        status=r.status,
        no_fee_reason=_no_fee_reason(student, r),
        checks=[_check(u, current_month) for u in r.checks],
        owed_before_paise=r.owed_before_paise,
        owed_before_months=[format_month(m.month) for m in r.owed_before],
        owed_now_paise=r.owed_now_paise,
        credit_paise=r.credit_paise,
        paid_ahead_paise=r.paid_ahead_paise,
    )


def totals(rows: list[ReportRow]) -> ReportTotals:
    """Sums over the rows, which match the dashboard summary for the month (see ReportTotals)."""

    def total(field: str) -> int:
        return sum(getattr(r, field) for r in rows)

    return ReportTotals(
        student_count=len(rows),
        fee_paise=total("fee_paise"),
        paid_paise=total("paid_paise"),
        paid_direct_paise=total("paid_direct_paise"),
        covered_by_credit_paise=total("covered_by_credit_paise"),
        collected_paise=total("paid_direct_paise") + total("covered_by_credit_paise"),
        extra_sent_paise=total("extra_sent_paise"),
        extra_unused_paise=total("extra_unused_paise"),
        short_paise=total("short_paise"),
        owed_before_paise=total("owed_before_paise"),
        owed_now_paise=total("owed_now_paise"),
        credit_paise=total("credit_paise"),
        paid_ahead_paise=total("paid_ahead_paise"),
        not_fully_paid_count=sum(1 for r in rows if r.short_paise > 0),
        active_student_count=sum(1 for r in rows if r.is_enrolled and r.fee_paise > 0),
    )


def get_report(
    session: Session, month: dt.date, current_month: dt.date, today: dt.date
) -> ReportResponse:
    students = all_students(session)
    by_id = {s.id: s for s in students}
    report = ledger.build_report((to_record(s) for s in students), month, current_month)
    rows = [_row(by_id[r.student.id], r, current_month) for r in report.rows]
    # Payments from an upload with no student yet: counted nowhere, so the report says so.
    count, paise = session.execute(
        select(func.count(), func.coalesce(func.sum(UnassignedPayment.amount_paise), 0)).where(
            UnassignedPayment.for_month == month
        )
    ).one()
    return ReportResponse(
        month=format_month(report.month),
        current_month=format_month(current_month),
        today=today,
        rows=rows,
        totals=totals(rows),
        unassigned_count=count,
        unassigned_paise=paise,
    )


# --------------------------------------------------------------------------- what's on screen
# The same rules as the Report page (frontend/src/lib/report.ts, lib/search.ts).


def filter_words(f: ReportFilter, month: str, current_month: str) -> str | None:
    """The status list's words (`lib/report.ts` `statusFilterLabel`), or None for one status.
    For a past month, "Owes anything" is "Still owes for Aug 2026 or earlier"."""
    if f is ReportFilter.all:
        return "Everyone"
    if f is ReportFilter.owes:
        if month < current_month:
            return f"Still owes for {parse_month(month):%b %Y} or earlier"
        return "Owes anything"
    if f is ReportFilter.short:
        return "Short this month"
    return None


def owes_through_month(row: ReportRow, month: str, current_month: str) -> bool:
    """`owes`: anything still owed, as of today, for M or an earlier month. From the current
    month on that is everything owed now; for a past month, debts that started after it don't
    count (what's left on M, plus the months before it)."""
    if month < current_month:
        return row.owed_before_paise + row.short_paise > 0
    return row.owed_now_paise > 0


def matches_filter(row: ReportRow, f: ReportFilter, month: str, current_month: str) -> bool:
    if f is ReportFilter.all:
        return True
    if f is ReportFilter.owes:
        return owes_through_month(row, month, current_month)
    if f is ReportFilter.short:
        return row.short_paise > 0
    return row.status.value == f.value


_PHONE_LIKE = re.compile(r"^[\d\s()+\-./]+$")


def _digits(text: str) -> str:
    digits = re.sub(r"\D", "", text)
    if len(digits) == 12 and digits.startswith("91"):
        return digits[2:]
    if len(digits) == 11 and digits.startswith("0"):
        return digits[1:]
    return digits


def matches_search(row: ReportRow, query: str) -> bool:
    """`lib/search.ts` `studentMatches`, over the name, class and phone."""
    words = search_fold(query).split()
    if not words:
        return True
    text = search_fold(" ".join(t for t in (row.student_name, row.batch_label, row.phone) if t))
    phone = _digits(row.phone or "")

    def in_phone(typed: str) -> bool:
        digits = _digits(typed)
        return bool(digits) and digits in phone

    if _PHONE_LIKE.match(query.strip()) and in_phone(query):
        return True
    return all(w in text or (_PHONE_LIKE.match(w) and in_phone(w)) for w in words)


def _sort_value(row: ReportRow, key: ReportSort) -> str | int:
    match key:
        case ReportSort.student:
            return search_fold(row.student_name)
        case ReportSort.batch:
            return search_fold(row.batch_label or "")
        case ReportSort.status:
            return ledger.REPORT_STATUS_ORDER.index(row.status)
        case ReportSort.fee:
            return row.fee_paise
        case ReportSort.paid:
            return row.paid_paise
        case ReportSort.short:
            return row.short_paise
        case ReportSort.owed_now:
            return row.owed_now_paise
        case ReportSort.covered:
            return row.covered_by_credit_paise
        case ReportSort.extra:
            return row.extra_sent_paise + row.extra_unused_paise
        case ReportSort.owed_before:
            return row.owed_before_paise
        case ReportSort.credit:
            return row.credit_paise + row.paid_ahead_paise


def shown(
    report: ReportResponse,
    status: ReportFilter = ReportFilter.all,
    q: str | None = None,
    sort: ReportSort | None = None,
    order: SortOrder = SortOrder.asc,
) -> ReportResponse:
    """The report as the page shows it: filtered, searched and sorted, with totals for the rows
    shown. Ties keep the usual order (the server's), as on the page."""
    rows = [
        r
        for r in report.rows
        if matches_filter(r, status, report.month, report.current_month)
        and matches_search(r, q or "")
    ]
    if sort is not None:
        # Python's sort is stable, with reverse=True too: ties keep the usual order.
        rows.sort(key=lambda r: _sort_value(r, sort), reverse=order is SortOrder.desc)
    return report.model_copy(update={"rows": rows, "totals": totals(rows)})
