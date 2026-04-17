# Dockerfile for haltmarket-monitor (Railway).
#
# Two-stage build: the first stage uses uv to resolve and install dependencies
# into a wheel-cache-friendly virtualenv; the runtime stage copies just the
# .venv and the source tree. Final image stays under ~120MB on python:3.12-slim.

FROM python:3.12-slim AS builder

ENV PIP_DISABLE_PIP_VERSION_CHECK=1 \
    PIP_NO_CACHE_DIR=1 \
    UV_LINK_MODE=copy \
    UV_PROJECT_ENVIRONMENT=/app/.venv

WORKDIR /app

RUN pip install --no-cache-dir "uv>=0.5,<1.0"

COPY pyproject.toml uv.lock README.md ./
COPY src ./src

RUN uv sync --frozen --no-dev

# -----------------------------------------------------------------------------

FROM python:3.12-slim AS runtime

ENV PATH="/app/.venv/bin:${PATH}" \
    PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1

WORKDIR /app

RUN groupadd --system --gid 1001 monitor \
 && useradd  --system --uid 1001 --gid monitor --home-dir /app --shell /sbin/nologin monitor

COPY --from=builder /app/.venv /app/.venv
COPY --from=builder /app/src /app/src

USER monitor

EXPOSE 8080
HEALTHCHECK --interval=30s --timeout=3s --start-period=10s --retries=3 \
  CMD python -c "import urllib.request, sys; \
sys.exit(0 if urllib.request.urlopen('http://127.0.0.1:8080/healthz', timeout=2).status == 200 else 1)"

CMD ["haltmarket-monitor"]
