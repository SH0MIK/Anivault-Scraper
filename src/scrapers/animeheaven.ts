import * as cheerio from 'cheerio';
import { makeClient } from '../utils/fetch';
import { cacheGet, cacheSet } from '../utils/cache';

const BASE = 'https://animeheaven.me';
// AnimeHeaven is NOT behind Cloudflare — no FlareSolverr needed, so we skip it
// entirely (leaving useFlareSolverr at its default `false`). This avoids
// paying for a slow FlareSolverr instance on every AnimeHeaven request.
const http = makeClient(BASE, BASE + '/');

// AnimeHeaven's gate endpoint can be session-bound. Axios does not persist
// Set-Cookie headers by itself, so keep the site's first-party cookies and
// send them back when requesting gate.php. The episode key cookie is added
// separately per stream request.
let heavenCookies = '';

function captureHeavenCookies(response: any): void {
  const setCookie = response?.headers?.['set-cookie'];
  if (!Array.isArray(setCookie)) return;

  const jar = new Map<string, string>();
  for (const cookie of heavenCookies.split(';')) {
    const [name, ...rest] = cookie.trim().split('=');
    if (name && rest.length) jar.set(name, rest.join('='));
  }
  for (const raw of setCookie) {
    const pair = String(raw).split(';', 1)[0]?.trim();
    if (!pair) continue;
    const [name, ...rest] = pair.split('=');
    if (name && rest.length) jar.set(name.trim(), rest.join('='));
  }
  heavenCookies = Array.from(jar.entries()).map(([name, value]) => `${name}=${value}`).join('; ');
}

function heavenCookieHeader(key?: string): string {
  const jar = new Map<string, string>();
  for (const cookie of heavenCookies.split(';')) {
    const value = cookie.trim();
    if (!value) continue;
    const index = value.indexOf('=');
    if (index <= 0) continue;
    jar.set(value.slice(0, index), value.slice(index + 1));
  }
  if (key) jar.set('key', key);
  return Array.from(jar.entries()).map(([name, value]) => `${name}=${value}`).join('; ');
}

export interface HeavenSearchResult {
  id: string;
  title: string;
  url: string;
  image?: string;
}

export interface HeavenEpisode {
  id: string;
  num: number;
  title: string;
}

export interface HeavenServer {
  name: string;
  sourceId: string;
  type: 'sub';
}

export interface HeavenStream {
  embedUrl: string;
  streamUrl: string;
  mp4: string;
  m3u8: null;
  type: 'mp4';
  servers: string[];
}

function absoluteUrl(url: string): string {
  return new URL(url, BASE).toString();
}

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

// See anikoto.ts's copy of this same fix for the full rationale: a
// candidate that only differs from the query by an OVA/special/movie/etc.
// marker, OR by an unrequested season/part/cour marker, is a different
// release, not the main entry, even though it scores well on prefix/ratio
// alone.
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
  if (hay === needle) return 100;

  // Length ratio guards against a short/truncated candidate (e.g. "Demon
  // Slayer") getting high confidence against a much longer query (e.g.
  // "Demon Slayer: Infinity Castle") just because one is a prefix of the
  // other. Without this, truncated search variants match the wrong title.
  const ratio = Math.min(needle.length, hay.length) / Math.max(needle.length, hay.length);

  // Direction matters too. If the QUERY is the longer string and the
  // candidate is only a prefix/substring of it, the candidate is likely
  // the generic franchise/series page missing a distinguishing subtitle
  // (a movie title like "Infinity Castle", "Heroes Rising", etc.) — i.e.
  // probably the wrong entry. A ratio check alone doesn't catch this when
  // the shared franchise name itself is long (e.g. "Demon Slayer: Kimetsu
  // no Yaiba" is a genuine prefix of the movie's full title with ratio
  // ~0.6). If the CANDIDATE is the longer string, the extra text is
  // usually just a season/part suffix tacked onto the full query, which
  // is safe and shouldn't be penalized.
  const queryIsLonger = needle.length > hay.length;
  const missingWords = queryIsLonger
    ? significantWords(query).length - significantWords(title).length
    : 0;

  // Candidate is the longer string here -- if the extra text it adds over
  // the query is an OVA/special/movie/etc. marker (e.g. query "Attack on
  // Titan" vs candidate "Attack on Titan OVA"), it's a near-miss, not a
  // match, same as the missingWords penalty below.
  const candidateAddsSpinoffMarker = !queryIsLonger && addsUnrequestedTypeIndicator(query, title);

  if (hay.startsWith(needle) || needle.startsWith(hay)) {
    if (queryIsLonger && missingWords >= 2) return Math.floor(ratio * 30);
    if (candidateAddsSpinoffMarker) return Math.floor(ratio * 30);
    return ratio >= 0.6 ? 80 : Math.floor(ratio * 60);
  }
  if (hay.includes(needle) || needle.includes(hay)) {
    if (queryIsLonger && missingWords >= 2) return Math.floor(ratio * 25);
    if (candidateAddsSpinoffMarker) return Math.floor(ratio * 25);
    return ratio >= 0.6 ? 60 : Math.floor(ratio * 45);
  }
  let matches = 0;
  for (const ch of needle) if (hay.includes(ch)) matches++;
  return Math.floor((matches / Math.max(needle.length, 1)) * 40);
}

