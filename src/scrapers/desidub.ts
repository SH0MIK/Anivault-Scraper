import * as cheerio from 'cheerio';
import axios from 'axios';
import https from 'https';
import crypto from 'crypto';
import * as vm from 'vm';
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
  'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
  'Accept-Language': 'en-US,en;q=0.9',
  'Referer': BASE + '/',
};

// ── Rate-limit guard ──
// desidub 429s per-IP, not per-slug: once it starts rate-limiting us, every
// other in-flight or subsequent request to the origin gets 429'd too — so
// retrying immediately (which happens naturally when several title-variant
// searches race, or a user's client retries a failed request) just keeps
// hammering an origin that's already told us to back off, and can turn a
// short-lived limit into a longer one. Track a single cooldown shared by
// every request to this origin (both the `http` client below and the
// handful of raw axios calls further down this file) so once we see a 429,
// everything backs off together instead of each call path retrying blind.
let desidubBackoffUntil = 0;

// Keep DesiDub requests serialized and spaced out. Their 429 limit is
// origin/IP-wide, so parallel title searches can trip it even when each
// individual request looks reasonable.
let desidubNextRequestAt = 0;
let desidubRequestQueue: Promise<void> = Promise.resolve();

function desidubCooldownError(): Error {
  const remaining = Math.max(1, Math.ceil((desidubBackoffUntil - Date.now()) / 1000));
  const err: any = new Error(`[desidub] in rate-limit cooldown for ~${remaining}s more, skipping request`);
  err.code = 'DESIDUB_COOLDOWN';
  return err;
}

