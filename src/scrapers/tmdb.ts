import axios from 'axios';
import { cacheGet, cacheSet } from '../utils/cache';

// ══════════════════════════════════════════════════════════════
// TMDB — official REST API, not a scrape (same as anilist.ts).
//
// Ported from the site's src/lib/episode-thumb.ts "Source 2: TMDB" block so
// the Cloudflare Worker no longer has to call api.themoviedb.org itself.
//
// IMPORTANT: TMDB lists anime as ONE show with multiple seasons nested
// inside it -- there is no separate "Show Name II" / "Show Name Season 2"
// entry to search for. A title like "Saga of Tanya the Evil II" will never
// match a TMDB search; only "Saga of Tanya the Evil" (the base title) does,
// with Season 2 as season_number 2 under that same show. extractSeasonHint
// below strips the season marker off the title so search works, and reports
// which season number it implied so callers can target the right season.
// ══════════════════════════════════════════════════════════════

const TMDB_API_KEY = process.env.TMDB_API_KEY || '';

const tmdbClient = axios.create({
  baseURL: 'https://api.themoviedb.org/3',
  timeout: 10000,
});

export interface TmdbEpisodeThumb {
  showId: number;
  showName: string;
  season: number;
  stillPath: string;
  thumbnail: string;        // w780 — matches what episode-thumb.ts used for og:image / Continue Watching
  thumbnailOriginal: string; // full-res, only useful for the admin "list all candidates" view
}

export interface TmdbEpisodeThumbResult {
  result: TmdbEpisodeThumb | null;
  log: string[];
}

export interface TmdbAnimeImages {
  showId: number;
  showName: string;
  season: number | null;          // which season the poster came from (null = show-level fallback)
  poster: string | null;          // w500 — anime "cover" image
  posterOriginal: string | null;
  backdrop: string | null;        // w1280 — banner
  backdropOriginal: string | null;
  logo: string | null;            // w500 — transparent title logo
  logoOriginal: string | null;
}

export interface TmdbAnimeImagesResult {
  result: TmdbAnimeImages | null;
  log: string[];
}

// ── Season-hint extraction ─────────────────────────────────────────────
// Strips a trailing season marker off an anime title and reports the
// implied season number, e.g.:
//   "Saga of Tanya the Evil II"    -> { base: "Saga of Tanya the Evil", season: 2 }
//   "Attack on Titan Season 3"     -> { base: "Attack on Titan", season: 3 }
//   "Kaguya-sama: Love Is War -Ultra Romantic-" (2nd/3rd season titles vary
//   per anime so this is best-effort; callers should keep the raw title as
//   a fallback search candidate too, which resolveTmdbTitles in routes.ts does).

const ROMAN_TO_NUM: Record<string, number> = {
  ii: 2, iii: 3, iv: 4, v: 5, vi: 6, vii: 7, viii: 8, ix: 9, x: 10,
};

const SEASON_WORD_PATTERNS: Array<{ re: RegExp; num: (m: RegExpMatchArray) => number }> = [
  { re: /\s+season\s+(\d{1,2})\s*$/i, num: (m) => parseInt(m[1], 10) },
  { re: /\s+(\d{1,2})(?:st|nd|rd|th)\s+season\s*$/i, num: (m) => parseInt(m[1], 10) },
  { re: /\s+part\s+(\d{1,2})\s*$/i, num: (m) => parseInt(m[1], 10) },
  { re: /\s+cour\s+(\d{1,2})\s*$/i, num: (m) => parseInt(m[1], 10) },
];

