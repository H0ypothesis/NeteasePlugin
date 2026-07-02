/**
 * 歌词获取与解析（来自网易云公开接口）
 * ============================================================================
 * macOS 的 MediaRemote 不提供歌词，所以这里用「正在播放」拿到的歌名/歌手/时长，
 * 去网易云搜索匹配出歌曲 ID，再拉取逐行歌词(lrc)与翻译(tlyric)。
 *
 * 时长是非常强的匹配信号（MediaRemote 的总时长通常与网易云完全一致），
 * 因此匹配以"标题相近 + 时长接近"为准。
 *
 * 注意：本文件与 macos-bridge/lyrics.js 内容一致，被内置进插件后端(plugin.cjs)，
 * 使插件在 macOS 上无需外部桥接进程即可拉取歌词。
 */

'use strict';

const https = require('https');

const UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36';
const TIMEOUT_MS = 8000;

function httpRequest(method, url, body) {
    return new Promise((resolve, reject) => {
        const u = new URL(url);
        const data = body || null;
        const req = https.request(
            {
                method,
                hostname: u.hostname,
                path: u.pathname + u.search,
                headers: {
                    'User-Agent': UA,
                    Referer: 'https://music.163.com/',
                    ...(data
                        ? {
                              'Content-Type': 'application/x-www-form-urlencoded',
                              'Content-Length': Buffer.byteLength(data),
                          }
                        : {}),
                },
            },
            (res) => {
                let s = '';
                res.on('data', (d) => (s += d));
                res.on('end', () => resolve(s));
            }
        );
        req.on('error', reject);
        req.setTimeout(TIMEOUT_MS, () => req.destroy(new Error('timeout')));
        if (data) req.write(data);
        req.end();
    });
}

function normalize(s) {
    return (s || '')
        .toLowerCase()
        .replace(/[\s　]/g, '')
        .replace(/[^\p{L}\p{N}]/gu, '');
}

// 解析 LRC：返回 [{timeMs, text}]，跳过空行
function parseLrc(lrc) {
    const out = [];
    if (!lrc) return out;
    const timeRe = /\[(\d+):(\d+)(?:[.:](\d+))?\]/g;
    for (const raw of lrc.split('\n')) {
        const text = raw.replace(/\[[^\]]*\]/g, '').trim();
        if (!text) continue;
        timeRe.lastIndex = 0;
        let m;
        while ((m = timeRe.exec(raw)) !== null) {
            const mm = parseInt(m[1], 10);
            const ss = parseInt(m[2], 10);
            let frac = 0;
            if (m[3] !== undefined) {
                if (m[3].length === 1) frac = parseInt(m[3], 10) * 100;
                else if (m[3].length === 2) frac = parseInt(m[3], 10) * 10;
                else frac = parseInt(m[3].slice(0, 3), 10);
            }
            out.push({ timeMs: mm * 60000 + ss * 1000 + frac, text });
        }
    }
    return out;
}

// 在网易云搜索并选出最佳匹配的歌曲 ID
async function searchSongId(title, artist, durationMs, log) {
    const query = `${title} ${artist || ''}`.trim();
    const body = `s=${encodeURIComponent(query)}&type=1&limit=8`;
    let json;
    try {
        json = JSON.parse(await httpRequest('POST', 'https://music.163.com/api/search/get', body));
    } catch (e) {
        log && log('歌词搜索失败:', e.message);
        return null;
    }
    const songs = (json && json.result && json.result.songs) || [];
    if (!songs.length) return null;

    const nTitle = normalize(title);
    let best = null;
    for (const s of songs) {
        const sDur = s.duration || s.dt || 0;
        const durDiff = durationMs ? Math.abs(sDur - durationMs) : Infinity;
        const nName = normalize(s.name);
        let titleScore = 2;
        if (nName === nTitle) titleScore = 0;
        else if (nName.includes(nTitle) || nTitle.includes(nName)) titleScore = 1;
        const score = [titleScore, durDiff];
        if (!best || score[0] < best.score[0] || (score[0] === best.score[0] && score[1] < best.score[1])) {
            best = { id: s.id, name: s.name, score };
        }
    }
    if (!best) return null;
    // 置信度：标题相近，或时长非常接近（≤3s）
    if (best.score[0] <= 1 || best.score[1] <= 3000) {
        return best.id;
    }
    log && log(`歌词匹配置信度不足，放弃 (titleScore=${best.score[0]}, durDiff=${best.score[1]})`);
    return null;
}

/**
 * 获取并解析歌词。
 * @returns {Promise<{songId:number, lines:Array<{timeMs:number,text:string,trans:string}>}|null>}
 */
async function fetchLyrics({ title, artist, durationMs }, log) {
    if (!title) return null;
    const id = await searchSongId(title, artist, durationMs, log);
    if (!id) return null;

    let json;
    try {
        json = JSON.parse(
            await httpRequest('GET', `https://music.163.com/api/song/lyric?id=${id}&lv=-1&kv=-1&tv=-1`)
        );
    } catch (e) {
        log && log('歌词拉取失败:', e.message);
        return null;
    }

    const main = parseLrc(json.lrc && json.lrc.lyric);
    if (!main.length) return null;

    // 翻译：按时间戳建表
    const transMap = new Map();
    for (const t of parseLrc(json.tlyric && json.tlyric.lyric)) {
        if (!transMap.has(t.timeMs)) transMap.set(t.timeMs, t.text);
    }

    // 合并、排序、去重
    main.sort((a, b) => a.timeMs - b.timeMs);
    const lines = [];
    let lastT = -1;
    for (const l of main) {
        if (l.timeMs === lastT) continue;
        lastT = l.timeMs;
        lines.push({ timeMs: l.timeMs, text: l.text, trans: transMap.get(l.timeMs) || '' });
    }

    return { songId: id, lines };
}

module.exports = { fetchLyrics, parseLrc, normalize };
