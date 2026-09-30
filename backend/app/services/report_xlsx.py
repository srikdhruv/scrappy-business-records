"""The monthly report as an Excel file (`GET /api/report.xlsx`): the rows the Report page shows
(its filter, search and sort, `app.services.report.shown`), with its columns in its order.

Row 1 is the title, with the filter if there is one ("Scrappy Records — Fees report, September
2026 · Short this month"), row 2 the date, then the headings (bold, frozen with the Student
column, with Excel's filter buttons), one row per student, a bold totals row of
`SUBTOTAL(109, …)` formulas (so they follow Excel's own filters too), and a **Collected** line
that matches the Dashboard. The sheet prints on A4 landscape, one page wide.

**Money** is a number of rupees (so it adds up) shown with the Indian grouping the screen uses,
₹1,07,73,749.50, by a conditional number format (`RUPEES`, `RUPEES_PAISE`): Excel number
formats only know groups of three, so the lakh and crore commas are literal commas (`\\,`) in
patterns picked by the amount, `[>=10000000]` (a crore or more) and `[>=100000]` (a lakh or
more). Excel allows two such conditions plus the rest; amounts here are never negative. A whole
number of rupees uses the pattern without paise. `tests/test_report.py` checks the strings.

Kept small and on its own on purpose. It follows the same approach as the Excel downloads PR
(`openpyxl`, the heading colour, text that is never a formula, the same download headers), so
the two can share one helper module once both are in.
"""

from __future__ import annotations

import datetime as dt
import io
from collections.abc import Sequence
from dataclasses import dataclass
from typing import Any

from openpyxl import Workbook
from openpyxl.cell.cell import ILLEGAL_CHARACTERS_RE
from openpyxl.styles import Alignment, Border, Font, PatternFill, Side
from openpyxl.utils import get_column_letter
from openpyxl.worksheet.worksheet import Worksheet

from app.months import add_months, parse_month
from app.schemas import (
    CreditSource,
    ExtraSent,
    NoFeeReason,
    ReportCheck,
    ReportFilter,
    ReportGroup,
    ReportResponse,
    ReportRow,
    ReportSort,
    ReportStatus,
    SortOrder,
)
from app.services.report import filter_words

XLSX = "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"

STATUS_WORDS = {
    ReportStatus.paid: "Paid",
    ReportStatus.paid_with_credit: "Paid (from extra)",
    ReportStatus.partial: "Partial",
    ReportStatus.unpaid: "Unpaid",
    ReportStatus.no_fee: "No fee",
    ReportStatus.not_due_yet: "Not due yet",
    ReportStatus.left: "Left",
}
"""The words on the Report screen (`frontend/src/lib/report.ts`)."""

NO_FEE_WORDS = {
    NoFeeReason.not_joined: "Not joined yet",
    NoFeeReason.away: "Away (no fee)",
    NoFeeReason.zero_fee: "No fee",
}

SORT_WORDS = {
    ReportSort.student: "Student",
    ReportSort.status: "Status",
    ReportSort.fee: "Fee",
    ReportSort.paid: "Paid for this month",
    ReportSort.short: "Short",
    ReportSort.owed_now: "Total owed now",
    ReportSort.covered: "Paid from another payment's extra",
    ReportSort.extra: "Extra sent elsewhere",
    ReportSort.owed_before: "Owed from earlier months",
    ReportSort.credit: "Kept as credit / paid ahead",
    ReportSort.batch: "Class/batch",
}

RUPEES = r'[>=10000000]"₹"##\,##\,##\,##0;[>=100000]"₹"##\,##\,##0;"₹"#,##0'
RUPEES_PAISE = r'[>=10000000]"₹"##\,##\,##\,##0.00;[>=100000]"₹"##\,##\,##0.00;"₹"#,##0.00'

_HEAD_FONT = Font(bold=True)
_GROUP_FILL = PatternFill("solid", fgColor="F2E9D8")  # the app's muted cream
_HEAD_FILL = PatternFill("solid", fgColor="FBEFD5")  # the app's cream-marigold
_TITLE_FONT = Font(bold=True, size=14)
_TOTAL_BORDER = Border(top=Side(style="thin"))
_DASH = "\u2013"  # the en dash, as in "Jan-Jun 2026" on screen

