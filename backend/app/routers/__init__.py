from fastapi import APIRouter

from app.routers import about, dashboard, feedback, health, payments, report, students, update

api_router = APIRouter(prefix="/api")
api_router.include_router(health.router)
api_router.include_router(students.router)
api_router.include_router(payments.router)
api_router.include_router(dashboard.router)
api_router.include_router(report.router)
api_router.include_router(about.router)
api_router.include_router(feedback.router)
api_router.include_router(update.router)
