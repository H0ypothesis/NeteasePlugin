#!/usr/bin/env node
/**
 * macOS 网易云音乐桥接服务 (NetEase macOS Bridge)
 * ============================================================================
 *
 * FlexBar 的 NeteasePlugin 是一个 WebSocket 客户端，它连接 ws://127.0.0.1:35010，
 * 期待一个"服务端"推送播放状态、并接收播放控制命令。原方案的服务端是 Windows 上
 * 通过 BetterNCM 注入网易云的 FlexLink 插件，在 macOS 上无法运行。
 *
 * 本服务在 macOS 上扮演这个服务端：
 *   1. 通过 mediaremote-adapter（/usr/bin/perl 绕过 macOS 15.4+ 对 MediaRemote
 *      的限制）读取系统"正在播放"信息——也就是网易云上报给系统的歌曲/进度/封面。
 *   2. 把这些信息翻译成插件期待的协议（FullState / SongUpdate / ...）并通过
 *      WebSocket 推送给插件。
 *   3. 把插件发来的命令（Play/Pause/NextSong/...）翻译成媒体控制命令发回系统。
 *
 * 数据链路：
 *   网易云 → macOS 正在播放 → mediaremote-adapter → 本服务 → ws:35010 → FlexBar 插件
 *
 * 歌词：
 *   - MediaRemote 不带歌词，故本服务按"歌名+时长"在网易云接口匹配歌曲并拉取逐行
 *     歌词与翻译(见 lyrics.js)，再随进度推送 CurrentLyricUpdate 驱动滚动。
 *
 * 已知限制：
 *   - 网易云不向系统上报"播放模式"(顺序/随机/循环)，所以播放模式键固定显示顺序，
 *     切换命令为"尽力而为"（系统可能忽略）。
 */

'use strict';

const path = require('path');
const fs = require('fs');
const readline = require('readline');
const { spawn } = require('child_process');
const { WebSocketServer } = require('ws');
const { fetchLyrics } = require('./lyrics');

// ============================================================================
// 配置
// ============================================================================

const WS_HOST = process.env.NETEASE_WS_HOST || '127.0.0.1';
const WS_PORT = parseInt(process.env.NETEASE_WS_PORT || '35010', 10);

// 只透传网易云的播放信息（设为空字符串可放行所有 App）。
const ONLY_BUNDLE = process.env.NETEASE_ANY_APP ? null : 'com.netease.163music';

