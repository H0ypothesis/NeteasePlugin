/**
 * Netease Music Plugin for FlexDesigner
 */

const { plugin, logger, pluginPath } = require("@eniac/flexdesigner");
const WebSocket = require('ws');
const CanvasRenderer = require('./canvas-renderer');
const LyricRenderer = require('./lyric-renderer');
const fs = require('fs');
const path = require('path');
const { exec } = require('child_process');

// ============================================================================
// WebSocket 连接管理
// ============================================================================

const WS_URL = 'ws://127.0.0.1:35010';
let ws = null;
let reconnectTimer = null;
let isConnected = false;

// 当前播放状态
let currentState = {
    song: null,
    playState: 'Stopped',
    timeline: { currentTime: 0, totalTime: 0 },
    playMode: { isShuffling: false, repeatMode: 'Off' },
    lyrics: null,
    currentLyric: null
};

// 设备和按键跟踪
const deviceKeys = new Map(); // serialNumber -> { keys: Map<uid, key> }
let globalUpdateTimer = null;

// 歌词动画定时器
let lyricAnimationTimer = null;
let lastLyricWordIndex = -1;
let lastLyricLineIndex = -1;

// 渲染器
const canvasRenderer = new CanvasRenderer(logger);
const lyricRenderer = new LyricRenderer(logger);

// ============================================================================
// WebSocket 连接
// ============================================================================

function connectWebSocket() {
    if (ws && ws.readyState === WebSocket.OPEN) {
        return;
    }

    //  logger.info(`[Plugin] 正在连接到 ${WS_URL}...`);
    
    try {
        ws = new WebSocket(WS_URL);

        ws.on('open', () => {
            //  logger.info('[Plugin] WebSocket 连接成功');
            isConnected = true;
            // 请求完整状态
            sendCommand({ type: 'GetState' });
        });

        ws.on('message', (data) => {
            try {
                const msg = JSON.parse(data.toString());
                handleWebSocketMessage(msg);
            } catch (e) {
                logger.error(`[Plugin] 解析消息失败: ${e.message}`);
            }
        });

        ws.on('close', () => {
            //  logger.info('[Plugin] WebSocket 连接已关闭');
            isConnected = false;
            scheduleReconnect();
        });

        ws.on('error', (err) => {
            logger.error(`[Plugin] WebSocket 错误: ${err.message}`);
            isConnected = false;
        });
    } catch (err) {
        logger.error(`[Plugin] 创建 WebSocket 失败: ${err.message}`);
        scheduleReconnect();
    }
}

function scheduleReconnect() {
    if (reconnectTimer) return;
    
    reconnectTimer = setTimeout(() => {
        reconnectTimer = null;
        connectWebSocket();
    }, 5000);
    
    //  logger.info('[Plugin] 5秒后重新连接...');
}

function sendCommand(cmd) {
    if (ws && ws.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify(cmd));
        //  logger.info(`[Plugin] 发送命令: ${cmd.type}`);
    } else {
        logger.warn('[Plugin] WebSocket 未连接，无法发送命令');
    }
}

// ============================================================================
// 消息处理
// ============================================================================

function handleWebSocketMessage(msg) {
    switch (msg.type) {
        case 'FullState':
            currentState.song = msg.data.song;
            currentState.playState = msg.data.playState;
            currentState.timeline = msg.data.timeline || { currentTime: 0, totalTime: 0 };
            currentState.playMode = msg.data.playMode || { isShuffling: false, repeatMode: 'Off' };
            //  logger.info(`[Plugin] 收到完整状态: ${currentState.song?.songName || '无歌曲'}`);
            updateAllDeviceKeys();
            break;

        case 'SongUpdate':
            currentState.song = msg.data;
            //  logger.info(`[Plugin] 歌曲更新: ${msg.data.songName}`);
            updateAllDeviceKeys();
            break;

        case 'PlayStateUpdate':
            currentState.playState = msg.data.status;
            //  logger.info(`[Plugin] 播放状态: ${msg.data.status}`);
            updateAllDeviceKeys();
            break;

        case 'TimelineUpdate':
            currentState.timeline = {
                currentTime: msg.data.currentTime,
                totalTime: msg.data.totalTime
            };
            // 只更新 nowplaying 和 lyric keys
            updateTimelineKeys();
            break;

        case 'PlayModeUpdate':
            currentState.playMode = {
                isShuffling: msg.data.isShuffling,
                repeatMode: msg.data.repeatMode
            };
            //  logger.info(`[Plugin] 播放模式: 随机=${msg.data.isShuffling}, 循环=${msg.data.repeatMode}`);
            updateAllDeviceKeys();
            break;

        case 'LyricUpdate':
            currentState.lyrics = msg.data;
            //  logger.info(`[Plugin] 歌词更新: ${msg.data.lines?.length || 0} 行, 逐词=${msg.data.hasDynamicLyric}`);
            updateLyricKeys();
            break;

        case 'CurrentLyricUpdate':
            currentState.currentLyric = msg.data;
            // 添加调试日志
            //  logger.info(`[Plugin] 当前歌词: 行=${msg.data.lineIndex}, 词=${msg.data.wordIndex}, "${msg.data.line?.originalLyric || ''}"`);
            // 启动歌词动画
            startLyricAnimation(msg.data.lineIndex, msg.data.wordIndex);
            break;
    }
}

