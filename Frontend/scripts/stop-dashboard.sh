#!/usr/bin/env bash
# Stop dashboard on port 3000 without killing npm restart/start.
set -euo pipefail

PORT="${PORT:-3000}"

if command -v fuser >/dev/null 2>&1; then
  fuser -k "${PORT}/tcp" 2>/dev/null || true
elif command -v lsof >/dev/null 2>&1; then
  PIDS=$(lsof -ti "tcp:${PORT}" 2>/dev/null || true)
  if [[ -n "${PIDS}" ]]; then
    kill ${PIDS} 2>/dev/null || true
  fi
else
  echo "WARN: install fuser or lsof to stop dashboard cleanly" >&2
fi

sleep 0.5
