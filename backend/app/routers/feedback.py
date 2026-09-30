"""In-app feedback (Settings → Send feedback). See docs/data-model.md, "Feedback"."""

import uuid

from fastapi import APIRouter, HTTPException, Request, status

from app.db import SessionDep
from app.feedback_sender import FeedbackSender
from app.models import Feedback, FeedbackStatus
from app.schemas import ErrorResponse, FeedbackCreate, FeedbackRead
from app.services import feedback as service

router = APIRouter(prefix="/feedback", tags=["feedback"])


def _sender(request: Request) -> FeedbackSender | None:
    return getattr(request.app.state, "feedback_sender", None)


def _read(row: Feedback, sender: FeedbackSender | None) -> FeedbackRead:
    return FeedbackRead(
        id=row.id,
        category=row.category,
        status=row.status,
        created_at=row.created_at,
        sent_at=row.sent_at,
        attempts=row.attempts,
        sending=sender is not None and row.status == FeedbackStatus.pending,
    )


@router.post(
    "",
    response_model=FeedbackRead,
    status_code=status.HTTP_201_CREATED,
    operation_id="createFeedback",
)
def create_feedback(body: FeedbackCreate, session: SessionDep, request: Request) -> FeedbackRead:
    """Save feedback on this laptop, then send it in the background (never waits for the
    internet). The same `id` again returns what was saved the first time."""
    row = service.create_feedback(session, body)
    sender = _sender(request)
    if sender is not None and row.status == FeedbackStatus.pending:
        sender.wake()
    return _read(row, sender)


@router.get(
    "/{feedback_id}",
    response_model=FeedbackRead,
    operation_id="getFeedback",
    responses={404: {"model": ErrorResponse}},
)
def get_feedback(feedback_id: uuid.UUID, session: SessionDep, request: Request) -> FeedbackRead:
    """Whether it has been sent yet (the dialog asks for a few seconds after saving)."""
    row = service.get_feedback(session, str(feedback_id))
    if row is None:
        raise HTTPException(status.HTTP_404_NOT_FOUND, f"No feedback with id {feedback_id}")
    return _read(row, _sender(request))