// ============================================================================
// 按键更新
// ============================================================================

async function updateAllDeviceKeys() {
    for (const [serialNumber, deviceData] of deviceKeys) {
        await updateDeviceKeys(serialNumber, deviceData.keys);
    }
}

async function updateDeviceKeys(serialNumber, keys) {
    for (const [uid, key] of keys) {
        await updateKey(serialNumber, key);
    }
}

async function updateTimelineKeys() {
    for (const [serialNumber, deviceData] of deviceKeys) {
        for (const [uid, key] of deviceData.keys) {
            if (key.cid === 'com.eniac.neteaseplugin.nowplaying' ||
                key.cid === 'com.eniac.neteaseplugin.lyric') {
                await updateKey(serialNumber, key);
            }
        }
    }
}

async function updateLyricKeys() {
    for (const [serialNumber, deviceData] of deviceKeys) {
        for (const [uid, key] of deviceData.keys) {
            if (key.cid === 'com.eniac.neteaseplugin.lyric') {
                await updateKey(serialNumber, key);
            }
        }
    }
}

// 歌词动画相关常量
const LYRIC_ANIMATION_INTERVAL = 16; // 约60fps
const LYRIC_ANIMATION_DURATION = 500; // 动画持续时间（毫秒）

/**
 * 启动歌词动画
 * 当词索引变化时，启动定时器持续渲染以显示逐字母动画
 */
function startLyricAnimation(lineIndex, wordIndex) {
    // 检查是否是新词
    const isNewWord = lineIndex !== lastLyricLineIndex || wordIndex !== lastLyricWordIndex;
    
    lastLyricLineIndex = lineIndex;
    lastLyricWordIndex = wordIndex;
    
    // 立即渲染一次
    updateLyricKeys();
    
    // 如果是新词，启动动画定时器
    if (isNewWord && wordIndex !== undefined && wordIndex >= 0) {
        // 清除之前的定时器
        if (lyricAnimationTimer) {
            clearInterval(lyricAnimationTimer);
        }
        
        const startTime = Date.now();
        
        // 启动动画定时器
        lyricAnimationTimer = setInterval(() => {
            const elapsed = Date.now() - startTime;
            
            // 动画结束后停止
            if (elapsed >= LYRIC_ANIMATION_DURATION) {
                clearInterval(lyricAnimationTimer);
                lyricAnimationTimer = null;
                return;
            }
            
            // 持续渲染
            updateLyricKeys();
        }, LYRIC_ANIMATION_INTERVAL);
    }
}

/**
 * 停止歌词动画
 */
function stopLyricAnimation() {
    if (lyricAnimationTimer) {
        clearInterval(lyricAnimationTimer);
        lyricAnimationTimer = null;
    }
}

async function updateKey(serialNumber, key) {
    try {
        switch (key.cid) {
            case 'com.eniac.neteaseplugin.nowplaying':
                await updateNowPlayingKey(serialNumber, key);
                break;
            case 'com.eniac.neteaseplugin.lyric':
                await updateLyricKey(serialNumber, key);
                break;
            case 'com.eniac.neteaseplugin.playpause':
                updatePlayPauseKey(serialNumber, key);
                break;
            case 'com.eniac.neteaseplugin.playmode':
                updatePlayModeKey(serialNumber, key);
                break;
        }
    } catch (err) {
        logger.error(`[Plugin] 更新按键 ${key.cid} 失败: ${err.message}`);
    }
}

async function updateNowPlayingKey(serialNumber, key) {
    const options = {
        showTitle: key.data?.showTitle !== false,
        showArtist: key.data?.showArtist !== false,
        showAlbum: key.data?.showAlbum !== false,
        showProgress: key.data?.showProgress !== false
    };

    const width = key.style?.width || 600;
    const height = 60;

    const imageBuffer = await canvasRenderer.render(currentState, options, width, height);
    const base64Image = imageBuffer.toString('base64');
    
    key.style.showImage = true;
    key.style.showIcon = false;
    key.style.showTitle = false;
    key.style.image = `data:image/png;base64,${base64Image}`;
    
    plugin.draw(serialNumber, key, 'draw');
}