export function extractSeasonHint(title: string): { base: string; season: number | null } {
  for (const { re, num } of SEASON_WORD_PATTERNS) {
    const m = title.match(re);
    if (m) return { base: title.slice(0, m.index).trim(), season: num(m) };
  }

  // Trailing roman numeral, e.g. "Youjo Senki II"
  const romanMatch = title.match(/\s+(I{2,3}|IV|VI{0,3}|IX|X)\s*$/i);
  if (romanMatch) {
    const season = ROMAN_TO_NUM[romanMatch[1].toLowerCase()];
    if (season) return { base: title.slice(0, romanMatch.index).trim().replace(/[:\-–]\s*$/, ''), season };
  }

  // Trailing arabic digit (2-10 only, to avoid eating years like "2003")
  const digitMatch = title.match(/\s+(\d{1,2})\s*$/);
  if (digitMatch) {
    const n = parseInt(digitMatch[1], 10);
    if (n >= 2 && n <= 10) {
      return { base: title.slice(0, digitMatch.index).trim().replace(/[:\-–]\s*$/, ''), season: n };
    }
  }

  return { base: title, season: null };
}

// Different art types want different preferences:
// - posters/logos: prefer English (they carry title text), then textless
// - backdrops: prefer textless/no-language first (cleaner as a banner),
//   then English, since a banner with baked-in foreign text looks worse
//   than one with none.
function pickBestImage(arr: any[], mode: 'lang-first' | 'textless-first' = 'lang-first'): any | null {
  if (!arr || arr.length === 0) return null;
  const byVotes = [...arr].sort((a, b) => (b.vote_average ?? 0) - (a.vote_average ?? 0));
  if (mode === 'textless-first') {
    return byVotes.find((i) => !i.iso_639_1) || byVotes.find((i) => i.iso_639_1 === 'en') || byVotes[0];
  }
  return byVotes.find((i) => i.iso_639_1 === 'en') || byVotes.find((i) => !i.iso_639_1) || byVotes[0];
}

// TMDB search/tv genre_id for "Animation". Used below to disambiguate shows
// that share a title with a non-anime entry (e.g. "One Piece" the anime vs.
// Netflix's 2023 live-action "One Piece" -- both come back from the same
// search query, and TMDB's own relevance ranking doesn't reliably put the
// anime first).
const ANIMATION_GENRE_ID = 16;

async function searchShow(animeTitle: string, log: string[]): Promise<{ id: number; name: string } | null> {
  const srch = await tmdbClient.get('/search/tv', {
    params: { api_key: TMDB_API_KEY, query: animeTitle, language: 'en-US' },
  });
  const results = srch.data?.results ?? [];
  if (results.length === 0) {
    log.push(`TMDB: no show found for '${animeTitle}'`);
    return null;
  }

  // Prefer a result that's actually animated AND Japanese-origin -- catches
  // cases like "One Piece" where a live-action adaptation of the same name
  // (different genre, different origin_country) outranks the anime in
  // TMDB's default search order. Falls back through progressively looser
  // criteria, then finally to whatever TMDB ranked first, so this never
  // returns nothing just because a match couldn't be scored.
  const isAnimated = (r: any) => Array.isArray(r.genre_ids) && r.genre_ids.includes(ANIMATION_GENRE_ID);
  const isJapanese = (r: any) => r.original_language === 'ja' || (Array.isArray(r.origin_country) && r.origin_country.includes('JP'));

  const show =
    results.find((r: any) => isAnimated(r) && isJapanese(r)) ||
    results.find((r: any) => isAnimated(r)) ||
    results.find((r: any) => isJapanese(r)) ||
    results[0];

  if (show !== results[0]) {
    log.push(`TMDB: '${results[0].name}' (ID ${results[0].id}) ranked first but isn't anime -- picked '${show.name}' (ID ${show.id}) instead`);
  }
  log.push(`TMDB: matched '${animeTitle}' -> '${show.name}' (ID ${show.id})`);
  return { id: show.id, name: show.name };
}

/**
 * Poster (cover), backdrop (banner), and logo for a show, by title.
 *
 * `seasonHint` (from extractSeasonHint, computed by the caller from the raw
 * MAL/AniList title before base-stripping) is used to fetch the
 * season-specific poster first -- TMDB posters differ per season (Season 2
 * gets its own key art) but backdrops/logos are show-level, shared across
 * all seasons. If the hinted season has no poster of its own, falls back to
 * season 1's poster, then the show-level poster, same idea as the site's
 * own "fallback to season 1" behavior.
 */