export async function searchAnimeHeaven(query: string): Promise<HeavenSearchResult[]> {
  const cacheKey = `heaven:search:${query.toLowerCase().trim()}`;
  console.error(`[AnimeHeaven] search start: ${query}`);
  const cached = cacheGet<HeavenSearchResult[]>(cacheKey);
  if (cached) {
    console.error(`[AnimeHeaven] search cache hit: ${cached.length} result(s)`);
    return cached;
  }

  let res: any;
  try {
    res = await http.get('/fastsearch.php', {
    params: { xhr: 1, s: query },
    headers: { Accept: 'text/html,*/*' },
  });
  } catch (error: any) {
    console.error(`[AnimeHeaven] search request failed: ${error?.response?.status ?? error?.message ?? error}`);
    throw error;
  }
  console.error(`[AnimeHeaven] search status: ${res.status} url=${res.request?.res?.responseUrl ?? 'unknown'}`);
  captureHeavenCookies(res);
  const $ = cheerio.load(res.data);

  const results: HeavenSearchResult[] = [];
  $('a[href*="anime.php?"]').each((_, el) => {
    const href = $(el).attr('href') ?? '';
    const id = href.split('?')[1]?.trim();
    const title = $(el).find('.fastname').text().trim() || $(el).find('img').attr('alt')?.trim() || '';
    if (!id || !title) return;
    results.push({
      id,
      title,
      url: absoluteUrl(`/anime.php?${id}`),
      image: absoluteUrl($(el).find('img').attr('src') ?? ''),
    });
  });

  console.error(`[AnimeHeaven] search matched: ${results.length} result(s)`);
  cacheSet(cacheKey, results, 'episodes');
  return results;
}

