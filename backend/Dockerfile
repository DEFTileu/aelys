FROM python:3.12-slim

ENV PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1

WORKDIR /app/backend
COPY backend/pyproject.toml backend/uv.lock ./
RUN python -m pip install --no-cache-dir uv \
    && uv sync --frozen --no-dev --no-install-project

COPY backend .
RUN uv sync --frozen --no-dev

ENV PATH="/app/backend/.venv/bin:$PATH"
ENV PYTHONPATH="/app/backend"
EXPOSE 8000
CMD ["sh", "-c", "/app/backend/.venv/bin/alembic upgrade head && exec /app/backend/.venv/bin/uvicorn app.main:app --host 0.0.0.0 --port ${PORT:-8000} --ws-max-size 65536"]
