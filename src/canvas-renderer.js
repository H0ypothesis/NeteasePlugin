/**
 * Canvas Renderer for Netease Music Now Playing
 * 使用 @napi-rs/canvas 渲染播放信息
 */

const { createCanvas, loadImage, GlobalFonts } = require('@napi-rs/canvas');
const path = require('path');
const fs = require('fs');

// 注册系统字体以支持中日韩文字
function registerSystemFonts(logger) {
    const platform = process.platform;
    const fontPaths = [];

    if (platform === 'win32') {
        const winFonts = path.join(process.env.WINDIR || 'C:\\Windows', 'Fonts');
        fontPaths.push(
            { path: path.join(winFonts, 'msyh.ttc'), family: 'Microsoft YaHei' },
            { path: path.join(winFonts, 'msyhbd.ttc'), family: 'Microsoft YaHei' },
            { path: path.join(winFonts, 'simhei.ttf'), family: 'SimHei' },
            { path: path.join(winFonts, 'simsun.ttc'), family: 'SimSun' },
            { path: path.join(winFonts, 'meiryo.ttc'), family: 'Meiryo' },
            { path: path.join(winFonts, 'yugothic.ttf'), family: 'Yu Gothic' }
        );
    } else if (platform === 'darwin') {
        fontPaths.push(
            { path: '/System/Library/Fonts/PingFang.ttc', family: 'PingFang SC' },
            { path: '/System/Library/Fonts/Hiragino Sans GB.ttc', family: 'Hiragino Sans GB' },
            { path: '/Library/Fonts/Arial Unicode.ttf', family: 'Arial Unicode MS' }
        );
    } else {
        fontPaths.push(
            { path: '/usr/share/fonts/opentype/noto/NotoSansCJK-Regular.ttc', family: 'Noto Sans CJK' },
            { path: '/usr/share/fonts/truetype/droid/DroidSansFallbackFull.ttf', family: 'Droid Sans Fallback' }
        );
    }

    let registered = false;
    for (const font of fontPaths) {
        try {
            if (fs.existsSync(font.path)) {
                GlobalFonts.registerFromPath(font.path, font.family);
                //  logger.info(`[CanvasRenderer] 注册字体: ${font.family}`);
                registered = true;
            }
        } catch (err) {
            // 忽略字体注册错误
        }
    }

    if (!registered) {
        logger.warn('[CanvasRenderer] 未注册 CJK 字体，部分字符可能无法显示');
    }
}

// 网易云音乐配色
const COLORS = {
    background: '#1a1a1a',
    cardBg: '#252525',
    primary: '#FFFFFF',
    secondary: '#B3B3B3',
    accent: '#E60026', // 网易云红色
    progressBg: '#404040',
    progressFill: '#E60026'
};

const DEFAULT_WIDTH = 600;
const DEFAULT_HEIGHT = 60;
const FONT_FAMILY = 'Microsoft YaHei, PingFang SC, Hiragino Sans GB, SimHei, Noto Sans CJK, Meiryo, Yu Gothic, Arial, sans-serif';

class CanvasRenderer {
    constructor(logger) {
        this.logger = logger;
        this.fontsRegistered = false;
    }

    ensureFonts() {
        if (!this.fontsRegistered) {
            registerSystemFonts(this.logger);
            this.fontsRegistered = true;
        }
    }

    formatTime(ms) {
        if (!ms || ms < 0) return '0:00';
        const totalSeconds = Math.floor(ms / 1000);
        const minutes = Math.floor(totalSeconds / 60);
        const seconds = totalSeconds % 60;
        return `${minutes}:${seconds.toString().padStart(2, '0')}`;
    }

    truncateText(ctx, text, maxWidth) {
        if (!text) return '';
        
        let truncated = text;
        let width = ctx.measureText(truncated).width;
        
        if (width <= maxWidth) return truncated;
        
        while (width > maxWidth && truncated.length > 0) {
            truncated = truncated.slice(0, -1);
            width = ctx.measureText(truncated + '...').width;
        }
        
        return truncated + '...';
    }

    async loadAlbumArt(coverBase64, size) {
        if (!coverBase64) {
            return this.createDefaultAlbumArt(size);
        }

        try {
            // coverBase64 可能已经包含 data:image 前缀，也可能是纯 base64
            let imageData = coverBase64;
            if (!coverBase64.startsWith('data:')) {
                imageData = `data:image/jpeg;base64,${coverBase64}`;
            }
            
            const image = await loadImage(imageData);
            return image;
        } catch (err) {
            this.logger.error(`[CanvasRenderer] 加载封面失败: ${err.message}`);
            return this.createDefaultAlbumArt(size);
        }
    }

    async createDefaultAlbumArt(size) {
        const canvas = createCanvas(size, size);
        const ctx = canvas.getContext('2d');

        // 背景
        ctx.fillStyle = COLORS.cardBg;
        ctx.fillRect(0, 0, size, size);

        // 音符图标
        ctx.fillStyle = COLORS.secondary;
        ctx.font = `bold ${Math.floor(size * 0.5)}px ${FONT_FAMILY}`;
        ctx.textAlign = 'center';
        ctx.textBaseline = 'middle';
        ctx.fillText('♪', size / 2, size / 2);

        return canvas;
    }

