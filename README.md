# NeteasePlugin — with macOS support

FlexBar 控制面板：在 FlexBar 上显示网易云音乐的**正在播放 / 歌词 / 进度**并控制**播放、暂停、上一首、下一首**。

> 这是在 [ENIAC-Tech/NeteasePlugin](https://github.com/ENIAC-Tech/NeteasePlugin) 基础上**增加了 macOS 支持**的版本。
> 原插件通过 Windows 上的 BetterNCM + FlexLink 工作；本仓库新增 `macos-bridge/`，让它在 macOS 上也能用。

<p align="center">
  <img src="com.h0ypothesis.neteaseplugin.mac.plugin/resources/Netease.png" alt="Netease Plugin Logo" />
</p>

## 工作原理

FlexBar 插件本身是一个 **WebSocket 客户端**，连接 `ws://127.0.0.1:35010`，等待一个"服务端"
推送播放状态、并接收控制命令。不同平台的"服务端"不一样：

- **Windows**：服务端是注入到网易云客户端里的 **FlexLink**（经由 BetterNCM，依赖 `smtc_handler.dll`，Windows 专属）。
- **macOS**：没有 FlexLink。本仓库的 **`macos-bridge/`** 充当这个服务端——它从 macOS 系统的「正在播放」读取网易云的播放信息，从网易云公开接口拉取歌词，再统一在 35010 端口提供给插件。

```
网易云 → macOS 正在播放 → mediaremote-adapter → macos-bridge → ws:35010 → FlexBar 插件
```

> macOS 15.4 起 Apple 锁死了第三方进程直接读取 MediaRemote 的能力。`macos-bridge` 借助
> [mediaremote-adapter](https://github.com/ungive/mediaremote-adapter)（已内置于 `vendor/`，BSD-3）
> 通过系统自带且被授权的 `/usr/bin/perl` 绕过该限制。详见 [`macos-bridge/README.md`](macos-bridge/README.md)。

---

## macOS 快速开始

**前置条件**

- macOS（已在 macOS 26/Tahoe 家族、Apple Silicon 实测）
- Node.js 18+
- 首次运行需编译一个小框架：Xcode 命令行工具 + cmake
  ```bash
  xcode-select --install      # 若尚未安装
  brew install cmake          # 若尚未安装
  ```

**运行桥接服务**

```bash
npm install
npm run macos:bridge        # 首次会自动编译辅助框架，随后监听 ws://127.0.0.1:35010
```

看到 `WebSocket 服务已启动: ws://127.0.0.1:35010` 即就绪。然后打开网易云音乐播放歌曲，
并在 FlexDesigner 里把插件按键放到 FlexBar 上。

**让它开机自启 / 常驻**

```bash
bash macos-bridge/install-launchagent.sh     # 登录自动启动、崩溃自动重启
bash macos-bridge/uninstall-launchagent.sh   # 撤销
```

### macOS 功能与限制

| 功能 | 状态 |
| --- | --- |
| 歌曲名 / 歌手 / 专辑 / 封面 | ✅ |
| 播放进度条 | ✅ |
| 播放 / 暂停 / 上一首 / 下一首 | ✅ |
| 逐行歌词 + 翻译 | ✅ 按"歌名+时长"匹配网易云曲库后拉取，随进度滚动 |
| 逐字(karaoke)高亮 | ⚠️ 数据可得(yrc)，当前仅启用逐行 |
| 播放模式（顺序/随机/循环） | ⚠️ 网易云不向系统上报，固定显示顺序，切换为尽力而为 |

完整说明（含环境变量、目录结构、匹配边界）见 [`macos-bridge/README.md`](macos-bridge/README.md)。

---

## Windows（原方案）

在 Windows 上按插件配置页的引导安装 网易云 + BetterNCM + FlexLink 即可，与本 fork 无关、保持原样。

## 插件开发

```bash
npm install
npm run dev          # 链接并热重载插件
npm run build        # 构建
npm run plugin:pack  # 打包
```

## 致谢 / 许可

- 原插件：[ENIAC-Tech/NeteasePlugin](https://github.com/ENIAC-Tech/NeteasePlugin)
- [mediaremote-adapter](https://github.com/ungive/mediaremote-adapter) — Jonas van den Berg，BSD-3-Clause（见 `macos-bridge/vendor/mediaremote-adapter/LICENSE`）
