/**
 * Lyric Renderer for Netease Music
 * 使用 @napi-rs/canvas 渲染歌词，支持逐字母渐变高亮效果
 */

const { createCanvas, GlobalFonts } = require('@napi-rs/canvas');
const path = require('path');
const fs = require('fs');

// 注册系统字体
function registerSystemFonts(logger) {
    const platform = process.platform;
    const fontPaths = [];

    if (platform === 'win32') {
        const winFonts = path.join(process.env.WINDIR || 'C:\\Windows', 'Fonts');
        fontPaths.push(
            { path: path.join(winFonts, 'msyh.ttc'), family: 'Microsoft YaHei' },
            { path: path.join(winFonts, 'msyhbd.ttc'), family: 'Microsoft YaHei' },
            { path: path.join(winFonts, 'simhei.ttf'), family: 'SimHei' }
        );
    } else if (platform === 'darwin') {
        fontPaths.push(
            { path: '/System/Library/Fonts/PingFang.ttc', family: 'PingFang SC' },
            { path: '/System/Library/Fonts/Hiragino Sans GB.ttc', family: 'Hiragino Sans GB' }
        );
    } else {
        fontPaths.push(
            { path: '/usr/share/fonts/opentype/noto/NotoSansCJK-Regular.ttc', family: 'Noto Sans CJK' }
        );
    }

    for (const font of fontPaths) {
        try {
            if (fs.existsSync(font.path)) {
                GlobalFonts.registerFromPath(font.path, font.family);
            }
        } catch (err) {
            // 忽略字体注册错误
        }
    }
}

// 默认配色方案
const DEFAULT_COLORS = {
    background: '#1a1a1a',
    primary: '#FFFFFF',
    secondary: '#888888',
    highlight: '#E60026'
};

const DEFAULT_WIDTH = 480;
const DEFAULT_HEIGHT = 60;
const FONT_FAMILY = 'Microsoft YaHei, PingFang SC, Hiragino Sans GB, SimHei, Noto Sans CJK, Arial, sans-serif';

// 字母渐变间隔（毫秒）- 每个字母高亮的时间
const CHAR_INTERVAL_MS = 35; 

class LyricRenderer {
    constructor(logger) {
        this.logger = logger;
        this.fontsRegistered = false;
        
        // 渐变状态
        this.lastWordIndex = -1;
        this.lastLineIndex = -1;
        this.wordStartTime = 0;
        this.currentWordLength = 0;
    }

    ensureFonts() {
        if (!this.fontsRegistered) {
            registerSystemFonts(this.logger);
            this.fontsRegistered = true;
        }
    }

    /**
     * 解析颜色字符串为 RGB
     */
    parseColor(color) {
        if (color.startsWith('#')) {
            const hex = color.slice(1);
            return {
                r: parseInt(hex.slice(0, 2), 16),
                g: parseInt(hex.slice(2, 4), 16),
                b: parseInt(hex.slice(4, 6), 16)
            };
        }
        return { r: 255, g: 255, b: 255 };
    }

    /**
     * RGB 转换为 CSS 颜色字符串
     */
    rgbToColor(r, g, b) {
        return `rgb(${Math.round(r)}, ${Math.round(g)}, ${Math.round(b)})`;
    }

