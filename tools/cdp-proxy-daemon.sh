#!/bin/bash
# cdp-proxy-daemon.sh — web-access CDP 代理的常驻包装脚本
#
# 作用：给 LaunchAgent 调用，负责
#   1. 动态解析 node（managed 版本目录带版本号，直接写进 plist 会在升级后失效）
#   2. 清掉上次残留的代理进程，保证端口 3456 只有一份
#   3. exec 代理本体，让 launchd 直接监管
#
# 为什么代理要常驻：Chrome 的「允许远程调试」授权是按「每条新建 WebSocket 连接」
# 生效的，连接断了再连就得重新批准。常驻长连接是 Chrome 官方推荐的规避方式
# （ChromeDevTools/chrome-devtools-mcp#825）。

set -uo pipefail

PROXY="$HOME/.workbuddy/skills/web-access/scripts/cdp-proxy.mjs"

# --- 1. 解析 node ---
NODE=""
for cand in "$HOME"/.workbuddy/binaries/node/versions/*/bin/node \
            /usr/local/bin/node \
            /opt/homebrew/bin/node \
            /usr/bin/node; do
  if [ -x "$cand" ]; then NODE="$cand"; fi
done
if [ -z "$NODE" ]; then
  echo "[cdp-proxy] 找不到可用的 node" >&2
  exit 1
fi

# --- 2. 代理本体存在性 ---
if [ ! -f "$PROXY" ]; then
  echo "[cdp-proxy] 代理脚本不存在: $PROXY" >&2
  echo "[cdp-proxy] web-access skill 可能被卸载或改名，守护将退出。" >&2
  exit 1
fi

# --- 3. 清掉残留实例（含之前手工/会话里启的） ---
pkill -f "cdp-proxy\.mjs" >/dev/null 2>&1
sleep 1

echo "[cdp-proxy] $(date '+%Y-%m-%d %H:%M:%S') 启动: $NODE $PROXY --browser chrome"

# --- 4. 前台 exec，交给 launchd 监管 ---
exec "$NODE" "$PROXY" --browser chrome
