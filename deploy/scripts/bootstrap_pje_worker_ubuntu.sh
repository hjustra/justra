#!/usr/bin/env bash
set -euo pipefail

APP_DIR="${APP_DIR:-/opt/justra/app}"
BASE_DIR="${BASE_DIR:-/opt/justra}"
DATA_DIR="${DATA_DIR:-/mnt/justra-data}"
LOG_DIR="${LOG_DIR:-/mnt/justra-logs}"
REPO_URL="${REPO_URL:-git@github.com:hjustra/justra.git}"
BRANCH="${BRANCH:-staging}"

if [[ "${EUID}" -ne 0 ]]; then
  echo "Execute com sudo/root."
  exit 1
fi

run_as_justra() {
  (cd / && sudo -H -u justra env HOME=/home/justra "$@")
}

apt-get update
apt-get install -y \
  ca-certificates \
  curl \
  git \
  openssh-client \
  python3 \
  python3-pip \
  python3-venv \
  sudo \
  unzip

if ! id justra >/dev/null 2>&1; then
  useradd --system --create-home --shell /bin/bash justra
fi

mkdir -p "${BASE_DIR}" "${DATA_DIR}" "${LOG_DIR}" /etc/justra
chown -R justra:justra "${BASE_DIR}" "${DATA_DIR}" "${LOG_DIR}"
chown root:justra /etc/justra
chmod 750 "${DATA_DIR}" "${LOG_DIR}" /etc/justra

install -d -m 700 -o justra -g justra /home/justra/.ssh
if [[ ! -f /home/justra/.ssh/id_ed25519 ]]; then
  run_as_justra ssh-keygen -t ed25519 -N "" -C "justra-pje-worker-vps" -f /home/justra/.ssh/id_ed25519
  echo
  echo "Deploy key criada. Cadastre esta chave publica no GitHub como Deploy Key read-only do repo hjustra/justra:"
  echo
  cat /home/justra/.ssh/id_ed25519.pub
  echo
  echo "Depois rode este bootstrap novamente."
  exit 2
fi

run_as_justra ssh-keyscan github.com >> /home/justra/.ssh/known_hosts 2>/dev/null || true
chown justra:justra /home/justra/.ssh/known_hosts
chmod 600 /home/justra/.ssh/known_hosts

if [[ ! -d "${APP_DIR}/.git" ]]; then
  run_as_justra git clone --branch "${BRANCH}" "${REPO_URL}" "${APP_DIR}"
else
  run_as_justra git -C "${APP_DIR}" fetch origin
  run_as_justra git -C "${APP_DIR}" checkout "${BRANCH}"
  run_as_justra git -C "${APP_DIR}" pull --ff-only
fi

run_as_justra python3 -m venv "${APP_DIR}/.venv"
run_as_justra "${APP_DIR}/.venv/bin/python" -m pip install --upgrade pip
run_as_justra "${APP_DIR}/.venv/bin/pip" install -r "${APP_DIR}/requirements.txt"
"${APP_DIR}/.venv/bin/python" -m playwright install-deps chromium
run_as_justra "${APP_DIR}/.venv/bin/python" -m playwright install chromium

if [[ ! -f /etc/justra/pje-worker.env ]]; then
  install -m 640 -o root -g justra "${APP_DIR}/deploy/env/pje-worker.env.example" /etc/justra/pje-worker.env
  echo "Edite /etc/justra/pje-worker.env antes de iniciar o worker."
fi

install -m 644 "${APP_DIR}/deploy/systemd/justra-pje-worker-remote.service" /etc/systemd/system/justra-pje-worker.service
systemctl daemon-reload
systemctl enable justra-pje-worker.service

cat <<'EOF'
Bootstrap do worker PJe concluido.

Antes de iniciar:
1. Edite /etc/justra/pje-worker.env.
2. Teste a fila com:
   sudo systemctl start justra-pje-worker
   sudo journalctl -u justra-pje-worker -f
EOF
