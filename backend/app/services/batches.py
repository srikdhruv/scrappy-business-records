"""Batches: the classes students come to. Creating, editing and deleting them, each batch's
fees for a month, and turning the old free-text "class or batch" labels into batches.

A student is in one batch or none (`students.batch_id`). A batch's `default_fee_paise` only
prefills the fee of a student added to it: every student keeps their own fee, so changing a
batch's fee changes no student's fee, unless the owner also asks for that (`apply_fee`), which
records an ordinary fee change for each student she chose.

A batch's numbers for a month are the dashboard's own (`ledger.build_dashboard`), worked out
over that batch's students only, so every batch plus "no batch" adds up to the dashboard.
"""

from __future__ import annotations

import datetime as dt
import re
from collections import Counter, defaultdict
from dataclasses import dataclass

from fastapi import HTTPException, status
from sqlalchemy import select, update
from sqlalchemy.orm import Session

from app import backup
from app.db import lock_for_writing
from app.errors import not_found, unprocessable
from app.models import WEEKDAYS, Batch, FeeKind, Student
from app.months import add_months, format_month, parse_month
from app.schemas import (
    BatchCreate,
    BatchOverview,
    BatchRead,
    BatchSummary,
    BatchUpdate,
    FeeChangeRead,
    FeePlan,
    FeePlanStatus,
    FeePlanStudent,
    LabelConversion,
    LabelGroup,
    LabelPreview,
    Weekday,
)
from app.services import ledger
from app.services.bounds import latest_month, valid_id
from app.services.students import (
    LEDGER_ROWS,
    all_students,
    check_batch,
    same_text_key,
    set_fee_from,
    to_record,
)
from app.services.text import fold

# --------------------------------------------------------------------------- shapes


def days_to_mask(days: list[Weekday]) -> str:
    """["mon", "wed"] -> "1010000" (Monday first), as stored in `batches.days`."""
    chosen = {d.value for d in days}
    return "".join("1" if d in chosen else "0" for d in WEEKDAYS)


def mask_to_days(mask: str) -> list[Weekday]:
    return [Weekday(d) for d, bit in zip(WEEKDAYS, mask, strict=False) if bit == "1"]


def _is_active(student: Student, current_month: dt.date) -> bool:
    """PRD ledger rule 8, as `ledger.has_left`: Active until their left month has passed."""
    return student.left_month is None or student.left_month >= current_month


def _counts(session: Session, current_month: dt.date) -> dict[int, tuple[int, int]]:
    """batch id -> (everyone in it, those in it who haven't left), in one query."""
    counts: dict[int, list[int]] = defaultdict(lambda: [0, 0])
    rows = session.execute(
        select(Student.batch_id, Student.left_month).where(Student.batch_id.is_not(None))
    )
    for batch_id, left in rows:
        counts[batch_id][0] += 1
        if left is None or left >= current_month:
            counts[batch_id][1] += 1
    return {k: (v[0], v[1]) for k, v in counts.items()}


def batch_read(batch: Batch, counts: tuple[int, int] = (0, 0)) -> BatchRead:
    return BatchRead(
        id=batch.id,
        name=batch.name,
        location=batch.location,
        days=mask_to_days(batch.days),
        start_time=batch.start_time,
        end_time=batch.end_time,
        default_fee_paise=batch.default_fee_paise,
        notes=batch.notes,
        student_count=counts[0],
        active_student_count=counts[1],
        created_at=batch.created_at,  # type: ignore[arg-type]
        updated_at=batch.updated_at,  # type: ignore[arg-type]
    )


def _sort_key(batch: Batch) -> tuple[tuple[tuple[int, int | str], ...], int]:
    """By name, ignoring capitals and accents, with numbers in number order: "Batch 2" before
    "Batch 10"."""
    parts = re.split(r"(\d+)", fold(batch.name))
    return (tuple((0, int(p)) if p.isdigit() else (1, p) for p in parts if p), batch.id)


# --------------------------------------------------------------------------- queries


def _all_batches(session: Session) -> list[Batch]:
    return sorted(session.scalars(select(Batch)), key=_sort_key)