export async function getAnimeImages(
  animeTitle: string,
  seasonHint: number | null = null,
  isList = false
): Promise<TmdbAnimeImagesResult> {
  const log: string[] = [];

  if (!TMDB_API_KEY) {
    log.push('TMDB: skipped (no TMDB_API_KEY set on scraper)');
    return { result: null, log };
  }

  const cacheKey = `tmdb:images:${animeTitle.toLowerCase()}:s${seasonHint ?? ''}`;
  if (!isList) {
    const cached = cacheGet<TmdbAnimeImages | null>(cacheKey);
    if (cached !== null) {
      log.push('TMDB: cache hit');
      return { result: cached, log };
    }
  }

  try {
    const show = await searchShow(animeTitle, log);
    if (!show) {
      cacheSet(cacheKey, null, 'mapping');
      return { result: null, log };
    }
    const showId = show.id;

    const imgRes = await tmdbClient.get(`/tv/${showId}/images`, {
      params: { api_key: TMDB_API_KEY, include_image_language: 'en,ja,null' },
    });
    const showPosters: any[] = imgRes.data?.posters ?? [];
    const backdrops: any[] = imgRes.data?.backdrops ?? [];
    const logos: any[] = imgRes.data?.logos ?? [];
    log.push(`TMDB show-level images: ${showPosters.length} posters, ${backdrops.length} backdrops, ${logos.length} logos`);

    const backdrop = pickBestImage(backdrops, 'textless-first');
    const logo = pickBestImage(logos, 'lang-first');

    // Poster: try the hinted season first, then season 1 as fallback, then
    // whatever show-level poster exists.
    let poster: any | null = null;
    let posterSeason: number | null = null;
    const seasonsToTry = [...new Set([seasonHint, 1].filter((s): s is number => !!s && s > 0))];

    for (const s of seasonsToTry) {
      try {
        const seasonImgRes = await tmdbClient.get(`/tv/${showId}/season/${s}/images`, {
          params: { api_key: TMDB_API_KEY, include_image_language: 'en,ja,null' },
        });
        const seasonPosters: any[] = seasonImgRes.data?.posters ?? [];
        log.push(`TMDB season ${s} posters: ${seasonPosters.length}`);
        const best = pickBestImage(seasonPosters, 'lang-first');
        if (best) {
          poster = best;
          posterSeason = s;
          log.push(`TMDB: using season ${s} poster`);
          break;
        }
      } catch (e: any) {
        const status = e?.response?.status;
        log.push(`TMDB season ${s} images: ${status ? `HTTP ${status}` : `request failed (${e?.message})`}`);
      }
    }

    if (!poster) {
      poster = pickBestImage(showPosters, 'lang-first');
      if (poster) log.push('TMDB: using show-level poster (no season-specific poster found)');
    }

    if (!poster && !backdrop && !logo) {
      log.push('TMDB: no usable images found at all');
      cacheSet(cacheKey, null, 'mapping');
      return { result: null, log };
    }

    const result: TmdbAnimeImages = {
      showId,
      showName: show.name,
      season: posterSeason,
      poster: poster ? `https://image.tmdb.org/t/p/w500${poster.file_path}` : null,
      posterOriginal: poster ? `https://image.tmdb.org/t/p/original${poster.file_path}` : null,
      backdrop: backdrop ? `https://image.tmdb.org/t/p/w1280${backdrop.file_path}` : null,
      backdropOriginal: backdrop ? `https://image.tmdb.org/t/p/original${backdrop.file_path}` : null,
      logo: logo ? `https://image.tmdb.org/t/p/w500${logo.file_path}` : null,
      logoOriginal: logo ? `https://image.tmdb.org/t/p/original${logo.file_path}` : null,
    };

    cacheSet(cacheKey, result, 'mapping');
    return { result, log };
  } catch (e: any) {
    const status = e?.response?.status;
    log.push(`TMDB images: ${status ? `HTTP ${status}` : `request failed (${e?.message})`}`);
    return { result: null, log };
  }
}

