"""The dashboard for one month: loads every student and shapes `ledger.build_dashboard`."""

from __future__ import annotations

import datetime as dt

from sqlalchemy.orm import Session

from app.months import format_month
from app.schemas import (
    BacklogItem,
    BacklogMonth,
    CreditMoveItem,
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
        current_month=format_month(current_month),
        summary=DashboardSummary(
            expected_paise=s.expected_paise,
            collected_paise=s.collected_paise,
            paid_ahead_paise=s.paid_ahead_paise,
            still_due_paise=s.still_due_paise,
            not_fully_paid_count=s.not_fully_paid_count,
            active_student_count=s.active_student_count,
            logged_paise=s.logged_paise,
            covered_by_credit_paise=s.covered_by_credit_paise,
            sent_elsewhere_paise=s.sent_elsewhere_paise,
        ),
        yet_to_pay=[
            YetToPayItem(
                student_id=e.student.id,
                student_name=e.student.name,
                batch_label=e.student.batch_label,
                batch_name=e.student.batch_name,
                phone=e.student.phone,
                expected_paise=e.line.expected_paise,
                paid_paise=e.line.paid_paise,
                covered_by_credit_paise=e.line.covered_by_credit_paise,
                remaining_paise=e.line.remaining_paise,
                status=e.line.status,  # type: ignore[arg-type]
                credit_paise=e.credit_paise,
            )
            for e in board.yet_to_pay
        ],
        backlog=[
            BacklogItem(
                student_id=e.student.id,
                student_name=e.student.name,
                batch_label=e.student.batch_label,
                batch_name=e.student.batch_name,
                phone=e.student.phone,
                months=[
                    BacklogMonth(
                        month=format_month(line.month),
                        expected_paise=line.expected_paise,
                        paid_paise=line.paid_paise,
                        covered_by_credit_paise=line.covered_by_credit_paise,
                        remaining_paise=line.remaining_paise,
                        status=line.status,  # type: ignore[arg-type]
                    )
                    for line in e.lines
                ],
                total_owed_paise=e.total_owed_paise,
                credit_paise=e.credit_paise,
            )
            for e in board.backlog
        ],
        overpaid=[
            OverpaidItem(
                student_id=e.student.id,
                student_name=e.student.name,
                batch_label=e.student.batch_label,
                batch_name=e.student.batch_name,
                phone=e.student.phone,
                month=format_month(e.line.month),
                expected_paise=e.line.expected_paise,
                paid_paise=e.line.paid_paise,
                excess_paise=e.line.excess_paise,
                extra_unused_paise=e.line.extra_unused_paise,
            )
            for e in board.overpaid
        ],
        credit_moves=[
            CreditMoveItem(
                student_id=e.student.id,
                student_name=e.student.name,
                batch_label=e.student.batch_label,
                batch_name=e.student.batch_name,
                phone=e.student.phone,
                payment_id=e.move.payment.id,
                paid_on=e.move.payment.paid_on,  # type: ignore[arg-type]  # set when stored
                from_month=format_month(e.move.payment.for_month),
                to_month=format_month(e.move.to_month),
                amount_paise=e.move.amount_paise,
                payment_amount_paise=e.move.payment.amount_paise,
                payment_pays_until=format_month(
                    ledger.pays_until(e.use) if e.use else e.move.to_month
                ),
                payment_needs_check=e.needs_check,
                payment_months_ahead=ledger.months_ahead(e.use, current_month) if e.use else 0,
                payment_extra_unused_paise=e.use.unused_paise if e.use else 0,
            )
            for e in board.credit_moves
        ],
    )