def list_batches(session: Session, current_month: dt.date) -> list[BatchRead]:
    """Every batch, sorted by name (ignoring capitals and accents)."""
    counts = _counts(session, current_month)
    return [batch_read(b, counts.get(b.id, (0, 0))) for b in _all_batches(session)]


def _get_row(session: Session, batch_id: int) -> Batch:
    batch = session.get(Batch, batch_id) if valid_id(batch_id) else None
    if batch is None:
        raise not_found("batch", batch_id)
    return batch


def get_batch(session: Session, batch_id: int, current_month: dt.date) -> BatchRead:
    batch = _get_row(session, batch_id)
    return batch_read(batch, _counts(session, current_month).get(batch.id, (0, 0)))


def _summary(
    batch_id: int | None, students: list[ledger.StudentRecord], month: dt.date, current: dt.date
) -> BatchSummary:
    """The dashboard's summary for `month`, over these students only."""
    s = ledger.build_dashboard(students, month, current).summary
    count = sum(1 for r in students if r.is_active(month))
    paid = s.expected_paise - s.still_due_paise
    return BatchSummary(
        batch_id=batch_id,
        student_count=count,
        active_student_count=s.active_student_count,
        expected_paise=s.expected_paise,
        collected_paise=s.collected_paise,
        still_due_paise=s.still_due_paise,
        paid_ahead_paise=s.paid_ahead_paise,
        not_fully_paid_count=s.not_fully_paid_count,
        # Rounded down, so it only says 100% once every fee for the month is paid.
        paid_percent=paid * 100 // s.expected_paise if s.expected_paise > 0 else None,
    )


def overview(session: Session, month: dt.date, current_month: dt.date) -> BatchOverview:
    """Each batch's fees for `month`, and those of the students in no batch. Three queries for
    the students (as the dashboard) and one for the batches."""
    by_batch: dict[int | None, list[ledger.StudentRecord]] = defaultdict(list)
    for student in all_students(session):
        by_batch[student.batch_id].append(to_record(student))
    return BatchOverview(
        month=format_month(month),
        current_month=format_month(current_month),
        batches=[
            _summary(b.id, by_batch.get(b.id, []), month, current_month)
            for b in _all_batches(session)
        ],
        no_batch=_summary(None, by_batch.get(None, []), month, current_month),
    )


# --------------------------------------------------------------------------- changes


def _check_name_free(session: Session, name: str, batch_id: int | None = None) -> None:
    """Batch names are unique, ignoring capitals, accents and spaces."""
    key = same_text_key(name)
    for other in session.scalars(select(Batch)):
        if other.id != batch_id and same_text_key(other.name) == key:
            raise unprocessable(
                f"There's already a batch called {other.name}. Choose another name.",
                field="name",
            )


def create_batch(session: Session, body: BatchCreate, current_month: dt.date) -> BatchRead:
    lock_for_writing(session)
    _check_name_free(session, body.name)
    batch = Batch(
        name=body.name,
        location=body.location,
        days=days_to_mask(body.days),
        start_time=body.start_time,
        end_time=body.end_time,
        default_fee_paise=body.default_fee_paise,
        notes=body.notes,
    )
    session.add(batch)
    session.commit()
    return get_batch(session, batch.id, current_month)


def update_batch(
    session: Session, batch_id: int, body: BatchUpdate, current_month: dt.date
) -> BatchRead:
    """Partial update. With `apply_fee`, the new `default_fee_paise` is also recorded as a fee
    change for each student named, from `apply_fee.from_month` (see `_apply_fee`), in the same
    transaction: all of it is saved, or none of it."""
    lock_for_writing(session)
    batch = _get_row(session, batch_id)
    sent = body.model_fields_set
    if "name" in sent and body.name is not None:
        _check_name_free(session, body.name, batch.id)
    start = body.start_time if "start_time" in sent else batch.start_time
    end = body.end_time if "end_time" in sent else batch.end_time
    if start is not None and end is not None and end <= start:
        field = "end_time" if "end_time" in sent else "start_time"
        raise unprocessable("The end time must be after the start time", field=field)

    if body.apply_fee is not None and body.default_fee_paise is not None:
        _apply_fee(
            session,
            batch,
            body.default_fee_paise,
            parse_month(body.apply_fee.from_month),
            body.apply_fee.student_ids,
            body.apply_fee.confirm_planned,
            current_month,
        )

    for name in ("name", "location", "start_time", "end_time", "default_fee_paise", "notes"):
        if name in sent:
            setattr(batch, name, getattr(body, name))
    if "days" in sent and body.days is not None:
        batch.days = days_to_mask(body.days)
    session.commit()
    return get_batch(session, batch.id, current_month)