function noteDesidubResponseError(err: any): void {
  const status = err?.response?.status;
  if (status !== 429) return;

  const retryAfterHeader = err.response.headers?.['retry-after'];
  const retryAfterSec = retryAfterHeader ? parseInt(String(retryAfterHeader), 10) : NaN;
  const cooldownMs = Number.isFinite(retryAfterSec)
    ? Math.max(retryAfterSec * 1000, 15_000)
    : 60_000;

  const until = Date.now() + cooldownMs;
  if (until > desidubBackoffUntil) {
    desidubBackoffUntil = until;
    console.error(`[desidub] rate-limited (429) — backing off ~${Math.round(cooldownMs / 1000)}s`);
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

http.interceptors.request.use((config) => {
  const scheduled = desidubRequestQueue.then(async () => {
    const now = Date.now();
    const waitUntil = Math.max(desidubBackoffUntil, desidubNextRequestAt);
    if (waitUntil > now) await sleep(waitUntil - now);

    // Reserve the next request slot before releasing the queue so concurrent
    // callers cannot all wake up and fire together.
    desidubNextRequestAt = Date.now() + 1200;
  });

  desidubRequestQueue = scheduled.catch(() => {});
  return scheduled.then(() => config);
});

http.interceptors.response.use(
  (res) => res,
  (err) => {
    noteDesidubResponseError(err);
    return Promise.reject(err);
  }
);

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

export interface DesidubQuality {
  label: string;
  url: string;
  bandwidth?: number;
  resolution?: string;
}

export interface DesidubAudioTrack {
  lang: string;
  name: string;
  url: string;
  default?: boolean;
}

export interface DesidubStream {
  embedUrl: string;
  m3u8: string | null;
  mp4?: string | null;
  referer?: string;
  subtitles: DesidubSubtitle[];
  qualities?: DesidubQuality[];
  audioTracks?: DesidubAudioTrack[];
  serverName: string;
  type: 'hls' | 'mp4' | 'iframe';
}

interface AbyssMp4ProxySource {
  type: 'abyss';
  embedUrl: string;
  md5Id: number;
  resId: number;
  size: number;
  label: string;
  codec: string;
  domain: string;
}

interface CloudJwConfig {
  file?: string;
  type?: string;
  tracks?: Array<{ kind?: string; file?: string; label?: string }>;
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

function decodeMaybeBase64(input: string, encoding: BufferEncoding = 'utf8'): string {
  const padded = input + '='.repeat((4 - (input.length % 4)) % 4);
  return Buffer.from(padded, 'base64').toString(encoding);
}

function cleanMediaUrl(url: string): string {
  return url
    .replace(/\\\//g, '/')
    .replace(/&amp;/g, '&')
    .trim();
}

function parseHlsAttributes(line: string): Record<string, string> {
  const attrs: Record<string, string> = {};
  const payload = line.slice(line.indexOf(':') + 1);
  for (const match of payload.matchAll(/([A-Z0-9-]+)=("[^"]*"|[^,]*)/gi)) {
    attrs[match[1].toUpperCase()] = match[2].replace(/^"|"$/g, '');
  }
  return attrs;
}

function parseDesidubHlsMaster(master: string, masterUrl: string): { qualities: DesidubQuality[]; audioTracks: DesidubAudioTrack[]; subtitles: DesidubSubtitle[] } {
  const lines = master.split(/\r?\n/);
  const qualities: DesidubQuality[] = [];
  const audioTracks: DesidubAudioTrack[] = [];
  const subtitles: DesidubSubtitle[] = [];

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i].trim();
    if (line.startsWith('#EXT-X-MEDIA') && /TYPE=AUDIO/i.test(line)) {
      const attrs = parseHlsAttributes(line);
      if (attrs.URI) {
        audioTracks.push({
          lang: (attrs.LANGUAGE || attrs.NAME || 'audio').toLowerCase(),
          name: attrs.NAME || attrs.LANGUAGE || 'Audio',
          url: cleanMediaUrl(new URL(attrs.URI, masterUrl).toString()),
          default: attrs.DEFAULT?.toUpperCase() === 'YES',
        });
      }
      continue;
    }

    if (line.startsWith('#EXT-X-MEDIA') && /TYPE=SUBTITLES/i.test(line)) {
      const attrs = parseHlsAttributes(line);
      if (attrs.URI) {
        subtitles.push({
          lang: attrs.NAME || attrs.LANGUAGE || 'Subtitle',
          url: cleanMediaUrl(new URL(attrs.URI, masterUrl).toString()),
          default: attrs.DEFAULT?.toUpperCase() === 'YES',
        });
      }
      continue;
    }

    if (line.startsWith('#EXT-X-STREAM-INF')) {
      const attrs = parseHlsAttributes(line);
      const nextUri = lines.slice(i + 1).find((candidate) => {
        const trimmed = candidate.trim();
        return trimmed && !trimmed.startsWith('#');
      })?.trim();
      if (!nextUri) continue;
      const bandwidth = attrs.BANDWIDTH ? parseInt(attrs.BANDWIDTH, 10) : undefined;
      const resolution = attrs.RESOLUTION;
      const height = resolution?.match(/x(\d+)$/)?.[1];
      qualities.push({
        label: height ? `${height}p` : bandwidth ? `${Math.round(bandwidth / 1000)}kbps` : 'Auto',
        url: cleanMediaUrl(new URL(nextUri, masterUrl).toString()),
        bandwidth: Number.isFinite(bandwidth) ? bandwidth : undefined,
        resolution,
      });
    }
  }

  return {
    qualities: Array.from(new Map(qualities.map((quality) => [quality.url, quality])).values()),
    audioTracks: Array.from(new Map(audioTracks.map((track) => [`${track.lang}:${track.url}`, track])).values()),
    subtitles: Array.from(new Map(subtitles.map((subtitle) => [subtitle.url, subtitle])).values()),
  };
}

async function enrichDesidubHlsOptions(m3u8: string | null, referer: string, subtitles: DesidubSubtitle[] = []): Promise<{ qualities: DesidubQuality[]; audioTracks: DesidubAudioTrack[]; subtitles: DesidubSubtitle[] }> {
  if (!m3u8) return { qualities: [], audioTracks: [], subtitles };
  try {
    const res = await axios.get(m3u8, {
      headers: {
        'User-Agent': HEADERS['User-Agent'],
        Accept: '*/*',
        Referer: referer,
      },
      timeout: 12000,
      responseType: 'text',
      transformResponse: [(data) => data],
    });
    const parsed = parseDesidubHlsMaster(String(res.data), m3u8);
    return {
      qualities: parsed.qualities,
      audioTracks: parsed.audioTracks,
      subtitles: Array.from(new Map([...subtitles, ...parsed.subtitles].map((subtitle) => [subtitle.url, subtitle])).values()),
    };
  } catch {
    return { qualities: [], audioTracks: [], subtitles };
  }
}

async function buildDesidubStream(base: {
  embedUrl: string;
  m3u8: string | null;
  mp4?: string | null;
  referer: string;
  subtitles?: DesidubSubtitle[];
  serverName: string;
}): Promise<DesidubStream> {
  const hlsOptions = await enrichDesidubHlsOptions(base.m3u8, base.referer, base.subtitles ?? []);
  return {
    embedUrl: base.embedUrl,
    m3u8: base.m3u8,
    mp4: base.mp4,
    referer: base.referer,
    subtitles: hlsOptions.subtitles,
    qualities: hlsOptions.qualities,
    audioTracks: hlsOptions.audioTracks,
    serverName: base.serverName,
    type: base.m3u8 ? 'hls' : base.mp4 ? 'mp4' : 'iframe',
  };
}

function isProbablyJson(text: string): boolean {
  const trimmed = text.trim();
  return trimmed.startsWith('{') || trimmed.startsWith('[');
}

function decryptAbyssMedia(media: string, userId: string, slug: string, md5Id: string): string {
  const keyMaterial = `${userId}:${slug}:${md5Id}`;
  const md5Hex = crypto.createHash('md5').update(keyMaterial).digest('hex');
  const mediaIsBase64 = /^[A-Za-z0-9+/=_-]+$/.test(media) && media.length % 4 !== 1;
  const cipherCandidates = [
    Buffer.from(media, 'latin1'),
    ...(mediaIsBase64 ? [Buffer.from(media + '='.repeat((4 - (media.length % 4)) % 4), 'base64')] : []),
  ];

  const attempts: { algorithm: string; key: Buffer; iv: Buffer }[] = [
    {
      algorithm: 'aes-128-ctr',
      key: Buffer.from(md5Hex, 'hex'),
      iv: Buffer.from(md5Hex, 'hex'),
    },
    {
      algorithm: 'aes-256-ctr',
      key: Buffer.from(md5Hex, 'utf8'),
      iv: Buffer.from(md5Hex.slice(0, 16), 'utf8'),
    },
    {
      algorithm: 'aes-256-ctr',
      key: Buffer.from(md5Hex, 'utf8'),
      iv: Buffer.from(md5Hex.slice(0, 32), 'hex'),
    },
  ];

  for (const cipherBytes of cipherCandidates) {
    for (const attempt of attempts) {
      try {
        const decipher = crypto.createDecipheriv(attempt.algorithm, attempt.key, attempt.iv);
        const decrypted = Buffer.concat([decipher.update(cipherBytes), decipher.final()]).toString('utf8');
        if (isProbablyJson(decrypted)) return decrypted;
      } catch {
        // Try the next known Abyss envelope variant.
      }
    }
  }

  return '';
}

function abyssNumericKey(value: number): string {
  const bytes = Buffer.from(String(value).split('').map((char) => /\d/.test(char) ? Number(char) : char.charCodeAt(0)));
  return crypto.createHash('md5').update(bytes).digest('hex');
}

export function createAbyssSegmentToken(path: string, size: number): string {
  const key = Buffer.from(abyssNumericKey(size), 'utf8');
  const cipher = crypto.createCipheriv('aes-256-ctr', key, key.subarray(0, 16));
  const encrypted = Buffer.concat([cipher.update(path, 'utf8'), cipher.final()]);
  const once = encrypted.toString('base64').replace(/=/g, '');
  return Buffer.from(once, 'utf8').toString('base64').replace(/=/g, '');
}

function encodeAbyssProxySource(source: AbyssMp4ProxySource): string {
  return `abyss://${Buffer.from(JSON.stringify(source), 'utf8').toString('base64url')}`;
}

export function decodeAbyssProxySource(url: string): AbyssMp4ProxySource | null {
  if (!url.startsWith('abyss://')) return null;
  try {
    const decoded = JSON.parse(Buffer.from(url.slice('abyss://'.length), 'base64url').toString('utf8'));
    if (decoded?.type !== 'abyss' || !decoded.domain || !decoded.size || !decoded.md5Id || !decoded.resId) return null;
    return decoded as AbyssMp4ProxySource;
  } catch {
    return null;
  }
}

function pickAbyssMp4(mediaData: any, embedUrl: string, md5Id: number): string | null {
  const sources = Array.isArray(mediaData?.mp4?.sources) ? mediaData.mp4.sources : [];
  const domains = Array.isArray(mediaData?.mp4?.domains) ? mediaData.mp4.domains.filter((d: any) => typeof d === 'string') : [];
  if (!sources.length || !domains.length) return null;

  const baseDomain = String(domains[0]).split('.').slice(1).join('.');
  const playable = sources
    .filter((s: any) => s?.status !== false && s?.size && s?.res_id && s?.sub)
    .map((s: any) => ({
      source: s,
      height: parseInt(String(s.label || '').replace(/\D/g, ''), 10) || 0,
      h264: String(s.codec || '').toLowerCase().includes('h264'),
    }))
    .sort((a: any, b: any) => Number(b.h264) - Number(a.h264) || b.height - a.height);

  const best = playable[0]?.source;
  if (!best || !baseDomain) return null;

  return encodeAbyssProxySource({
    type: 'abyss',
    embedUrl,
    md5Id,
    resId: Number(best.res_id),
    size: Number(best.size),
    label: String(best.label || 'mp4'),
    codec: String(best.codec || 'h264'),
    domain: `${best.sub}.${baseDomain}`,
  });
}

async function getTextWithRetry(url: string, options: any, retries = 1): Promise<string> {
  let lastError: unknown;
  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      const res = await axios.get(url, {
        ...options,
        responseType: 'text',
        transformResponse: [(data) => data],
        validateStatus: (status) => status >= 200 && status < 400,
      });
      return String(res.data);
    } catch (e) {
      lastError = e;
    }
  }
  throw lastError;
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

function extractCloudJwConfig(html: string, playUrl: string): CloudJwConfig | null {
  const scripts = [...html.matchAll(/<script\b([^>]*)>([\s\S]*?)<\/script>/gi)]
    .map((match) => match[2])
    .filter((script) => script.includes('jwplayer'))
    .sort((a, b) => b.length - a.length);

  const makeElement = (): any => ({
    style: {},
    classList: { add() {}, remove() {} },
    setAttribute() {},
    getAttribute() { return ''; },
    addEventListener() {},
    appendChild() {},
    removeChild() {},
    remove() {},
    click() {},
    querySelector() { return makeElement(); },
    querySelectorAll() { return []; },
    cloneNode() { return makeElement(); },
    parentNode: { replaceChild() {} },
  });

  for (const script of scripts) {
    const sandbox: any = {
      captured: null,
      location: { href: playUrl, reload() {} },
      document: {
        getElementById() { return makeElement(); },
        createElement() { return makeElement(); },
        querySelector() { return makeElement(); },
        querySelectorAll() { return []; },
        body: { appendChild() {}, removeChild() {} },
      },
      console: { log() {}, warn() {}, error() {}, info() {}, debug() {}, trace() {} },
      setInterval() { return 1; },
      clearInterval() {},
      setTimeout() { return 1; },
      clearTimeout() {},
      jwplayer() {
        const player = {
          setup: (config: CloudJwConfig) => {
            sandbox.captured = config;
            throw new Error('CLOUD_JW_CAPTURED');
          },
          on() { return player; },
          addButton() { return player; },
          getContainer() { return makeElement(); },
          getPlaylistItem() { return sandbox.captured || {}; },
        };
        return player;
      },
      playerInstance: null,
    };
    sandbox.window = sandbox;
    sandbox.self = sandbox;
    sandbox.global = sandbox;
    sandbox.globalThis = sandbox;
    sandbox.playerInstance = sandbox.jwplayer('vplayer');

    try {
      vm.runInNewContext(script, sandbox, { timeout: 8000 });
    } catch (e) {
      if ((e as Error).message !== 'CLOUD_JW_CAPTURED') continue;
    }

    if (sandbox.captured?.file) return sandbox.captured as CloudJwConfig;
  }

  return null;
}

function addCloudTrackSubtitles(config: CloudJwConfig | null, playUrl: string, subtitles: DesidubSubtitle[]): DesidubSubtitle[] {
  for (const track of config?.tracks ?? []) {
    if (!track?.file || (track.kind && !['captions', 'subtitles'].includes(track.kind))) continue;
    const url = cleanMediaUrl(new URL(track.file, playUrl).toString());
    if (subtitles.some((sub) => sub.url === url)) continue;

    subtitles.push({
      lang: track.label || 'English',
      url,
      default: (track.label || '').toLowerCase().includes('en'),
    });
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
export async function resolveAbyss(embedUrl: string): Promise<{ m3u8: string | null; mp4?: string | null; subtitles: DesidubSubtitle[]; referer: string } | null> {
  try {
    const res = await axios.get(embedUrl, {
      headers: { ...HEADERS, Referer: BASE + '/' },
      timeout: 12000,
    });
    if (res.status !== 200) return null;

    const html = String(res.data);
    const datasMatch = html.match(/const datas\s*=\s*"([^"]+)"/);
    if (!datasMatch) return null;

    const decodedStr = decodeMaybeBase64(datasMatch[1], 'latin1');
    const payload = JSON.parse(decodedStr);
    const { user_id, slug, md5_id, media } = payload;
    if (!user_id || !slug || !md5_id || !media) return null;

    const decryptedStr = decryptAbyssMedia(String(media), String(user_id), String(slug), String(md5_id));
    if (!decryptedStr) {
      console.warn('[abyss] AES-CTR decryption produced no JSON — key/payload mismatch?');
      return null;
    }

    let mediaData: any;
    try {
      mediaData = JSON.parse(decryptedStr);
    } catch {
      console.warn('[abyss] Decrypted payload is not valid JSON:', decryptedStr.slice(0, 120));
      return null;
    }

    // Abyss currently serves either HLS-shaped payloads or MP4 chunk metadata.
    // The latter is playable by the iframe only, so return null m3u8 gracefully.
    const candidates: string[] = [];

    // Shape 1: top-level hls array (most common on abyss.to)
    if (Array.isArray(mediaData.hls)) {
      candidates.push(...mediaData.hls.filter((s: any) => typeof s === 'string').map(cleanMediaUrl));
    }
    // Shape 2: sources array of objects { file } or raw strings
    if (Array.isArray(mediaData.sources)) {
      for (const src of mediaData.sources) {
        if (typeof src === 'string') candidates.push(cleanMediaUrl(src));
        else if (src?.file) candidates.push(cleanMediaUrl(String(src.file)));
      }
    }
    // Shape 3: flat string fields (older embeds)
    if (typeof mediaData.file === 'string') candidates.push(cleanMediaUrl(mediaData.file));
    if (typeof mediaData.url === 'string') candidates.push(cleanMediaUrl(mediaData.url));
    if (typeof mediaData?.mp4?.url === 'string') candidates.push(cleanMediaUrl(mediaData.mp4.url));
    if (Array.isArray(mediaData?.mp4?.fristDatas)) {
      for (const src of mediaData.mp4.fristDatas) {
        if (typeof src?.url === 'string') candidates.push(cleanMediaUrl(src.url));
      }
    }

    const m3u8 = candidates.find((s) => s.includes('.m3u8')) || null;
    const mp4 = m3u8 ? null : pickAbyssMp4(mediaData, embedUrl, Number(md5_id));

    // Extract subtitle tracks from tracks[]
    const subtitles: DesidubSubtitle[] = [];
    if (Array.isArray(mediaData.tracks)) {
      for (const t of mediaData.tracks) {
        if (t?.kind === 'captions' || t?.kind === 'subtitles') {
          const url = t.file || t.src || '';
          const label: string = t.label || 'English';
          if (url && !subtitles.some((s) => s.url === url)) {
            subtitles.push({ lang: label, url: cleanMediaUrl(String(url)), default: label.toLowerCase().includes('eng') });
          }
        }
      }
    }

    return { m3u8, mp4, subtitles, referer: embedUrl };
  } catch (e) {
    console.warn('[abyss] resolveAbyss failed:', (e as Error).message);
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

        // Validate that m3u8 is actually reachable upstream (RPMStream proxy often returns 502/timeout/403)
        if (m3u8) {
          try {
            const probeRes = await axios.get(m3u8, {
              headers: {
                'User-Agent': HEADERS['User-Agent'],
                'Referer': `https://${domain}/#${videoId}`,
              },
              timeout: 4000,
              validateStatus: (status) => status === 200,
            });
            if (probeRes.status === 200 && typeof probeRes.data === 'string' && probeRes.data.includes('#EXTM3U')) {
              return {
                m3u8,
                subtitles,
                referer: `https://${domain}/#${videoId}`,
              };
            }
          } catch {
            // Upstream proxy failed/502/timed out - do not return unplayable stream
          }
        }

        return {
          m3u8: null,
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

      // Priority 1: VidMoly (Direct HLS - most reliable)
      for (const mirror of subMirrors) {
        if (mirror.key === 'vidmoly') {
          const stream = await resolveVidmoly(mirror.url);
          if (stream?.m3u8) return stream;
        }
      }

      // Priority 2: StreamRuby
      for (const mirror of subMirrors) {
        if (mirror.key === 'ruby' || mirror.key === 'streamruby') {
          const stream = await resolveStreamRuby(mirror.url);
          if (stream?.m3u8) return stream;
        }
      }

      // Priority 3: EarnVids (dramiyos-cdn m3u8)
      for (const mirror of subMirrors) {
        if (mirror.key === 'flls' || mirror.key === 'earnvids') {
          const stream = await resolveEarnVids(mirror.url);
          if (stream?.m3u8) return stream;
        }
      }

      // Priority 4: RPMStream / UPNShare (Validated HLS)
      for (const mirror of subMirrors) {
        if (mirror.key === 'rpmshre' || mirror.key === 'upnshr') {
          const stream = await resolveP2PPlay(mirror.url);
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
    return buildDesidubStream({
      embedUrl,
      m3u8: res?.m3u8 ?? null,
      referer: res?.referer ?? embedUrl,
      subtitles: res?.subtitles ?? [],
      serverName: 'VidMoly',
    });
  }

  if (embedUrl.includes('rubyvidhub.') || embedUrl.includes('streamruby.') || embedUrl.includes('rubystream.')) {
    const res = await resolveStreamRuby(embedUrl);
    return buildDesidubStream({
      embedUrl,
      m3u8: res?.m3u8 ?? null,
      referer: res?.referer ?? embedUrl,
      subtitles: res?.subtitles ?? [],
      serverName: 'StreamRuby',
    });
  }

  if (embedUrl.includes('smoothpre.') || embedUrl.includes('earnvids.') || embedUrl.includes('dramiyos-cdn.')) {
    const res = await resolveEarnVids(embedUrl);
    return buildDesidubStream({
      embedUrl,
      m3u8: res?.m3u8 ?? null,
      referer: res?.referer ?? 'https://gdmirrorbot.nl/',
      subtitles: res?.subtitles ?? [],
      serverName: 'EarnVids',
    });
  }

  if (embedUrl.includes('rpmstream.') || embedUrl.includes('upns.') || embedUrl.includes('strp2p.')) {
    const res = await resolveP2PPlay(embedUrl);
    return buildDesidubStream({
      embedUrl,
      m3u8: res?.m3u8 ?? null,
      referer: res?.referer ?? embedUrl,
      subtitles: res?.subtitles ?? [],
      serverName: 'RPMStream',
    });
  }

  if (embedUrl.includes('gdmirrorbot.')) {
    const res = await resolveGdMirrorBot(embedUrl);
    return buildDesidubStream({
      embedUrl,
      m3u8: res?.m3u8 ?? null,
      referer: res?.referer ?? 'https://gdmirrorbot.nl/',
      subtitles: res?.subtitles ?? [],
      serverName: 'Mirror',
    });
  }

  if (embedUrl.includes('abyssplayer.com') || embedUrl.includes('abyss.to')) {
    const res = await resolveAbyss(embedUrl);
    return buildDesidubStream({
      embedUrl,
      m3u8: res?.m3u8 ?? null,
      mp4: res?.mp4 ?? null,
      referer: res?.referer ?? embedUrl,
      subtitles: res?.subtitles ?? [],
      serverName: 'Abyss',
    });
  }

  if (embedUrl.includes('cloud.desidubanime.me')) {
    try {
      // Step 1: If it's an /external/ page, follow through to find the /play/ URL
      let playUrl = embedUrl;
      const cloudHeaders = {
        ...HEADERS,
        'Referer': embedUrl.includes('/external/') ? 'https://www.desidubanime.me/' : 'https://cloud.desidubanime.me/',
        'Origin': 'https://cloud.desidubanime.me',
        'Cache-Control': 'no-cache',
        'Pragma': 'no-cache',
      };
      if (embedUrl.includes('/external/')) {
        const extHtml = await getTextWithRetry(embedUrl, {
          headers: cloudHeaders,
          timeout: 40000,
        }, 2);
        const playMatch =
          extHtml.match(/src=['"](\/play\/[^'"]+)['"]/i) ||
          extHtml.match(/src=['"](https?:\/\/cloud\.desidubanime\.me\/play\/[^'"]+)['"]/i) ||
          extHtml.match(/"url"\s*:\s*"(\/play\/[^"]+)"/i) ||
          extHtml.match(/href=['"](\/play\/[^'"]+)['"]/i);
        if (playMatch) {
          playUrl = playMatch[1].startsWith('http')
            ? playMatch[1]
            : `https://cloud.desidubanime.me${playMatch[1]}`;
        }
      }

      // Step 2: Fetch the /play/ page and extract the m3u8
      const playHtml = await getTextWithRetry(playUrl, {
        headers: {
          ...HEADERS,
          'Referer': 'https://cloud.desidubanime.me/',
          'Origin': 'https://cloud.desidubanime.me',
        },
        timeout: 40000,
      }, 2);

      const cloudConfig = extractCloudJwConfig(playHtml, playUrl);

      // Try packed JS first, then raw HTML
      const unpacked = unpackPacked(playHtml);
      const text = cleanMediaUrl(unpacked || playHtml);

      // Match m3u8 URL from JWPlayer/VideoJS config or any quoted URL
      const fileMatch =
        text.match(/['"](https?:\/\/[^'"]+\.m3u8[^'"]*)['"]/i) ||
        text.match(/file\s*:\s*['"](https?:\/\/[^'"]+\.m3u8[^'"]*)['"]/i) ||
        text.match(/source\s*:\s*['"](https?:\/\/[^'"]+\.m3u8[^'"]*)['"]/i) ||
        text.match(/src\s*:\s*['"](https?:\/\/[^'"]+\.m3u8[^'"]*)['"]/i);

      const jwFile = typeof cloudConfig?.file === 'string'
        ? cleanMediaUrl(new URL(cloudConfig.file, playUrl).toString())
        : null;
      const m3u8 = fileMatch ? cleanMediaUrl(fileMatch[1]) : jwFile;
      const subtitles = addCloudTrackSubtitles(cloudConfig, playUrl, extractSubtitlesFromText(text));

      return buildDesidubStream({
        embedUrl: playUrl,
        m3u8,
        referer: playUrl,
        subtitles,
        serverName: 'Cloud',
      });
    } catch (e) {
      console.warn('[cloud] resolveCloud failed:', (e as Error).message);
      return {
        embedUrl,
        m3u8: null,
        referer: 'https://cloud.desidubanime.me/',
        subtitles: [],
        serverName: 'Cloud',
        type: 'iframe',
      };
    }
  }


  // Fallback: direct m3u8 scan
  try {
    const res = await axios.get(embedUrl, { headers: HEADERS, timeout: 10000 });
    const html = String(res.data);
    const unpacked = unpackPacked(html);
    const text = unpacked || html;
    const m3u8Match = text.match(/(https?:\/\/[^\s"']+\.m3u8[^\s"']*)/i);
    const subtitles = extractSubtitlesFromText(text);

    return buildDesidubStream({
      embedUrl,
      m3u8: m3u8Match ? m3u8Match[1] : null,
      referer: embedUrl,
      subtitles,
      serverName: 'Direct',
    });
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

let cachedSearchNonce: string | null = null;
let searchNonceExpiry = 0;

async function getDesidubSearchNonce(): Promise<string> {
  const now = Date.now();
  if (cachedSearchNonce && now < searchNonceExpiry) {
    return cachedSearchNonce;
  }
  try {
    const res = await http.get('/', {
      headers: HEADERS,
      timeout: 8000,
    });
    const match = String(res.data).match(/"search_actions":\s*"([a-f0-9]+)"/i) ||
                  String(res.data).match(/nonce['"]?\s*:\s*['"]([a-f0-9]+)['"]/i);
    if (match) {
      cachedSearchNonce = match[1];
      searchNonceExpiry = now + 12 * 60 * 60 * 1000;
      return cachedSearchNonce;
    }
  } catch (e) {
    // fallback
  }
  return cachedSearchNonce || '248d7f7bcc';
}

function addsUnrequestedTypeIndicator(query: string, candidateTitle: string): boolean {
  const queryWords = new Set(significantWords(query));
  const candidateWords = significantWords(candidateTitle);
  const hasSeason1 = /\bseason\s*0?1\b|\b1st\s*season\b/i.test(candidateTitle);
  if (hasSeason1 && !queryWords.has('season')) {
    return false;
  }
  return candidateWords.some((w) => TYPE_INDICATOR_WORDS.has(w) && !queryWords.has(w));
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

function desidubSearchVariants(title: string): string[] {
  const cleanTitle = title.replace(/[’']s\b/gi, '').trim();
  const withoutTrailingSubtitle = cleanTitle
    .replace(/\s*-\s*[^-:]+$/g, '')
    .replace(/\s*:\s*[^:]+$/g, '')
    .trim();
  const finalSeasonBase = cleanTitle.replace(/\bfinal\s+season(?:\s+part\s+\d+)?\b/gi, '').replace(/\s+/g, ' ').trim();
  const seasonStripped = cleanTitle
    .replace(/\bseason\s*\d+(?:\s*[-:]?\s*part\s*\d+)?\b/gi, '')
    .replace(/\bpart\s*\d+\b/gi, '')
    .replace(/\s+/g, ' ')
    .trim();
  const seasonOnly = cleanTitle.match(/^(.+?\bseason\s*\d+)/i)?.[1]?.trim();
  const firstWords = withoutTrailingSubtitle.split(/\s+/).slice(0, 5).join(' ');
  const firstWordsShort = withoutTrailingSubtitle.split(/\s+/).slice(0, 3).join(' ');

  return Array.from(new Set([
    cleanTitle,
    withoutTrailingSubtitle,
    seasonOnly,
    seasonStripped,
    finalSeasonBase,
    firstWords,
    firstWordsShort,
  ].filter((value): value is string => Boolean(value && value.length >= 3))));
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

  // 1. Try Instant Search API (action=instant_search with nonce)
  try {
    let nonce = await getDesidubSearchNonce();
    let res = await http.get('/wp-admin/admin-ajax.php', {
      params: {
        action: 'instant_search',
        query,
        nonce,
      },
      headers: {
        ...HEADERS,
        'X-Requested-With': 'XMLHttpRequest',
      },
      timeout: 10000,
      validateStatus: (status) => status < 500,
    });

    if (res.status === 403 || res.data === -1 || res.data === '-1') {
      cachedSearchNonce = null;
      nonce = await getDesidubSearchNonce();
      res = await http.get('/wp-admin/admin-ajax.php', {
        params: {
          action: 'instant_search',
          query,
          nonce,
        },
        headers: {
          ...HEADERS,
          'X-Requested-With': 'XMLHttpRequest',
        },
        timeout: 10000,
      });
    }

    const html = res.data?.data?.html || (typeof res.data?.html === 'string' ? res.data.html : '');
    if (html) {
      const $ = cheerio.load(html);
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
    // Fall back to advanced_search
  }

  // 2. Fallback: advanced_search POST
  if (results.length === 0) {
    try {
      const nonce = await getDesidubSearchNonce();
      const params = new URLSearchParams();
      params.append('action', 'advanced_search');
      params.append('s_keyword', query);
      params.append('nonce', nonce);

      const res = await axios.post(`${BASE}/wp-admin/admin-ajax.php`, params.toString(), {
        headers: {
          ...HEADERS,
          'Content-Type': 'application/x-www-form-urlencoded; charset=UTF-8',
          'X-Requested-With': 'XMLHttpRequest',
        },
        timeout: 10000,
      });

      const html = res.data?.data?.html || (typeof res.data?.data === 'string' ? res.data.data : '');
      if (html) {
        const $ = cheerio.load(html);
        $('article, .anime-card').each((_, el) => {
          const $el = $(el);
          const ldJson = $el.find('script[type="application/ld+json"]').html();
          let animeSlug = '';
          let animeTitle = '';
          if (ldJson) {
            try {
              const parsed = JSON.parse(ldJson);
              if (parsed.url) {
                const match = parsed.url.match(/\/anime\/([^/]+)\//);
                if (match) animeSlug = match[1];
              }
              if (parsed.name) animeTitle = parsed.name;
            } catch {}
          }

          const link = $el.find('a[href*="/anime/"], a[href*="/watch/"]').first().attr('href') || '';
          if (!animeSlug) {
            const slugMatch = link.match(/\/(anime|watch)\/([^/]+)\//);
            animeSlug = slugMatch ? slugMatch[2] || slugMatch[1] : '';
            animeSlug = animeSlug.replace(/-episode-\d+/, '').replace(/-movie/, '');
          }

          const spans = $el.find('h3 span, .title span').toArray();
          const titleEn = spans[0] ? $(spans[0]).text().trim() : '';
          const titleJp = spans[1] ? $(spans[1]).text().trim() : '';
          const title = animeTitle || titleEn || titleJp || $el.find('.entry-title, .title, h3, h2').first().text().trim();
          const img = $el.find('img').first().attr('src') || $el.find('img').first().attr('data-src');

          if (animeSlug && title && !results.some((r) => r.slug === animeSlug)) {
            results.push({ slug: animeSlug, title, titleEn, titleJp, image: img });
          }
        });
      }
    } catch (e) {}
  }

  // 3. Fallback: standard search page
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

  // Sequential with early-exit on a strong match, rather than firing every
  // variant in parallel — a burst of simultaneous requests is exactly what
  // trips desidub's rate limit (see the backoff guard above), and most
  // titles resolve on the first variant anyway.
  const allResults: DesidubSearchResult[] = [];
  for (const variant of desidubSearchVariants(cleanTitle)) {
    const results = await searchDesidub(variant).catch(() => []);
    allResults.push(...results);
    if (results.some((r) => scoreTitle(cleanTitle, r.titleEn || r.title) >= 80)) break;
  }
  const searchResults = allResults.filter((item, index, all) => all.findIndex((candidate) => candidate.slug === item.slug) === index);

  // DesiDub search can intermittently return no usable results even when the
  // anime page still exists. Try the site's conventional title slug as a
  // lightweight fallback before giving up, so /watch does not silently 404.
  if (!searchResults.length) {
    const candidates = Array.from(new Set([
      cleanTitle
        .toLowerCase()
        .normalize('NFKD')
        .replace(/[\u0300-\u036f]/g, '')
        .replace(/&/g, ' and ')
        .replace(/[^a-z0-9]+/g, '-')
        .replace(/^-+|-+$/g, ''),
      cleanTitle
        .toLowerCase()
        .replace(/\b(season|part)\s+\d+\b/gi, '')
        .replace(/[^a-z0-9]+/g, '-')
        .replace(/^-+|-+$/g, ''),
    ].filter(Boolean)));

    for (const candidate of candidates) {
      try {
        const res = await http.get(`/anime/${candidate}/`, {
          headers: HEADERS,
          timeout: 8000,
          validateStatus: (status) => status < 500,
        });
        if (res.status === 200) return candidate;
      } catch {}
    }
    return null;
  }

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

  return bestScore >= 50 ? bestSlug : null;
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
    let res: any;
    let lastError: unknown = null;
    for (let attempt = 1; attempt <= 3; attempt++) {
      try {
        res = await http.get(`/anime/${slug}/`, {
          headers: HEADERS,
          timeout: 12000,
          validateStatus: (status) => status < 500,
        });
        if (res.status === 200) break;
        lastError = new Error(`DesiDub returned HTTP ${res.status}`);
      } catch (err) {
        lastError = err;
      }
      if (attempt < 3) await sleep(700 * attempt);
    }
    // A search result can occasionally contain a stale/alternate slug. If the
    // chosen slug is genuinely 404, search DesiDub again using the slug words
    // and try the closest alternate result before failing the episode request.
    if (!res || res.status === 404) {
      const query = slug.replace(/-/g, ' ').replace(/\\b(?:season|part)\\s*\\d+\\b/gi, '').trim();
      if (query) {
        const alternates = await searchDesidub(query).catch(() => []);
        const ranked = alternates
          .filter((item) => item.slug && item.slug !== slug)
          .map((item) => ({
            item,
            score: Math.max(
              scoreTitle(query, item.titleEn || ''),
              scoreTitle(query, item.titleJp || ''),
              scoreTitle(query, item.title || ''),
              scoreTitle(query, item.slug.replace(/-/g, ' '))
            ),
          }))
          .filter((candidate) => candidate.score >= 50)
          .sort((a, b) => b.score - a.score);

        for (const candidate of ranked.slice(0, 3)) {
          try {
            const retryRes = await http.get(`/anime/${candidate.item.slug}/`, {
              headers: HEADERS,
              timeout: 12000,
              validateStatus: (status) => status < 500,
            });
            if (retryRes.status === 200) {
              res = retryRes;
              console.log(`[desidub] Recovered stale slug ${slug} -> ${candidate.item.slug}`);
              break;
            }
          } catch {
            // Try the next alternate result.
          }
        }
      }
    }

    if (!res || res.status !== 200) {
      throw lastError || new Error(`DesiDub returned HTTP ${res?.status ?? 'unknown'}`);
    }
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
      let postId = ($('#seasonContent').attr('data-season') || $('button[data-season].bg-accent-2').attr('data-season') || $('input#comment_post_ID').val()) as string;
      if (!postId) {
        const match = html.match(/postId\s*[:=]\s*["'](\d+)["']/i) ||
                      html.match(/showWatchlistModal\('#watchlist-(\d+)'\)/i) ||
                      html.match(/id=["']seasonContent["'][^>]*data-season=["'](\d+)["']/i) ||
                      html.match(/"postId"\s*:\s*"(\d+)"/i) ||
                      html.match(/data-season=["'](\d+)["']/i);
        if (match) postId = match[1];
      }

      if (postId) {
        let page = 1;
        let maxPage = 1;
        do {
          if (page > 1) await sleep(350); // avoid bursting the origin on shows with many episode pages
          const ajaxRes = await http.get('/wp-admin/admin-ajax.php', {
            params: {
              action: 'get_episodes',
              anime_id: postId,
              page: String(page),
              order: 'asc',
            },
            headers: HEADERS,
            timeout: 10000,
          });

          if (ajaxRes.status === 200 && ajaxRes.data?.success && Array.isArray(ajaxRes.data.data?.episodes)) {
            maxPage = parseInt(String(ajaxRes.data.data.max_episodes_page || maxPage), 10) || maxPage;
            for (const ep of ajaxRes.data.data.episodes) {
              const url = ep.url || '';
              const epSlugMatch = url.match(/\/watch\/([^/]+)\//);
              const epSlug = epSlugMatch ? epSlugMatch[1] : '';
              const num = parseFloat(String(ep.meta_number || ep.number).replace(/[^0-9.]/g, '')) || episodes.length + 1;
              const title = ep.title || ep.post_title || `Episode ${num}`;

              if (epSlug && !episodes.some((e) => e.id === epSlug)) {
                episodes.push({ num, id: epSlug, title });
              }
            }
          } else {
            break;
          }
          page++;
        } while (page <= maxPage && page <= 20);
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

      // Classify by the site-provided server label so strict server tests work
      // even for iframe-first hosts like Abyss/Cloud.
      let type: 'sub' | 'dub' | 'raw';
      const isDub = nameLow.includes('dub') || nameLow === 'cloud' || urlLow.includes('cloud.desidubanime.me');
      const isSub = nameLow.includes('sub') && !isDub;
      type = isDub ? 'dub' : isSub ? 'sub' : 'raw';

      const groupMatch = name.match(/\(([^)]+)\)/);
      const dubGroup = groupMatch ? groupMatch[1] : undefined;

      servers.push({
        name,
        sourceId: url,
        type,
        dubGroup,
      });
    }

    // Sort servers to prioritize direct, reliable HLS providers (VidMoly, StreamRuby)
    // before multi-mirrors (Mirror/GDMirrorBot) and raw iframe players
    servers.sort((a, b) => {
      const rank = (name: string, url: string) => {
        const n = name.toLowerCase();
        const u = url.toLowerCase();
        if (n.includes('vmoly') || n.includes('vidmoly') || u.includes('vidmoly.')) return 1;
        if (n.includes('ruby') || u.includes('ruby')) return 2;
        if (n.includes('earn') || u.includes('earn')) return 3;
        if (n.includes('mirror') || u.includes('gdmirrorbot.')) return 4;
        return 5;
      };
      return rank(a.name, a.sourceId) - rank(b.name, b.sourceId);
    });
  } catch (e) {
    console.error(`[desidub] Failed to fetch servers for ${episodeSlug}:`, (e as Error).message);
  }

  if (servers.length > 0) {
    cacheSet(cacheKey, servers, 'episodes');
  }
  return servers;
}
