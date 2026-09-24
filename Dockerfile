# syntax=docker/dockerfile:1

# ---------- Stage 1: build the Next.js static export ----------
FROM node:20-slim AS frontend
WORKDIR /app/frontend

# Install deps first so this layer is cached until the lockfile changes
COPY frontend/package.json frontend/package-lock.json* ./
RUN if [ -f package-lock.json ]; then npm ci; else npm install; fi

COPY frontend/ ./
ENV NEXT_TELEMETRY_DISABLED=1
RUN npm run build


# ---------- Stage 2: Python runtime with uv ----------
FROM python:3.12-slim AS runtime

COPY --from=ghcr.io/astral-sh/uv:latest /uv /uvx /usr/local/bin/

ENV UV_COMPILE_BYTECODE=1 \
    UV_LINK_MODE=copy \
    UV_PROJECT_ENVIRONMENT=/app/backend/.venv \
    PYTHONUNBUFFERED=1 \
    PATH="/app/backend/.venv/bin:$PATH" \
    DB_PATH=/app/db/finally.db \
    STATIC_DIR=/app/backend/static

WORKDIR /app/backend

# Dependencies only (cached until pyproject/uv.lock change)
COPY backend/pyproject.toml backend/uv.lock ./
RUN uv sync --frozen --no-dev --no-install-project

# Application code, then install the project itself
COPY backend/ ./
RUN uv sync --frozen --no-dev

# Static frontend served by FastAPI
COPY --from=frontend /app/frontend/out /app/backend/static

RUN mkdir -p /app/db
VOLUME ["/app/db"]

EXPOSE 8000

HEALTHCHECK --interval=30s --timeout=5s --start-period=15s --retries=3 \
    CMD python -c "import urllib.request,sys; sys.exit(0 if urllib.request.urlopen('http://127.0.0.1:8000/api/health', timeout=4).status == 200 else 1)"

CMD ["uvicorn", "app.main:app", "--host", "0.0.0.0", "--port", "8000"]