// ── Absolute episode -> TMDB (season, in-season episode) mapping ────────
// Long-running shonen (Naruto Shippuden, One Piece, Bleach, etc.) air as one
// continuous series on MAL/Jikan -- episode 1, 2, 3... straight through to
// the finale -- but TMDB models the same show as many separate seasons,
// each restarting its own numbering from episode 1. Naruto Shippuden alone
// is ~21 TMDB seasons. Without converting between the two, "episode 54"
// only ever means "season X, episode 54", which stops existing once every
// season TMDB has is shorter than 54 episodes.
interface TmdbSeasonInfo {
  season_number: number;
  episode_count: number;
}

async function getShowSeasons(showId: number, log: string[]): Promise<TmdbSeasonInfo[]> {
  const cacheKey = `tmdb:seasons:${showId}`;
  const cached = cacheGet<TmdbSeasonInfo[]>(cacheKey);
  if (cached) return cached;

  const res = await tmdbClient.get(`/tv/${showId}`, { params: { api_key: TMDB_API_KEY } });
  const seasons: TmdbSeasonInfo[] = (res.data?.seasons ?? [])
    .filter((s: any) => s.season_number > 0) // skip "Specials" (season 0) -- not part of the absolute count
    .map((s: any) => ({ season_number: s.season_number, episode_count: s.episode_count ?? 0 }))
    .sort((a: TmdbSeasonInfo, b: TmdbSeasonInfo) => a.season_number - b.season_number);

  cacheSet(cacheKey, seasons, 'mapping'); // 24h TTL -- a show's season structure essentially never changes
  log.push(`TMDB: '${showId}' has ${seasons.length} season(s) -- ${seasons.map((s) => `S${s.season_number}:${s.episode_count}`).join(', ')}`);
  return seasons;
}

/**
 * Walks the season list in cumulative order to find which season the
 * absolute episode number falls under, e.g. with seasons [S1:32, S2:21,
 * S3:18, ...] and absoluteEp=54: 32+21=53, 54<=53+18=71, so that's season 3.
 *
 * Returns TWO candidate (season, epInSeason) pairs for that season, because
 * TMDB is inconsistent about whether a season's own episode_number field
 * resets to 1 or keeps counting the absolute number straight through:
 *   1) epInSeason = the season-relative remainder (54-53=1 here) -- the
 *      "normal" TMDB convention almost every show follows (season resets
 *      its own numbering to 1).
 *   2) epInSeason = absoluteEp itself (unchanged) -- what long-running
 *      shonen imported into TMDB via TheTVDB's "aired order" sometimes do
 *      instead. Confirmed directly against TMDB: Naruto Shippuden's season
 *      3 episodes are numbered 54-71, NOT 1-18, even though the season only
 *      has 18 episodes in it.
 *
 * Relative is tried FIRST now (this used to be absolute-first). Reason:
 * for a split-cour/multi-part show where a season's own episode_count is
 * large enough to comfortably contain the raw absolute number too (e.g.
 * Mushoku Tensei season 2 has 25 episodes, numbered 0-24 including a recap
 * special) -- absolute-first would silently match a DIFFERENT real episode
 * within that same season instead of 404ing, e.g. absoluteEp=24 spuriously
 * hit season 2's own episode 24 (the finale) instead of its actual target,
 * episode 1 (relative = 24-23) the premiere, because "episode 24" simply
 * happened to also exist in that season and matched before relative was
 * ever tried. Relative-first avoids that class of wrong-but-real match for
 * every show following the normal convention, while the Shippuden-style
 * case above still resolves correctly on the fallback: season 3 doesn't
 * have an "episode 1" on TMDB (it's numbered 54+ there), so the relative
 * candidate 404s and absolute is tried next as before.
 */