async function updateLyricKey(serialNumber, key) {
    const d = key.data || {};
    const options = {
        showTranslation: d.showTranslation !== false,
        highlightWord: d.highlightWord !== false,
        // 背景颜色
        backgroundColor: d.backgroundColor || '#1a1a1a',
        // Primary 设置
        primaryAlign: d.primaryAlign || 'left',
        primaryFontSize: d.primaryFontSize || 18,
        primaryColor: d.primaryColor || '#FFFFFF',
        highlightColor: d.highlightColor || '#E60026',
        primaryPaddingTop: d.primaryPaddingTop ?? 5,
        // Secondary 设置
        secondaryAlign: d.secondaryAlign || 'left',
        secondaryFontSize: d.secondaryFontSize || 13,
        secondaryColor: d.secondaryColor || '#888888',
        secondaryPaddingTop: d.secondaryPaddingTop ?? 28,
        // 水平边距
        paddingHorizontal: d.paddingHorizontal || 10
    };

    const width = key.style?.width || 480;
    const height = 60;

    const imageBuffer = await lyricRenderer.render(
        currentState.lyrics,
        currentState.currentLyric,
        currentState.song,  // 传递歌曲信息
        options,
        width,
        height
    );
    const base64Image = imageBuffer.toString('base64');
    
    key.style.showImage = true;
    key.style.showIcon = false;
    key.style.showTitle = false;
    key.style.image = `data:image/png;base64,${base64Image}`;
    
    plugin.draw(serialNumber, key, 'draw');
}

function updatePlayPauseKey(serialNumber, key) {
    const isPlaying = currentState.playState === 'Playing';
    const newState = isPlaying ? 1 : 0;
    plugin.set(serialNumber, key, { state: newState });
}

function updatePlayModeKey(serialNumber, key) {
    const playMode = currentState.playMode || { isShuffling: false, repeatMode: 'None' };
    let newState = 0;
    
    // 状态: 0=顺序, 1=列表循环, 2=单曲循环, 3=随机
    if (playMode.isShuffling) {
        newState = 3; // 随机播放
    } else {
        switch (playMode.repeatMode) {
            case 'List':
                newState = 1; // 列表循环
                break;
            case 'Track':
            case 'One':
            case 'Single':
                newState = 2; // 单曲循环
                break;
            default:
                newState = 0; // 顺序播放
        }
    }
    
    plugin.set(serialNumber, key, { state: newState });
}

// ============================================================================
// 按键操作处理
// ============================================================================

async function handleKeyAction(serialNumber, key, currentKeyState) {
    if (!isConnected) {
        logger.warn('[Plugin] 未连接到网易云音乐');
        return;
    }

    try {
        switch (key.cid) {
            case 'com.eniac.neteaseplugin.playpause':
                await handlePlayPause(serialNumber, key);
                break;
            case 'com.eniac.neteaseplugin.playmode':
                await handlePlayMode(serialNumber, key);
                break;
            case 'com.eniac.neteaseplugin.previous':
                sendCommand({ type: 'PreviousSong' });
                break;
            case 'com.eniac.neteaseplugin.next':
                sendCommand({ type: 'NextSong' });
                break;
        }
    } catch (err) {
        logger.error(`[Plugin] 按键操作失败: ${err.message}`);
    }
}

async function handlePlayPause(serialNumber, key) {
    const isPlaying = currentState.playState === 'Playing';
    if (isPlaying) {
        sendCommand({ type: 'Pause' });
        plugin.set(serialNumber, key, { state: 0 });
    } else {
        sendCommand({ type: 'Play' });
        plugin.set(serialNumber, key, { state: 1 });
    }
    //  logger.info(`[Plugin] 播放 ${isPlaying ? '暂停' : '继续'}`);
}

async function handlePlayMode(serialNumber, key) {
    sendCommand({ type: 'TogglePlayMode' });
    // 播放模式会在收到 PlayModeUpdate 时更新
}

// ============================================================================
// 设备管理
// ============================================================================

function registerDevice(serialNumber, keys) {
    if (!deviceKeys.has(serialNumber)) {
        deviceKeys.set(serialNumber, { keys: new Map() });
        //  logger.info(`[Plugin] 设备注册: ${serialNumber}`);
    }
    
    const deviceData = deviceKeys.get(serialNumber);
    for (const key of keys) {
        deviceData.keys.set(key.uid, key);
        //  logger.info(`[Plugin] 按键注册: ${key.cid} (${key.uid})`);
    }
    
    // 确保 WebSocket 连接
    connectWebSocket();
}

function unregisterDevice(serialNumber) {
    if (deviceKeys.has(serialNumber)) {
        deviceKeys.delete(serialNumber);
        //  logger.info(`[Plugin] 设备注销: ${serialNumber}`);
    }
}

