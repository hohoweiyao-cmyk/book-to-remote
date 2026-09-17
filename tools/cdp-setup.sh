#!/bin/bash
# cdp-setup.sh — 一键安装「CDP 代理常驻 + 调试授权弹窗自动点击」
#
# 为什么必须手动在 Terminal 里跑一次：
#   launchctl bootstrap gui/<uid> 需要调用方处于 Aqua 登录会话。从 AI 助手
#   的脚本沙箱里调用会稳定失败（Bootstrap failed: 5: Input/output error），
#   连 /bin/date 这种最小 agent 也一样。装完一次之后长期有效。
#
# 用法：
#   bash ~/.workbuddy/tools/cdp-setup.sh            # 安装 + 自检
#   bash ~/.workbuddy/tools/cdp-setup.sh --remove    # 卸载
#   bash ~/.workbuddy/tools/cdp-setup.sh --status    # 只看状态

set -uo pipefail

TOOLS="$HOME/.workbuddy/tools"
SELF_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd -P)"

# 自部署：plist 里写的是 ~/.workbuddy/tools 这个固定路径，所以无论从哪里运行
# （比如直接跑仓库里的 tools/cdp-setup.sh），都先把工具集归位到该目录再重新执行，
# 否则 plist 会指向仓库路径，仓库一移动守护就废了。
if [ "$SELF_DIR" != "$TOOLS" ]; then
  mkdir -p "$TOOLS"
  for f in cdp-setup.sh cdp-proxy-daemon.sh cdp-allow-dialog.sh cdp-allow-dialog.applescript; do
    [ -f "$SELF_DIR/$f" ] && cp -f "$SELF_DIR/$f" "$TOOLS/$f"
  done
  chmod +x "$TOOLS"/*.sh 2>/dev/null
  echo "已将工具集归位到 $TOOLS，从该路径继续执行…"
  exec bash "$TOOLS/cdp-setup.sh" "$@"
fi

AGENTS="$HOME/Library/LaunchAgents"
UID_N="$(id -u)"
PROXY_LABEL="com.damon.cdp-proxy"
ALLOW_LABEL="com.damon.cdp-allow-dialog"
PROXY_PLIST="$AGENTS/${PROXY_LABEL}.plist"
ALLOW_PLIST="$AGENTS/${ALLOW_LABEL}.plist"

c() { printf '\033[%sm%s\033[0m\n' "$1" "$2"; }
ok()   { c "1;32" "  ✓ $*"; }
warn() { c "1;33" "  ! $*"; }
bad()  { c "1;31" "  ✗ $*"; }
step() { printf '\n'; c "1;36" "▸ $*"; }

id_check() {
  if [ -z "${TERM_SESSION_ID:-}${SECURITYSESSIONID:-}${SSH_TTY:-}" ]; then
    warn "当前看起来不在交互式终端会话里。若下面报 Bootstrap failed: 5，请改用 Terminal.app 运行本脚本。"
  fi
}

write_proxy_plist() {
  mkdir -p "$AGENTS"
  cat > "$PROXY_PLIST" <<EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>${PROXY_LABEL}</string>
  <key>ProgramArguments</key>
  <array>
    <string>/bin/bash</string>
    <string>${TOOLS}/cdp-proxy-daemon.sh</string>
  </array>
  <key>RunAtLoad</key>
  <true/>
  <key>KeepAlive</key>
  <true/>
  <key>ThrottleInterval</key>
  <integer>30</integer>
  <key>StandardOutPath</key>
  <string>${HOME}/Library/Logs/cdp-proxy.out.log</string>
  <key>StandardErrorPath</key>
  <string>${HOME}/Library/Logs/cdp-proxy.err.log</string>
</dict>
</plist>
EOF
  chmod 644 "$PROXY_PLIST"
}

bootstrap_one() {
  local plist="$1" label="$2"
  launchctl bootout "gui/${UID_N}" "$plist" >/dev/null 2>&1 || true
  local out
  out="$(launchctl bootstrap "gui/${UID_N}" "$plist" 2>&1)"
  if [ -n "$out" ]; then
    bad "加载 $label 失败: $out"
    return 1
  fi
  launchctl enable "gui/${UID_N}/${label}" >/dev/null 2>&1 || true
  launchctl kickstart -k "gui/${UID_N}/${label}" >/dev/null 2>&1 || true
  ok "$label 已加载"
  return 0
}

do_install() {
  step "1/4 检查前置文件"
  local missing=0
  for f in "$TOOLS/cdp-proxy-daemon.sh" "$TOOLS/cdp-allow-dialog.sh" "$TOOLS/cdp-allow-dialog.applescript"; do
    if [ -f "$f" ]; then ok "$(basename "$f")"; else bad "缺少 $f"; missing=1; fi
  done
  if [ ! -f "$HOME/.workbuddy/skills/web-access/scripts/cdp-proxy.mjs" ]; then
    bad "缺少 web-access 的 cdp-proxy.mjs（skill 被卸载或改名了？）"; missing=1
  fi
  [ "$missing" -eq 1 ] && { bad "前置不齐，中止。"; exit 1; }

  step "2/4 安装 CDP 代理常驻守护"
  write_proxy_plist
  bootstrap_one "$PROXY_PLIST" "$PROXY_LABEL"

  step "3/4 安装授权弹窗自动点击守护"
  bash "$TOOLS/cdp-allow-dialog.sh" install | sed 's/^/  /'
  if grep -q "$ALLOW_LABEL" "$ALLOW_PLIST" 2>/dev/null; then
    ok "plist 已生成: $ALLOW_PLIST"
  else
    bad "弹窗点击守护的 plist 没生成"
  fi

  step "4/4 自检"
  sleep 5
  # 辅助功能权限
  if /usr/bin/osascript -e 'tell application "System Events" to UI elements enabled' 2>/dev/null | grep -q '^true$'; then
    ok "辅助功能权限已开启"
  else
    bad "辅助功能权限未开启 —— 弹窗点击守护不会生效"
    echo "      路径：系统设置 → 隐私与安全性 → 辅助功能"
    echo "      点 + 号添加下面这一项（Cmd+Shift+G 可直接粘贴路径）："
    c "1;33" "        /usr/bin/osascript"
    echo "      只加这一个即可：守护的入口就是它，不需要给 /bin/bash 授权。"
    echo "      加了之后立即生效，也可以手动触发一次验证："
    echo "        launchctl kickstart -k gui/${UID_N}/${ALLOW_LABEL}"
    read -r -p "      现在打开辅助功能设置面板？[Y/n] " a
    case "${a:-Y}" in [Yy]*) open "x-apple.systempreferences:com.apple.preference.security?Privacy_Accessibility" ;; esac
  fi
  # 代理端口
  if nc -z -G 1 127.0.0.1 3456 >/dev/null 2>&1; then ok "代理端口 3456 在监听"; else warn "代理端口 3456 未监听（看 ~/Library/Logs/cdp-proxy.err.log）"; fi
  if nc -z -G 1 127.0.0.1 9222 >/dev/null 2>&1; then ok "Chrome 调试端口 9222 在监听"; else warn "9222 未监听 —— 到 chrome://inspect/#remote-debugging 确认开关已开"; fi

  printf '\n'
  c "1;32" "安装完成。之后："
  echo "  · Chrome 弹「要允许远程调试吗？」会被自动点掉，无需你干预"
  echo "  · 代理常驻，不再需要每次任务重启"
  echo "  · 查状态： bash $TOOLS/cdp-setup.sh --status"
  echo "  · 看日志： tail -f ~/Library/Logs/cdp-allow-dialog.log"
}

do_remove() {
  step "卸载"
  for pair in "$PROXY_PLIST:$PROXY_LABEL" "$ALLOW_PLIST:$ALLOW_LABEL"; do
    plist="${pair%%:*}"; label="${pair##*:}"
    launchctl bootout "gui/${UID_N}" "$plist" >/dev/null 2>&1 || true
    if [ -f "$plist" ]; then
      mkdir -p "$HOME/.Trash"
      mv "$plist" "$HOME/.Trash/$(basename "$plist").$(date +%Y%m%d-%H%M%S)"
    fi
    ok "$label 已卸载（plist 已移入废纸篓）"
  done
  pkill -f "cdp-proxy\.mjs" >/dev/null 2>&1 || true
  pkill -f "cdp-allow-dialog" >/dev/null 2>&1 || true
  ok "相关进程已停止"
}

do_status() {
  step "服务状态"
  for label in "$PROXY_LABEL" "$ALLOW_LABEL"; do
    st="$(launchctl print "gui/${UID_N}/${label}" 2>/dev/null | awk '/state =/{print $3; exit}')"
    if [ -n "$st" ]; then ok "$label: $st"; else warn "$label: 未加载"; fi
  done
  step "运行态"
  pgrep -f "cdp-proxy\.mjs" >/dev/null 2>&1 && ok "代理进程在跑" || warn "代理进程不在"
  pgrep -f "cdp-allow-dialog" >/dev/null 2>&1 && ok "弹窗点击守护在跑" || warn "弹窗点击守护不在"
  if /usr/bin/osascript -e 'tell application "System Events" to UI elements enabled' 2>/dev/null | grep -q '^true$'; then
    ok "辅助功能权限已开启"
  else
    bad "辅助功能权限未开启"
  fi
  step "端口"
  for p in 3456 9222; do
    nc -z -G 1 127.0.0.1 "$p" >/dev/null 2>&1 && ok "$p 在监听" || warn "$p 未监听"
  done
  step "代理自检"
  node -e "fetch('http://127.0.0.1:3456/health',{signal:AbortSignal.timeout(5000)}).then(r=>r.json()).then(j=>console.log(JSON.stringify(j))).catch(e=>console.log('ERR:',e.message))" 2>/dev/null | sed 's/^/  /'
}

id_check
case "${1:-}" in
  --remove|--uninstall) do_remove ;;
  --status)             do_status ;;
  *)                    do_install ;;
esac
