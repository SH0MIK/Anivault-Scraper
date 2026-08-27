import { anilistClient } from '../utils/fetch';
import { cacheGet, cacheSet } from '../utils/cache';

// ══════════════════════════════════════════════════════════════
// ANILIST.CO — direct GraphQL API, not a scrape
//
// AniList blocks requests from Cloudflare Workers' IP ranges outright (the
// site's own CF Worker gets a 403 "manually blocked" response). Railway is
// a normal server, not a Workers IP, so it hits AniList's real API with no
// issues -- same as utils/mapper.ts already does for search/ID-mapping.
// This exists so the CF Worker side can get AniList data by calling *this*
// service (an ordinary HTTPS request, unaffected by the block) instead of
// AniList directly, removing the need for an external GitHub Action relay.
// ══════════════════════════════════════════════════════════════

export interface AniListSeasonAnime {
  idMal: number | null;
  title: { romaji: string | null; english: string | null };
  description: string | null;
  bannerImage: string | null;
  coverImage: { large: string | null; extraLarge: string | null };
  genres: string[];
  episodes: number | null;
  averageScore: number | null;
  format: string | null;
  status: string | null;
}

function currentSeason(): { season: string; seasonYear: number } {
  const now = new Date();
  const month = now.getUTCMonth() + 1;
  const seasonYear = now.getUTCFullYear();
  const season = month <= 3 ? 'WINTER' : month <= 6 ? 'SPRING' : month <= 9 ? 'SUMMER' : 'FALL';
  return { season, seasonYear };
}

const SEASON_QUERY = `
  query ($season: MediaSeason, $seasonYear: Int) {
    Page(page: 1, perPage: 50) {
      media(season: $season, seasonYear: $seasonYear, type: ANIME, sort: POPULARITY_DESC, isAdult: false) {
        idMal
        title { romaji english }
        description(asHtml: false)
        bannerImage
        coverImage { large extraLarge }
        genres
        episodes
        averageScore
        format
        status
      }
    }
  }`;

// Cached under a season+year key (same convention the site's own KV cache
// uses) so a Railway cold-restart doesn't cost an extra AniList round trip
// per request -- only the first request each hour (see cache.ts 'episodes'
// TTL) actually hits AniList.
export async function getSeasonNow(): Promise<{ season: string; seasonYear: number; media: AniListSeasonAnime[] }> {
  const { season, seasonYear } = currentSeason();
  const cacheKey = `anilist:season:${season}:${seasonYear}`;
  const cached = cacheGet<AniListSeasonAnime[]>(cacheKey);
  if (cached) return { season, seasonYear, media: cached };

  const res = await anilistClient.post('', { query: SEASON_QUERY, variables: { season, seasonYear } });
  if (res.data?.errors?.length) {
    throw new Error('AniList GraphQL error: ' + JSON.stringify(res.data.errors).slice(0, 300));
  }
  const media: AniListSeasonAnime[] = res.data?.data?.Page?.media ?? [];
  cacheSet(cacheKey, media, 'episodes');
  return { season, seasonYear, media };
}

const TOP_BANNERS_QUERY = `
  query ($page: Int) {
    Page(page: $page, perPage: 50) {
      pageInfo { hasNextPage }
      media(type: ANIME, sort: POPULARITY_DESC, isAdult: false) {
        idMal
        bannerImage
      }
    }
  }`;

// Top-N-by-popularity bannerImage map (malId -> bannerImage) -- covers
// older/finished popular titles the season list above can never include
// (Attack on Titan, Naruto, etc). Effectively static day to day, so this
// gets the full 24h 'mapping' TTL rather than refetching per call.
export async function getTopBanners(limit = 200): Promise<Record<string, string>> {
  const cacheKey = `anilist:top-banners:${limit}`;
  const cached = cacheGet<Record<string, string>>(cacheKey);
  if (cached) return cached;

  const map: Record<string, string> = {};
  const perPage = 50;
  const pages = Math.ceil(limit / perPage);

  for (let page = 1; page <= pages; page++) {
    const res = await anilistClient.post('', { query: TOP_BANNERS_QUERY, variables: { page } });
    if (res.data?.errors?.length) break; // keep whatever pages already succeeded
    const media: any[] = res.data?.data?.Page?.media ?? [];
    for (const m of media) {
      if (m.idMal && m.bannerImage) map[String(m.idMal)] = m.bannerImage;
    }
    if (!res.data?.data?.Page?.pageInfo?.hasNextPage) break;
  }

  cacheSet(cacheKey, map, 'mapping');
  return map;
}

export interface AniListStreamingEpisode {
  title: string | null;
  thumbnail: string | null;
  url: string | null;
  site: string | null;
}

