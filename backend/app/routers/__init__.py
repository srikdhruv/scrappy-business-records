from fastapi import APIRouter

from app.routers import (
    batches,
    dashboard,
    excel,
    health,
    payments,
    report,
    students,
    unassigned,
)

api_router = APIRouter(prefix="/api")
api_router.include_router(health.router)
api_router.include_router(students.router)
api_router.include_router(payments.router)
api_router.include_router(dashboard.router)
api_router.include_router(report.router)
api_router.include_router(excel.router)
api_router.include_router(unassigned.router)
api_router.include_router(batches.router)
