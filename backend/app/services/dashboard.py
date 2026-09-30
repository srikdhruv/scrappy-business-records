"""The dashboard for one month: loads every student and shapes `ledger.build_dashboard`."""

from __future__ import annotations

import datetime as dt

from sqlalchemy.orm import Session

from app.months import format_month
from app.schemas import (
    BacklogItem,
    BacklogMonth,
    DashboardResponse,
    DashboardSummary,
    OverpaidItem,
    YetToPayItem,
)
from app.services import ledger
from app.services.students import all_students, to_record


def get_dashboard(session: Session, month: dt.date, current_month: dt.date) -> DashboardResponse:
    board = ledger.build_dashboard(
        (to_record(s) for s in all_students(session)), month, current_month
    )
    s = board.summary
    return DashboardResponse(
        month=format_month(board.month),
        summary=DashboardSummary(
            expected_paise=s.expected_paise,
            collected_paise=s.collected_paise,
            still_due_paise=s.still_due_paise,
            not_fully_paid_count=s.not_fully_paid_count,
            active_student_count=s.active_student_count,
        ),
        yet_to_pay=[
            YetToPayItem(
                student_id=e.student.id,
                student_name=e.student.name,
                batch_label=e.student.batch_label,
                phone=e.student.phone,
                expected_paise=e.line.expected_paise,
                paid_paise=e.line.paid_paise,
                remaining_paise=e.line.remaining_paise,
                status=e.line.status,  # type: ignore[arg-type]
            )
            for e in board.yet_to_pay
        ],
        backlog=[
            BacklogItem(
                student_id=e.student.id,
                student_name=e.student.name,
                batch_label=e.student.batch_label,
                phone=e.student.phone,
                months=[
                    BacklogMonth(
                        month=format_month(line.month),
                        expected_paise=line.expected_paise,
                        paid_paise=line.paid_paise,
                        remaining_paise=line.remaining_paise,
                        status=line.status,  # type: ignore[arg-type]
                    )
                    for line in e.lines
                ],
                total_owed_paise=e.total_owed_paise,
            )
            for e in board.backlog
        ],
        overpaid=[
            OverpaidItem(
                student_id=e.student.id,
                student_name=e.student.name,
                month=format_month(e.line.month),
                expected_paise=e.line.expected_paise,
                paid_paise=e.line.paid_paise,
                excess_paise=e.line.excess_paise,
            )
            for e in board.overpaid
        ],
    )