def _too_late(from_month: dt.date, current_month: dt.date, loc: list[str]) -> None:
    latest = latest_month(current_month)
    if from_month > latest:
        raise HTTPException(
            status.HTTP_422_UNPROCESSABLE_CONTENT,
            detail=[
                {
                    "loc": loc,
                    "msg": f"The month the new fee starts can't be later than {latest:%B %Y} "
                    "(two years from now)",
                    "type": "value_error",
                }
            ],
        )


@dataclass
class _Plan:
    """What charging a batch's new usual fee from a month would do to one student. The one
    rule behind both the preview (`fee_plan`) and the change itself (`_apply_fee`)."""

    student: Student
    start: dt.date | None  # the month their new fee would start; None: not affected
    status: FeePlanStatus
    current_fee: int
    due_months: int  # months already due (up to the current month) whose fee would change
    due_change_paise: int  # how much more (or, below 0, less) those months would then owe

    @property
    def selectable(self) -> bool:
        return self.status in (FeePlanStatus.usual, FeePlanStatus.own_fee, FeePlanStatus.planned)


def _planned_changes(student: Student, current_month: dt.date) -> list[dt.date]:
    """Fee changes set for a month that hasn't started yet (never the first fee, the one they
    join on): a raise, a discount, a month off, or the months away of a return still to come."""
    rows = sorted(student.fee_changes, key=lambda f: f.effective_month)
    return [f.effective_month for f in rows[1:] if f.effective_month > current_month]


def _start_month(student: Student, from_month: dt.date) -> dt.date | None:
    """The month the new fee would start for them: `from_month`, or their joining month if
    later, or the month they came back if `from_month` falls in their months away. None if
    they leave before it."""
    month = max(from_month, student.joined_month)
    if student.left_month is not None and month > student.left_month:
        return None
    rows = sorted(student.fee_changes, key=lambda f: f.effective_month)
    in_effect = [f for f in rows if f.effective_month <= month]
    if in_effect and in_effect[-1].kind is FeeKind.away:
        return next(
            (
                f.effective_month
                for f in rows
                if f.effective_month > month and f.kind is FeeKind.fee
            ),
            None,  # away with no way back: never happens, since a return ends a gap
        )
    return month


def _plans(
    batch: Batch, fee: int, from_month: dt.date, students: list[Student], current_month: dt.date
) -> tuple[list[_Plan], int | None]:
    """Every student of the batch who hasn't left, and what the new fee would do to them, and
    the fee counted as "the usual one": the batch's old usual fee, or if it had none, the fee
    most of them pay (none on a tie).

    - `not_affected`: they leave before the new fee would start.
    - `already`: they'd already pay it then, and nothing is planned: nothing changes.
    - `planned`: a fee change is set for a month still to come. The new fee would end at it,
      or replace it: only with their own tick (`confirm_planned`).
    - `usual`: they pay the usual fee now (ticked at first).
    - `own_fee`: they pay something else (a discount, a free place): not ticked at first.
    """
    members = [s for s in students if s.batch_id == batch.id and not _has_left(s, current_month)]
    records = {s.id: to_record(s) for s in members}
    current = {s.id: ledger.current_fee(records[s.id], current_month) for s in members}
    usual = batch.default_fee_paise
    if usual is None and members:
        counts = Counter(current.values()).most_common()
        if len(counts) == 1 or counts[0][1] > counts[1][1]:
            usual = counts[0][0]
    plans: list[_Plan] = []
    for s in sorted(members, key=lambda s: (fold(s.name), s.id)):
        record = records[s.id]
        start = _start_month(s, from_month)
        due_months = due_change = 0
        if start is None:
            status_ = FeePlanStatus.not_affected
        else:
            later = [f.effective_month for f in record.fee_changes if f.effective_month > start]
            until = min(later) if later else None
            m = start
            while m <= current_month and (until is None or m < until):
                if record.is_active(m) and record.fee_in_effect(m) != fee:
                    due_months += 1
                    due_change += fee - record.fee_in_effect(m)
                m = add_months(m, 1)
            if _planned_changes(s, current_month):
                status_ = FeePlanStatus.planned
            elif record.fee_in_effect(start) == fee:
                status_ = FeePlanStatus.already
            elif usual is not None and current[s.id] == usual:
                status_ = FeePlanStatus.usual
            else:
                status_ = FeePlanStatus.own_fee
        plans.append(_Plan(s, start, status_, current[s.id], due_months, due_change))
    return plans, usual