    /**
     * 在两个颜色之间插值
     */
    interpolateColor(color1, color2, progress) {
        const c1 = this.parseColor(color1);
        const c2 = this.parseColor(color2);
        const r = c1.r + (c2.r - c1.r) * progress;
        const g = c1.g + (c2.g - c1.g) * progress;
        const b = c1.b + (c2.b - c1.b) * progress;
        return this.rgbToColor(r, g, b);
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

    /**
     * 检测文本是否包含中日韩文字
     */
    hasCJK(text) {
        return /[\u4e00-\u9fff\u3040-\u309f\u30a0-\u30ff\uac00-\ud7af]/.test(text);
    }

    /**
     * 将歌词文本分割为"词"数组
     * 英文按空格分词，中日韩按字符分词
     */
    splitLyricToWords(text) {
        if (!text) return [];
        
        if (this.hasCJK(text)) {
            // 中日韩文字：按字符分割
            return Array.from(text).map(char => char);
        } else {
            // 英文/其他语言：按空格分词
            return text.split(/\s+/).filter(w => w.length > 0);
        }
    }

    /**
     * 根据对齐方式计算起始X坐标
     */
    getAlignedX(align, padding, maxWidth, textWidth) {
        switch (align) {
            case 'center':
                return padding + (maxWidth - textWidth) / 2;
            case 'right':
                return padding + maxWidth - textWidth;
            default: // left
                return padding;
        }
    }

    /**
     * 更新渐变状态，返回当前词内应高亮的字符数
     */
    updateGradientState(lineIndex, wordIndex, wordLength) {
        const now = Date.now();
        
        // 检查是否切换到新行或新词
        if (lineIndex !== this.lastLineIndex || wordIndex !== this.lastWordIndex) {
            this.lastLineIndex = lineIndex;
            this.lastWordIndex = wordIndex;
            this.wordStartTime = now;
            this.currentWordLength = wordLength;
        }
        
        // 计算当前应该高亮的字符数
        const elapsed = now - this.wordStartTime;
        const highlightedChars = Math.floor(elapsed / CHAR_INTERVAL_MS);
        
        return Math.min(highlightedChars, wordLength);
    }

    /**
     * 渲染歌词
     * @param {object} lyrics - 歌词数据
     * @param {object} currentLyric - 当前歌词位置
     * @param {object} song - 歌曲信息 (songName, authorName, albumName)
     * @param {object} options - 渲染选项
     * @param {number} width - 画布宽度
     * @param {number} height - 画布高度
     */
    async render(lyrics, currentLyric, song, options = {}, width = DEFAULT_WIDTH, height = DEFAULT_HEIGHT) {
        this.ensureFonts();

        const {
            showTranslation = true,
            highlightWord = true,
            backgroundColor = DEFAULT_COLORS.background,
            primaryAlign = 'left',
            primaryFontSize = 18,
            primaryColor = DEFAULT_COLORS.primary,
            highlightColor = DEFAULT_COLORS.highlight,
            primaryPaddingTop = 8,
            secondaryAlign = 'left',
            secondaryFontSize = 13,
            secondaryColor = DEFAULT_COLORS.secondary,
            secondaryPaddingTop = 4,
            paddingHorizontal = 10
        } = options;

        const canvas = createCanvas(width, height);
        const ctx = canvas.getContext('2d');

        // 背景
        ctx.fillStyle = backgroundColor;
        ctx.fillRect(0, 0, width, height);

        // 如果没有当前歌词位置信息，显示歌曲信息
        if (!currentLyric || currentLyric.lineIndex === undefined || currentLyric.lineIndex < 0) {
            return this.renderSongInfo(canvas, ctx, width, height, song, {
                primaryColor, secondaryColor, highlightColor, backgroundColor,
                primaryFontSize, secondaryFontSize, paddingHorizontal,
                primaryPaddingTop, secondaryPaddingTop, primaryAlign, secondaryAlign
            });
        }

        const line = currentLyric.line;
        const nextLine = currentLyric.nextLine;
        const wordIndex = currentLyric.wordIndex;
        const lineIndex = currentLyric.lineIndex;
        
        if (!line || !line.originalLyric) {
            return this.renderSongInfo(canvas, ctx, width, height, song, {
                primaryColor, secondaryColor, highlightColor, backgroundColor,
                primaryFontSize, secondaryFontSize, paddingHorizontal,
                primaryPaddingTop, secondaryPaddingTop, primaryAlign, secondaryAlign
            });
        }

        const maxWidth = width - paddingHorizontal * 2;
        const hasTranslation = showTranslation && line.translatedLyric;
        const hasNextLine = nextLine && nextLine.originalLyric;

        if (hasTranslation || hasNextLine) {
            // 两行模式
            // 第一行 - primaryPaddingTop 是距离顶部的距离
            this.renderCurrentLine(ctx, line, lineIndex, wordIndex, highlightWord, {
                x: paddingHorizontal,
                y: primaryPaddingTop,
                maxWidth,
                fontSize: primaryFontSize,
                align: primaryAlign,
                primaryColor,
                highlightColor
            });
            
            // 第二行 - secondaryPaddingTop 是距离顶部的距离
            ctx.fillStyle = secondaryColor;
            ctx.font = `${secondaryFontSize}px ${FONT_FAMILY}`;
            
            const secondaryText = hasTranslation ? line.translatedLyric : nextLine.originalLyric;
            const truncatedText = this.truncateText(ctx, secondaryText, maxWidth);
            const textWidth = ctx.measureText(truncatedText).width;
            const textX = this.getAlignedX(secondaryAlign, paddingHorizontal, maxWidth, textWidth);
            ctx.fillText(truncatedText, textX, secondaryPaddingTop + secondaryFontSize);
        } else {
            // 单行模式
            const centerY = height / 2;
            this.renderCurrentLineCentered(ctx, line, lineIndex, wordIndex, highlightWord, {
                padding: paddingHorizontal,
                centerY,
                maxWidth,
                fontSize: primaryFontSize + 2,
                align: primaryAlign,
                primaryColor,
                highlightColor
            });
        }

        return canvas.toBuffer('image/png');
    }

    /**
     * 渲染当前歌词行（支持逐字母渐变高亮）
     */
    renderCurrentLine(ctx, line, lineIndex, wordIndex, highlightWord, config) {
        const { x, y, maxWidth, fontSize, align, primaryColor, highlightColor } = config;
        
        if (!line || !line.originalLyric) {
            return y + fontSize;
        }

        ctx.font = `bold ${fontSize}px ${FONT_FAMILY}`;
        const lineY = y + fontSize;
        const originalText = line.originalLyric;
        
        const words = this.splitLyricToWords(originalText);
        const isCJK = this.hasCJK(originalText);
        const hasValidWordIndex = highlightWord && wordIndex !== undefined && wordIndex >= 0;
        
        if (hasValidWordIndex && words.length > 0) {
            // 获取当前词的长度，更新渐变状态
            const currentWord = words[wordIndex] || '';
            const highlightedChars = this.updateGradientState(lineIndex, wordIndex, currentWord.length);
            
            // 计算总宽度（包含空格）
            let totalWidth = 0;
            for (let i = 0; i < words.length; i++) {
                totalWidth += ctx.measureText(words[i]).width;
                if (!isCJK && i < words.length - 1) {
                    totalWidth += ctx.measureText(' ').width;
                }
            }
            
            // 根据对齐方式计算起始位置
            let currentX = this.getAlignedX(align, x, maxWidth, Math.min(totalWidth, maxWidth));
            
            for (let i = 0; i < words.length; i++) {
                const word = words[i];
                const wordWidth = ctx.measureText(word).width;
                
                // 检查是否超出宽度
                if (currentX + wordWidth > x + maxWidth) {
                    ctx.fillStyle = primaryColor;
                    ctx.fillText('...', currentX, lineY);
                    break;
                }
                
                if (i < wordIndex) {
                    // 已完成的词：全部高亮
                    ctx.fillStyle = highlightColor;
                    ctx.fillText(word, currentX, lineY);
                } else if (i === wordIndex) {
                    // 当前词：逐字母渐变
                    this.renderWordWithGradient(ctx, word, currentX, lineY, highlightedChars, primaryColor, highlightColor);
                } else {
                    // 未开始的词：普通色
                    ctx.fillStyle = primaryColor;
                    ctx.fillText(word, currentX, lineY);
                }
                
                currentX += wordWidth;
                
                // 非中日韩文字，添加空格
                if (!isCJK && i < words.length - 1) {
                    const spaceWidth = ctx.measureText(' ').width;
                    // 空格颜色跟随词的状态
                    if (i < wordIndex) {
                        ctx.fillStyle = highlightColor;
                    } else {
                        ctx.fillStyle = primaryColor;
                    }
                    ctx.fillText(' ', currentX, lineY);
                    currentX += spaceWidth;
                }
            }
        } else {
            // 整行渲染（无逐词高亮）
            ctx.fillStyle = highlightColor;
            const text = this.truncateText(ctx, originalText, maxWidth);
            const textWidth = ctx.measureText(text).width;
            const textX = this.getAlignedX(align, x, maxWidth, textWidth);
            ctx.fillText(text, textX, lineY);
        }
        
        return y + fontSize;
    }

    /**
     * 渲染带有逐字母渐变效果的词
     */
    renderWordWithGradient(ctx, word, x, y, highlightedChars, primaryColor, highlightColor) {
        const chars = Array.from(word);
        let currentX = x;
        
        for (let i = 0; i < chars.length; i++) {
            const char = chars[i];
            const charWidth = ctx.measureText(char).width;
            
            if (i < highlightedChars) {
                // 已高亮的字符
                ctx.fillStyle = highlightColor;
            } else if (i === highlightedChars) {
                // 正在渐变的字符 - 使用过渡色
                const progress = ((Date.now() - this.wordStartTime) % CHAR_INTERVAL_MS) / CHAR_INTERVAL_MS;
                ctx.fillStyle = this.interpolateColor(primaryColor, highlightColor, progress);
            } else {
                // 未高亮的字符
                ctx.fillStyle = primaryColor;
            }
            
            ctx.fillText(char, currentX, y);
            currentX += charWidth;
        }
    }

    /**
     * 居中渲染当前歌词行
     */
    renderCurrentLineCentered(ctx, line, lineIndex, wordIndex, highlightWord, config) {
        const { padding, centerY, maxWidth, fontSize, align, primaryColor, highlightColor } = config;
        
        if (!line || !line.originalLyric) {
            return;
        }

        ctx.font = `bold ${fontSize}px ${FONT_FAMILY}`;
        ctx.textBaseline = 'middle';
        
        const originalText = line.originalLyric;
        const words = this.splitLyricToWords(originalText);
        const isCJK = this.hasCJK(originalText);
        const hasValidWordIndex = highlightWord && wordIndex !== undefined && wordIndex >= 0;
        
        if (hasValidWordIndex && words.length > 0) {
            // 获取当前词的长度，更新渐变状态
            const currentWord = words[wordIndex] || '';
            const highlightedChars = this.updateGradientState(lineIndex, wordIndex, currentWord.length);
            
            // 计算总宽度
            let totalWidth = 0;
            for (let i = 0; i < words.length; i++) {
                totalWidth += ctx.measureText(words[i]).width;
                if (!isCJK && i < words.length - 1) {
                    totalWidth += ctx.measureText(' ').width;
                }
            }
            
            let currentX = this.getAlignedX(align, padding, maxWidth, Math.min(totalWidth, maxWidth));
            
            for (let i = 0; i < words.length; i++) {
                const word = words[i];
                const wordWidth = ctx.measureText(word).width;
                
                if (currentX + wordWidth > padding + maxWidth) {
                    break;
                }
                
                if (i < wordIndex) {
                    ctx.fillStyle = highlightColor;
                    ctx.fillText(word, currentX, centerY);
                } else if (i === wordIndex) {
                    this.renderWordWithGradientCentered(ctx, word, currentX, centerY, highlightedChars, primaryColor, highlightColor);
                } else {
                    ctx.fillStyle = primaryColor;
                    ctx.fillText(word, currentX, centerY);
                }
                
                currentX += wordWidth;
                
                if (!isCJK && i < words.length - 1) {
                    const spaceWidth = ctx.measureText(' ').width;
                    if (i < wordIndex) {
                        ctx.fillStyle = highlightColor;
                    } else {
                        ctx.fillStyle = primaryColor;
                    }
                    ctx.fillText(' ', currentX, centerY);
                    currentX += spaceWidth;
                }
            }
        } else {
            ctx.fillStyle = highlightColor;
            ctx.textAlign = align;
            const text = this.truncateText(ctx, originalText, maxWidth);
            let textX = padding;
            if (align === 'center') textX = padding + maxWidth / 2;
            else if (align === 'right') textX = padding + maxWidth;
            ctx.fillText(text, textX, centerY);
            ctx.textAlign = 'left';
        }
        
        ctx.textBaseline = 'alphabetic';
    }

    /**
     * 居中模式下渲染带有逐字母渐变效果的词
     */
    renderWordWithGradientCentered(ctx, word, x, centerY, highlightedChars, primaryColor, highlightColor) {
        const chars = Array.from(word);
        let currentX = x;
        
        for (let i = 0; i < chars.length; i++) {
            const char = chars[i];
            const charWidth = ctx.measureText(char).width;
            
            if (i < highlightedChars) {
                ctx.fillStyle = highlightColor;
            } else if (i === highlightedChars) {
                const progress = ((Date.now() - this.wordStartTime) % CHAR_INTERVAL_MS) / CHAR_INTERVAL_MS;
                ctx.fillStyle = this.interpolateColor(primaryColor, highlightColor, progress);
            } else {
                ctx.fillStyle = primaryColor;
            }
            
            ctx.fillText(char, currentX, centerY);
            currentX += charWidth;
        }
    }

    /**
     * 渲染歌曲信息（无歌词时显示）
     */
    renderSongInfo(canvas, ctx, width, height, song, options) {
        const {
            primaryColor, secondaryColor, highlightColor, backgroundColor,
            primaryFontSize, secondaryFontSize, paddingHorizontal,
            primaryPaddingTop, secondaryPaddingTop, primaryAlign, secondaryAlign
        } = options;

        // 背景已在 render 中绘制
        const maxWidth = width - paddingHorizontal * 2;

        // 如果没有歌曲信息，显示默认文本
        if (!song || !song.songName) {
            ctx.fillStyle = secondaryColor;
            ctx.font = `16px ${FONT_FAMILY}`;
            ctx.textAlign = 'center';
            ctx.textBaseline = 'middle';
            ctx.fillText('♪ 等待播放 ♪', width / 2, height / 2);
            ctx.textAlign = 'left';
            ctx.textBaseline = 'alphabetic';
            return canvas.toBuffer('image/png');
        }

        // 显示歌曲名（第一行）- primaryPaddingTop 是距离顶部的距离
        ctx.fillStyle = highlightColor;
        ctx.font = `bold ${primaryFontSize}px ${FONT_FAMILY}`;
        
        const songName = this.truncateText(ctx, `♪ ${song.songName}`, maxWidth);
        const songNameWidth = ctx.measureText(songName).width;
        const songNameX = this.getAlignedX(primaryAlign, paddingHorizontal, maxWidth, songNameWidth);
        ctx.fillText(songName, songNameX, primaryPaddingTop + primaryFontSize);

        // 显示艺术家 - 专辑（第二行）- secondaryPaddingTop 是距离顶部的距离
        ctx.fillStyle = secondaryColor;
        ctx.font = `${secondaryFontSize}px ${FONT_FAMILY}`;
        
        let artistAlbum = song.authorName || '';
        if (song.albumName) {
            artistAlbum += artistAlbum ? ` - ${song.albumName}` : song.albumName;
        }
        
        if (artistAlbum) {
            const artistText = this.truncateText(ctx, artistAlbum, maxWidth);
            const artistWidth = ctx.measureText(artistText).width;
            const artistX = this.getAlignedX(secondaryAlign, paddingHorizontal, maxWidth, artistWidth);
            ctx.fillText(artistText, artistX, secondaryPaddingTop + secondaryFontSize);
        }

        return canvas.toBuffer('image/png');
    }

    /**
     * 渲染无歌词状态（备用）
     */
    renderNoLyrics(canvas, ctx, width, height, message = '暂无歌词', color = DEFAULT_COLORS.secondary, bgColor = DEFAULT_COLORS.background) {
        ctx.fillStyle = bgColor;
        ctx.fillRect(0, 0, width, height);
        
        ctx.fillStyle = color;
        ctx.font = `16px ${FONT_FAMILY}`;
        ctx.textAlign = 'center';
        ctx.textBaseline = 'middle';
        ctx.fillText(message, width / 2, height / 2);
        ctx.textAlign = 'left';
        ctx.textBaseline = 'alphabetic';
        
        return canvas.toBuffer('image/png');
    }
}

module.exports = LyricRenderer;