function cleanupResources() {
    if (reconnectTimer) {
        clearTimeout(reconnectTimer);
        reconnectTimer = null;
    }
    if (lyricAnimationTimer) {
        clearInterval(lyricAnimationTimer);
        lyricAnimationTimer = null;
    }
    if (ws) {
        ws.close();
        ws = null;
    }
    deviceKeys.clear();
    isConnected = false;
    //  logger.info('[Plugin] 资源已清理');
}

// ============================================================================
// 插件事件
// ============================================================================

/**
 * 插件按键加载时调用
 */
plugin.on('plugin.alive', async (payload) => {
    //  logger.info(`[Plugin] plugin.alive - 设备: ${payload.serialNumber}, 按键数: ${payload.keys.length}`);
    registerDevice(payload.serialNumber, payload.keys);
    
    // 初始更新
    setTimeout(() => updateAllDeviceKeys(), 500);
});

/**
 * 用户与按键交互时调用
 */
plugin.on('plugin.data', (payload) => {
    //  logger.info(`[Plugin] plugin.data - 按键: ${payload.data.key.cid}, 状态: ${payload.data.state}`);
    
    setImmediate(async () => {
        await handleKeyAction(payload.serialNumber, payload.data.key, payload.data.state);
    });
    
    return {
        'status': 'success',
    };
});

/**
 * 设备状态变化时调用
 * 注意：不在此处注销设备，因为设备可能只是暂时断开
 * 设备注销应由 plugin.alive 事件重新注册处理
 */
plugin.on('device.status', (devices) => {
    //  logger.info(`[Plugin] device.status - ${devices.length} 台设备`);
    // 仅记录状态，不主动注销设备
    // 当设备重新连接时，plugin.alive 会被触发并重新注册
});

/**
 * 接收 UI 消息
 */
plugin.on('ui.message', async (payload) => {
    //  logger.info(`[Plugin] ui.message - action: ${payload.action}`);
    
    switch (payload.action) {
        case 'getConnectionStatus':
            return {
                connected: isConnected,
                currentSong: currentState.song?.songName || null
            };
        
        case 'openUrl':
            return await handleOpenUrl(payload.url);
        
        case 'installBetterNCMPlugin':
            return await handleInstallBetterNCMPlugin();
        
        default:
            return { success: false, error: 'Unknown action' };
    }
});

/**
 * 打开 URL
 */
async function handleOpenUrl(url) {
    try {
        const platform = process.platform;
        let command;
        
        if (platform === 'win32') {
            command = `start "" "${url}"`;
        } else if (platform === 'darwin') {
            command = `open "${url}"`;
        } else {
            command = `xdg-open "${url}"`;
        }
        
        exec(command, (error) => {
            if (error) {
                logger.error(`[Plugin] 打开 URL 失败: ${error.message}`);
            }
        });
        
        return { success: true };
    } catch (error) {
        logger.error(`[Plugin] 打开 URL 失败: ${error.message}`);
        return { success: false, error: error.message };
    }
}

/**
 * 安装 BetterNCM 插件
 * 将 resources/FlexLink.plugin 拷贝到 C:\betterncm\plugins 目录
 */
async function handleInstallBetterNCMPlugin() {
    try {
        // 源文件路径
        const sourcePath = path.join(pluginPath, 'resources', 'FlexLink.plugin');
        
        // 目标目录
        const targetDir = 'C:\\betterncm\\plugins';
        const targetPath = path.join(targetDir, 'FlexLink.plugin');
        
        // 检查源文件是否存在
        if (!fs.existsSync(sourcePath)) {
            logger.error(`[Plugin] 源文件不存在: ${sourcePath}`);
            return { success: false, error: '插件文件不存在' };
        }
        
        // 创建目标目录（如果不存在）
        if (!fs.existsSync(targetDir)) {
            fs.mkdirSync(targetDir, { recursive: true });
            logger.info(`[Plugin] 创建目录: ${targetDir}`);
        }
        
        // 拷贝文件
        fs.copyFileSync(sourcePath, targetPath);
        logger.info(`[Plugin] 插件已安装到: ${targetPath}`);
        
        return { success: true };
    } catch (error) {
        logger.error(`[Plugin] 安装插件失败: ${error.message}`);
        return { success: false, error: error.message };
    }
}

/**
 * 活动窗口变化
 */
plugin.on('system.actwin', (payload) => {
    // 此插件不使用
});

// ============================================================================
// 退出清理
// ============================================================================

process.on('SIGINT', () => {
    //  logger.info('[Plugin] 收到 SIGINT，正在清理...');
    cleanupResources();
    process.exit(0);
});

process.on('SIGTERM', () => {
    //  logger.info('[Plugin] 收到 SIGTERM，正在清理...');
    cleanupResources();
    process.exit(0);
});

// ============================================================================
// 启动插件
// ============================================================================

plugin.start();
//  logger.info('[Plugin] 网易云音乐插件已启动');
