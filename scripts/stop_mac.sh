#!/usr/bin/env bash
# Stop FinAlly (macOS/Linux). Keeps the finally-data volume so data persists.
set -euo pipefail

CONTAINER="finally"

if ! docker info >/dev/null 2>&1; then
  echo "Docker is not running; nothing to stop."
  exit 0
fi

if docker container inspect "$CONTAINER" >/dev/null 2>&1; then
  docker rm -f "$CONTAINER" >/dev/null
  echo "Stopped and removed container '$CONTAINER'. Data volume 'finally-data' kept."
else
  echo "Container '$CONTAINER' is not running."
fi
