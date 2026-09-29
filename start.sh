#!/usr/bin/env bash
# 一键启动：Next 单进程 (:6864)
set -euo pipefail

ROOT="$(cd "$(dirname "$0")" && pwd)"
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
  return 1
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

free_port_if_requested "${WEB_PORT}"
if port_is_busy "${WEB_PORT}"; then
  report_port_users "${WEB_PORT}" "Next"
  echo "请先结束占用进程，或 FORCE_FREE_PORTS=1 ./start.sh"
  exit 1
fi

cd "$ROOT"
if [[ ! -d node_modules ]]; then
  npm install
fi

echo ""
echo "Paper Reading → http://localhost:${WEB_PORT}"
echo "Ctrl+C 停止"
echo ""

exec npm run dev
