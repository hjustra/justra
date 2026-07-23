#!/usr/bin/env bash
set -euo pipefail

APP_DIR="${APP_DIR:-/opt/justra/app}"
DATA_DIR="${JUSTRA_DATA_DIR:-/mnt/justra-data}"
LOG_DIR="${JUSTRA_LOG_DIR:-/mnt/justra-logs}"
PROFILE_DIR="${FALCAO_USER_DATA_DIR:-${DATA_DIR}/app/falcao_gold_profile}"
NODE_BIN="${JUSTRA_NODE_BIN:-/usr/bin/node}"
NODE_MODULES="${JUSTRA_NODE_MODULES:-/opt/justra/node-runtime/node_modules}"
PLAYWRIGHT_PATH="${PLAYWRIGHT_BROWSERS_PATH:-/home/justra/.cache/ms-playwright}"

DISPLAY_NUM="${FALCAO_LOGIN_DISPLAY_NUM:-98}"
DISPLAY_VALUE=":${DISPLAY_NUM}"
XVFB_SCREEN="${FALCAO_LOGIN_SCREEN:-1440x1000x24}"
VNC_PORT="${FALCAO_LOGIN_VNC_PORT:-5901}"
NOVNC_PORT="${FALCAO_LOGIN_NOVNC_PORT:-6080}"
AUTH_WAIT_MINUTES="${FALCAO_AUTH_WAIT_MINUTES:-60}"
STATUS_PATH="${DATA_DIR}/app/falcao_gold_login_session.json"

mkdir -p "${PROFILE_DIR}" "${DATA_DIR}/app" "${DATA_DIR}/raw/falcao" "${LOG_DIR}"
chmod 700 "${PROFILE_DIR}"

XVFB_PID=""
OPENBOX_PID=""
X11VNC_PID=""
WEBSOCKIFY_PID=""

cleanup() {
  for pid in "${WEBSOCKIFY_PID}" "${X11VNC_PID}" "${OPENBOX_PID}" "${XVFB_PID}"; do
    if [[ -n "${pid}" ]] && kill -0 "${pid}" >/dev/null 2>&1; then
      kill "${pid}" >/dev/null 2>&1 || true
      wait "${pid}" >/dev/null 2>&1 || true
    fi
  done
}
trap cleanup EXIT

write_status() {
  local state="$1"
  local detail="${2:-}"
  python3 - "${STATUS_PATH}" "${state}" "${detail}" "${PROFILE_DIR}" "${NOVNC_PORT}" "${VNC_PORT}" "${AUTH_WAIT_MINUTES}" <<'PY'
import datetime as dt
import json
import os
import sys

path, state, detail, profile_dir, novnc_port, vnc_port, wait_minutes = sys.argv[1:]
payload = {
    "state": state,
    "detail": detail,
    "updated_at": dt.datetime.now(dt.timezone.utc).isoformat().replace("+00:00", "Z"),
    "profile_dir": profile_dir,
    "novnc_url": f"http://127.0.0.1:{novnc_port}/vnc.html?autoconnect=1&resize=scale",
    "vnc_port": int(vnc_port),
    "auth_wait_minutes": int(wait_minutes),
}
os.makedirs(os.path.dirname(path), exist_ok=True)
tmp = path + ".tmp"
with open(tmp, "w", encoding="utf-8") as stream:
    json.dump(payload, stream, ensure_ascii=False, indent=2)
    stream.write("\n")
os.chmod(tmp, 0o600)
os.replace(tmp, path)
PY
}

if ! command -v Xvfb >/dev/null 2>&1; then
  write_status "error" "Xvfb nao instalado"
  echo "Xvfb nao instalado." >&2
  exit 1
fi
if ! command -v x11vnc >/dev/null 2>&1; then
  write_status "error" "x11vnc nao instalado"
  echo "x11vnc nao instalado." >&2
  exit 1
fi
if ! command -v websockify >/dev/null 2>&1; then
  write_status "error" "websockify nao instalado"
  echo "websockify nao instalado." >&2
  exit 1
fi

export HOME="${HOME:-/home/justra}"
export DISPLAY="${DISPLAY_VALUE}"
export JUSTRA_NODE_MODULES="${NODE_MODULES}"
export PLAYWRIGHT_BROWSERS_PATH="${PLAYWRIGHT_PATH}"
export XDG_RUNTIME_DIR="${XDG_RUNTIME_DIR:-/tmp/justra-falcao-runtime}"
mkdir -p "${XDG_RUNTIME_DIR}"
chmod 700 "${XDG_RUNTIME_DIR}"

write_status "starting" "iniciando display virtual"
Xvfb "${DISPLAY_VALUE}" -screen 0 "${XVFB_SCREEN}" -ac -nolisten tcp >"${LOG_DIR}/falcao-gold-xvfb.log" 2>&1 &
XVFB_PID="$!"
sleep 1

if command -v openbox >/dev/null 2>&1; then
  openbox >"${LOG_DIR}/falcao-gold-openbox.log" 2>&1 &
  OPENBOX_PID="$!"
fi

x11vnc \
  -display "${DISPLAY_VALUE}" \
  -localhost \
  -rfbport "${VNC_PORT}" \
  -forever \
  -shared \
  -nopw \
  -quiet \
  >"${LOG_DIR}/falcao-gold-x11vnc.log" 2>&1 &
X11VNC_PID="$!"
sleep 1

websockify \
  --web=/usr/share/novnc \
  "127.0.0.1:${NOVNC_PORT}" \
  "127.0.0.1:${VNC_PORT}" \
  >"${LOG_DIR}/falcao-gold-novnc.log" 2>&1 &
WEBSOCKIFY_PID="$!"
sleep 1

write_status "ready" "acesse via tunel SSH local"
echo "noVNC pronto: http://127.0.0.1:${NOVNC_PORT}/vnc.html?autoconnect=1&resize=scale"
echo "Perfil persistente: ${PROFILE_DIR}"

set +e
"${NODE_BIN}" "${APP_DIR}/scripts/collect_falcao_direct.mjs" \
  --auth-setup \
  --auth-wait-minutes "${AUTH_WAIT_MINUTES}" \
  --user-data-dir "${PROFILE_DIR}" \
  --api-mode frontend \
  --headed \
  --output-tag "falcao_gold_auth_$(date -u +%Y%m%dT%H%M%SZ)"
RESULT="$?"
set -e

if [[ "${RESULT}" -eq 0 ]]; then
  write_status "finished" "sessao de login encerrada"
else
  write_status "error" "coletor de login retornou ${RESULT}"
fi
exit "${RESULT}"