function mapAbsoluteEpisode(seasons: TmdbSeasonInfo[], absoluteEp: number): Array<{ season: number; epInSeason: number }> {
  let cumulative = 0;
  for (const s of seasons) {
    if (s.episode_count <= 0) continue;
    const before = cumulative;
    cumulative += s.episode_count;
    if (absoluteEp <= cumulative) {
      const relative = absoluteEp - before;
      const candidates = [{ season: s.season_number, epInSeason: relative }];
      if (absoluteEp !== relative) candidates.push({ season: s.season_number, epInSeason: absoluteEp });
      return candidates;
    }
  }
  return [];
}


// Shared by getEpisodeThumbnail and getEpisodeInfo below -- both need the
// same "which (season, epInSeason) pairs could absoluteEp map to" list, just
// to fetch different fields off the resulting episode object.
async function buildEpisodeCandidates(
  showId: number,
  showName: string,
  epNum: number,
  seasonHint: number | null,
  log: string[]
): Promise<Array<{ season: number; epInSeason: number }>> {
  const candidates: Array<{ season: number; epInSeason: number }> = [];

  try {
    const seasons = await getShowSeasons(showId, log);
    const mapped = mapAbsoluteEpisode(seasons, epNum);
    if (mapped.length > 0) {
      log.push(`TMDB: absolute ep ${epNum} -> season ${mapped[0].season} (trying e${mapped.map((c) => c.epInSeason).join('/e')})`);
      candidates.push(...mapped);
    } else {
      log.push(`TMDB: absolute ep ${epNum} is beyond every season TMDB lists for '${showName}'`);
    }
  } catch (e: any) {
    log.push(`TMDB: couldn't fetch season list for '${showName}' (${e?.message})`);
  }

  for (const season of [seasonHint, 1, 2]) {
    if (!season || season <= 0) continue;
    if (candidates.some((c) => c.season === season && c.epInSeason === epNum)) continue;
    candidates.push({ season, epInSeason: epNum });
  }

  return candidates;
}

/**
 * Looks up an episode-specific still from TMDB by anime title + episode number.
 *
 * `epNum` here is the ABSOLUTE episode number (MAL/Jikan-style -- counts
 * straight through 1..N across the whole series), but TMDB splits
 * long-running shows into many seasons (Naruto Shippuden is ~20 TMDB
 * seasons; One Piece is 20+). So this first fetches the show's season list
 * to figure out which season absoluteEp falls under, then tries that
 * episode number two ways within that season -- see mapAbsoluteEpisode for
 * why there are two candidates, not one; TMDB isn't consistent about
 * whether a season resets its own episode numbering back to 1.
 *
 * `seasonHint` (title-derived, e.g. "Show II" -> season 2) and a bare
 * season-1/2 attempt at the raw epNum are still tried afterward as further
 * fallbacks, in case the season list fetch fails entirely.
 */
