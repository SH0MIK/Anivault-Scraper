import * as cheerio from 'cheerio';
import axios from 'axios';
import https from 'https';
import CryptoJS from 'crypto-js';
import { makeClient } from '../utils/fetch';
import { cacheGet, cacheSet } from '../utils/cache';

// ══════════════════════════════════════════════════════════════
// DESIDUBANIME.ME — Hindi & Regional Dub / Multi-Audio Scraper
// ══════════════════════════════════════════════════════════════

const BASE = 'https://www.desidubanime.me';
const http = makeClient(BASE, BASE + '/');

const HEADERS = {
  'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
  'Referer': BASE + '/',
};

export interface DesidubSearchResult {
  slug: string;
  title: string;
  image?: string;
}

export interface DesidubEpisode {
  num: number;
  id: string; // Episode slug e.g. "shingeki-no-kyojin-episode-1"
  title: string;
}

export interface DesidubServer {
  name: string;
  sourceId: string; // Embed URL or encoded embed data
  type: 'sub' | 'dub' | 'raw';
  dubGroup?: string;
}

export interface DesidubSubtitle {
  lang: string;
  url: string;
  default?: boolean;
}

export interface DesidubStream {
  embedUrl: string;
  m3u8: string | null;
  mp4?: string | null;
  referer?: string;
  subtitles: DesidubSubtitle[];
  serverName: string;
  type: 'hls' | 'mp4' | 'iframe';
}

// ══════════════════════════════════════════════════════════════
// DECRYPTORS & UNPACKERS (Pure TypeScript / crypto-js)
// ══════════════════════════════════════════════════════════════

/**
 * Unpacks Dean Edwards packed JavaScript: eval(function(p,a,c,k,e,d)...)
 */
export function unpackPacked(packed: string): string {
  const match = packed.match(/eval\(function\(p,a,c,k,e,[rd]\)\{[\s\S]*?return\s+p;?\}\s*\(\s*['"]([\s\S]*?)['"]\s*,\s*(\d+)\s*,\s*(\d+)\s*,\s*['"]([\s\S]*?)['"]\.split\(['"]\|['"]\)/);
  if (match) {
    const [, p, aStr, cStr, kStr] = match;
    return decodePacked(p, parseInt(aStr, 10), parseInt(cStr, 10), kStr.split('|'));
  }

  const fallbackMatch = packed.match(/}\s*\(\s*['"]([\s\S]*?)['"]\s*,\s*(\d+)\s*,\s*(\d+)\s*,\s*['"]([\s\S]*?)['"]\.split\(['"]\|['"]\)/);
  if (fallbackMatch) {
    const [, p, aStr, cStr, kStr] = fallbackMatch;
    return decodePacked(p, parseInt(aStr, 10), parseInt(cStr, 10), kStr.split('|'));
  }

  return '';
}

function decodePacked(p: string, radix: number, count: number, dict: string[]): string {
  function toBase(val: number, rad: number): string {
    const chars = '0123456789abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ';
    let res = '';
    while (val > 0) {
      res = chars[val % rad] + res;
      val = Math.floor(val / rad);
    }
    return res || '0';
  }

  for (let i = count - 1; i >= 0; i--) {
    const key = toBase(i, radix);
    const val = dict[i] || key;
    const reg = new RegExp('\\b' + key + '\\b', 'g');
    p = p.replace(reg, val);
  }
  return p;
}

/**
 * Decrypts AES-128-CBC encoded payloads (used by P2PPlay, RPMStream, UPNShare)
 */
export function decryptAesCbc(encryptedHex: string, keyStr: string = 'kiemtienmua911ca', ivStr: string = '1234567890oiuytr'): string {
  try {
    const key = CryptoJS.enc.Utf8.parse(keyStr);
    const iv = CryptoJS.enc.Utf8.parse(ivStr);
    const ciphertext = CryptoJS.enc.Hex.parse(encryptedHex);
    const decrypted = CryptoJS.AES.decrypt({ ciphertext } as any, key, {
      iv,
      mode: CryptoJS.mode.CBC,
      padding: CryptoJS.pad.Pkcs7,
    });
    return decrypted.toString(CryptoJS.enc.Utf8);
  } catch (err) {
    return '';
  }
}

/**
 * Extracts .vtt/.srt subtitle tracks from HTML or unpacked JavaScript
 */
