#!/bin/bash
# cdp-allow-dialog.sh — Chrome「要允许远程调试吗？」弹窗自动点击器
#
# 背景：chrome://inspect 的开关只管开端口，另有一个按「每条新建 WebSocket 连接」
# 生效的授权弹窗管「允许谁连」。Chrome 官方明确拒绝让其持久化
# （ChromeDevTools/chrome-devtools-mcp#825，closed as not planned），
# 因此只能在外部把弹窗点掉。
#
# 用法：
#   cdp-allow-dialog.sh once       扫一次，点掉一个匹配弹窗后退出
#   cdp-allow-dialog.sh watch      常驻轮询（默认）
#   cdp-allow-dialog.sh status     打印辅助功能权限 / 浏览器 / 9222 端口状态
#   cdp-allow-dialog.sh install    装 LaunchAgent 并启动
#   cdp-allow-dialog.sh uninstall  卸载 LaunchAgent
#   cdp-allow-dialog.sh logs       跟踪日志
#
# 可选环境变量：
#   CDP_ALLOW_INTERVAL  轮询间隔秒，默认 1
#   CDP_ALLOW_TIMEOUT   单次 AppleScript 超时秒，默认 8
#   CDP_ALLOW_DRY=1     只报告匹配、不点击

set -uo pipefail

LABEL="com.damon.cdp-allow-dialog"
SELF_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd -P)"
SELF="$SELF_DIR/$(basename -- "${BASH_SOURCE[0]}")"
AS_SCRIPT="$SELF_DIR/cdp-allow-dialog.applescript"
INTERVAL="${CDP_ALLOW_INTERVAL:-3}"
TIMEOUT="${CDP_ALLOW_TIMEOUT:-8}"
LOG_FILE="${CDP_ALLOW_LOG:-$HOME/Library/Logs/cdp-allow-dialog.log}"
PLIST="$HOME/Library/LaunchAgents/${LABEL}.plist"

log() { printf '[%s] %s\n' "$(date '+%Y-%m-%d %H:%M:%S')" "$*" | tee -a "$LOG_FILE"; }

accessibility_enabled() {
  /usr/bin/osascript -e 'tell application "System Events" to UI elements enabled' 2>/dev/null | grep -q '^true$'
}

# 单次扫描：返回 0=点掉了 1=无匹配 3=无辅助功能权限 4=超时 2=其它错误
scan_once() {
  [ -f "$AS_SCRIPT" ] || { log "找不到 AppleScript: $AS_SCRIPT"; return 2; }

  local out status
  out="$(/usr/bin/perl -e 'alarm shift @ARGV; exec @ARGV' "$TIMEOUT" \
        /usr/bin/osascript "$AS_SCRIPT" 2>&1)"
  status=$?

  if [ "$status" -eq 142 ]; then log "AppleScript 扫描超时（${TIMEOUT}s）"; return 4; fi
  if [ "$status" -ne 0 ]; then log "osascript 失败: $out"; return 2; fi

  case "$out" in
    NO_ACCESS)
      log "辅助功能权限未开启。到「系统设置 → 隐私与安全性 → 辅助功能」给运行方打勾。"
      return 3 ;;
    NO_BROWSER)
      return 1 ;;
    NO_MATCH)
      return 1 ;;
    CLICKED*)
      log "已自动点击: ${out//$'\t'/ }"
      return 0 ;;
    CLICK_FAILED*)
      log "点击失败: ${out//$'\t'/ }"
      return 2 ;;
    *)
      log "未知返回: $out"
      return 2 ;;
  esac
}

do_watch() {
  log "开始监听 Chrome 远程调试授权弹窗，间隔 ${INTERVAL}s。日志：$LOG_FILE"
  trap 'log "停止监听。"; exit 0' INT TERM
  local no_perm_logged=0
  while true; do
    scan_once
    local rc=$?
    if [ "$rc" -eq 3 ]; then
      if [ "$no_perm_logged" -eq 0 ]; then no_perm_logged=1; else :; fi
    else
      no_perm_logged=0
    fi
    sleep "$INTERVAL"
  done
}

