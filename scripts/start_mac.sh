#!/usr/bin/env bash
# Start FinAlly in Docker (macOS/Linux). Safe to run repeatedly.
# Usage: ./scripts/start_mac.sh [--build] [--no-open]
set -euo pipefail

IMAGE="finally"
CONTAINER="finally"
VOLUME="finally-data"
PORT="${PORT:-8000}"
URL="http://localhost:${PORT}"

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

BUILD=0
OPEN=1
for arg in "$@"; do
  case "$arg" in
    --build|-b) BUILD=1 ;;
    --no-open)  OPEN=0 ;;
    -h|--help)
      echo "Usage: $0 [--build] [--no-open]"; exit 0 ;;
    *) echo "Unknown option: $arg" >&2; exit 1 ;;
  esac
done

if ! docker info >/dev/null 2>&1; then
  echo "Error: Docker is not running. Start Docker and try again." >&2
  exit 1
fi

# Environment file: create from the example if missing
ENV_ARGS=()
if [[ ! -f .env ]]; then
  if [[ -f .env.example ]]; then
    echo "Warning: .env not found; creating it from .env.example. Add your OPENROUTER_API_KEY for AI chat."
    cp .env.example .env
  else
    echo "Warning: .env not found; running without it (AI chat will not work)."
  fi
fi
[[ -f .env ]] && ENV_ARGS=(--env-file .env)

# Build the image if missing or requested
if [[ "$BUILD" == 1 ]] || ! docker image inspect "$IMAGE" >/dev/null 2>&1; then
  echo "Building Docker image '$IMAGE'..."
  docker build -t "$IMAGE" .
fi

# Remove any existing container (running or stopped)
if docker container inspect "$CONTAINER" >/dev/null 2>&1; then
  echo "Removing existing container '$CONTAINER'..."
  docker rm -f "$CONTAINER" >/dev/null
fi

echo "Starting container '$CONTAINER'..."
docker run -d \
  --name "$CONTAINER" \
  -v "$VOLUME":/app/db \
  -p "$PORT":8000 \
  ${ENV_ARGS[@]+"${ENV_ARGS[@]}"} \
  "$IMAGE" >/dev/null

# Wait for the health endpoint (up to ~60s)
printf "Waiting for FinAlly to become healthy"
READY=0
for _ in $(seq 1 60); do
  if curl -fsS "$URL/api/health" >/dev/null 2>&1; then
    READY=1
    break
  fi
  printf "."
  sleep 1
done
echo
[[ "$READY" == 1 ]] || echo "Warning: health check did not pass yet. Check logs with: docker logs $CONTAINER" >&2

echo "FinAlly is running at $URL"
echo "Stop it with: ./scripts/stop_mac.sh"

if [[ "$OPEN" == 1 ]]; then
  if command -v open >/dev/null 2>&1; then
    open "$URL" >/dev/null 2>&1 || true
  elif command -v xdg-open >/dev/null 2>&1; then
    xdg-open "$URL" >/dev/null 2>&1 || true
  fi
fi
