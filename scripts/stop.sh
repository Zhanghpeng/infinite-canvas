#!/usr/bin/env bash
# 停掉 scripts/dev.sh 起的进程（按 .dev-logs/*.pid）。Ctrl+C 正常退出时不需要它。
set -uo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
LOGS="$ROOT/.dev-logs"
[ -d "$LOGS" ] || { echo "没有 .dev-logs（没跑过 scripts/dev.sh）"; exit 0; }

for name in web agent; do
  pidfile="$LOGS/$name.pid"
  [ -f "$pidfile" ] || continue
  pid="$(cat "$pidfile" 2>/dev/null || true)"
  if [ -n "$pid" ] && kill -0 "$pid" 2>/dev/null; then
    kill "$pid" 2>/dev/null || true
    echo "已停止 $name（PID $pid）"
  else
    echo "$name 未在运行"
  fi
  rm -f "$pidfile"
done
