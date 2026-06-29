#!/usr/bin/env bash
#
# 卸载 LaunchAgent（停止自动启动并停止当前服务）。
#
set -euo pipefail

LABEL="com.eniac.neteaseplugin.bridge"
PLIST="$HOME/Library/LaunchAgents/$LABEL.plist"
UID_NUM="$(id -u)"

launchctl bootout "gui/$UID_NUM/$LABEL" 2>/dev/null || true
rm -f "$PLIST"
echo "已卸载 LaunchAgent: $LABEL（如需临时运行：npm run macos:bridge）"
