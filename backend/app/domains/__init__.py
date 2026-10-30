"""Aelys domain routers and SQLAlchemy models.

The application entrypoint should include ``all_routers`` and configure
``common.db_dependency`` through its own dependency override.
"""
from .ai import router as ai_router
from .finance import router as finance_router
from .mail import router as mail_router
from .productivity import router as productivity_router
from .projects import router as projects_router
from .search import router as search_router

all_routers = [projects_router, productivity_router, finance_router, mail_router, ai_router, search_router]

__all__ = ["all_routers"]