const STREAMING_EPISODES_QUERY = `
  query ($malId: Int) {
    Media(idMal: $malId, type: ANIME) {
      streamingEpisodes { title thumbnail url site }
    }
  }`;

// Per-title episode thumbnails (AniList's "streamingEpisodes" block --
// usually sourced from whichever streaming partner AniList itself tracks
// stills for, most often Crunchyroll). This was previously called directly
// from the site's episode-thumb.ts via graphql.anilist.co, which -- same as
// the season data -- silently always failed on Cloudflare Workers (blocked
// IP range), so this source has effectively never worked. Routed through
// here now for the same reason as getSeasonNow/getTopBanners above.
export async function getStreamingEpisodes(malId: number): Promise<AniListStreamingEpisode[]> {
  const cacheKey = `anilist:episodes:${malId}`;
  const cached = cacheGet<AniListStreamingEpisode[]>(cacheKey);
  if (cached) return cached;

  const res = await anilistClient.post('', { query: STREAMING_EPISODES_QUERY, variables: { malId } });
  if (res.data?.errors?.length) {
    throw new Error('AniList GraphQL error: ' + JSON.stringify(res.data.errors).slice(0, 300));
  }
  const episodes: AniListStreamingEpisode[] = res.data?.data?.Media?.streamingEpisodes ?? [];
  cacheSet(cacheKey, episodes, 'episodes');
  return episodes;
}

export interface AniListAnimeImages {
  idMal: number;
  title: string | null;
  poster: string | null;          // large — anime "cover" image (AniList calls this field coverImage)
  posterOriginal: string | null;  // extraLarge
  cover: string | null;           // wide banner (AniList calls this field bannerImage)
  coverOriginal: string | null;
}

export interface AniListAnimeImagesResult {
  result: AniListAnimeImages | null;
  log: string[];
}

const ANIME_IMAGES_QUERY = `
  query ($malId: Int) {
    Media(idMal: $malId, type: ANIME) {
      idMal
      title { romaji english }
      coverImage { large extraLarge }
      bannerImage
    }
  }`;

/**
 * Poster + cover (banner) art for a MAL ID, shaped to match tmdb.ts's and
 * kitsu.ts's getAnimeImages so routes.ts's combined /api/anime endpoint can
 * fall through TMDB -> Kitsu -> AniList interchangeably (same as
 * resolveEpisodeThumbnail already does for episode thumbnails).
 *
 * NOTE: AniList's own field names are the reverse of the poster/cover
 * naming used here (and in kitsu.ts). AniList's `coverImage` is the
 * portrait key art -- mapped to `poster` below -- and AniList's
 * `bannerImage` is the wide banner -- mapped to `cover` below.
 */
export async function getAnimeImages(malId: number, isList = false): Promise<AniListAnimeImagesResult> {
  const log: string[] = [];
  const cacheKey = `anilist:images:${malId}`;

  if (!isList) {
    const cached = cacheGet<AniListAnimeImages | null>(cacheKey);
    if (cached !== null) {
      log.push('AniList images: cache hit');
      return { result: cached, log };
    }
  }

  try {
    const res = await anilistClient.post('', { query: ANIME_IMAGES_QUERY, variables: { malId } });
    if (res.data?.errors?.length) {
      log.push(`AniList images: GraphQL error (${JSON.stringify(res.data.errors).slice(0, 200)})`);
      cacheSet(cacheKey, null, 'mapping');
      return { result: null, log };
    }

    const media = res.data?.data?.Media;
    if (!media) {
      log.push(`AniList images: no media found for MAL ID ${malId}`);
      cacheSet(cacheKey, null, 'mapping');
      return { result: null, log };
    }

    const poster: string | null = media.coverImage?.large ?? media.coverImage?.extraLarge ?? null;
    const posterOriginal: string | null = media.coverImage?.extraLarge ?? poster;
    const cover: string | null = media.bannerImage ?? null;

    if (!poster && !cover) {
      log.push(`AniList images: MAL ID ${malId} has no poster or banner image`);
      cacheSet(cacheKey, null, 'mapping');
      return { result: null, log };
    }

    const result: AniListAnimeImages = {
      idMal: malId,
      title: media.title?.english || media.title?.romaji || null,
      poster,
      posterOriginal,
      cover,
      coverOriginal: cover,
    };

    log.push(`AniList images: found (poster: ${poster ? 'yes' : 'no'}, cover: ${cover ? 'yes' : 'no'})`);
    cacheSet(cacheKey, result, 'mapping');
    return { result, log };
  } catch (e: any) {
    log.push(`AniList images: request failed (${e?.message})`);
    return { result: null, log };
  }
}
