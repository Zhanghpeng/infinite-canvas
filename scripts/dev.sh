#!/usr/bin/env bash
# 一键启动：前端（Vite）+ 本地 Agent（canvas-agent）。
#
# 已处理的实际问题：
#   - 端口被占用：自动往后找一个空闲端口（而不是直接报错）；
#   - 已经在跑：探测到端口已服务就直接复用并告诉你地址，不再起第二个；
#   - 日志：都写到 .dev-logs/，同时把 PID 写下来，方便 scripts/stop.sh 收干净；
#   - Ctrl+C：只停掉本脚本起的进程。
#
# 用法：
#   bash scripts/dev.sh                    # 前端 3000（占用则顺延）+ 本地 Agent
#   bash scripts/dev.sh --port 3100        # 指定前端端口
#   bash scripts/dev.sh --no-agent         # 只起前端
#   bash scripts/dev.sh --dry-run          # 只打印计划，不启动任何东西
set -uo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
PORT=3000; WITH_AGENT=1; DRY_RUN=0; HOST=0.0.0.0
AGENT_PORT="${CANVAS_AGENT_PORT:-17371}"
while [ $# -gt 0 ]; do
  case "$1" in
    --port) PORT="${2:-3000}"; shift 2 ;;
    --host) HOST="${2:-0.0.0.0}"; shift 2 ;;
    --no-agent) WITH_AGENT=0; shift ;;
    --dry-run) DRY_RUN=1; shift ;;
    -h|--help) sed -n '3,17p' "$0" | sed 's/^# \{0,1\}//'; exit 0 ;;
    *) echo "未知参数：$1（用 --help 看用法）" >&2; exit 2 ;;
  esac
done

say() { printf '%s\n' "$*"; }
LOGS="$ROOT/.dev-logs"
port_open() { (exec 3<>"/dev/tcp/127.0.0.1/$1") 2>/dev/null && { exec 3<&-; exec 3>&-; return 0; }; return 1; }

# --- 前端端口：占用就顺延 ---
WEB_PORT="$PORT"
for _ in $(seq 1 10); do
  if port_open "$WEB_PORT"; then
    say "端口 $WEB_PORT 已被占用，试 $((WEB_PORT + 1)) …"
    WEB_PORT=$((WEB_PORT + 1))
  else break; fi
done
if port_open "$WEB_PORT"; then say "!! $PORT 起连续 10 个端口都被占用，用 --port 指定一个空闲端口" >&2; exit 1; fi

WEB_PID=""; AGENT_PID=""
cleanup() {
  local pid
  for pid in "$WEB_PID" "$AGENT_PID"; do
    [ -n "$pid" ] || continue
    kill "$pid" 2>/dev/null || true
  done
  WEB_PID=""; AGENT_PID=""
}
trap cleanup INT TERM EXIT

if [ "$DRY_RUN" = 1 ]; then
  say "[dry-run] 前端：cd web && ./node_modules/.bin/vite --host $HOST --port $WEB_PORT"
  if [ "$WITH_AGENT" = 1 ]; then
    if port_open "$AGENT_PORT"; then say "[dry-run] 本地 Agent：端口 $AGENT_PORT 已在运行，复用（不重启）"
    else say "[dry-run] 本地 Agent：cd canvas-agent && ./node_modules/.bin/tsx src/index.ts"; fi
  fi
  exit 0
fi

# 直接调本地 vite 二进制：pnpm exec / pnpm run 都会被 web/package.json 的 packageManager=bun 拒掉
VITE_BIN="$ROOT/web/node_modules/.bin/vite"
if [ ! -x "$VITE_BIN" ]; then
  say "!! 没找到 $VITE_BIN —— 先跑 bash scripts/setup.sh（装依赖）" >&2; exit 1
fi
mkdir -p "$LOGS"

# --- 前端 ---
( cd "$ROOT/web" && exec "$VITE_BIN" --host "$HOST" --port "$WEB_PORT" ) >>"$LOGS/web.log" 2>&1 &
WEB_PID=$!
echo "$WEB_PID" > "$LOGS/web.pid"
say "==> 前端启动中 … http://127.0.0.1:$WEB_PORT  （日志：.dev-logs/web.log，PID $WEB_PID）"

# --- 本地 Agent（可选） ---
if [ "$WITH_AGENT" = 1 ]; then
  if port_open "$AGENT_PORT"; then
    say "==> 本地 Agent 已在运行（:$AGENT_PORT），复用，不重启"
  elif [ -x "$ROOT/canvas-agent/node_modules/.bin/tsx" ]; then
    ( cd "$ROOT/canvas-agent" && exec ./node_modules/.bin/tsx src/index.ts ) >>"$LOGS/agent.log" 2>&1 &
    AGENT_PID=$!
    echo "$AGENT_PID" > "$LOGS/agent.pid"
    say "==> 本地 Agent 启动中 … http://127.0.0.1:$AGENT_PORT  （日志：.dev-logs/agent.log，PID $AGENT_PID）"
  else
    say "==> 跳过本地 Agent（canvas-agent 未装依赖：bash scripts/setup.sh）"
  fi
fi

# --- 等前端真的能访问 ---
for _ in $(seq 1 40); do
  port_open "$WEB_PORT" && break
  sleep 0.5
done
if port_open "$WEB_PORT"; then say "==> 前端已就绪：http://127.0.0.1:$WEB_PORT"
else say "!! 前端 20 秒内没起来，看 .dev-logs/web.log" >&2; fi
if [ "$WITH_AGENT" = 1 ]; then
  say "    本地 Agent token：~/.infinite-canvas/canvas-agent.json（首次运行会自动生成）"
  say "    注意：改了 canvas-agent/src 必须重启 Agent 进程才会生效（tsx 没有 watch）"
fi
say ""
say "==> 按 Ctrl+C 停止（只停本脚本起的进程）；后台残留可用 bash scripts/stop.sh"

wait