    /**
     * 渲染正在播放组件
     * @param {object} state - 当前播放状态
     * @param {object} options - 渲染选项
     * @param {number} width - 画布宽度
     * @param {number} height - 画布高度
     */
    async render(state, options = {}, width = DEFAULT_WIDTH, height = DEFAULT_HEIGHT) {
        this.ensureFonts();

        const {
            showTitle = true,
            showArtist = true,
            showAlbum = true,
            showProgress = true
        } = options;

        const canvas = createCanvas(width, height);
        const ctx = canvas.getContext('2d');

        // 背景
        ctx.fillStyle = COLORS.background;
        ctx.fillRect(0, 0, width, height);

        // 如果没有歌曲信息，显示空闲状态
        if (!state.song) {
            return this.renderIdleState(canvas, ctx, width, height);
        }

        const song = state.song;
        const isPlaying = state.playState === 'Playing';
        const progressMs = state.timeline?.currentTime || 0;
        const durationMs = state.timeline?.totalTime || 0;

        // 专辑封面
        const albumSize = height;
        
        try {
            const albumArt = await this.loadAlbumArt(song.coverBase64, albumSize);
            ctx.drawImage(albumArt, 0, 0, albumSize, albumSize);
        } catch (err) {
            this.logger.error(`[CanvasRenderer] 绘制封面错误: ${err.message}`);
        }

        // 文字区域
        const textPadding = 10;
        const textX = albumSize + textPadding;
        const textMaxWidth = width - textX - textPadding;
        
        // 进度条位置
        const progressHeight = 4;
        const progressY = height - progressHeight;
        
        // 字体大小
        const titleFontSize = 18;
        const artistFontSize = 14;
        const albumFontSize = 11;
        const timeFontSize = 11;

        // 专辑名 - 右上角
        if (showAlbum && song.albumName) {
            ctx.fillStyle = COLORS.secondary;
            ctx.font = `${albumFontSize}px ${FONT_FAMILY}`;
            ctx.textAlign = 'right';
            const album = this.truncateText(ctx, song.albumName, textMaxWidth * 0.5);
            ctx.fillText(album, width - textPadding, 4 + albumFontSize);
            ctx.textAlign = 'left';
        }

        // 歌曲标题 - 左上
        if (showTitle && song.songName) {
            ctx.fillStyle = COLORS.primary;
            ctx.font = `bold ${titleFontSize}px ${FONT_FAMILY}`;
            const titleMaxWidth = showAlbum ? textMaxWidth * 0.55 : textMaxWidth;
            const title = this.truncateText(ctx, song.songName, titleMaxWidth);
            ctx.fillText(title, textX, 4 + titleFontSize);
        }

        // 艺术家 - 标题下方
        if (showArtist && song.authorName) {
            ctx.fillStyle = COLORS.secondary;
            ctx.font = `${artistFontSize}px ${FONT_FAMILY}`;
            const artist = this.truncateText(ctx, song.authorName, textMaxWidth);
            ctx.fillText(artist, textX, 28 + artistFontSize);
        }

        // 进度条和时间
        if (showProgress && durationMs > 0) {
            const progress = Math.min(progressMs / durationMs, 1);
            const progressWidth = width - albumSize;

            // 时间标签
            ctx.fillStyle = COLORS.secondary;
            ctx.font = `${timeFontSize}px ${FONT_FAMILY}`;
            ctx.textAlign = 'right';
            const timeText = `${this.formatTime(progressMs)} / ${this.formatTime(durationMs)}`;
            ctx.fillText(timeText, width - textPadding, progressY - 3);
            ctx.textAlign = 'left';

            // 进度条背景
            ctx.fillStyle = COLORS.progressBg;
            ctx.fillRect(albumSize, progressY, progressWidth, progressHeight);

            // 进度条填充
            if (progress > 0) {
                ctx.fillStyle = COLORS.progressFill;
                ctx.fillRect(albumSize, progressY, progressWidth * progress, progressHeight);
            }
        }

        // 暂停时显示覆盖层
        if (!isPlaying) {
            ctx.fillStyle = 'rgba(0, 0, 0, 0.5)';
            ctx.fillRect(0, 0, albumSize, albumSize);
            
            // 绘制暂停图标（两个竖条）
            ctx.fillStyle = COLORS.primary;
            const iconHeight = Math.floor(albumSize * 0.4);
            const iconWidth = Math.floor(iconHeight * 0.25);
            const iconGap = Math.floor(iconWidth * 0.8);
            const iconX = (albumSize - iconWidth * 2 - iconGap) / 2;
            const iconY = (albumSize - iconHeight) / 2;
            
            // 左边竖条
            ctx.fillRect(iconX, iconY, iconWidth, iconHeight);
            // 右边竖条
            ctx.fillRect(iconX + iconWidth + iconGap, iconY, iconWidth, iconHeight);
        }

        return canvas.toBuffer('image/png');
    }

    renderIdleState(canvas, ctx, width, height) {
        const centerX = width / 2;
        const centerY = height / 2;
        
        // 音符图标
        ctx.fillStyle = COLORS.accent;
        ctx.font = `${Math.floor(height * 0.5)}px ${FONT_FAMILY}`;
        ctx.textAlign = 'center';
        ctx.textBaseline = 'middle';
        ctx.fillText('♪', centerX - 80, centerY);
        
        // 文字
        ctx.fillStyle = COLORS.secondary;
        ctx.font = `${Math.floor(height * 0.35)}px ${FONT_FAMILY}`;
        ctx.fillText('未在播放', centerX + 40, centerY);

        ctx.textAlign = 'left';
        ctx.textBaseline = 'alphabetic';

        return canvas.toBuffer('image/png');
    }
}

module.exports = CanvasRenderer;