def _has_left(student: Student, current_month: dt.date) -> bool:
    return student.left_month is not None and student.left_month < current_month


def fee_plan(
    session: Session, batch_id: int, fee: int, from_month: dt.date, current_month: dt.date
) -> FeePlan:
    """The preview for "Also charge the new usual fee to its students": each student of the
    batch who hasn't left, what would happen to them, and whether they're ticked at first."""
    batch = _get_row(session, batch_id)
    _too_late(from_month, current_month, ["query", "from_month"])
    students = list(
        session.scalars(select(Student).where(Student.batch_id == batch.id).options(*LEDGER_ROWS))
    )
    plans, usual = _plans(batch, fee, from_month, students, current_month)
    return FeePlan(
        batch_id=batch.id,
        fee_paise=fee,
        from_month=format_month(from_month),
        current_month=format_month(current_month),
        usual_fee_paise=usual,
        students=[
            FeePlanStudent(
                student_id=p.student.id,
                student_name=p.student.name,
                current_fee_paise=p.current_fee,
                start_month=format_month(p.start) if p.start else None,
                status=p.status,
                selected=p.status is FeePlanStatus.usual,
                due_months=p.due_months,
                due_change_paise=p.due_change_paise,
                fee_history=[
                    FeeChangeRead(
                        id=f.id,
                        effective_month=format_month(f.effective_month),
                        amount_paise=f.amount_paise,
                        kind=f.kind,
                    )
                    for f in sorted(p.student.fee_changes, key=lambda f: f.effective_month)
                ],
            )
            for p in plans
        ],
    )


def _apply_fee(
    session: Session,
    batch: Batch,
    fee: int,
    from_month: dt.date,
    student_ids: list[int],
    confirm_planned: list[int],
    current_month: dt.date,
) -> None:
    """Charge `fee` to each of these students of the batch, from the month `fee_plan` says
    (`_start_month`), with the same rule as changing a fee in Edit (`students.set_fee_from`):
    earlier months keep their fee, and the new one lasts until the next fee change already set.

    Students who leave before it, or already pay it, are left as they are. A student with a fee
    change planned for a later month is only changed if they're also in `confirm_planned` (the
    owner ticked them after reading what it does): otherwise 422, and nothing is saved.
    422 too if a student isn't in this batch (moved in another window) or the month is too late.
    """
    _too_late(from_month, current_month, ["body", "apply_fee", "from_month"])
    wanted = list(dict.fromkeys(student_ids))
    students = [
        session.get(Student, sid, options=LEDGER_ROWS, populate_existing=True)
        if valid_id(sid)
        else None
        for sid in wanted
    ]
    if any(s is None or s.batch_id != batch.id for s in students):
        raise unprocessable(
            "Some of those students aren't in this batch any more. Close this and try again.",
            field="apply_fee",
        )
    plans, _ = _plans(batch, fee, from_month, students, current_month)  # type: ignore[arg-type]
    confirmed = set(confirm_planned)
    for plan in plans:
        if plan.status is FeePlanStatus.planned and plan.student.id not in confirmed:
            first = _planned_changes(plan.student, current_month)[0]
            raise unprocessable(
                f"{plan.student.name} has a fee change planned for {first:%B %Y}. Tick them "
                "only if the new fee should apply to them anyway.",
                field="apply_fee",
            )
    for plan in plans:
        if plan.selectable and plan.start is not None:
            set_fee_from(session, plan.student, plan.start, fee)


