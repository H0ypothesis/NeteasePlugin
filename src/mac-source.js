/**
 * macOS 原生数据源 (in-process MediaRemote source)
 * ============================================================================
 * 这是原 macos-bridge/server.js 的"内置化"版本：不再作为独立进程 + WebSocket 服务端，
 * 而是被直接编译进插件后端(plugin.cjs)，在 FlexDesigner 的插件进程内运行。
 *
 * 它做三件事：
 *   1. 通过 mediaremote-adapter（/usr/bin/perl 绕过 macOS 15.4+ 对 MediaRemote 的
 *      限制）读取系统"正在播放"信息——即网易云上报给系统的歌曲/进度/封面。
 *   2. 把这些信息翻译成插件内部使用的协议消息（FullState / SongUpdate / ...），
 *      通过 emit() 回调交给插件主逻辑（与 Windows 下 FlexLink 经 WebSocket 下发的
 *      消息结构完全一致，从而复用同一套渲染/按键代码）。
 *   3. 把插件发来的命令（Play/Pause/NextSong/Like/...）翻译成媒体控制命令或应用内
 *      快捷键发回系统。
 *
 * 数据链路（无需外部进程）：
 *   网易云 → macOS 正在播放 → mediaremote-adapter → 本模块(插件后端内) → 按键渲染
 *
 * 依赖的可执行文件均为系统自带、无需安装：
 *   /usr/bin/perl（签名 com.apple.perl，被授权读取 MediaRemote）
 *   /usr/bin/osascript（Like 时发送应用内快捷键）
 * 框架 MediaRemoteAdapter.framework 已随插件打包在 resources/mediaremote/ 下。
 */

'use strict';

const path = require('path');
const fs = require('fs');
const readline = require('readline');
const { spawn } = require('child_process');
const { fetchLyrics } = require('./netease-lyrics');