export async function getEpisodeThumbnail(
  animeTitle: string,
  epNum: number,
  seasonHint: number | null = null,
  isList = false
): Promise<TmdbEpisodeThumbResult> {
  const log: string[] = [];

  if (!TMDB_API_KEY) {
    log.push('TMDB: skipped (no TMDB_API_KEY set on scraper)');
    return { result: null, log };
  }

  const cacheKey = `tmdb:epthumb:${animeTitle.toLowerCase()}:s${seasonHint ?? ''}:${epNum}`;
  if (!isList) {
    const cached = cacheGet<TmdbEpisodeThumb | null>(cacheKey);
    if (cached !== null) {
      log.push('TMDB: cache hit');
      return { result: cached, log };
    }
  }

  try {
    const show = await searchShow(animeTitle, log);
    if (!show) {
      cacheSet(cacheKey, null, 'episodes');
      return { result: null, log };
    }
    const showId = show.id;
    const candidates = await buildEpisodeCandidates(showId, show.name, epNum, seasonHint, log);

    for (const { season, epInSeason } of candidates) {
      try {
        const epRes = await tmdbClient.get(`/tv/${showId}/season/${season}/episode/${epInSeason}`, {
          params: { api_key: TMDB_API_KEY },
        });
        const still: string | null = epRes.data?.still_path ?? null;
        log.push(`TMDB ${show.name} s${season}e${epInSeason}: ${still ? `found ${still}` : 'no still'}`);

        if (still) {
          const result: TmdbEpisodeThumb = {
            showId,
            showName: show.name,
            season,
            stillPath: still,
            thumbnail: `https://image.tmdb.org/t/p/w780${still}`,
            thumbnailOriginal: `https://image.tmdb.org/t/p/original${still}`,
          };
          cacheSet(cacheKey, result, 'episodes');
          return { result, log };
        }
      } catch (e: any) {
        // 404 just means that season/episode doesn't exist for this show — keep trying
        const status = e?.response?.status;
        log.push(`TMDB s${season}e${epInSeason}: ${status ? `HTTP ${status}` : `request failed (${e?.message})`}`);
      }
    }

    log.push(`TMDB: no still found for '${animeTitle}' ep ${epNum} (tried ${candidates.map((c) => `s${c.season}e${c.epInSeason}`).join(', ')})`);
    cacheSet(cacheKey, null, 'episodes');
    return { result: null, log };
  } catch (e: any) {
    const status = e?.response?.status;
    log.push(`TMDB search: ${status ? `HTTP ${status}` : `request failed (${e?.message})`}`);
    return { result: null, log };
  }
}

export interface TmdbEpisodeInfo {
  showId: number;
  showName: string;
  season: number;
  title: string;
  aired: string | null; // TMDB air_date, YYYY-MM-DD
}

export interface TmdbEpisodeInfoResult {
  result: TmdbEpisodeInfo | null;
  log: string[];
}

/**
 * Episode title + air date from TMDB, by anime title + absolute episode
 * number. Same show-search + absolute->season/episode mapping as
 * getEpisodeThumbnail (see buildEpisodeCandidates), just pulling name/
 * air_date off the episode object instead of still_path -- kept as a
 * separate function/cache key since a still can be missing on an episode
 * that otherwise has a title+date (or vice versa), so callers resolving
 * thumbnail vs. info independently shouldn't have one's cache miss cost
 * the other a redundant fetch.
 */
export async function getEpisodeInfo(
  animeTitle: string,
  epNum: number,
  seasonHint: number | null = null,
  isList = false
): Promise<TmdbEpisodeInfoResult> {
  const log: string[] = [];

  if (!TMDB_API_KEY) {
    log.push('TMDB: skipped (no TMDB_API_KEY set on scraper)');
    return { result: null, log };
  }

  const cacheKey = `tmdb:epinfo:${animeTitle.toLowerCase()}:s${seasonHint ?? ''}:${epNum}`;
  if (!isList) {
    const cached = cacheGet<TmdbEpisodeInfo | null>(cacheKey);
    if (cached !== null) {
      log.push('TMDB: cache hit');
      return { result: cached, log };
    }
  }

  try {
    const show = await searchShow(animeTitle, log);
    if (!show) {
      cacheSet(cacheKey, null, 'episodes');
      return { result: null, log };
    }
    const showId = show.id;
    const candidates = await buildEpisodeCandidates(showId, show.name, epNum, seasonHint, log);

    for (const { season, epInSeason } of candidates) {
      try {
        const epRes = await tmdbClient.get(`/tv/${showId}/season/${season}/episode/${epInSeason}`, {
          params: { api_key: TMDB_API_KEY },
        });
        const name: string | null = epRes.data?.name ?? null;
        const airDate: string | null = epRes.data?.air_date ?? null;
        log.push(`TMDB ${show.name} s${season}e${epInSeason}: ${name ? `found '${name}'` : 'no episode data'}`);

        // TMDB defaults an un-aired/placeholder episode's name to something
        // like "Episode 12" -- still useful (better than nothing), but real
        // titles from a `name` that isn't just the generic placeholder win
        // over a bare still-existing check the way getEpisodeThumbnail does.
        if (name) {
          const result: TmdbEpisodeInfo = { showId, showName: show.name, season, title: name, aired: airDate };
          cacheSet(cacheKey, result, 'episodes');
          return { result, log };
        }
      } catch (e: any) {
        const status = e?.response?.status;
        log.push(`TMDB s${season}e${epInSeason}: ${status ? `HTTP ${status}` : `request failed (${e?.message})`}`);
      }
    }

    log.push(`TMDB: no episode info found for '${animeTitle}' ep ${epNum} (tried ${candidates.map((c) => `s${c.season}e${c.epInSeason}`).join(', ')})`);
    cacheSet(cacheKey, null, 'episodes');
    return { result: null, log };
  } catch (e: any) {
    const status = e?.response?.status;
    log.push(`TMDB search: ${status ? `HTTP ${status}` : `request failed (${e?.message})`}`);
    return { result: null, log };
  }
}