def move_students(session: Session, student_ids: list[int], batch_id: int | None) -> int:
    """Put these students in one batch (or none), all at once. Nothing else about them
    changes: not their fee, not their label. 422 if the batch or a student doesn't exist."""
    lock_for_writing(session)
    check_batch(session, batch_id)
    wanted = list(dict.fromkeys(student_ids))
    found = (
        list(
            session.scalars(
                select(Student).where(Student.id.in_([i for i in wanted if valid_id(i)]))
            )
        )
        if wanted
        else []
    )
    if len(found) != len(wanted):
        raise unprocessable(
            "Some of those students don't exist any more. Reload the page and try again.",
            field="student_ids",
        )
    for student in found:
        student.batch_id = batch_id
    session.commit()
    return len(found)


def delete_batch(session: Session, batch_id: int) -> None:
    """Delete a batch. Its students stay, in no batch: they are taken out of it here, and the
    database's `ON DELETE SET NULL` would do the same."""
    lock_for_writing(session)
    batch = _get_row(session, batch_id)
    session.execute(update(Student).where(Student.batch_id == batch.id).values(batch_id=None))
    session.delete(batch)
    session.commit()


# --------------------------------------------------------------------------- old labels


@dataclass
class _Group:
    key: str
    students: list[Student]
    existing: Batch | None

    @property
    def spellings(self) -> list[str]:
        counts = Counter(" ".join((s.batch_label or "").split()) for s in self.students)
        # Most used first; ties alphabetically, so the same data always gives the same name.
        return [label for label, _ in sorted(counts.items(), key=lambda kv: (-kv[1], fold(kv[0])))]

    @property
    def name(self) -> str:
        return self.existing.name if self.existing else self.spellings[0]


def _label_groups(session: Session) -> list[_Group]:
    """Students in no batch whose label isn't blank, grouped by label ignoring capitals,
    accents and spaces. A group whose name matches an existing batch goes into that batch."""
    batches = {same_text_key(b.name): b for b in session.scalars(select(Batch))}
    grouped: dict[str, list[Student]] = defaultdict(list)
    for student in session.scalars(
        select(Student).where(Student.batch_id.is_(None), Student.batch_label.is_not(None))
    ):
        key = same_text_key(student.batch_label or "")
        if key:
            grouped[key].append(student)
    groups = [
        _Group(key, sorted(rows, key=lambda s: (fold(s.name), s.id)), batches.get(key))
        for key, rows in grouped.items()
    ]
    return sorted(groups, key=lambda g: (fold(g.name), g.key))


def label_preview(session: Session, current_month: dt.date) -> LabelPreview:
    groups = _label_groups(session)
    return LabelPreview(
        groups=[
            LabelGroup(
                name=g.name,
                labels=g.spellings,
                student_count=len(g.students),
                student_names=[s.name for s in g.students],
                left_student_names=[s.name for s in g.students if _has_left(s, current_month)],
                active_student_count=sum(1 for s in g.students if not _has_left(s, current_month)),
                existing_batch_id=g.existing.id if g.existing else None,
            )
            for g in groups
        ],
        student_count=sum(len(g.students) for g in groups),
        new_batch_count=sum(1 for g in groups if g.existing is None),
    )


def convert_labels(session: Session) -> LabelConversion:
    """Create a batch for each group of labels (or use the batch of that name) and place its
    students in it, all in one transaction, after a `pre-batches` backup. Labels stay exactly
    as they were typed. Running it again does nothing: the students are in a batch now.

    Worked out again here, holding the write lock, rather than trusting the preview."""
    lock_for_writing(session)
    groups = _label_groups(session)
    if not groups:
        session.rollback()
        return LabelConversion(batches_created=0, students_placed=0, backup_file=None)
    try:
        saved = backup.backup("pre-batches")
    except Exception:
        session.rollback()
        raise unprocessable(
            "Couldn't save a backup first, so nothing was changed. Try again, or restart the "
            "laptop and try again."
        ) from None

    created = placed = 0
    for g in groups:
        batch = g.existing
        if batch is None:
            batch = Batch(name=g.name[:200])
            session.add(batch)
            session.flush()
            created += 1
        for student in g.students:
            student.batch_id = batch.id
            placed += 1
    session.commit()
    return LabelConversion(
        batches_created=created,
        students_placed=placed,
        backup_file=saved.name if saved else None,
    )
