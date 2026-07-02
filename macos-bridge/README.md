# macOS 网易云桥接服务 (NetEase macOS Bridge)

让 FlexBar 的 **NeteasePlugin** 在 **macOS** 上也能连上网易云音乐。

## 背景：为什么需要它

FlexBar 插件本身只是一个 WebSocket **客户端**，它连接 `ws://127.0.0.1:35010`，
等待一个"服务端"推送播放状态、接收播放控制命令。

原方案的服务端是 Windows 上通过 **BetterNCM** 注入网易云的 **FlexLink** 插件
（依赖 `smtc_handler.dll`，是 Windows 专属）。在 macOS 上它无法运行，所以插件
永远连不上 `35010`。

本服务在 macOS 上**充当这个服务端**，数据来源换成 macOS 系统的「正在播放」信息：

```
网易云 → macOS 正在播放(MediaRemote) → mediaremote-adapter → 本服务 → ws:35010 → FlexBar 插件
```

> **关于 macOS 15.4+ 的限制**：Apple 从 macOS 15.4 起锁死了第三方进程直接读取
> MediaRemote 的能力（在本机 macOS 27 上实测：网易云正在播放时直接调用也只返回空）。
> 本服务借助开源项目
> [mediaremote-adapter](https://github.com/ungive/mediaremote-adapter)（BSD-3，已内置于
> `vendor/`）通过系统自带、且被授权的 `/usr/bin/perl`（签名为 `com.apple.perl`）
> 绕过该限制来读取信息。

## 前置条件

- macOS（已在 macOS 27 / Apple Silicon 实测通过）
- Node.js 18+（仓库根目录已 `npm install`，本服务复用根目录的 `ws`）
- 首次运行需要编译一个小框架：**Xcode 命令行工具** + **cmake**
  ```
  xcode-select --install      # 若尚未安装
  brew install cmake          # 若尚未安装
  ```

## 使用

在仓库根目录运行：

```bash
npm run macos:bridge
```

或直接：

```bash
bash macos-bridge/start.sh
```

首次运行会自动编译 `MediaRemoteAdapter.framework`（之后跳过），随后启动服务并监听
`ws://127.0.0.1:35010`。看到下面这行即表示就绪：

```
[bridge] WebSocket 服务已启动: ws://127.0.0.1:35010
```

然后：
1. 打开网易云音乐并播放一首歌；
2. 在 FlexDesigner 里把 NeteasePlugin 的按键放到 FlexBar 上；
3. 按键会显示当前歌曲/封面/进度，播放/暂停/上一首/下一首均可控制。

> 让服务保持在前台运行（或放进后台），插件需要它时它得在线。Ctrl+C 退出。

## 已实现 / 已知限制

| 功能 | 状态 |
| --- | --- |
| 歌曲名 / 歌手 / 专辑 / 封面 | ✅ 实时 |
| 播放进度条（本服务插值，约 1Hz） | ✅ |
| 播放 / 暂停 | ✅ |
| 上一首 / 下一首 | ✅（与播放/暂停同一通道）|
| 逐行歌词 + 翻译 | ✅ MediaRemote 本身不带歌词，本服务按"歌名+时长"在网易云接口匹配并拉取歌词，随进度逐行滚动 |
| 逐字(karaoke)高亮 | ⚠️ 网易云有逐字数据(yrc)，但当前仅启用逐行；如需逐字高亮可再扩展 |
| 播放模式（顺序/随机/循环）显示与切换 | ⚠️ 网易云不向系统上报播放模式，故固定显示“顺序”，切换为尽力而为，系统通常会忽略 |

> 歌词靠"歌名+时长"匹配网易云曲库，绝大多数能命中；遇到翻唱/现场/冷门版本可能匹配不到或匹配偏差，此时歌词键回退为显示歌曲信息。

## 配置（环境变量）

| 变量 | 默认 | 说明 |
| --- | --- | --- |
| `NETEASE_WS_PORT` | `35010` | WebSocket 端口（需与插件一致）|
| `NETEASE_WS_HOST` | `127.0.0.1` | 监听地址 |
| `NETEASE_ANY_APP` | 未设置 | 设为任意值则不再只过滤网易云，透传系统当前任意播放源 |
| `DEBUG` | 未设置 | 设为任意值打印调试日志 |

## 目录结构

```
macos-bridge/
  server.js                     # Node 桥接服务（WS 服务端 + 协议翻译）
  start.sh                      # 启动脚本（首次自动编译框架）
  vendor/mediaremote-adapter/   # 内置的 mediaremote-adapter (BSD-3)
    build/                      # 编译产物（已 gitignore，由 start.sh 重建）
```

## 致谢

- [mediaremote-adapter](https://github.com/ungive/mediaremote-adapter) — Jonas van den Berg，BSD-3-Clause。