/**
 * Total episode count TMDB currently lists for a show (sum of episode_count
 * across all non-special seasons). Used to detect when MAL's scraped
 * episode-list page is undercounting an airing show (MAL can lag a scrape
 * or drop a row) so /api/episode can pad in the missing tail episodes from
 * TMDB/AniList/Kitsu instead of silently reporting a stale count.
 */
export async function getShowEpisodeCount(animeTitle: string): Promise<{ showId: number; count: number } | null> {
  const log: string[] = [];
  if (!TMDB_API_KEY) return null;

  const cacheKey = `tmdb:epcount:${animeTitle.toLowerCase()}`;
  const cached = cacheGet<{ showId: number; count: number } | null>(cacheKey);
  if (cached !== null) return cached;

  try {
    const show = await searchShow(animeTitle, log);
    if (!show) {
      cacheSet(cacheKey, null, 'episodes');
      return null;
    }
    const seasons = await getShowSeasons(show.id, log);
    const count = seasons.reduce((sum, s) => sum + Math.max(0, s.episode_count), 0);
    const result = { showId: show.id, count };
    cacheSet(cacheKey, result, 'episodes');
    return result;
  } catch {
    return null;
  }
}

export interface TmdbEpisodeData {
  showId: number;
  showName: string;
  season: number;
  title: string | null;
  aired: string | null;
  stillPath: string | null;
  thumbnail: string | null;
  thumbnailOriginal: string | null;
}

export interface TmdbEpisodeDataResult {
  result: TmdbEpisodeData | null;
  log: string[];
}

/**
 * Combined title+air-date+still fetch, one TMDB request per (season,
 * epInSeason) candidate instead of the two separate ones getEpisodeThumbnail
 * and getEpisodeInfo each make -- /api/episode's whole-show mode resolves
 * both thumbnail and info for every episode, and on a long-running show
 * (One Piece: 1175+ episodes) doubling the per-episode TMDB call count was
 * enough extra latency to trip the upstream request timeout. Use this from
 * a caller that wants both; getEpisodeThumbnail/getEpisodeInfo stay as they
 * are for callers (the standalone /tmdb/episode-thumb route) that only need
 * one or the other.
 *
 * `expectedAired` (MAL's own air date for this absolute episode number, when
 * the caller has it) is a sanity check against mapAbsoluteEpisode's inherent
 * ambiguity: for a split-cour/multi-part show a season can be long enough
 * that BOTH the relative and the absolute candidate exist as real episodes
 * in that season -- not a 404, an actual wrong-but-present match (this is
 * exactly what happened to Mushoku Tensei ep24, which spuriously matched
 * season 2's own episode 24, its finale, instead of episode 1, its
 * premiere). A candidate whose air_date is more than ~3 weeks from what MAL
 * already recorded for this episode number is rejected and the next
 * candidate is tried instead of trusting the first one that merely exists.
 */
