from fastapi import APIRouter

from app.routers import dashboard, health, payments, report, students

api_router = APIRouter(prefix="/api")
api_router.include_router(health.router)
api_router.include_router(students.router)
api_router.include_router(payments.router)
api_router.include_router(dashboard.router)
api_router.include_router(report.router)
