#!/usr/bin/env bash
# 一键初始化：装齐依赖（web / 插件 / canvas-agent），并按需把插件构建同步到 web/public/plugins/。
#
# 为什么要有这个脚本（这几步有几个"不写就会踩"的坑）：
#   1) web/package.json 声明了 packageManager=bun，pnpm 默认会拒绝执行，必须带两个 config 关闭校验；
#   2) npm 官方源在国内很慢，脚本会自动挑一个可用的镜像源；
#   3) 插件必须先装依赖、再 build，产物才会同步到 web/public/plugins/（画布才认这个插件）；
#   4) Vite 7 要求 Node ^20.19 || >=22.12，版本不对会报很难懂的错误，这里提前检查。
#
# 用法：
#   bash scripts/setup.sh                      # 自动挑 registry
#   bash scripts/setup.sh --registry URL        # 指定 registry
#   bash scripts/setup.sh --skip-plugin-build   # 只装依赖，不构建插件
#   bash scripts/setup.sh --dry-run             # 只打印要做什么，不动环境
set -uo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
REGISTRY=""; DRY_RUN=0; SKIP_PLUGIN_BUILD=0
while [ $# -gt 0 ]; do
  case "$1" in
    --registry) REGISTRY="${2:-}"; shift 2 ;;
    --dry-run) DRY_RUN=1; shift ;;
    --skip-plugin-build) SKIP_PLUGIN_BUILD=1; shift ;;
    -h|--help) sed -n '3,16p' "$0" | sed 's/^# \{0,1\}//'; exit 0 ;;
    *) echo "未知参数：$1（用 --help 看用法）" >&2; exit 2 ;;
  esac
done

say() { printf '%s\n' "$*"; }
run() { if [ "$DRY_RUN" = 1 ]; then say "[dry-run] $*"; else say "+ $*"; "$@"; fi }

say "==> 项目根目录：$ROOT"

# --- Node 版本检查（Vite 7 的硬要求） ---
if ! command -v node >/dev/null 2>&1; then
  say "!! 没找到 node。请先装 Node（需要 ^20.19 或 >=22.12），再跑本脚本。" >&2; exit 1
fi
NODE_RAW="$(node -v)"; NODE_VER="${NODE_RAW#v}"
NODE_MAJOR="${NODE_VER%%.*}"
NODE_REST="${NODE_VER#*.}"; NODE_MINOR="${NODE_REST%%.*}"
node_ok=1
if [ "$NODE_MAJOR" -lt 20 ]; then node_ok=0; fi
if [ "$NODE_MAJOR" -eq 20 ] && [ "$NODE_MINOR" -lt 19 ]; then node_ok=0; fi
if [ "$NODE_MAJOR" -eq 22 ] && [ "$NODE_MINOR" -lt 12 ]; then node_ok=0; fi
if [ "$NODE_MAJOR" -eq 21 ]; then node_ok=0; fi
if [ "$node_ok" = 0 ]; then
  say "!! Node $NODE_RAW 不满足 Vite 7 的要求（^20.19.0 || >=22.12.0），请换版本后再跑。" >&2; exit 1
fi
say "==> Node $NODE_RAW ✓"

# --- pnpm 检查（web 用 pnpm 装；npm install 会因为 peer 冲突装不上） ---
if ! command -v pnpm >/dev/null 2>&1; then
  say "!! 没找到 pnpm。装法： npm i -g pnpm  （或 corepack enable pnpm）" >&2; exit 1
fi

# --- registry：先探测，装失败还会自动换下一个源（探测不准也不至于卡住） ---
registry_reachable() { command -v curl >/dev/null 2>&1 && curl -fsS --max-time 4 -o /dev/null "$1/nanoid" >/dev/null 2>&1; }
REGISTRIES=()
[ -n "$REGISTRY" ] && REGISTRIES+=("$REGISTRY")
# 国内镜像优先（实测比官方源快约 10 倍）；镜像不通时自动落到官方源
REGISTRIES+=("https://registry.npmmirror.com" "https://registry.npmjs.org")
# 顺序 = 探测通的在前 + 其余留在后面兜底（探测偶尔超时也不会漏掉可用的源）
ORDER=()
for r in "${REGISTRIES[@]}"; do registry_reachable "$r" && ORDER+=("$r"); done
for r in "${REGISTRIES[@]}"; do
  for seen in ${ORDER[@]+"${ORDER[@]}"}; do [ "$seen" = "$r" ] && continue 2; done
  ORDER+=("$r")
done
REACHABLE=(${ORDER[@]+"${ORDER[@]}"})
if [ "${#REACHABLE[@]}" -gt 0 ]; then
  say "==> registry 尝试顺序：${REACHABLE[*]}"
else
  REACHABLE=("")
  say "==> 没探测通任何 registry，用本机已配置的源"
fi

# 逐个源重试：把 REG 交给下面的函数用
REG=""
with_registry() {
  local fn="$1" r
  for r in "${REACHABLE[@]}"; do
    REG="$r"
    [ -n "$r" ] && say "    用 $r" || say "    用本机默认源"
    if "$fn"; then return 0; fi
    say "    ^ 这一步失败，换下一个源重试 …"
  done
  return 1
}
reg_args() { if [ -n "${REG:-}" ]; then printf -- '--registry\n%s\n' "$REG"; fi; }

install_web() {
  local args=(install --config.manage-package-manager-versions=false --config.package-manager-strict=false)
  [ -n "${REG:-}" ] && args+=(--registry "$REG")
  ( cd "$ROOT/web" && run pnpm "${args[@]}" )
}
install_plugin() {
  local args=(install); [ -n "${REG:-}" ] && args+=(--registry "$REG")
  ( cd "$ROOT/plugins/canvas/director-stage" && run npm "${args[@]}" )
}
install_agent() {
  local args=(install); [ -n "${REG:-}" ] && args+=(--registry "$REG")
  ( cd "$ROOT/canvas-agent" && run npm "${args[@]}" )
}

# --- web（pnpm；两个 config 是 packageManager=bun 必需的） ---
say ""
say "==> [1/3] web 依赖 …"
with_registry install_web || { say "!! web 依赖安装失败（可用 --registry URL 指定源）" >&2; exit 1; }

# --- 插件（npm；装完 build 才会同步到 web/public/plugins/） ---
say ""
say "==> [2/3] 导演台插件依赖 + 构建 …"
with_registry install_plugin || { say "!! 插件依赖安装失败" >&2; exit 1; }
if [ "$SKIP_PLUGIN_BUILD" = 1 ]; then
  say "--skip-plugin-build：跳过构建（插件产物已随包提供，直接用就行）"
else
  ( cd "$ROOT/plugins/canvas/director-stage" && run npm run build ) || { say "!! 插件构建失败" >&2; exit 1; }
fi

# --- canvas-agent（npm；可选，只有用本地 Agent 才需要） ---
say ""
say "==> [3/3] canvas-agent 依赖 …"
with_registry install_agent || say "!! canvas-agent 依赖安装失败（不影响只用画布）" >&2

say ""
say "==> 完成。下一步："
say "    bash scripts/dev.sh            # 启动前端（+ 本地 Agent）"
say "    bash scripts/dev.sh --port 3100 --no-agent   # 只起前端、换端口"
