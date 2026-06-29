#!/usr/bin/env bash
#
# 启动 macOS 网易云桥接服务。
# 首次运行会自动编译 mediaremote-adapter 框架（需要 cmake 与 Xcode 命令行工具）。
#
set -euo pipefail

DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
VENDOR="$DIR/vendor/mediaremote-adapter"
FRAMEWORK="$VENDOR/build/MediaRemoteAdapter.framework"

if [ ! -d "$FRAMEWORK" ]; then
    echo "==> 首次运行：编译 MediaRemoteAdapter.framework"
    if ! command -v cmake >/dev/null 2>&1; then
        echo "错误：未找到 cmake。请先安装：brew install cmake" >&2
        exit 1
    fi
    mkdir -p "$VENDOR/build"
    (
        cd "$VENDOR/build"
        cmake -DCMAKE_OSX_ARCHITECTURES="$(uname -m)" ..
        cmake --build .
    )
    echo "==> 编译完成"
fi

cd "$DIR/.."
echo "==> 启动桥接服务 (ws://127.0.0.1:35010)。按 Ctrl+C 退出。"
exec node "$DIR/server.js"
