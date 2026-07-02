#!/usr/bin/env bash
#
# 安装 LaunchAgent：让桥接服务在登录时自动启动、崩溃时自动重启。
# 反向操作见 uninstall-launchagent.sh
#
set -euo pipefail

DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT="$(cd "$DIR/.." && pwd)"
LABEL="com.h0ypothesis.neteaseplugin.mac.bridge"
PLIST="$HOME/Library/LaunchAgents/$LABEL.plist"
LOG="$HOME/Library/Logs/$LABEL.log"
NODE="$(command -v node || true)"
UID_NUM="$(id -u)"

if [ -z "$NODE" ]; then
    echo "错误：找不到 node，请确认 Node.js 已安装并在 PATH 中。" >&2
    exit 1
fi

if [ ! -d "$DIR/vendor/mediaremote-adapter/build/MediaRemoteAdapter.framework" ]; then
    echo "提示：尚未编译框架，正在编译…"
    if ! command -v cmake >/dev/null 2>&1; then
        echo "错误：未找到 cmake，请先 brew install cmake" >&2
        exit 1
    fi
    mkdir -p "$DIR/vendor/mediaremote-adapter/build"
    ( cd "$DIR/vendor/mediaremote-adapter/build" && cmake -DCMAKE_OSX_ARCHITECTURES="$(uname -m)" .. && cmake --build . )
fi

mkdir -p "$HOME/Library/LaunchAgents" "$HOME/Library/Logs"

cat > "$PLIST" <<EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
    <key>Label</key>
    <string>$LABEL</string>
    <key>ProgramArguments</key>
    <array>
        <string>$NODE</string>
        <string>$DIR/server.js</string>
    </array>
    <key>WorkingDirectory</key>
    <string>$PROJECT</string>
    <key>RunAtLoad</key>
    <true/>
    <key>KeepAlive</key>
    <true/>
    <key>StandardOutPath</key>
    <string>$LOG</string>
    <key>StandardErrorPath</key>
    <string>$LOG</string>
</dict>
</plist>
EOF

echo "写入: $PLIST"

# 先卸载旧的（若存在），再加载
launchctl bootout "gui/$UID_NUM/$LABEL" 2>/dev/null || true
launchctl bootstrap "gui/$UID_NUM" "$PLIST"
launchctl enable "gui/$UID_NUM/$LABEL"
launchctl kickstart "gui/$UID_NUM/$LABEL" 2>/dev/null || true

echo "已加载并启动 LaunchAgent: $LABEL"
echo "日志: $LOG"
