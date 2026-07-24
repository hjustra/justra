#!/usr/bin/env bash
set -euo pipefail

CDP_ENDPOINT="${FALCAO_CDP_ENDPOINT:-http://127.0.0.1:9228}"
WAIT_SECONDS="${FALCAO_CDP_WAIT_SECONDS:-90}"
DEADLINE=$((SECONDS + WAIT_SECONDS))

while [[ "${SECONDS}" -lt "${DEADLINE}" ]]; do
  if curl --fail --silent --show-error --max-time 3 "${CDP_ENDPOINT%/}/json/version" >/dev/null 2>&1; then
    exit 0
  fi
  sleep 2
done

echo "Chrome/CDP do Falcao nao respondeu em ${CDP_ENDPOINT} apos ${WAIT_SECONDS}s." >&2
exit 1
