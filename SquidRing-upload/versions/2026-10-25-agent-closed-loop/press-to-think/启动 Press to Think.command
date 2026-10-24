#!/bin/zsh
set -e

APP_DIR="${0:A:h}"
APP_PORT="3210"
APP_URL="http://localhost:${APP_PORT}/"
NODE_BIN="/Users/lex/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/bin/node"

cd "$APP_DIR"

open_app() {
  if [[ -d "/Applications/Google Chrome.app" ]]; then
    open -a "Google Chrome" "$APP_URL"
  else
    open "$APP_URL"
  fi
}

if curl -fsS --max-time 2 "http://127.0.0.1:${APP_PORT}/api/health" >/dev/null 2>&1; then
  open_app
  exit 0
fi

if [[ ! -x "$NODE_BIN" ]]; then
  NODE_BIN="$(command -v node || true)"
fi

if [[ -z "$NODE_BIN" ]]; then
  echo "没有找到 Node.js。请把这个窗口截图发给 Codex。"
  read -k 1 "?按任意键关闭…"
  exit 1
fi

( sleep 1; open_app ) &
echo "Press to Think 正在运行。"
echo "使用期间请不要关闭这个窗口；关闭窗口即停止本地服务。"
echo "地址：${APP_URL}"
PORT="$APP_PORT" exec "$NODE_BIN" server.mjs
