import * as cheerio from 'cheerio';
import { makeClient } from '../utils/fetch';
import { cacheGet, cacheSet } from '../utils/cache';

const BASE = 'https://animeheaven.me';
// AnimeHeaven is NOT behind Cloudflare — no FlareSolverr needed, so we skip it
// entirely (leaving useFlareSolverr at its default `false`). This avoids
// paying for a slow FlareSolverr instance on every AnimeHeaven request.
const http = makeClient(BASE, BASE + '/');

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
  const cached = cacheGet<HeavenSearchResult[]>(cacheKey);
  if (cached) return cached;

  const res = await http.get('/fastsearch.php', {
    params: { xhr: 1, s: query },
    headers: { Accept: 'text/html,*/*' },
  });
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

  cacheSet(cacheKey, results, 'episodes');
  return results;
}

export async function findAnimeHeavenId(title: string): Promise<string | null> {
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
    const results = await searchAnimeHeaven(variant).catch(() => []);
    allResults.push(...results);
    if (results.some((result) => scoreTitle(title, result.title) >= 80)) break;
  }

  const unique = Array.from(new Map(allResults.map((result) => [result.id, result])).values());
  if (!unique.length) return null;

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
  if (best.score < MIN_ACCEPT_SCORE) return null;

  return best.result.id;
}

export async function getHeavenEpisodes(animeId: string): Promise<HeavenEpisode[]> {
  const cacheKey = `heaven:eps:${animeId}`;
  const cached = cacheGet<HeavenEpisode[]>(cacheKey);
  if (cached) return cached;

  const res = await http.get(`/anime.php?${animeId}`);
  const $ = cheerio.load(res.data);
  const episodes: HeavenEpisode[] = [];

  $('a[onmouseover*="gateh("], a[onclick*="gatea("]').each((_, el) => {
    const attr = $(el).attr('onmouseover') || $(el).attr('onclick') || '';
    const key = attr.match(/gate[ha]\("([^"]+)"/)?.[1];
    const rawNum = $(el).find('.watch2').first().text().trim();
    const num = Number(rawNum.replace(/^0+(\d)/, '$1'));
    if (!key || !Number.isFinite(num)) return;
    episodes.push({ id: key, num, title: `Episode ${rawNum}` });
  });

  const unique = Array.from(new Map(episodes.map((ep) => [ep.id, ep])).values())
    .sort((a, b) => a.num - b.num);
  cacheSet(cacheKey, unique, 'episodes');
  return unique;
}

export async function getHeavenServers(episodeId: string): Promise<HeavenServer[]> {
  return [
    { name: 'AnimeHeaven', sourceId: episodeId, type: 'sub' },
  ];
}

export async function getHeavenStream(episodeId: string): Promise<HeavenStream | null> {
  const cacheKey = `heaven:stream:${episodeId}`;
  const cached = cacheGet<HeavenStream>(cacheKey);
  if (cached) return cached;

  const res = await http.get('/gate.php', {
    headers: {
      Cookie: `key=${episodeId}`,
      Referer: `${BASE}/`,
      Accept: 'text/html,*/*',
    },
  });
  const $ = cheerio.load(res.data);
  const sources = $('video source')
    .map((_, el) => $(el).attr('src')?.trim() || '')
    .get()
    .filter((url) => /^https?:\/\//i.test(url));

  const primary = sources.find((url) => url.includes('/video.mp4')) || sources[0];
  if (!primary) return null;

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
