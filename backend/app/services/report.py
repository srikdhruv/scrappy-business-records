"""The monthly report for one month: loads every student and shapes `ledger.build_report`.

The screen (`GET /api/report`) and the Excel download (`GET /api/report.xlsx`,
`app/services/report_xlsx.py`) both come from `get_report`, so they always agree.
"""

from __future__ import annotations

import datetime as dt

from sqlalchemy.orm import Session

from app.months import format_month
from app.schemas import ReportResponse, ReportRow, ReportTotals
from app.services import ledger
from app.services.students import all_students, credit_sources_read, extra_sent_read, to_record


def _row(r: ledger.ReportRow) -> ReportRow:
    s, line = r.student, r.line
    return ReportRow(
        student_id=s.id,
        student_name=s.name,
        batch_label=s.batch_label,
        phone=s.phone,
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
    report = ledger.build_report(
        (to_record(s) for s in all_students(session)), month, current_month
    )
    rows = [_row(r) for r in report.rows]
    return ReportResponse(
        month=format_month(report.month),
        current_month=format_month(current_month),
        today=today,
        rows=rows,
        totals=totals(rows),
    )