HEADER_ROW = 4
"""Row 1 is the title, row 2 the date, row 3 is empty."""


@dataclass(frozen=True)
class _Column:
    heading: str
    width: float
    money: bool = False


COLUMNS: tuple[_Column, ...] = (
    _Column("Student", 26),
    _Column("Status", 20),
    _Column("Fee ₹", 11, money=True),
    _Column("Paid for this month ₹", 13, money=True),
    _Column("Short ₹", 11, money=True),
    _Column("Total owed now ₹", 13, money=True),
    _Column("Paid from another payment's extra ₹", 15, money=True),
    _Column("Came from", 34),
    _Column("Extra sent elsewhere ₹", 13, money=True),
    _Column("Went to", 22),
    _Column("Extra kept as credit ₹", 12, money=True),
    _Column("Owed from earlier months ₹", 14, money=True),
    _Column("Earlier months owed", 26),
    _Column("Kept as credit, all months ₹", 13, money=True),
    _Column("Paid ahead ₹", 12, money=True),
    _Column("Check", 40),
    _Column("Class/batch", 24),
    _Column("Phone", 15),
)
_COL = {c.heading: i for i, c in enumerate(COLUMNS, start=1)}


def rupees(paise: int) -> str:
    """₹ in Indian grouping, as on screen: 15000000 -> "₹1,50,000"; 150050 -> "₹1,500.50"."""
    whole, part = divmod(abs(paise), 100)
    digits = str(whole)
    if len(digits) > 3:
        head, tail = digits[:-3], digits[-3:]
        groups = []
        while len(head) > 2:
            groups.insert(0, head[-2:])
            head = head[:-2]
        digits = ",".join([head, *groups, tail])
    sign = "-" if paise < 0 else ""
    return f"{sign}₹{digits}" + (f".{part:02d}" if part else "")


def _date(value: dt.date) -> str:
    return f"{value.day} {value:%b %Y}"


def _month_short(month: str) -> str:
    return f"{parse_month(month):%b %Y}"


def month_long(month: str) -> str:
    return f"{parse_month(month):%B %Y}"


def month_runs(months: Sequence[str]) -> str:
    """Months owed, in short, a run of months at a time, as on screen (`lib/report.ts`
    `formatMonthRuns`): "Apr 2026", "Jan-Jun 2026 (6 months)", "Dec 2025-Feb 2026 (3 months)",
    with an en dash."""
    runs: list[list[str]] = []
    for m in months:
        if runs and add_months(parse_month(runs[-1][-1]), 1) == parse_month(m):
            runs[-1].append(m)
        else:
            runs.append([m])
    parts = []
    for run in runs:
        first, last = run[0], run[-1]
        if len(run) == 1:
            parts.append(_month_short(first))
            continue
        start = f"{parse_month(first):%b}" if first[:4] == last[:4] else _month_short(first)
        parts.append(f"{start}{_DASH}{_month_short(last)} ({len(run)} months)")
    return ", ".join(parts)


def status_words(r: ReportRow) -> str:
    if r.status is ReportStatus.left and r.left_month:
        return f"Left after {month_long(r.left_month)}"
    if r.status is ReportStatus.no_fee and r.no_fee_reason:
        return NO_FEE_WORDS[r.no_fee_reason]
    return STATUS_WORDS[r.status]


def credit_from_text(sources: Sequence[CreditSource]) -> str:
    """ "₹1,500 from the 5 Sep 2026 payment (for Sep 2026)", one per source."""
    return "; ".join(
        f"{rupees(s.amount_paise)} from the {_date(s.paid_on)} payment "
        f"(for {_month_short(s.for_month)})"
        for s in sources
    )


