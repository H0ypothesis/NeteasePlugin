# NeteasePlugin — with native macOS support

FlexBar 控制面板：在 FlexBar 上显示网易云音乐的**正在播放 / 歌词 / 进度**并控制**播放、暂停、上一首、下一首、喜欢(红心)**。

> 这是在 [ENIAC-Tech/NeteasePlugin](https://github.com/ENIAC-Tech/NeteasePlugin) 基础上**增加了 macOS 支持**的版本。
> 原插件只在 Windows 上（经 BetterNCM + FlexLink）工作；本仓库让 **macOS 也能用，且是内置原生的——
> 装上插件即可，无需在电脑上再单独跑任何后台服务**。

<p align="center">
  <img src="com.h0ypothesis.neteaseplugin.mac.plugin/resources/Netease.png" alt="Netease Plugin Logo" />
</p>

## 工作原理

FlexBar 插件的后端本身就是一个 **Node.js 进程**（由 FlexDesigner 拉起，`backend/plugin.cjs`）。
不同平台的取数方式不同：

- **Windows**：后端作为 WebSocket 客户端连接注入到网易云里的 **FlexLink**（经 BetterNCM，依赖
  `smtc_handler.dll`，Windows 专属）。
- **macOS**：**无需 FlexLink，也无需任何外部进程**。插件后端**直接在自己进程内**读取 macOS 系统的
  「正在播放」信息（网易云上报的歌曲/进度/封面），从网易云公开接口拉取歌词，然后渲染到按键。

```
macOS：网易云 → 系统「正在播放」→ mediaremote-adapter(内置) → 插件后端(plugin.cjs) → FlexBar 按键
Windows：网易云 + BetterNCM → FlexLink(ws:35010) → 插件后端 → FlexBar 按键
```

> macOS 15.4 起 Apple 锁死了第三方进程直接读取 MediaRemote 的能力。插件借助
> [mediaremote-adapter](https://github.com/ungive/mediaremote-adapter)（BSD-3）通过系统自带、
> 且被授权的 `/usr/bin/perl` 绕过该限制。其编译好的通用(universal)框架已**随插件一起打包**在
> `resources/mediaremote/` 下，因此使用者**不需要**安装 Xcode / cmake，也**不需要**自己编译。

---

## macOS 快速开始

**前置条件**：只需 macOS（Intel 或 Apple Silicon 均可）+ 已安装网易云音乐桌面版。Node.js 由 FlexDesigner 自带，无需另装。

1. 在 FlexDesigner 中安装本插件（见下方「安装 / 开发」）。
2. 打开网易云音乐并播放一首歌。
3. 在 FlexDesigner 里把插件按键（正在播放 / 歌词 / 播放暂停 / 上一首 / 下一首 / 喜欢）拖到 FlexBar 上。

就这样——**没有要单独启动的服务，没有开机自启脚本，没有编译步骤**。

### 关于「喜欢 / 红心」按键（仅 macOS）

网易云没有对系统暴露「喜欢」的媒体命令，所以该按键通过网易云的**应用内快捷键 ⌘L** 实现：
按下时插件会瞬间把网易云切到前台、发送 ⌘L、再切回你原来的窗口。

- macOS 会拦截合成按键，直到你**在「系统设置 → 隐私与安全性 → 辅助功能」中给 FlexDesigner 授权**。
  首次点击「喜欢」若无反应，多半是还没授权。
- 若你已在网易云里为「喜欢」设置了**全局快捷键**，可让插件直接发键、不再切换窗口（无焦点闪烁）：
  设置环境变量 `NETEASE_LIKE_NO_ACTIVATE=1`（并按需 `NETEASE_LIKE_KEY` / `NETEASE_LIKE_MODS`）。
- 默认快捷键/修饰键可用 `NETEASE_LIKE_KEY`（默认 `l`）、`NETEASE_LIKE_MODS`（默认 `command`）覆盖。

### macOS 功能与限制

| 功能 | 状态 |
| --- | --- |
| 歌曲名 / 歌手 / 专辑 / 封面 | ✅ |
| 播放进度条 | ✅ 插件本地插值，随进度滚动 |
| 播放 / 暂停 / 上一首 / 下一首 | ✅ |
| 喜欢（红心，⌘L） | ✅ 需一次性授权「辅助功能」给 FlexDesigner |
| 逐行歌词 + 翻译 | ✅ 按"歌名+时长"匹配网易云曲库后拉取，随进度滚动 |
| 逐字(karaoke)高亮 | ⚠️ 数据可得(yrc)，当前仅启用逐行 |
| 播放模式（顺序/随机/循环） | ⚠️ 网易云不向系统上报，固定显示顺序，切换为尽力而为 |

> 歌词靠"歌名+时长"匹配网易云曲库，绝大多数能命中；遇到翻唱/现场/冷门版本可能匹配不到，此时歌词键回退为显示歌曲信息。

---

## Windows（原方案）

在 Windows 上按插件配置页的引导安装 网易云 + BetterNCM + FlexLink 即可，与本 fork 无关、保持原样。

## 安装 / 开发

```bash
npm install
npm run build          # 编译后端 backend/plugin.cjs（已内置 macOS 数据源与打包框架）
npm run plugin:link    # 链接进 FlexDesigner
npm run plugin:restart # 重启插件
# 或热重载开发：
npm run dev
```

装好后如果 FlexDesigner 的按键库里没立刻出现新按键，退出并重新打开一次 FlexDesigner。

> **提示（Node 25）**：若 `flexcli` 报 `assert { type: 'json' }` 语法错误，是其自身在新版 Node 上的兼容问题，
> 与本插件无关。可执行 `npm i -g @eniac/flexcli` 更新，或临时把该文件里的 `assert` 改为 `with`。

### 打包框架从何而来（可选，通常无需理会）

`resources/mediaremote/` 里的 `MediaRemoteAdapter.framework`（通用二进制 x86_64+arm64）与
`mediaremote-adapter.pl` 已随仓库提供。若想自行重建框架，见 `macos-bridge/`（内含 vendored 源码与
`start.sh` 的 cmake 构建流程），再把产物拷回 `resources/mediaremote/`。

### `macos-bridge/`（可选 / 旧方案）

`macos-bridge/` 是把上述逻辑做成**独立 WebSocket 服务**的早期版本，功能等价但需要单独运行。
现在 macOS 支持已内置进插件，**普通使用者不再需要它**。它保留下来用于：本地调试、或在不想让
FlexDesigner 进程读取 MediaRemote 时作为外部数据源。用法见 [`macos-bridge/README.md`](macos-bridge/README.md)。

## 致谢 / 许可

- 原插件：[ENIAC-Tech/NeteasePlugin](https://github.com/ENIAC-Tech/NeteasePlugin)
- [mediaremote-adapter](https://github.com/ungive/mediaremote-adapter) — Jonas van den Berg，BSD-3-Clause（见 `macos-bridge/vendor/mediaremote-adapter/LICENSE`）