show_status() {
  echo "辅助功能权限: $(accessibility_enabled && echo 已开启 || echo '未开启 ← 需要授权')"
  echo "AppleScript : $AS_SCRIPT"
  echo "日志        : $LOG_FILE"
  local found=""
  for a in "Google Chrome" "Google Chrome Beta" "Google Chrome Canary" "Chromium" "Microsoft Edge" "Brave Browser"; do
    if pgrep -x "$a" >/dev/null 2>&1; then found="$found$a  "; fi
  done
  echo "运行中的浏览器: ${found:-（无）}"
  if nc -z -G 1 127.0.0.1 9222 >/dev/null 2>&1; then echo "9222 端口: 开"; else echo "9222 端口: 关"; fi
  if [ -f "$PLIST" ]; then
    local st
    st="$(launchctl print "gui/$(id -u)/${LABEL}" 2>/dev/null | awk '/state =/{print $3; exit}')"
    echo "LaunchAgent: 已安装 (state=${st:-unknown})"
  else
    echo "LaunchAgent: 未安装"
  fi
}

# 关键设计：让 launchd 直接调用 /usr/bin/osascript，而不是包一层 bash。
# macOS 的辅助功能（TCC）授权是按「主可执行文件」判定的：
#   · 若用 /bin/bash 做入口，就必须把 /bin/bash 加进辅助功能 —— 授权面极宽，
#     等于任何脚本都能驱动 UI，不能接受。
#   · 改成 /usr/bin/osascript 做入口，只需授权这一个系统脚本，面收窄很多。
# 用 StartInterval 定时轮询而非 KeepAlive 常驻循环，是为了让入口保持 osascript；
# AppleScript 内部只在真正点击时才写日志，所以不会刷爆日志。
do_install() {
  mkdir -p "$(dirname "$PLIST")" "$(dirname "$LOG_FILE")"
  cat > "$PLIST" <<EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>${LABEL}</string>
  <key>ProgramArguments</key>
  <array>
    <string>/usr/bin/osascript</string>
    <string>${AS_SCRIPT}</string>
  </array>
  <key>StartInterval</key>
  <integer>${INTERVAL}</integer>
  <key>RunAtLoad</key>
  <true/>
  <key>StandardOutPath</key>
  <string>/dev/null</string>
  <key>StandardErrorPath</key>
  <string>${HOME}/Library/Logs/cdp-allow-dialog.err.log</string>
  <key>ProcessType</key>
  <string>Background</string>
</dict>
</plist>
EOF
  launchctl bootout "gui/$(id -u)" "$PLIST" >/dev/null 2>&1 || true
  launchctl bootstrap "gui/$(id -u)" "$PLIST" 2>&1 | head -3
  launchctl enable "gui/$(id -u)/${LABEL}" >/dev/null 2>&1 || true
  echo "已安装并启动: $LABEL（每 ${INTERVAL}s 扫一次）"
  echo "Plist: $PLIST"
}

do_uninstall() {
  launchctl bootout "gui/$(id -u)" "$PLIST" >/dev/null 2>&1 || true
  [ -f "$PLIST" ] && mv "$PLIST" "$HOME/.Trash/$(basename "$PLIST").$(date +%Y%m%d-%H%M%S)" 2>/dev/null
  echo "已卸载: $LABEL"
}

case "${1:-watch}" in
  once)      scan_once; echo "exit=$?" ;;
  watch)     do_watch ;;
  status)    show_status ;;
  install)   do_install ;;
  uninstall) do_uninstall ;;
  logs)      tail -n 60 -f "$LOG_FILE" ;;
  *)         echo "用法: $(basename "$0") [once|watch|status|install|uninstall|logs]"; exit 2 ;;
esac