def extra_went_text(sent: Sequence[ExtraSent]) -> str:
    """Where the extra went, a run of months at a time, as on screen (`lib/report.ts`
    `extraRuns`): "₹1,500 → Aug 2026", "₹13,500 → Oct 2026-Jun 2027 (9 months)" (en dash)."""
    runs: list[list[ExtraSent]] = []
    for e in sent:
        last = runs[-1][-1] if runs else None
        if last and add_months(parse_month(last.to_month), 1) == parse_month(e.to_month):
            runs[-1].append(e)
        else:
            runs.append([e])
    return "; ".join(
        f"{rupees(sum(e.amount_paise for e in run))} → {month_runs([e.to_month for e in run])}"
        for run in runs
    )


def check_text(c: ReportCheck) -> str:
    """The dashboard's note (`lib/credit.ts` `checkText`): "Check: this ₹30,000 payment pays up
    to Feb 2027 — 5 months ahead; ₹500 isn't needed by any month"."""
    reasons = []
    if c.months_ahead >= 4:
        reasons.append(f"pays up to {_month_short(c.pays_until)} — {c.months_ahead} months ahead")
    if c.extra_unused_paise > 0:
        reasons.append(f"{rupees(c.extra_unused_paise)} isn't needed by any month")
    what = f"this {rupees(c.amount_paise)} payment"
    if not reasons:
        return f"Check: {what}"
    first, *rest = reasons
    joined = "; ".join([first if first.startswith("pays") else f"— {first}", *rest])
    return f"Check: {what} {joined}"


def _values(r: ReportRow) -> list[Any]:
    return [
        r.student_name,
        status_words(r),
        r.fee_paise,
        r.paid_paise,
        r.short_paise,
        r.owed_now_paise,
        r.covered_by_credit_paise,
        credit_from_text(r.credit_sources),
        r.extra_sent_paise,
        extra_went_text(r.extra_sent),
        r.extra_unused_paise,
        r.owed_before_paise,
        month_runs(r.owed_before_months),
        r.credit_paise,
        r.paid_ahead_paise,
        "; ".join(check_text(c) for c in r.checks),
        r.batch_name or r.batch_label,
        r.phone,
    ]


def _put(ws: Worksheet, row: int, col: int, column: _Column, value: Any) -> None:
    fmt = None
    if column.money and isinstance(value, int):
        fmt = RUPEES if value % 100 == 0 else RUPEES_PAISE
        value = value // 100 if value % 100 == 0 else value / 100
    elif isinstance(value, str):
        value = ILLEGAL_CHARACTERS_RE.sub("", value) or None
    cell = ws.cell(row=row, column=col, value=value)
    if isinstance(value, str):
        cell.data_type = "s"  # a name starting with "=" stays text: never a formula
    if fmt:
        cell.number_format = fmt


SUMMED = (
    "Fee ₹",
    "Paid for this month ₹",
    "Short ₹",
    "Total owed now ₹",
    "Paid from another payment's extra ₹",
    "Extra sent elsewhere ₹",
    "Extra kept as credit ₹",
    "Owed from earlier months ₹",
    "Kept as credit, all months ₹",
    "Paid ahead ₹",
)
"""The money columns the totals row (and a batch's subtotal row) adds up."""


def _formula(ws: Worksheet, row: int, col: int, formula: str, paise: bool) -> None:
    cell = ws.cell(row=row, column=col, value=formula)
    cell.number_format = RUPEES_PAISE if paise else RUPEES


_NOTE_FONT = Font(italic=True)


def unassigned_words(report: ReportResponse) -> str:
    """The note under the totals when uploaded payments for the month have no student yet."""
    n = report.unassigned_count
    what = "payment" if n == 1 else "payments"
    return (
        f"Also {rupees(report.unassigned_paise)} of {what} not yet matched to a student ({n} "
        f"{what} for {month_long(report.month)} from an upload): not counted above. Give them "
        "to a student in Payments → Unassigned payments."
    )


def filename(month: str) -> str:
    return f"scrappy-records-report-{month}.xlsx"


def title(month: str) -> str:
    return f"Scrappy Records — Fees report, {month_long(month)}"