const EXPECTED_AIRED_TOLERANCE_MS = 21 * 24 * 60 * 60 * 1000; // ~3 weeks

function airedMismatch(candidateAired: string | null, expectedAired: string | null | undefined): boolean {
  if (!candidateAired || !expectedAired) return false; // nothing to compare against -- allow it
  const a = Date.parse(candidateAired);
  const b = Date.parse(expectedAired);
  if (Number.isNaN(a) || Number.isNaN(b)) return false;
  return Math.abs(a - b) > EXPECTED_AIRED_TOLERANCE_MS;
}

export async function getEpisodeData(
  animeTitle: string,
  epNum: number,
  seasonHint: number | null = null,
  isList = false,
  expectedAired: string | null = null
): Promise<TmdbEpisodeDataResult> {
  const log: string[] = [];

  if (!TMDB_API_KEY) {
    log.push('TMDB: skipped (no TMDB_API_KEY set on scraper)');
    return { result: null, log };
  }

  const cacheKey = `tmdb:epdata:${animeTitle.toLowerCase()}:s${seasonHint ?? ''}:${epNum}`;
  if (!isList) {
    const cached = cacheGet<TmdbEpisodeData | null>(cacheKey);
    if (cached !== null) {
      if (!airedMismatch(cached.aired, expectedAired)) {
        log.push('TMDB: cache hit');
        return { result: cached, log };
      }
      log.push(`TMDB: cache hit but air date (${cached.aired}) doesn't match MAL's (${expectedAired}) -- refetching`);
    }
  }

  try {
    const show = await searchShow(animeTitle, log);
    if (!show) {
      cacheSet(cacheKey, null, 'episodes');
      return { result: null, log };
    }
    const showId = show.id;
    const candidates = await buildEpisodeCandidates(showId, show.name, epNum, seasonHint, log);

    for (const { season, epInSeason } of candidates) {
      try {
        const epRes = await tmdbClient.get(`/tv/${showId}/season/${season}/episode/${epInSeason}`, {
          params: { api_key: TMDB_API_KEY },
        });
        const name: string | null = epRes.data?.name ?? null;
        const airDate: string | null = epRes.data?.air_date ?? null;
        const still: string | null = epRes.data?.still_path ?? null;
        log.push(`TMDB ${show.name} s${season}e${epInSeason}: ${name || still ? `found (name=${!!name}, still=${!!still})` : 'no episode data'}`);

        if (name || still) {
          if (airedMismatch(airDate, expectedAired)) {
            log.push(`TMDB s${season}e${epInSeason}: air date ${airDate} is way off MAL's ${expectedAired} for this episode -- likely the wrong season/episode match, trying next candidate`);
            continue;
          }
          const result: TmdbEpisodeData = {
            showId,
            showName: show.name,
            season,
            title: name,
            aired: airDate,
            stillPath: still,
            thumbnail: still ? `https://image.tmdb.org/t/p/w780${still}` : null,
            thumbnailOriginal: still ? `https://image.tmdb.org/t/p/original${still}` : null,
          };
          cacheSet(cacheKey, result, 'episodes');
          return { result, log };
        }
      } catch (e: any) {
        const status = e?.response?.status;
        log.push(`TMDB s${season}e${epInSeason}: ${status ? `HTTP ${status}` : `request failed (${e?.message})`}`);
      }
    }

    log.push(`TMDB: no episode data found for '${animeTitle}' ep ${epNum} (tried ${candidates.map((c) => `s${c.season}e${c.epInSeason}`).join(', ')})`);
    cacheSet(cacheKey, null, 'episodes');
    return { result: null, log };
  } catch (e: any) {
    const status = e?.response?.status;
    log.push(`TMDB search: ${status ? `HTTP ${status}` : `request failed (${e?.message})`}`);
    return { result: null, log };
  }
}
