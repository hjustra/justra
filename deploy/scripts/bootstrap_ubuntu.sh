#!/usr/bin/env bash
set -euo pipefail

APP_DIR="${APP_DIR:-/opt/justra/app}"
BASE_DIR="${BASE_DIR:-/opt/justra}"
DATA_DIR="${DATA_DIR:-/mnt/justra-data}"
LOG_DIR="${LOG_DIR:-/mnt/justra-logs}"
NODE_RUNTIME_DIR="${NODE_RUNTIME_DIR:-/opt/justra/node-runtime}"
REPO_URL="${REPO_URL:-git@github.com:hjustra/justra.git}"
BRANCH="${BRANCH:-staging}"

if [[ "${EUID}" -ne 0 ]]; then
  echo "Execute com sudo/root."
  exit 1
fi

run_as_justra() {
  (cd / && sudo -H -u justra env HOME=/home/justra "$@")
}

run_as_justra_in() {
  local workdir="$1"
  shift
  (cd "${workdir}" && sudo -H -u justra env HOME=/home/justra "$@")
}

apt-get update
apt-get install -y \
  git \
  nginx \
  nodejs \
  npm \
  openssh-client \
  python3 \
  python3-pip \
  python3-venv \
  rsync \
  unzip

if ! id justra >/dev/null 2>&1; then
  useradd --system --create-home --shell /bin/bash justra
fi

mkdir -p "${BASE_DIR}" "${DATA_DIR}" "${LOG_DIR}" "${NODE_RUNTIME_DIR}" /etc/justra
chown -R justra:justra "${BASE_DIR}" "${DATA_DIR}" "${LOG_DIR}" "${NODE_RUNTIME_DIR}"
chmod 750 "${DATA_DIR}" "${LOG_DIR}" /etc/justra

install -d -m 700 -o justra -g justra /home/justra/.ssh
if [[ ! -f /home/justra/.ssh/id_ed25519 ]]; then
  run_as_justra ssh-keygen -t ed25519 -N "" -C "justra-azure-deploy" -f /home/justra/.ssh/id_ed25519
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

if [[ ! -f "${NODE_RUNTIME_DIR}/package.json" ]]; then
  run_as_justra_in "${NODE_RUNTIME_DIR}" npm init -y
fi
run_as_justra_in "${NODE_RUNTIME_DIR}" npm install playwright
npm --prefix "${NODE_RUNTIME_DIR}" exec -- playwright install-deps chromium
run_as_justra_in "${NODE_RUNTIME_DIR}" env PLAYWRIGHT_BROWSERS_PATH="${NODE_RUNTIME_DIR}/browsers" \
  npm exec -- playwright install chromium
chown -R justra:justra "${NODE_RUNTIME_DIR}"

if [[ ! -f /etc/justra/justra.env ]]; then
  install -m 640 -o root -g justra "${APP_DIR}/deploy/env/justra.env.example" /etc/justra/justra.env
  echo "Edite /etc/justra/justra.env antes de iniciar o serviço."
fi

install -m 644 "${APP_DIR}/deploy/systemd/justra.service" /etc/systemd/system/justra.service
install -m 644 "${APP_DIR}/deploy/systemd/justra-djen-daily.service" /etc/systemd/system/justra-djen-daily.service
install -m 644 "${APP_DIR}/deploy/systemd/justra-djen-daily.timer" /etc/systemd/system/justra-djen-daily.timer
install -m 644 "${APP_DIR}/deploy/nginx/justra.conf" /etc/nginx/sites-available/justra.conf
ln -sfn /etc/nginx/sites-available/justra.conf /etc/nginx/sites-enabled/justra.conf
rm -f /etc/nginx/sites-enabled/default

systemctl daemon-reload
systemctl enable justra.service
systemctl enable justra-djen-daily.timer
nginx -t
systemctl reload nginx

cat <<'EOF'
Bootstrap concluido.

Antes de iniciar:
1. Edite /etc/justra/justra.env.
2. Garanta que /mnt/justra-data/mvp/trt2/trt2_mvp.duckdb exista ou rode o pipeline de carga.
3. Inicie com: sudo systemctl start justra
4. Veja logs com: sudo journalctl -u justra -f
EOF