def shown_words(
    report: ReportResponse,
    status: ReportFilter,
    q: str | None,
    sort: ReportSort | None,
    order: SortOrder,
) -> str:
    """What the rows are, for the title: "Short this month · matching "rao" · sorted by Short,
    largest first". Empty for everyone, in the usual order."""
    parts = []
    if status is not ReportFilter.all:
        words = filter_words(status, report.month, report.current_month)
        parts.append(words or STATUS_WORDS[ReportStatus(status.value)])
    if q and q.strip():
        parts.append(f'matching "{q.strip()}"')
    if sort is not None:
        text_sort = sort in (ReportSort.student, ReportSort.batch, ReportSort.status)
        way = ("Z to A" if text_sort else "largest first") if order is SortOrder.desc else None
        way = way or ("A to Z" if text_sort else "smallest first")
        parts.append(f"sorted by {SORT_WORDS[sort]}, {way}")
    return " · ".join(parts)


def workbook(
    report: ReportResponse,
    status: ReportFilter = ReportFilter.all,
    q: str | None = None,
    sort: ReportSort | None = None,
    order: SortOrder = SortOrder.asc,
    group: ReportGroup = ReportGroup.none,
    batch_words: str | None = None,
) -> bytes:
    """`report` is the rows to write (already filtered, sorted and grouped: `report.shown`);
    the other arguments only say so in the title. Grouped by batch, each batch's rows come
    under a heading row with its name and how many students."""
    book = Workbook()
    ws = book.active
    assert ws is not None
    ws.title = f"Report {_month_short(report.month)}"
    last_col = get_column_letter(len(COLUMNS))
    ahead = report.month > report.current_month

    heading = title(report.month)
    words = [w for w in (batch_words, shown_words(report, status, q, sort, order)) if w]
    if group is ReportGroup.batch:
        words.append("grouped by batch")
    if words:
        heading += " · " + " · ".join(words)
    ws["A1"] = ILLEGAL_CHARACTERS_RE.sub("", heading)
    ws["A1"].data_type = "s"
    ws["A1"].font = _TITLE_FONT
    ws["A2"] = (
        f"As of {_date(report.today)}. Payments count for the month they're for, not the day "
        "they were paid."
    )
    if ahead:
        ws["A2"] = (
            f"As of {_date(report.today)}. {month_long(report.month)} isn't due yet: what's "
            "paid for it is paid ahead."
        )

    for i, column in enumerate(COLUMNS, start=1):
        cell = ws.cell(row=HEADER_ROW, column=i, value=column.heading)
        cell.font = _HEAD_FONT
        cell.fill = _HEAD_FILL
        cell.alignment = Alignment(vertical="center", wrap_text=True)
        ws.column_dimensions[get_column_letter(i)].width = column.width
    ws.row_dimensions[HEADER_ROW].height = 45

    first = HEADER_ROW + 1
    row = HEADER_ROW
    has_paise: set[int] = set()  # columns with an amount in paise somewhere
    sizes: dict[str | None, int] = {}
    for r in report.rows:
        sizes[r.batch_name] = sizes.get(r.batch_name, 0) + 1
    grouped = group is ReportGroup.batch
    group_first = 0
    for n, r in enumerate(report.rows):
        if grouped and (n == 0 or r.batch_name != report.rows[n - 1].batch_name):
            row += 1
            count = sizes[r.batch_name]
            label = f"{r.batch_name or 'No batch'} ({count} student{'' if count == 1 else 's'})"
            _put(ws, row, 1, COLUMNS[0], label)
            ws.cell(row=row, column=1).font = _HEAD_FONT
            for i in range(1, len(COLUMNS) + 1):
                ws.cell(row=row, column=i).fill = _GROUP_FILL
            group_first = row + 1
        row += 1
        for i, (column, value) in enumerate(zip(COLUMNS, _values(r), strict=True), start=1):
            _put(ws, row, i, column, value)
            if column.money and isinstance(value, int) and value % 100:
                has_paise.add(i)
        last_of_group = n == len(report.rows) - 1 or report.rows[n + 1].batch_name != r.batch_name
        if grouped and last_of_group:
            # Each batch's subtotal: SUBTOTAL formulas, which the total below leaves out.
            row += 1
            _put(ws, row, 1, COLUMNS[0], f"Subtotal: {r.batch_name or 'No batch'}")
            for heading_text in SUMMED:
                col = _COL[heading_text]
                letter = get_column_letter(col)
                _formula(
                    ws, row, col, f"=SUBTOTAL(109,{letter}{group_first}:{letter}{row - 1})", True
                )
            for i in range(1, len(COLUMNS) + 1):
                ws.cell(row=row, column=i).font = _HEAD_FONT
    last = row

    t = report.totals
    total_row = row + 1
    count = f"{t.student_count} student" + ("" if t.student_count == 1 else "s")
    _put(ws, total_row, 1, COLUMNS[0], f"Total ({count})")
    wording = "not paid ahead" if ahead else "not fully paid"
    _put(
        ws,
        total_row,
        2,
        COLUMNS[1],
        f"{t.not_fully_paid_count} of {t.active_student_count} {wording}",
    )
    sums = {
        "Fee ₹": t.fee_paise,
        "Paid for this month ₹": t.paid_paise,
        "Short ₹": t.short_paise,
        "Total owed now ₹": t.owed_now_paise,
        "Paid from another payment's extra ₹": t.covered_by_credit_paise,
        "Extra sent elsewhere ₹": t.extra_sent_paise,
        "Extra kept as credit ₹": t.extra_unused_paise,
        "Owed from earlier months ₹": t.owed_before_paise,
        "Kept as credit, all months ₹": t.credit_paise,
        "Paid ahead ₹": t.paid_ahead_paise,
    }
    for heading_text, paise in sums.items():
        col = _COL[heading_text]
        letter = get_column_letter(col)
        if report.rows:
            # SUBTOTAL(109, …) adds up only the rows Excel's own filter shows.
            _formula(
                ws,
                total_row,
                col,
                f"=SUBTOTAL(109,{letter}{first}:{letter}{last})",
                # With paise if any row has some, so a filtered subtotal is never rounded.
                col in has_paise or paise % 100 != 0,
            )
        else:
            _put(ws, total_row, col, COLUMNS[col - 1], 0)
    for i in range(1, len(COLUMNS) + 1):
        cell = ws.cell(row=total_row, column=i)
        cell.font = _HEAD_FONT
        cell.border = _TOTAL_BORDER

    # Collected: what pays M, as on the Dashboard = paid for M - sent elsewhere - kept as credit
    # + paid from other payments' extra.
    collected_row = total_row + 1
    label = "Paid ahead" if ahead else "Collected"
    _put(
        ws,
        collected_row,
        1,
        COLUMNS[0],
        f"{label} for {month_long(report.month)}, as on the Dashboard (paid for this month, less "
        "extra sent elsewhere and kept as credit, plus paid from another payment's extra)",
    )
    paid, sent, kept, covered = (
        f"{get_column_letter(_COL[h])}{total_row}"
        for h in (
            "Paid for this month ₹",
            "Extra sent elsewhere ₹",
            "Extra kept as credit ₹",
            "Paid from another payment's extra ₹",
        )
    )
    _formula(
        ws,
        collected_row,
        _COL["Paid for this month ₹"],
        f"={paid}-{sent}-{kept}+{covered}",
        bool(has_paise) or t.collected_paise % 100 != 0,
    )
    ws.cell(row=collected_row, column=_COL["Paid for this month ₹"]).font = _HEAD_FONT

    if report.unassigned_count:
        # Money from an upload that no student has yet: in no row and no total above.
        _put(ws, collected_row + 1, 1, COLUMNS[0], unassigned_words(report))
        ws.cell(row=collected_row + 1, column=1).font = _NOTE_FONT

    ws.freeze_panes = f"B{first}"
    ws.auto_filter.ref = f"A{HEADER_ROW}:{last_col}{max(last, HEADER_ROW)}"
    ws.print_title_rows = f"{HEADER_ROW}:{HEADER_ROW}"
    ws.page_setup.orientation = "landscape"
    ws.page_setup.paperSize = ws.PAPERSIZE_A4
    ws.page_setup.fitToWidth = 1
    ws.page_setup.fitToHeight = 0
    ws.sheet_properties.pageSetUpPr.fitToPage = True

    out = io.BytesIO()
    book.save(out)
    return out.getvalue()
