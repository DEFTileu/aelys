FROM python:3.12-slim

ENV PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1

WORKDIR /app/backend
COPY backend/pyproject.toml backend/uv.lock ./
RUN python -m pip install --no-cache-dir uv \
    && uv sync --frozen --no-dev

COPY backend .

ENV PATH="/app/backend/.venv/bin:$PATH"
ENV PYTHONPATH="/app/backend"
EXPOSE 8000
CMD ["sh", "-c", "/app/backend/.venv/bin/alembic upgrade head && /app/backend/.venv/bin/uvicorn app.main:app --host 0.0.0.0 --port 8000"]
