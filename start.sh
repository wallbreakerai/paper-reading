#!/usr/bin/env bash
# 一键启动：Python API (:8010) + Next 前端 (:6864)
set -euo pipefail

ROOT="$(cd "$(dirname "$0")" && pwd)"
API_HOST="127.0.0.1"
API_PORT=8010
WEB_PORT=6864

cleanup() {
  trap - EXIT INT TERM
  jobs -p | xargs -r kill 2>/dev/null || true
  wait 2>/dev/null || true
}
trap cleanup EXIT INT TERM

pids_listening_on() {
  local port="$1"
  local pids=""
  if command -v ss >/dev/null 2>&1; then
    pids+=" $(ss -ltnp "sport = :${port}" 2>/dev/null | sed -n 's/.*pid=\([0-9][0-9]*\).*/\1/p')"
  fi
  if command -v lsof >/dev/null 2>&1; then
    pids+=" $(lsof -t -nP -iTCP:"${port}" -sTCP:LISTEN 2>/dev/null || true)"
  fi
  printf '%s\n' ${pids} | awk '/^[0-9]+$/ {print}' | sort -u
}

report_port_users() {
  local port="$1"
  local label="$2"
  echo ""
  echo "端口 ${port}（${label}）已被占用："
  while read -r pid; do
    [[ -z "${pid}" ]] && continue
    echo "  $(ps -o pid=,user=,args= -p "${pid}" 2>/dev/null || echo "${pid}")"
  done < <(pids_listening_on "${port}")
}

port_is_busy() {
  local port="$1"
  local pid
  while read -r pid; do
    [[ -n "${pid}" ]] && return 0
  done < <(pids_listening_on "${port}")
  python3 - "${port}" <<'PY' 2>/dev/null
import errno, socket, sys
port = int(sys.argv[1])
busy = False
s = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
try:
    s.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
    s.bind(("127.0.0.1", port))
except OSError as exc:
    busy = exc.errno == errno.EADDRINUSE
finally:
    s.close()
raise SystemExit(0 if busy else 1)
PY
}

free_port_if_requested() {
  local port="$1"
  if [[ "${FORCE_FREE_PORTS:-}" != "1" ]]; then
    return 0
  fi
  while read -r pid; do
    [[ -z "${pid}" ]] && continue
    kill "${pid}" 2>/dev/null || true
  done < <(pids_listening_on "${port}")
  sleep 0.3
}

check_ports_free() {
  free_port_if_requested "${API_PORT}"
  free_port_if_requested "${WEB_PORT}"
  local busy=0
  if port_is_busy "${API_PORT}"; then busy=1; report_port_users "${API_PORT}" "Python API"; fi
  if port_is_busy "${WEB_PORT}"; then busy=1; report_port_users "${WEB_PORT}" "Next"; fi
  if [[ "${busy}" -ne 0 ]]; then
    echo "请先结束占用进程，或 FORCE_FREE_PORTS=1 ./start.sh"
    exit 1
  fi
}

if command -v conda >/dev/null 2>&1; then
  # shellcheck disable=SC1091
  source "$(conda info --base)/etc/profile.d/conda.sh"
  conda activate base
else
  echo "需要 conda，并使用 base 环境运行 API"
  exit 1
fi

check_ports_free

(
  cd "$ROOT/python"
  exec python -m uvicorn app.main:app --host "${API_HOST}" --port "${API_PORT}" --reload --timeout-graceful-shutdown 3
) &

(
  cd "$ROOT/web"
  if [[ ! -d node_modules ]]; then
    npm install
  fi
  exec npm run dev -- -p "${WEB_PORT}"
) &

echo ""
echo "Paper Reading → http://localhost:${WEB_PORT}"
echo "API           → http://${API_HOST}:${API_PORT}"
echo "Ctrl+C 同时停两端"
echo ""

wait