export async function findAnimeHeavenId(title: string): Promise<string | null> {
  console.error(`[AnimeHeaven] find ID: ${title}`);
  const noPossessive = title.replace(/[’']s\b/gi, '');
  const variants = Array.from(new Set([
    title,
    noPossessive,
    title.replace(/[’']/g, ''),
    noPossessive.replace(/[+]/g, ' '),
    title.replace(/[+]/g, ' '),
    title.split(/[:(|-]/)[0]?.trim(),
    noPossessive.split(/[:(|-]/)[0]?.trim(),
    title.replace(/[’']/g, '').split(/\s+/).slice(0, 2).join(' '),
    noPossessive.split(/\s+/).slice(0, 2).join(' '),
    title.replace(/[’']/g, '').split(/\s+/)[0],
    noPossessive.split(/\s+/)[0],
  ].filter((value): value is string => Boolean(value && value.trim().length >= 3))));

  const allResults: HeavenSearchResult[] = [];
  for (const variant of variants) {
    const results = await searchAnimeHeaven(variant).catch((error: any) => {
      console.error(`[AnimeHeaven] variant failed: ${variant} -> ${error?.response?.status ?? error?.message ?? error}`);
      return [];
    });
    allResults.push(...results);
    if (results.some((result) => scoreTitle(title, result.title) >= 80)) break;
  }

  const unique = Array.from(new Map(allResults.map((result) => [result.id, result])).values());
  if (!unique.length) {
    console.error(`[AnimeHeaven] no search matches for: ${title}`);
    return null;
  }

  const best = unique
    .map((result) => ({ result, score: scoreTitle(title, result.title) }))
    .sort((a, b) => b.score - a.score)[0];

  // Below this, the "match" is more likely a different anime (or an
  // unrelated series when the title is a movie/OVA/special) than the real
  // thing. Treat it as not found rather than returning a wrong embed.
  // 60 is the score a genuine substring match gets (e.g. query is a clean
  // prefix/substring of the real listed title, or vice versa) — legit
  // matches on AnimeHeaven should never score below this. The false
  // matches from the bug report score ~20-35, well under this bar.
  const MIN_ACCEPT_SCORE = 60;
  if (best.score < MIN_ACCEPT_SCORE) {
    console.error(`[AnimeHeaven] best match rejected: ${best.result.title} score=${best.score}`);
    return null;
  }

  console.error(`[AnimeHeaven] matched: ${best.result.title} id=${best.result.id} score=${best.score}`);
  return best.result.id;
}

export async function getHeavenEpisodes(animeId: string): Promise<HeavenEpisode[]> {
  console.error(`[AnimeHeaven] anime page start: ${animeId}`);
  const cacheKey = `heaven:eps:${animeId}`;
  const cached = cacheGet<HeavenEpisode[]>(cacheKey);
  if (cached) {
    console.error(`[AnimeHeaven] episodes cache hit: ${cached.length} episode(s)`);
    return cached;
  }

  let res: any;
  try {
    res = await http.get(`/anime.php?${animeId}`);
  } catch (error: any) {
    console.error(`[AnimeHeaven] anime page failed: ${error?.response?.status ?? error?.message ?? error}`);
    throw error;
  }
  console.error(`[AnimeHeaven] anime page status: ${res.status} url=${res.request?.res?.responseUrl ?? 'unknown'}`);
  captureHeavenCookies(res);
  const $ = cheerio.load(res.data);
  const episodes: HeavenEpisode[] = [];

  // The site has changed its episode-link markup/quoting over time.
  // Inspect episode-looking anchors broadly and accept both quote styles.
  $('a').each((_, el) => {
    const onmouseover = $(el).attr('onmouseover') || '';
    const onclick = $(el).attr('onclick') || '';
    const href = $(el).attr('href') || '';
    const text = $(el).text().replace(/\s+/g, ' ').trim();
    const attrs = [onmouseover, onclick, href].join(' ');
    if (!/(?:gate[ha]\s*\(|gate\.php|episode)/i.test(attrs + ' ' + text)) return;

    const key =
      attrs.match(/gate[ha]\s*\(\s*["']([^"']+)["']/i)?.[1] ||
      attrs.match(/gate[ha]\s*\(\s*([^,)\s]+)/i)?.[1] ||
      href.match(/[?&](?:key|id)=([^&#]+)/i)?.[1];

    const rawNum =
      $(el).find('.watch2').first().text().trim() ||
      text.match(/episode\s*([0-9]+(?:\.[0-9]+)?)/i)?.[1] ||
      text.match(/^([0-9]+(?:\.[0-9]+)?)$/)?.[1] ||
      '';

    const num = Number(rawNum.replace(/^0+(\d)/, '$1'));
    if (!key || !Number.isFinite(num)) return;

    episodes.push({
      id: decodeURIComponent(key),
      num,
      title: `Episode ${rawNum}`,
    });
  });

  const unique = Array.from(new Map(episodes.map((ep) => [ep.id, ep])).values())
    .sort((a, b) => a.num - b.num);
  console.error(`[AnimeHeaven] episodes found: ${unique.length}`);
  cacheSet(cacheKey, unique, 'episodes');
  return unique;
}

export async function getHeavenServers(episodeId: string): Promise<HeavenServer[]> {
  return [
    { name: 'AnimeHeaven', sourceId: episodeId, type: 'sub' },
  ];
}

export async function getHeavenStream(episodeId: string): Promise<HeavenStream | null> {
  console.error(`[AnimeHeaven] gate start: key length=${episodeId.length}`);
  const cacheKey = `heaven:stream:${episodeId}`;
  const cached = cacheGet<HeavenStream>(cacheKey);
  if (cached) {
    console.error('[AnimeHeaven] gate cache hit');
    return cached;
  }

  let res: any;
  try {
    res = await http.get('/gate.php', {
    headers: {
      Cookie: heavenCookieHeader(episodeId),
      Referer: `${BASE}/`,
      Accept: 'text/html,*/*',
    },
  });
  } catch (error: any) {
    console.error(`[AnimeHeaven] gate request failed: ${error?.response?.status ?? error?.message ?? error}`);
    throw error;
  }
  console.error(`[AnimeHeaven] gate status: ${res.status} url=${res.request?.res?.responseUrl ?? 'unknown'} body=${String(res.data ?? '').slice(0, 300).replace(/\s+/g, ' ')}`);
  const $ = cheerio.load(res.data);
  const sources = $('video source')
    .map((_, el) => $(el).attr('src')?.trim() || '')
    .get()
    .filter((url) => /^https?:\/\//i.test(url));

  const primary = sources.find((url) => url.includes('/video.mp4')) || sources[0];
  console.error(`[AnimeHeaven] gate sources found: ${sources.length}`);
  if (!primary) {
    console.error('[AnimeHeaven] gate returned no playable video source');
    return null;
  }

  const stream: HeavenStream = {
    embedUrl: `${BASE}/gate.php`,
    streamUrl: primary,
    mp4: primary,
    m3u8: null,
    type: 'mp4',
    servers: Array.from(new Set(sources)),
  };
  cacheSet(cacheKey, stream, 'stream');
  return stream;
}