// 网易云的 bundle id（用于 like 时临时激活窗口）
const NETEASE_BUNDLE = 'com.netease.163music';
// like 快捷键（网易云应用内默认 ⌘L），可用环境变量覆盖
const LIKE_KEY = (process.env.NETEASE_LIKE_KEY || 'l').replace(/["\\]/g, '');
const LIKE_MODS = process.env.NETEASE_LIKE_MODS || 'command'; // 逗号分隔: command,option,control,shift
// 若已在网易云里设置了"全局快捷键"，置位此变量则不激活窗口、直接发键（无焦点闪烁）
const LIKE_NO_ACTIVATE = !!process.env.NETEASE_LIKE_NO_ACTIVATE;

const DEBUG = !!process.env.DEBUG;

// mediaremote-adapter 路径
const PERL = '/usr/bin/perl';
const VENDOR = path.join(__dirname, 'vendor', 'mediaremote-adapter');
const ADAPTER_PL = path.join(VENDOR, 'bin', 'mediaremote-adapter.pl');
const FRAMEWORK = path.join(VENDOR, 'build', 'MediaRemoteAdapter.framework');

// MediaRemote 命令 ID（见 vendor/.../include/MediaRemoteAdapter.h）
const CMD = {
    PLAY: 0,
    PAUSE: 1,
    TOGGLE_PLAY_PAUSE: 2,
    STOP: 3,
    NEXT: 4,
    PREVIOUS: 5,
    TOGGLE_SHUFFLE: 6,
    TOGGLE_REPEAT: 7,
};

// 进度条刷新间隔（播放时本服务自行插值，约 1Hz 推送）
const TIMELINE_TICK_MS = 1000;

// 歌词当前行刷新间隔
const LYRIC_TICK_MS = 300;

// ============================================================================
// 日志
// ============================================================================

function ts() {
    return new Date().toISOString().replace('T', ' ').replace('Z', '');
}
function log(...args) {
    console.error(`[${ts()}] [bridge]`, ...args);
}
function debug(...args) {
    if (DEBUG) console.error(`[${ts()}] [debug]`, ...args);
}

// ============================================================================
// 播放状态（原始 + 派生）
// ============================================================================

// 来自 adapter 的最新原始字段（按歌曲合并，便于保留稍后才到达的封面）
let raw = {};
let currentItemId = null;

// 进度插值的基准
let elapsedBaseSec = 0;   // 基准时刻的已播放秒数
let baseAtMs = 0;         // 基准对应的本地时间戳(ms)
let rate = 0;             // 播放速率(0=暂停)
let durationSec = null;   // 总时长(秒)

// 上次推送给客户端的派生状态（用于去重）
let lastSong = undefined;        // JSON 字符串
let lastPlayState = undefined;
let lastPlayMode = undefined;

let timelineTimer = null;

// 歌词状态
let lyricLines = [];              // [{timeMs, text, trans}]
let currentLyricKey = null;       // 已加载/加载中的歌曲标识 (title::artist)
let lyricFetchToken = 0;          // 防止过期异步结果覆盖
let lastSentLyricIndex = -2;
let lyricTimer = null;

// ============================================================================
// 派生：把原始字段翻译成插件期待的结构
// ============================================================================

function deriveSong() {
    const title = raw.title;
    if (!title) return null;
    return {
        songName: title,
        authorName: raw.artist || '',
        albumName: raw.album || '',
        // 渲染器接受裸 base64 或 data: URI；adapter 给的是裸 base64
        coverBase64: raw.artworkData || null,
    };
}

function derivePlayState() {
    if (!raw.title) return 'Stopped';
    return raw.playing ? 'Playing' : 'Paused';
}

function derivePlayMode() {
    // repeatMode: 1=Disabled 2=Track 3=Playlist ; shuffleMode: 1=Disabled 2/3=On
    let repeatMode = 'Off';
    if (raw.repeatMode === 2) repeatMode = 'Track';
    else if (raw.repeatMode === 3) repeatMode = 'List';
    const isShuffling = typeof raw.shuffleMode === 'number' && raw.shuffleMode >= 2;
    return { isShuffling, repeatMode };
}

function currentTimelineMs() {
    if (durationSec == null) return { currentTime: 0, totalTime: 0 };
    let pos = elapsedBaseSec;
    if (raw.playing && rate) {
        pos += ((Date.now() - baseAtMs) / 1000) * rate;
    }
    if (pos < 0) pos = 0;
    if (pos > durationSec) pos = durationSec;
    return {
        currentTime: Math.round(pos * 1000),
        totalTime: Math.round(durationSec * 1000),
    };
}

// ============================================================================
// WebSocket 服务端
// ============================================================================

const clients = new Set();
let wss = null;

function startServer() {
    wss = new WebSocketServer({ host: WS_HOST, port: WS_PORT });

    wss.on('listening', () => {
        log(`WebSocket 服务已启动: ws://${WS_HOST}:${WS_PORT}`);
    });

    wss.on('connection', (socket, req) => {
        clients.add(socket);
        log(`插件已连接 (${req.socket.remoteAddress})，当前连接数 ${clients.size}`);
        // 主动下发一次完整状态
        sendFullState(socket);

        socket.on('message', (data) => {
            let msg;
            try {
                msg = JSON.parse(data.toString());
            } catch (e) {
                debug('无法解析客户端消息:', data.toString());
                return;
            }
            handleClientCommand(msg, socket);
        });

        socket.on('close', () => {
            clients.delete(socket);
            log(`插件已断开，当前连接数 ${clients.size}`);
        });
        socket.on('error', (err) => {
            debug('客户端 socket 错误:', err.message);
        });
    });

    wss.on('error', (err) => {
        if (err.code === 'EADDRINUSE') {
            log(`端口 ${WS_PORT} 已被占用。是否已有其它桥接服务在运行？`);
            process.exit(1);
        }
        log('WebSocket 服务错误:', err.message);
    });
}

function send(socket, obj) {
    if (socket.readyState === socket.OPEN) {
        socket.send(JSON.stringify(obj));
    }
}

function broadcast(obj) {
    const text = JSON.stringify(obj);
    for (const socket of clients) {
        if (socket.readyState === socket.OPEN) socket.send(text);
    }
}

function sendFullState(socket) {
    const data = {
        song: deriveSong(),
        playState: derivePlayState(),
        timeline: currentTimelineMs(),
        playMode: derivePlayMode(),
    };
    send(socket, { type: 'FullState', data });
}

// 插件 → 本服务 的命令
function handleClientCommand(msg, socket) {
    const type = msg && msg.type;
    debug('收到命令:', type);
    switch (type) {
        case 'GetState':
            sendFullState(socket);
            break;
        case 'Play':
            adapterSend(CMD.PLAY);
            break;
        case 'Pause':
            adapterSend(CMD.PAUSE);
            break;
        case 'NextSong':
            adapterSend(CMD.NEXT);
            break;
        case 'PreviousSong':
            adapterSend(CMD.PREVIOUS);
            break;
        case 'TogglePlayMode':
            // 尽力而为：网易云通常不响应 MediaRemote 的循环/随机切换
            adapterSend(CMD.TOGGLE_REPEAT);
            break;
        case 'Like':
            likeCurrentSong();
            break;
        default:
            debug('未知命令:', type);
    }
}

// ============================================================================
// 状态变更 → 推送增量
// ============================================================================

function publish() {
    // 歌曲
    const song = deriveSong();
    const songKey = JSON.stringify(song);
    if (songKey !== lastSong) {
        lastSong = songKey;
        broadcast({ type: 'SongUpdate', data: song });
    }

    // 播放状态
    const playState = derivePlayState();
    if (playState !== lastPlayState) {
        lastPlayState = playState;
        broadcast({ type: 'PlayStateUpdate', data: { status: playState } });
    }

    // 播放模式
    const playMode = derivePlayMode();
    const modeKey = JSON.stringify(playMode);
    if (modeKey !== lastPlayMode) {
        lastPlayMode = modeKey;
        broadcast({ type: 'PlayModeUpdate', data: playMode });
    }

    // 歌词：检测换歌 -> 异步加载
    const lyricKey = song ? `${song.songName}::${song.authorName}` : null;
    if (lyricKey !== currentLyricKey) {
        currentLyricKey = lyricKey;
        onSongChangedForLyrics(song);
    }

    // 进度（每次状态变更都刷新一次基准并推送）
    broadcastTimeline();

    // 根据播放状态启停进度定时器
    if (playState === 'Playing') startTimelineTicker();
    else stopTimelineTicker();

    // 歌词当前行
    updateCurrentLyric(false);
    if (playState === 'Playing' && lyricLines.length) startLyricTicker();
    else stopLyricTicker();
}

function broadcastTimeline() {
    const t = currentTimelineMs();
    broadcast({ type: 'TimelineUpdate', data: t });
}

function startTimelineTicker() {
    if (timelineTimer) return;
    timelineTimer = setInterval(broadcastTimeline, TIMELINE_TICK_MS);
}
function stopTimelineTicker() {
    if (timelineTimer) {
        clearInterval(timelineTimer);
        timelineTimer = null;
    }
}

// ============================================================================
// 歌词
// ============================================================================

// 换歌时调用：清空旧歌词并异步加载新歌词
function onSongChangedForLyrics(song) {
    lyricLines = [];
    lastSentLyricIndex = -2;
    // 通知插件复位歌词
    broadcast({ type: 'LyricUpdate', data: { lines: [], hasDynamicLyric: false } });
    broadcast({ type: 'CurrentLyricUpdate', data: { lineIndex: -1, wordIndex: -1, line: null, nextLine: null } });

    if (!song) return;

    const token = ++lyricFetchToken;
    const durationMs = durationSec != null ? Math.round(durationSec * 1000) : null;
    fetchLyrics({ title: song.songName, artist: song.authorName, durationMs }, debug)
        .then((res) => {
            if (token !== lyricFetchToken) return; // 已换歌，丢弃过期结果
            if (!res || !res.lines.length) {
                log(`未找到匹配歌词: ${song.songName}`);
                return;
            }
            lyricLines = res.lines;
            log(`歌词已加载: ${song.songName} (${res.lines.length} 行, id=${res.songId})`);
            broadcast({
                type: 'LyricUpdate',
                data: {
                    lines: lyricLines.map((l) => ({
                        time: l.timeMs,
                        originalLyric: l.text,
                        translatedLyric: l.trans,
                    })),
                    hasDynamicLyric: false,
                },
            });
            lastSentLyricIndex = -2;
            updateCurrentLyric(true);
            if (derivePlayState() === 'Playing') startLyricTicker();
        })
        .catch((e) => debug('歌词加载异常:', e.message));
}

// 根据当前进度推送"当前行"
function updateCurrentLyric(force) {
    if (!lyricLines.length) return;
    const pos = currentTimelineMs().currentTime;
    let idx = -1;
    for (let i = 0; i < lyricLines.length; i++) {
        if (lyricLines[i].timeMs <= pos) idx = i;
        else break;
    }
    if (idx === lastSentLyricIndex && !force) return;
    lastSentLyricIndex = idx;
    const line = idx >= 0 ? lyricLines[idx] : null;
    const next = idx + 1 < lyricLines.length ? lyricLines[idx + 1] : null;
    broadcast({
        type: 'CurrentLyricUpdate',
        data: {
            lineIndex: idx,
            wordIndex: -1, // 逐行模式：整行高亮
            line: line ? { originalLyric: line.text, translatedLyric: line.trans } : null,
            nextLine: next ? { originalLyric: next.text } : null,
        },
    });
}

function startLyricTicker() {
    if (lyricTimer) return;
    lyricTimer = setInterval(() => updateCurrentLyric(false), LYRIC_TICK_MS);
}
function stopLyricTicker() {
    if (lyricTimer) {
        clearInterval(lyricTimer);
        lyricTimer = null;
    }
}

// ============================================================================
// adapter 数据处理
// ============================================================================

function isAllowed(payload) {
    if (!ONLY_BUNDLE) return true;
    const b = payload.bundleIdentifier;
    const pb = payload.parentApplicationBundleIdentifier;
    if (!b && !pb) return true; // 未知来源，放行
    return b === ONLY_BUNDLE || pb === ONLY_BUNDLE;
}

function clearState() {
    raw = {};
    currentItemId = null;
    elapsedBaseSec = 0;
    baseAtMs = Date.now();
    rate = 0;
    durationSec = null;
}

function onAdapterPayload(payload, diff) {
    // payload 为空或没有标题：视为"无播放"
    if (!payload || (!payload.title && Object.keys(payload).length === 0)) {
        clearState();
        publish();
        return;
    }

    // 非网易云来源：清空（让插件显示"未在播放"）
    if (!isAllowed(payload)) {
        debug('忽略非网易云来源:', payload.bundleIdentifier);
        clearState();
        publish();
        return;
    }

    if (diff) {
        // 增量：null 表示删除
        for (const [k, v] of Object.entries(payload)) {
            if (v === null) delete raw[k];
            else raw[k] = v;
        }
    } else {
        // 全量快照：检测换歌则重置（避免保留上一首的封面等）
        const newId =
            payload.contentItemIdentifier ||
            payload.uniqueIdentifier ||
            (payload.title ? `${payload.title}::${payload.artist || ''}` : null);
        if (newId !== currentItemId) {
            raw = {};
            currentItemId = newId;
        }
        // 合并（保留稍后才到达的封面；不因瞬时缺失而清掉已有字段）
        for (const [k, v] of Object.entries(payload)) {
            if (v !== null && v !== undefined) raw[k] = v;
        }
        // playing 是必有字段，始终取最新
        raw.playing = payload.playing;
    }

    // 刷新进度插值基准
    durationSec = typeof raw.duration === 'number' ? raw.duration : null;
    rate = typeof raw.playbackRate === 'number' ? raw.playbackRate : (raw.playing ? 1 : 0);
    if (typeof raw.elapsedTime === 'number') {
        elapsedBaseSec = raw.elapsedTime;
        // 用 MediaRemote 的 timestamp 作为基准时刻更精确，否则用当前时间
        const tsMs = raw.timestamp ? Date.parse(raw.timestamp) : NaN;
        baseAtMs = Number.isFinite(tsMs) ? tsMs : Date.now();
    }

    publish();
}

function parseAdapterLine(line) {
    const trimmed = line.trim();
    if (!trimmed) return;
    let obj;
    try {
        obj = JSON.parse(trimmed);
    } catch (e) {
        debug('adapter 输出非 JSON:', trimmed.slice(0, 120));
        return;
    }
    if (obj === null) {
        clearState();
        publish();
        return;
    }
    if (obj.type === 'data') {
        onAdapterPayload(obj.payload || {}, !!obj.diff);
    } else {
        debug('adapter 其它消息:', obj.type);
    }
}

// ============================================================================
// adapter 进程管理
// ============================================================================

let streamProc = null;
let restartTimer = null;

function startAdapterStream() {
    if (!fs.existsSync(ADAPTER_PL)) {
        log(`找不到 adapter 脚本: ${ADAPTER_PL}`);
        process.exit(1);
    }
    if (!fs.existsSync(FRAMEWORK)) {
        log(`找不到已编译的框架: ${FRAMEWORK}`);
        log('请先构建：见 macos-bridge/README.md 或运行 macos-bridge/start.sh');
        process.exit(1);
    }

    log('启动 mediaremote-adapter 数据流…');
    streamProc = spawn(PERL, [ADAPTER_PL, FRAMEWORK, 'stream', '--no-diff'], {
        stdio: ['ignore', 'pipe', 'pipe'],
    });

    const rl = readline.createInterface({ input: streamProc.stdout });
    rl.on('line', parseAdapterLine);

    streamProc.stderr.on('data', (d) => debug('adapter stderr:', d.toString().trim()));

    streamProc.on('exit', (code, signal) => {
        log(`adapter 数据流退出 (code=${code} signal=${signal})，3 秒后重启…`);
        streamProc = null;
        clearState();
        publish();
        if (!restartTimer) {
            restartTimer = setTimeout(() => {
                restartTimer = null;
                startAdapterStream();
            }, 3000);
        }
    });

    streamProc.on('error', (err) => {
        log('启动 adapter 失败:', err.message);
    });
}

// 发送控制命令（短生命周期进程）
function adapterSend(commandId) {
    debug('发送 MediaRemote 命令:', commandId);
    const p = spawn(PERL, [ADAPTER_PL, FRAMEWORK, 'send', String(commandId)], {
        stdio: ['ignore', 'ignore', 'pipe'],
    });
    p.stderr.on('data', (d) => debug('send stderr:', d.toString().trim()));
    p.on('error', (err) => log('发送命令失败:', err.message));
}

// "喜欢"当前歌曲：网易云没有 MediaRemote 的 like 命令，这里用它应用内的快捷键(默认 ⌘L)。
// 默认会临时把网易云激活到前台再发键，最后恢复原来的前台 App（因此即便 FlexBar/其它窗口
// 在前台也能生效）。只用到 System Events，所以只需授权一次「辅助功能(Accessibility)」。
function likeCurrentSong() {
    const usingClause =
        LIKE_MODS.trim().length > 0
            ? ` using {${LIKE_MODS.split(',').map((m) => `${m.trim()} down`).join(', ')}}`
            : '';

    let lines;
    if (LIKE_NO_ACTIVATE) {
        // 全局快捷键模式：直接发键
        lines = [`tell application "System Events" to keystroke "${LIKE_KEY}"${usingClause}`];
    } else {
        lines = [
            `set bid to "${NETEASE_BUNDLE}"`,
            `set prev to missing value`,
            `tell application "System Events"`,
            `  try`,
            `    set prev to bundle identifier of (first application process whose frontmost is true)`,
            `  end try`,
            `  try`,
            `    set frontmost of (first application process whose bundle identifier is bid) to true`,
            `  end try`,
            `end tell`,
            `delay 0.12`,
            `tell application "System Events" to keystroke "${LIKE_KEY}"${usingClause}`,
            `delay 0.05`,
            `if prev is not missing value and prev is not bid then`,
            `  tell application "System Events"`,
            `    try`,
            `      set frontmost of (first application process whose bundle identifier is prev) to true`,
            `    end try`,
            `  end tell`,
            `end if`,
        ];
    }

    const args = [];
    for (const ln of lines) args.push('-e', ln);

    const p = spawn('/usr/bin/osascript', args, { stdio: ['ignore', 'ignore', 'pipe'] });
    let err = '';
    p.stderr.on('data', (d) => (err += d.toString()));
    p.on('error', (e) => log('发送 like 快捷键失败:', e.message));
    p.on('exit', (code) => {
        if (code !== 0) {
            log(`like 快捷键执行失败 (code=${code})。${err.trim()}`);
            log('提示：需在「系统设置 → 隐私与安全性 → 辅助功能」中给运行本服务的程序授权。');
        } else {
            debug('已发送 like 快捷键');
        }
    });
}

// ============================================================================
// 退出清理
// ============================================================================

function cleanup() {
    stopTimelineTicker();
    stopLyricTicker();
    if (restartTimer) clearTimeout(restartTimer);
    if (streamProc) {
        streamProc.removeAllListeners('exit');
        streamProc.kill();
    }
    if (wss) wss.close();
}

process.on('SIGINT', () => { log('收到 SIGINT，退出…'); cleanup(); process.exit(0); });
process.on('SIGTERM', () => { log('收到 SIGTERM，退出…'); cleanup(); process.exit(0); });

// ============================================================================
// 启动
// ============================================================================

log('网易云 macOS 桥接服务启动中…');
log(`过滤来源: ${ONLY_BUNDLE || '(不过滤)'}`);
clearState();
startServer();
startAdapterStream();