export function extractSubtitlesFromText(text: string): DesidubSubtitle[] {
  const subtitles: DesidubSubtitle[] = [];
  const vttMatches = text.match(/["'](https?:\/\/[^\s"']+\.(?:vtt|srt)[^\s"']*)["']/gi) || [];

  for (const raw of vttMatches) {
    const v = raw.replace(/["']/g, '');
    if (v.includes('_sli') || v.toLowerCase().includes('thumb')) continue;

    let lang = 'English';
    const low = v.toLowerCase();
    if (low.includes('hin')) lang = 'Hindi';
    else if (low.includes('tam')) lang = 'Tamil';
    else if (low.includes('tel')) lang = 'Telugu';
    else if (low.includes('jap') || low.includes('jpn')) lang = 'Japanese';
    else if (low.includes('eng')) lang = 'English';

    if (!subtitles.some((s) => s.url === v)) {
      subtitles.push({
        lang,
        url: v,
        default: lang === 'English',
      });
    }
  }
  return subtitles;
}

// ══════════════════════════════════════════════════════════════
// RESOLVERS FOR INDIVIDUAL STREAM HOSTS
// ══════════════════════════════════════════════════════════════

/**
 * Resolve VidMoly embed (https://vidmoly.net/embed-xxx.html)
 */
export async function resolveVidmoly(embedUrl: string): Promise<{ m3u8: string | null; subtitles: DesidubSubtitle[]; referer: string } | null> {
  try {
    const res = await axios.get(embedUrl, {
      headers: { ...HEADERS, Referer: BASE + '/' },
      timeout: 12000,
    });
    if (res.status === 200) {
      const html = String(res.data);
      const m3u8Match = html.match(/(https?:\/\/[^\s"']+\.m3u8[^\s"']*)/i);
      const subtitles = extractSubtitlesFromText(html);
      return {
        m3u8: m3u8Match ? m3u8Match[1] : null,
        subtitles,
        referer: 'https://vidmoly.net/',
      };
    }
  } catch (e) {
    // Ignore resolution error
  }
  return null;
}

/**
 * Resolve StreamRuby / RubyVidHub embed
 */
export async function resolveStreamRuby(embedUrl: string): Promise<{ m3u8: string | null; subtitles: DesidubSubtitle[]; referer: string } | null> {
  try {
    const res = await axios.get(embedUrl, {
      headers: { ...HEADERS, Referer: BASE + '/' },
      timeout: 12000,
    });
    if (res.status === 200) {
      const html = String(res.data);
      const unpacked = unpackPacked(html);
      const textToSearch = unpacked || html;
      const m3u8Match = textToSearch.match(/(https?:\/\/[^\s"']+\.m3u8[^\s"']*)/i);
      const subtitles = extractSubtitlesFromText(textToSearch);
      return {
        m3u8: m3u8Match ? m3u8Match[1] : null,
        subtitles,
        referer: 'https://rubyvidhub.com/',
      };
    }
  } catch (e) {
    // Ignore resolution error
  }
  return null;
}

/**
 * Resolve AbyssPlayer embed — decrypts AES-CTR media payload
 */
export async function resolveAbyss(embedUrl: string): Promise<{ m3u8: string | null; subtitles: DesidubSubtitle[]; referer: string } | null> {
  try {
    const res = await axios.get(embedUrl, {
      headers: { ...HEADERS, Referer: BASE + '/' },
      timeout: 12000,
    });
    if (res.status !== 200) return null;

    const html = String(res.data);
    const datasMatch = html.match(/const datas\s*=\s*"([^"]+)"/);
    if (!datasMatch) return null;

    const decodedStr = Buffer.from(datasMatch[1], 'base64').toString('latin1');
    const payload = JSON.parse(decodedStr);
    const { user_id, slug, md5_id, media } = payload;
    if (!user_id || !slug || !md5_id || !media) return null;

    // AES-CTR decryption: key = MD5(user_id:slug:md5_id), counter = key[:16]
    const keyStr = `${user_id}:${slug}:${md5_id}`;
    const md5Hex = require('crypto').createHash('md5').update(keyStr).digest('hex');
    const key = CryptoJS.enc.Hex.parse(md5Hex);
    // AES-CTR using CryptoJS CTR mode
    const iv = CryptoJS.enc.Hex.parse(md5Hex.slice(0, 32)); // first 16 bytes as counter
    const cipherBytes = Buffer.from(media, 'latin1');
    // Decrypt via CTR
    const cipherHex = cipherBytes.toString('hex');
    const cipherParams = CryptoJS.lib.CipherParams.create({
      ciphertext: CryptoJS.enc.Hex.parse(cipherHex),
    });
    const decrypted = CryptoJS.AES.decrypt(cipherParams, key, {
      iv,
      mode: CryptoJS.mode.CTR,
      padding: CryptoJS.pad.NoPadding,
    });
    const decryptedStr = decrypted.toString(CryptoJS.enc.Utf8);
    if (!decryptedStr) return null;

    const mediaData = JSON.parse(decryptedStr);
    // Abyss uses chunked .fd segments — try to find any m3u8 or HLS-like source
    const sources: string[] = mediaData?.mp4?.sources || [];
    const fristDatas: string[] = mediaData?.mp4?.fristDatas || [];

    // Some Abyss instances embed an m3u8 directly
    const allSources = [...sources, ...fristDatas];
    const m3u8 = allSources.find((s) => s.includes('.m3u8')) || null;

    return {
      m3u8,
      subtitles: [],
      referer: embedUrl,
    };
  } catch (e) {
    return null;
  }
}

/**
 * Resolve EarnVids / SmoothPre embed (from GDMirrorBot)
 */
export async function resolveEarnVids(embedUrl: string): Promise<{ m3u8: string | null; subtitles: DesidubSubtitle[]; referer: string } | null> {
  try {
    const res = await axios.get(embedUrl, {
      headers: { ...HEADERS, Referer: 'https://gdmirrorbot.nl/' },
      timeout: 12000,
    });
    if (res.status === 200) {
      const html = String(res.data);
      const unpacked = unpackPacked(html);
      const textToSearch = unpacked || html;

      const linksMatch = textToSearch.match(/"hls\d*"\s*:\s*"([^"]+\.m3u8[^"]*)"/i);
      const m3u8 = linksMatch ? linksMatch[1] : textToSearch.match(/(https?:\/\/[^\s"']+\.m3u8[^\s"']*)/i)?.[1] || null;
      const subtitles = extractSubtitlesFromText(textToSearch);

      return {
        m3u8,
        subtitles,
        referer: embedUrl,
      };
    }
  } catch (e) {
    // Ignore
  }
  return null;
}

/**
 * Resolve RPMStream / UPNShare / P2PPlay embed (used in GDMirrorBot)
 */
export async function resolveP2PPlay(embedUrl: string): Promise<{ m3u8: string | null; subtitles: DesidubSubtitle[]; referer: string } | null> {
  try {
    const urlObj = new URL(embedUrl);
    const domain = urlObj.host;
    const videoId = urlObj.hash ? urlObj.hash.replace('#', '') : urlObj.pathname.split('/').pop();
    if (!videoId) return null;

    const apiUrl = `https://${domain}/api/v1/video?id=${videoId}`;
    const res = await axios.get(apiUrl, {
      headers: {
        'User-Agent': HEADERS['User-Agent'],
        'Referer': `https://${domain}/#${videoId}`,
      },
      timeout: 10000,
    });

    if (res.status === 200 && typeof res.data === 'string') {
      const encryptedHex = res.data.trim();
      const decryptedStr = decryptAesCbc(encryptedHex, 'kiemtienmua911ca', '1234567890oiuytr');
      if (decryptedStr) {
        const data = JSON.parse(decryptedStr);
        // Prefer cfNative (Cloudflare CDN) over direct IP (source) since direct IP may be slow/blocked
        const m3u8 = data.cfNative || data.source || null;

        const subtitles: DesidubSubtitle[] = [];
        if (data.subtitle && typeof data.subtitle === 'object') {
          for (const [langKey, subPath] of Object.entries(data.subtitle)) {
            if (typeof subPath === 'string') {
              const fullUrl = subPath.startsWith('http') ? subPath : `https://${domain}${subPath.split('#')[0]}`;
              const lang = langKey === 'en' ? 'English' : langKey === 'hi' ? 'Hindi' : langKey;
              subtitles.push({ lang, url: fullUrl, default: lang === 'English' });
            }
          }
        }
        return {
          m3u8,
          subtitles,
          referer: `https://${domain}/#${videoId}`,
        };
      }
    }
  } catch (e) {}
  return null;
}

/**
 * Resolve GDMirrorBot multi-mirror embed (https://gdmirrorbot.nl/embed/xxx)
 */
export async function resolveGdMirrorBot(embedUrl: string): Promise<{ m3u8: string | null; subtitles: DesidubSubtitle[]; referer: string } | null> {
  try {
    const sid = embedUrl.split('/').pop()?.split('?')[0] || '';
    if (!sid) return null;

    const payload = new URLSearchParams({
      sid,
      UserFavSite: '',
      currentDomain: '[]',
    });

    let res: any = null;
    try {
      res = await axios.post('https://pro.iqsmartgames.com/embedhelper2.php', payload.toString(), {
        headers: {
          'User-Agent': HEADERS['User-Agent'],
          'Referer': embedUrl,
          'Content-Type': 'application/x-www-form-urlencoded',
        },
        timeout: 12000,
      });
    } catch {
      res = await axios.post('https://gdmirrorbot.nl/embedhelper2.php', payload.toString(), {
        headers: {
          'User-Agent': HEADERS['User-Agent'],
          'Referer': embedUrl,
          'Content-Type': 'application/x-www-form-urlencoded',
        },
        timeout: 12000,
      });
    }

    if (res && res.status === 200 && res.data) {
      const data = res.data;
      let mresult: Record<string, any> = {};
      if (data.mresult) {
        let rawB64 = data.mresult;
        rawB64 += '='.repeat((4 - (rawB64.length % 4)) % 4);
        const decodedStr = Buffer.from(rawB64, 'base64').toString('utf8');
        mresult = JSON.parse(decodedStr);
      }

      const sources = data.sources || {};

      // Build mirror candidates list
      const subMirrors: { key: string; name: string; url: string }[] = [];
      for (const [key, code] of Object.entries(mresult)) {
        const srcInfo = sources[key] || {};
        const siteUrl = srcInfo.siteUrl || '';
        const name = srcInfo.friendlyName || key;
        subMirrors.push({ key, name, url: `${siteUrl}${code}` });
      }

      // Priority 1: EarnVids (dramiyos-cdn m3u8)
      for (const mirror of subMirrors) {
        if (mirror.key === 'flls' || mirror.key === 'earnvids') {
          const stream = await resolveEarnVids(mirror.url);
          if (stream?.m3u8) return stream;
        }
      }

      // Priority 2: RPMStream / UPNShare
      for (const mirror of subMirrors) {
        if (mirror.key === 'rpmshre' || mirror.key === 'upnshr') {
          const stream = await resolveP2PPlay(mirror.url);
          if (stream?.m3u8) return stream;
        }
      }

      // Priority 3: VidMoly
      for (const mirror of subMirrors) {
        if (mirror.key === 'vidmoly') {
          const stream = await resolveVidmoly(mirror.url);
          if (stream?.m3u8) return stream;
        }
      }

      // Priority 4: StreamRuby
      for (const mirror of subMirrors) {
        if (mirror.key === 'ruby' || mirror.key === 'streamruby') {
          const stream = await resolveStreamRuby(mirror.url);
          if (stream?.m3u8) return stream;
        }
      }
    }
  } catch (e) {
    // Fall back
  }
  return null;
}

/**
 * Universal DesiDub Stream Resolver
 */
export async function getDesidubStream(sourceIdOrUrl: string): Promise<DesidubStream | null> {
  let embedUrl = sourceIdOrUrl.trim();

  // Decode if base64 embed ID (only if not already an http(s) URL)
  if (!embedUrl.startsWith('http://') && !embedUrl.startsWith('https://') && !embedUrl.startsWith('<') && embedUrl.includes(':')) {
    const parts = embedUrl.split(':');
    if (parts.length === 2) {
      try {
        let urlB64 = parts[1];
        urlB64 += '='.repeat((4 - (urlB64.length % 4)) % 4);
        embedUrl = Buffer.from(urlB64, 'base64').toString('utf8');
      } catch {}
    }
  }

  // If iframe tag in url
  if (embedUrl.toLowerCase().includes('<iframe')) {
    const srcMatch = embedUrl.match(/src=['"]([^'"]+)['"]/i);
    if (srcMatch) embedUrl = srcMatch[1];
  }

  if (embedUrl.includes('vidmoly.')) {
    const res = await resolveVidmoly(embedUrl);
    return {
      embedUrl,
      m3u8: res?.m3u8 ?? null,
      referer: res?.referer ?? embedUrl,
      subtitles: res?.subtitles ?? [],
      serverName: 'VidMoly',
      type: res?.m3u8 ? 'hls' : 'iframe',
    };
  }

  if (embedUrl.includes('rubyvidhub.') || embedUrl.includes('streamruby.') || embedUrl.includes('rubystream.')) {
    const res = await resolveStreamRuby(embedUrl);
    return {
      embedUrl,
      m3u8: res?.m3u8 ?? null,
      referer: res?.referer ?? embedUrl,
      subtitles: res?.subtitles ?? [],
      serverName: 'StreamRuby',
      type: res?.m3u8 ? 'hls' : 'iframe',
    };
  }

  if (embedUrl.includes('smoothpre.') || embedUrl.includes('earnvids.') || embedUrl.includes('dramiyos-cdn.')) {
    const res = await resolveEarnVids(embedUrl);
    return {
      embedUrl,
      m3u8: res?.m3u8 ?? null,
      referer: res?.referer ?? 'https://gdmirrorbot.nl/',
      subtitles: res?.subtitles ?? [],
      serverName: 'EarnVids',
      type: res?.m3u8 ? 'hls' : 'iframe',
    };
  }

  if (embedUrl.includes('rpmstream.') || embedUrl.includes('upns.') || embedUrl.includes('strp2p.')) {
    const res = await resolveP2PPlay(embedUrl);
    return {
      embedUrl,
      m3u8: res?.m3u8 ?? null,
      referer: res?.referer ?? embedUrl,
      subtitles: res?.subtitles ?? [],
      serverName: 'RPMStream',
      type: res?.m3u8 ? 'hls' : 'iframe',
    };
  }

  if (embedUrl.includes('gdmirrorbot.')) {
    const res = await resolveGdMirrorBot(embedUrl);
    return {
      embedUrl,
      m3u8: res?.m3u8 ?? null,
      referer: res?.referer ?? 'https://gdmirrorbot.nl/',
      subtitles: res?.subtitles ?? [],
      serverName: 'Mirror',
      type: res?.m3u8 ? 'hls' : 'iframe',
    };
  }

  if (embedUrl.includes('abyssplayer.com') || embedUrl.includes('abyss.to')) {
    const res = await resolveAbyss(embedUrl);
    return {
      embedUrl,
      m3u8: res?.m3u8 ?? null,
      referer: res?.referer ?? embedUrl,
      subtitles: res?.subtitles ?? [],
      serverName: 'Abyss',
      type: res?.m3u8 ? 'hls' : 'iframe',
    };
  }

  if (embedUrl.includes('cloud.desidubanime.me/external/')) {
    try {
      const cloudRes = await axios.get(embedUrl, {
        headers: {
          'User-Agent': HEADERS['User-Agent'],
          'Referer': 'https://www.desidubanime.me/',
        },
        timeout: 10000,
      });
      const playMatch = String(cloudRes.data).match(/src=['"](\/play\/[^'"]+)['"]/i) || String(cloudRes.data).match(/"url"\s*:\s*"(\/play\/[^"]+)"/i);
      if (playMatch) {
        embedUrl = `https://cloud.desidubanime.me${playMatch[1]}`;
      }
    } catch {}
    return {
      embedUrl,
      m3u8: null,
      referer: 'https://cloud.desidubanime.me/',
      subtitles: [],
      serverName: 'Cloud',
      type: 'iframe',
    };
  }

  // Fallback: direct m3u8 scan
  try {
    const res = await axios.get(embedUrl, { headers: HEADERS, timeout: 10000 });
    const html = String(res.data);
    const unpacked = unpackPacked(html);
    const text = unpacked || html;
    const m3u8Match = text.match(/(https?:\/\/[^\s"']+\.m3u8[^\s"']*)/i);
    const subtitles = extractSubtitlesFromText(text);

    return {
      embedUrl,
      m3u8: m3u8Match ? m3u8Match[1] : null,
      referer: embedUrl,
      subtitles,
      serverName: 'Direct',
      type: m3u8Match ? 'hls' : 'iframe',
    };
  } catch (e) {
    return {
      embedUrl,
      m3u8: null,
      subtitles: [],
      serverName: 'Embed',
      type: 'iframe',
    };
  }
}

// ══════════════════════════════════════════════════════════════
// SCRAPER & SEARCH FUNCTIONS
// ══════════════════════════════════════════════════════════════

function normalizeTitle(title: string): string {
  return title.toLowerCase().replace(/[^a-z0-9]/g, '');
}

function significantWords(s: string): string[] {
  return s
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, ' ')
    .split(/\s+/)
    .filter((w) => w.length >= 2);
}

const TYPE_INDICATOR_WORDS = new Set([
  'ova', 'ona', 'special', 'specials', 'movie', 'film', 'recap', 'picture', 'pv',
  'season', 'part', 'cour', 'saga',
]);

function addsUnrequestedTypeIndicator(query: string, candidateTitle: string): boolean {
  const queryWords = new Set(significantWords(query));
  return significantWords(candidateTitle).some((w) => TYPE_INDICATOR_WORDS.has(w) && !queryWords.has(w));
}

function scoreTitle(query: string, title: string): number {
  const needle = normalizeTitle(query);
  const hay = normalizeTitle(title);
  if (!needle || !hay) return 0;
  if (hay === needle) return 100;

  const ratio = Math.min(needle.length, hay.length) / Math.max(needle.length, hay.length);
  const queryIsLonger = needle.length > hay.length;
  const candidateAddsSpinoffMarker = !queryIsLonger && addsUnrequestedTypeIndicator(query, title);

  if (candidateAddsSpinoffMarker) {
    return Math.floor(ratio * 40);
  }

  if (hay.startsWith(needle) || needle.startsWith(hay)) return Math.floor(ratio * 90);
  if (hay.includes(needle) || needle.includes(hay)) return Math.floor(ratio * 75);

  let matches = 0;
  for (const ch of needle) if (hay.includes(ch)) matches++;
  return Math.floor((matches / Math.max(needle.length, 1)) * 40);
}

export interface DesidubSearchResult {
  slug: string;
  title: string;
  titleEn?: string;
  titleJp?: string;
  image?: string;
}

/**
 * Search DesiDubAnime for anime title
 */
export async function searchDesidub(query: string): Promise<DesidubSearchResult[]> {
  const cacheKey = `desidub:search:${query.toLowerCase().trim()}`;
  const cached = cacheGet<DesidubSearchResult[]>(cacheKey);
  if (cached) return cached;

  const results: DesidubSearchResult[] = [];

  // Try Instant Search API (action=instant_search)
  try {
    const res = await axios.get(`${BASE}/wp-admin/admin-ajax.php`, {
      params: {
        action: 'instant_search',
        query,
      },
      headers: {
        'User-Agent': HEADERS['User-Agent'],
        'Referer': BASE + '/',
      },
      timeout: 10000,
    });

    if (res.status === 200 && res.data && res.data.success && res.data.data?.html) {
      const $ = cheerio.load(res.data.data.html);
      $('a').each((_, el) => {
        const $el = $(el);
        const link = $el.attr('href') || '';
        const spans = $el.find('h3 span').toArray();
        const titleEn = spans[0] ? $(spans[0]).text().trim() : '';
        const titleJp = spans[1] ? $(spans[1]).text().trim() : '';
        const title = titleEn || titleJp || $el.attr('title') || $el.text().trim();
        const img = $el.find('img').attr('src') || $el.find('img').attr('data-src');

        const slugMatch = link.match(/\/anime\/([^/]+)\//);
        const slug = slugMatch ? slugMatch[1] : '';

        if (slug && title && !results.some((r) => r.slug === slug)) {
          results.push({ slug, title, titleEn, titleJp, image: img });
        }
      });
    }
  } catch (e) {
    // Fall back to standard search page
  }

  // Fallback: standard search page
  if (results.length === 0) {
    try {
      const res = await http.get('/', { params: { s: query } });
      const $ = cheerio.load(res.data);
      $('article, .anime-card, .film-item, .post-item, .bsx, .animposx').each((_, el) => {
        const $el = $(el);
        const link = $el.find('a').first().attr('href') || '';
        const spans = $el.find('h3 span, .title span').toArray();
        const titleEn = spans[0] ? $(spans[0]).text().trim() : '';
        const titleJp = spans[1] ? $(spans[1]).text().trim() : '';
        const title = titleEn || titleJp || $el.find('.entry-title, .title, .tt, h2, h3').first().text().trim();
        const img = $el.find('img').first().attr('src') || $el.find('img').first().attr('data-src');

        const slugMatch = link.match(/\/(anime|watch)\/([^/]+)\//);
        let slug = slugMatch ? slugMatch[2] || slugMatch[1] : '';
        slug = slug.replace(/-episode-\d+/, '').replace(/-movie/, '');

        if (slug && title && !results.some((r) => r.slug === slug)) {
          results.push({ slug, title, titleEn, titleJp, image: img });
        }
      });
    } catch (e) {}
  }

  cacheSet(cacheKey, results, 'episodes');
  return results;
}

/**
 * Fuzzy-find the closest DesiDub show slug
 */
export async function findDesidubSlug(title: string): Promise<string | null> {
  const cleanTitle = title.replace(/[’']s\b/gi, '').trim();
  const searchResults = await searchDesidub(cleanTitle);
  if (!searchResults.length) return null;

  let bestSlug: string | null = null;
  let bestScore = -1;

  for (const item of searchResults) {
    const scoreTitleEn = item.titleEn ? scoreTitle(cleanTitle, item.titleEn) : 0;
    const scoreTitleJp = item.titleJp ? scoreTitle(cleanTitle, item.titleJp) : 0;
    const scoreMain = scoreTitle(cleanTitle, item.title);
    const scoreSlug = scoreTitle(cleanTitle, item.slug.replace(/-/g, ' '));
    const score = Math.max(scoreTitleEn, scoreTitleJp, scoreMain, scoreSlug);

    if (score > bestScore) {
      bestScore = score;
      bestSlug = item.slug;
    }
  }

  return bestScore >= 40 ? bestSlug : searchResults[0].slug;
}

/**
 * Get episode list for an anime slug on DesiDubAnime
 */
export async function getDesidubEpisodes(slug: string): Promise<DesidubEpisode[]> {
  const cacheKey = `desidub:episodes:${slug}`;
  const cached = cacheGet<DesidubEpisode[]>(cacheKey);
  if (cached) return cached;

  const episodes: DesidubEpisode[] = [];

  try {
    const res = await http.get(`/anime/${slug}/`);
    const html = String(res.data);
    const $ = cheerio.load(html);

    // 1. Try static HTML lists
    $('.episodelist ul li, .eplister ul li, #episode_list li, .ep-item, #episodes-container a').each((_, el) => {
      const $el = $(el);
      const link = $el.attr('href') || $el.find('a').first().attr('href') || '';
      const epSlugMatch = link.match(/\/watch\/([^/]+)\//);
      const epSlug = epSlugMatch ? epSlugMatch[1] : '';
      const text = $el.text().trim();

      const numMatch = text.match(/Episode\s*(\d+(?:\.\d+)?)/i) || epSlug.match(/episode-(\d+(?:\.\d+)?)/i);
      const num = numMatch ? parseFloat(numMatch[1]) : episodes.length + 1;
      const title = text || `Episode ${num}`;

      if (epSlug && !episodes.some((e) => e.id === epSlug)) {
        episodes.push({ num, id: epSlug, title });
      }
    });

    // 2. If static list is empty, fetch via AJAX get_episodes
    if (episodes.length === 0) {
      let postId = $('input#comment_post_ID').val() as string;
      if (!postId) {
        const match = html.match(/postId\s*[:=]\s*["'](\d+)["']/i) ||
                      html.match(/showWatchlistModal\('#watchlist-(\d+)'\)/i) ||
                      html.match(/"postId"\s*:\s*"(\d+)"/i) ||
                      html.match(/data-season=["'](\d+)["']/i);
        if (match) postId = match[1];
      }

      if (postId) {
        const ajaxRes = await axios.get(`${BASE}/wp-admin/admin-ajax.php`, {
          params: {
            action: 'get_episodes',
            anime_id: postId,
            page: '1',
            order: 'asc',
          },
          headers: HEADERS,
          timeout: 10000,
        });

        if (ajaxRes.status === 200 && ajaxRes.data?.success && Array.isArray(ajaxRes.data.data?.episodes)) {
          for (const ep of ajaxRes.data.data.episodes) {
            const url = ep.url || '';
            const epSlugMatch = url.match(/\/watch\/([^/]+)\//);
            const epSlug = epSlugMatch ? epSlugMatch[1] : '';
            const num = parseFloat(String(ep.number).replace(/[^0-9.]/g, '')) || episodes.length + 1;
            const title = ep.title || ep.post_title || `Episode ${num}`;

            if (epSlug && !episodes.some((e) => e.id === epSlug)) {
              episodes.push({ num, id: epSlug, title });
            }
          }
        }
      }
    }

    // Sort ascending by episode number
    episodes.sort((a, b) => a.num - b.num);
  } catch (e) {
    console.error(`[desidub] Failed to fetch episodes for ${slug}:`, (e as Error).message);
  }

  if (episodes.length > 0) {
    cacheSet(cacheKey, episodes, 'episodes');
  }
  return episodes;
}

/**
 * Extract streaming servers from an episode watch page
 */
export async function getDesidubServers(episodeSlug: string): Promise<DesidubServer[]> {
  const cacheKey = `desidub:servers:${episodeSlug}`;
  const cached = cacheGet<DesidubServer[]>(cacheKey);
  if (cached) return cached;

  const servers: DesidubServer[] = [];

  try {
    const res = await http.get(`/watch/${episodeSlug}/`);
    const html = String(res.data);

    // Extract all data-embed-id attributes
    const embedIdMatches = html.match(/data-embed-id=["']([^"']+)["']/g) || [];

    for (const matchStr of embedIdMatches) {
      const embedId = matchStr.replace(/data-embed-id=["']/g, '').replace(/["']/g, '');
      if (!embedId || !embedId.includes(':')) continue;

      const [nameB64, urlB64] = embedId.split(':');
      const padName = nameB64 + '='.repeat((4 - (nameB64.length % 4)) % 4);
      const padUrl = urlB64 + '='.repeat((4 - (urlB64.length % 4)) % 4);

      const name = Buffer.from(padName, 'base64').toString('utf8').trim();
      let url = Buffer.from(padUrl, 'base64').toString('utf8').trim();

      if (url.includes('<iframe')) {
        const srcMatch = url.match(/src=['"]([^'"]+)['"]/i);
        if (srcMatch) url = srcMatch[1];
      }

      // Filter out dead/broken hosts (StreamP2P / p2pplay)
      const nameLow = name.toLowerCase();
      const urlLow = url.toLowerCase();
      if (nameLow.includes('streamp2p') || urlLow.includes('p2pplay.pro') || urlLow.includes('strp2p.site')) {
        continue;
      }

      // Classify Sub vs Dub & Dub Group
      // HLS Sources: VidMoly, StreamRuby, and Mirror / GDMirrorBot (which resolves to HLS sub-mirrors)
      // Embed-only non-HLS players (Abyss, CLOUD, PlayerX, Dood, StreamTape, etc.) are "raw".
      const isHlsCapable =
        urlLow.includes('vidmoly.') ||
        urlLow.includes('rubyvidhub.') ||
        urlLow.includes('streamruby.') ||
        urlLow.includes('rubystream.') ||
        urlLow.includes('gdmirrorbot.') ||
        urlLow.includes('smoothpre.') ||
        urlLow.includes('earnvids.') ||
        urlLow.includes('dramiyos-cdn.') ||
        urlLow.includes('rpmstream.') ||
        urlLow.includes('upns.');

      let type: 'sub' | 'dub' | 'raw';
      if (!isHlsCapable) {
        type = 'raw';
      } else {
        const isDub = nameLow.includes('dub');
        const isSub = nameLow.includes('sub') && !isDub;
        type = isDub ? 'dub' : isSub ? 'sub' : 'raw';
      }

      const groupMatch = name.match(/\(([^)]+)\)/);
      const dubGroup = groupMatch ? groupMatch[1] : undefined;

      servers.push({
        name,
        sourceId: url,
        type,
        dubGroup,
      });
    }
  } catch (e) {
    console.error(`[desidub] Failed to fetch servers for ${episodeSlug}:`, (e as Error).message);
  }

  if (servers.length > 0) {
    cacheSet(cacheKey, servers, 'episodes');
  }
  return servers;
}