// 网易云 bundle id / like 快捷键（可用环境变量覆盖，默认应用内 ⌘L）
const NETEASE_BUNDLE = 'com.netease.163music';
const ONLY_BUNDLE = process.env.NETEASE_ANY_APP ? null : NETEASE_BUNDLE;
const LIKE_KEY = (process.env.NETEASE_LIKE_KEY || 'l').replace(/["\\]/g, '');
const LIKE_MODS = process.env.NETEASE_LIKE_MODS || 'command'; // 逗号分隔: command,option,control,shift
const LIKE_NO_ACTIVATE = !!process.env.NETEASE_LIKE_NO_ACTIVATE;

const PERL = '/usr/bin/perl';
const OSASCRIPT = '/usr/bin/osascript';

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

const TIMELINE_TICK_MS = 1000; // 播放时本模块自行插值，约 1Hz 推送
const LYRIC_TICK_MS = 300; // 歌词当前行刷新间隔

/**
 * 创建一个 macOS 原生数据源。
 * @param {object} opts
 * @param {(msg:object)=>void} opts.emit  发送一条协议消息给插件主逻辑
 * @param {string} opts.resourcesDir       打包资源目录（含 mediaremote/）
 * @param {(...a:any[])=>void} [opts.log]   普通日志
 * @param {(...a:any[])=>void} [opts.debug] 调试日志
 * @returns {{start:Function, stop:Function, command:Function, isAlive:Function}}
 */
function createMacSource({ emit, resourcesDir, log = () => {}, debug = () => {} }) {
    const VENDOR = path.join(resourcesDir, 'mediaremote');
    const ADAPTER_PL = path.join(VENDOR, 'mediaremote-adapter.pl');
    const FRAMEWORK = path.join(VENDOR, 'MediaRemoteAdapter.framework');

    // ------------------------------------------------------------------
    // 播放状态（原始 + 派生）
    // ------------------------------------------------------------------
    let raw = {};
    let currentItemId = null;

    // 进度插值基准
    let elapsedBaseSec = 0;
    let baseAtMs = 0;
    let rate = 0;
    let durationSec = null;

    // 去重用的上次派生状态
    let lastSong;
    let lastPlayState;
    let lastPlayMode;

    let timelineTimer = null;

    // 歌词状态
    let lyricLines = [];
    let currentLyricKey = null;
    let lyricFetchToken = 0;
    let lastSentLyricIndex = -2;
    let lyricTimer = null;

    // adapter 进程
    let streamProc = null;
    let restartTimer = null;
    let stopped = false;

    // ------------------------------------------------------------------
    // 派生：原始字段 → 插件期待的结构
    // ------------------------------------------------------------------
    function deriveSong() {
        const title = raw.title;
        if (!title) return null;
        return {
            songName: title,
            authorName: raw.artist || '',
            albumName: raw.album || '',
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

    function emitFullState() {
        emit({
            type: 'FullState',
            data: {
                song: deriveSong(),
                playState: derivePlayState(),
                timeline: currentTimelineMs(),
                playMode: derivePlayMode(),
            },
        });
    }

    // ------------------------------------------------------------------
    // 状态变更 → 推送增量
    // ------------------------------------------------------------------
    function publish() {
        const song = deriveSong();
        const songKey = JSON.stringify(song);
        if (songKey !== lastSong) {
            lastSong = songKey;
            emit({ type: 'SongUpdate', data: song });
        }

        const playState = derivePlayState();
        if (playState !== lastPlayState) {
            lastPlayState = playState;
            emit({ type: 'PlayStateUpdate', data: { status: playState } });
        }

        const playMode = derivePlayMode();
        const modeKey = JSON.stringify(playMode);
        if (modeKey !== lastPlayMode) {
            lastPlayMode = modeKey;
            emit({ type: 'PlayModeUpdate', data: playMode });
        }

        // 歌词：检测换歌 -> 异步加载
        const lyricKey = song ? `${song.songName}::${song.authorName}` : null;
        if (lyricKey !== currentLyricKey) {
            currentLyricKey = lyricKey;
            onSongChangedForLyrics(song);
        }

        broadcastTimeline();

        if (playState === 'Playing') startTimelineTicker();
        else stopTimelineTicker();

        updateCurrentLyric(false);
        if (playState === 'Playing' && lyricLines.length) startLyricTicker();
        else stopLyricTicker();
    }

    function broadcastTimeline() {
        emit({ type: 'TimelineUpdate', data: currentTimelineMs() });
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

    // ------------------------------------------------------------------
    // 歌词
    // ------------------------------------------------------------------
    function onSongChangedForLyrics(song) {
        lyricLines = [];
        lastSentLyricIndex = -2;
        emit({ type: 'LyricUpdate', data: { lines: [], hasDynamicLyric: false } });
        emit({ type: 'CurrentLyricUpdate', data: { lineIndex: -1, wordIndex: -1, line: null, nextLine: null } });

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
                emit({
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
        emit({
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

    // ------------------------------------------------------------------
    // adapter 数据处理
    // ------------------------------------------------------------------
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
        if (!payload || (!payload.title && Object.keys(payload).length === 0)) {
            clearState();
            publish();
            return;
        }

        if (!isAllowed(payload)) {
            debug('忽略非网易云来源:', payload.bundleIdentifier);
            clearState();
            publish();
            return;
        }

        if (diff) {
            for (const [k, v] of Object.entries(payload)) {
                if (v === null) delete raw[k];
                else raw[k] = v;
            }
        } else {
            const newId =
                payload.contentItemIdentifier ||
                payload.uniqueIdentifier ||
                (payload.title ? `${payload.title}::${payload.artist || ''}` : null);
            if (newId !== currentItemId) {
                raw = {};
                currentItemId = newId;
            }
            for (const [k, v] of Object.entries(payload)) {
                if (v !== null && v !== undefined) raw[k] = v;
            }
            raw.playing = payload.playing;
        }

        durationSec = typeof raw.duration === 'number' ? raw.duration : null;
        rate = typeof raw.playbackRate === 'number' ? raw.playbackRate : (raw.playing ? 1 : 0);
        if (typeof raw.elapsedTime === 'number') {
            elapsedBaseSec = raw.elapsedTime;
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

    // ------------------------------------------------------------------
    // adapter 进程管理
    // ------------------------------------------------------------------
    function startAdapterStream() {
        if (!fs.existsSync(ADAPTER_PL)) {
            log(`找不到 adapter 脚本: ${ADAPTER_PL}（插件资源缺失？）`);
            return;
        }
        if (!fs.existsSync(FRAMEWORK)) {
            log(`找不到已编译的框架: ${FRAMEWORK}（插件资源缺失？）`);
            return;
        }

        log('启动 mediaremote-adapter 数据流…');
        streamProc = spawn(PERL, [ADAPTER_PL, FRAMEWORK, 'stream', '--no-diff'], {
            stdio: ['ignore', 'pipe', 'pipe'],
        });

        const rl = readline.createInterface({ input: streamProc.stdout });
        rl.on('line', parseAdapterLine);

        streamProc.stderr.on('data', (d) => debug('adapter stderr:', d.toString().trim()));

        streamProc.on('exit', (code, signal) => {
            log(`adapter 数据流退出 (code=${code} signal=${signal})`);
            streamProc = null;
            clearState();
            publish();
            if (!stopped && !restartTimer) {
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

    // "喜欢"当前歌曲：网易云没有 MediaRemote 的 like 命令，改用其应用内快捷键(默认 ⌘L)。
    // 默认临时把网易云激活到前台再发键，随后恢复原来的前台 App（因此即便 FlexBar/其它窗口
    // 在前台也能生效）。只用到 System Events，故只需授权一次「辅助功能(Accessibility)」。
    function likeCurrentSong() {
        const usingClause =
            LIKE_MODS.trim().length > 0
                ? ` using {${LIKE_MODS.split(',').map((m) => `${m.trim()} down`).join(', ')}}`
                : '';

        let lines;
        if (LIKE_NO_ACTIVATE) {
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

        const p = spawn(OSASCRIPT, args, { stdio: ['ignore', 'ignore', 'pipe'] });
        let err = '';
        p.stderr.on('data', (d) => (err += d.toString()));
        p.on('error', (e) => log('发送 like 快捷键失败:', e.message));
        p.on('exit', (code) => {
            if (code !== 0) {
                log(`like 快捷键执行失败 (code=${code})。${err.trim()}`);
                log('提示：需在「系统设置 → 隐私与安全性 → 辅助功能」中给 FlexDesigner 授权。');
            } else {
                debug('已发送 like 快捷键');
            }
        });
    }

    // ------------------------------------------------------------------
    // 对外接口：插件 → 本模块 的命令
    // ------------------------------------------------------------------
    function command(msg) {
        const type = msg && msg.type;
        debug('收到命令:', type);
        switch (type) {
            case 'GetState':
                emitFullState();
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

    function start() {
        stopped = false;
        clearState();
        emitFullState();
        startAdapterStream();
    }

    function stop() {
        stopped = true;
        stopTimelineTicker();
        stopLyricTicker();
        if (restartTimer) {
            clearTimeout(restartTimer);
            restartTimer = null;
        }
        if (streamProc) {
            streamProc.removeAllListeners('exit');
            streamProc.kill();
            streamProc = null;
        }
    }

    function isAlive() {
        return !!streamProc;
    }

    return { start, stop, command, isAlive };
}

module.exports = { createMacSource };
