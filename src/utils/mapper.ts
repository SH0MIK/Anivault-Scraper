import axios from 'axios';
import { anilistClient } from './fetch';
import { cacheGet, cacheSet } from './cache';
import { findAnimeHeavenId } from '../scrapers/animeheaven';
import { findAnikotoSlug } from '../scrapers/anikoto';
import { getAnimeDetails } from '../scrapers/mal';

export interface SiteIds {
  anilistId: number | null;
  malId: number | null;
  title: string;
  // Secondary title candidate (opposite of `title`'s romaji/English choice)
  // used only to retry site-matching (Anikoto/AnimeHeaven) when the primary
  // title doesn't score a good match. Not part of the public /info response
  // (routes.ts only ever destructures the named fields it wants).
  altTitle?: string | null;
  siteIds: {
    zoro?: string;
    gogoanime?: string;
    animeheaven?: string;
    anidao?: string;
    anikoto?: string;
  };
}

async function enrichAnimeHeaven(result: SiteIds, altTitle?: string | null): Promise<SiteIds> {
  if (result.siteIds.animeheaven || result.title === 'Unknown') return result;
  const id = await findAnimeHeavenId(result.title).catch(() => null);
  if (id) {
    result.siteIds.animeheaven = id;
    return result;
  }
  if (altTitle && altTitle !== result.title) {
    const altId = await findAnimeHeavenId(altTitle).catch(() => null);
    if (altId) result.siteIds.animeheaven = altId;
  }
  return result;
}

// Anikoto's own site displays/searches by the localized English title, not
// the JP romaji — so callers whose `result.title` is romaji (e.g. the
// MAL-fallback path) MUST also pass the English title here, or every match
// will legitimately score too low and get rejected (see findAnikotoSlug's
// MIN_MATCH_SCORE). Tries `result.title` first, falls back to `altTitle`.
async function enrichAnikoto(result: SiteIds, altTitle?: string | null): Promise<SiteIds> {
  if (result.siteIds.anikoto || result.title === 'Unknown') return result;
  const slug = await findAnikotoSlug(result.title).catch(() => null);
  if (slug) {
    result.siteIds.anikoto = slug;
    return result;
  }
  if (altTitle && altTitle !== result.title) {
    const altSlug = await findAnikotoSlug(altTitle).catch(() => null);
    if (altSlug) result.siteIds.anikoto = altSlug;
  }
  return result;
}

// MAL ID → AniList ID
// Returns null (never throws) if AniList is down/unreachable -- callers use
// that as the signal to fall back to the MAL-only path (getSiteIdsByMal).
export async function malToAnilist(malId: number): Promise<number | null> {
  const cacheKey = `mal2al:${malId}`;
  const cached = cacheGet<number>(cacheKey);
  if (cached) return cached;

  try {
    const query = `query ($malId: Int) {
      Media(idMal: $malId, type: ANIME) { id idMal title { romaji english } }
    }`;
    const res = await anilistClient.post('', { query, variables: { malId } });
    const id = res.data?.data?.Media?.id ?? null;
    if (id) cacheSet(cacheKey, id);
    return id;
  } catch {
    return null;
  }
}

// Fetch title from AniList for a given anilistId
async function getAnilistTitle(anilistId: number): Promise<{ title: string; altTitle: string | null; malId: number | null }> {
  const query = `query ($id: Int) {
    Media(id: $id, type: ANIME) { idMal title { romaji english } }
  }`;
  const res = await anilistClient.post('', { query, variables: { id: anilistId } });
  const media = res.data?.data?.Media;
  const english: string | null = media?.title?.english ?? null;
  const romaji: string | null = media?.title?.romaji ?? null;
  return {
    title: english ?? romaji ?? 'Unknown',
    altTitle: english && romaji && english !== romaji ? romaji : null,
    malId: media?.idMal ?? null,
  };
}

// AniList ID → metadata + site-specific IDs
export async function getSiteIds(anilistId: number): Promise<SiteIds | null> {
  const cacheKey = `siteids:${anilistId}`;
  const cached = cacheGet<SiteIds>(cacheKey);
  if (cached) {
    const wasMissingAnimeHeaven = !cached.siteIds.animeheaven;
    const wasMissingAnikoto = !cached.siteIds.anikoto;
    const enriched = await enrichAnikoto(await enrichAnimeHeaven(cached, cached.altTitle), cached.altTitle);
    if ((wasMissingAnimeHeaven && enriched.siteIds.animeheaven) || (wasMissingAnikoto && enriched.siteIds.anikoto)) {
      cacheSet(cacheKey, enriched);
    }
    return enriched;
  }

  // Build result shell using AniList (always reliable for title + malId)
  const alInfo = await getAnilistTitle(anilistId).catch(() => ({ title: 'Unknown', altTitle: null, malId: null }));

  const result: SiteIds = {
    anilistId,
    malId: alInfo.malId,
    title: alInfo.title,
    altTitle: alInfo.altTitle,
    siteIds: {},
  };

  // Try Anify for site mappings
  try {
    const res = await axios.get(`https://api.anify.tv/info/${anilistId}`, {
      params: { fields: 'mappings' },
      timeout: 8000,
    });
    const mappings: any[] = res.data?.mappings ?? [];
    for (const m of mappings) {
      if (m.providerId === 'zoro')      result.siteIds.zoro = m.id;
      if (m.providerId === 'gogoanime') result.siteIds.gogoanime = m.id;
      
      if (m.providerId === 'mal' && !result.malId) result.malId = parseInt(m.id);
    }
  } catch {
    // Anify down or missing — fall through to direct scraper fallbacks below
  }

  await enrichAnimeHeaven(result, result.altTitle);
  await enrichAnikoto(result, result.altTitle);

  // If still no zoro ID, try a slug guess (title-anilistId format common on HiAnime clones)
  // This is a heuristic and may not always work
  if (!result.siteIds.zoro && result.title !== 'Unknown') {
    const slug = result.title.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
    result.siteIds.zoro = `${slug}-${anilistId}`;
  }

  cacheSet(cacheKey, result);
  return result;
}

// AniList-free fallback: build SiteIds from a MAL ID alone (title comes from
// your own MAL scraper instead of AniList's getAnilistTitle). Used when
// malToAnilist can't resolve an AniList ID (AniList down/blocked). Note:
// zoro/gogoanime via Anify both key off anilistId, so
// those stay unavailable here -- everything keyed off title (animeheaven,
// anikoto) still works normally.
export async function getSiteIdsByMal(malId: number): Promise<SiteIds | null> {
  const cacheKey = `siteids:mal:${malId}`;
  const cached = cacheGet<SiteIds>(cacheKey);
  if (cached) {
    const wasMissingAnimeHeaven = !cached.siteIds.animeheaven;
    const wasMissingAnikoto = !cached.siteIds.anikoto;
    const enriched = await enrichAnikoto(await enrichAnimeHeaven(cached, cached.altTitle), cached.altTitle);
    if ((wasMissingAnimeHeaven && enriched.siteIds.animeheaven) || (wasMissingAnikoto && enriched.siteIds.anikoto)) {
      cacheSet(cacheKey, enriched);
    }
    return enriched;
  }

  const details = await getAnimeDetails(malId).catch(() => null);
  if (!details) return null;

  // details.title is MAL's romaji/native title; details.titleEnglish is the
  // localized one. Anikoto (and most streaming clones) index by the English
  // title, so that has to be tried too, not just whichever MAL calls
  // "the" title.
  const romajiTitle = details.title || null;
  const englishTitle = details.titleEnglish || null;

  const result: SiteIds = {
    anilistId: null,
    malId,
    title: romajiTitle || englishTitle || 'Unknown',
    altTitle: englishTitle && romajiTitle && englishTitle !== romajiTitle ? englishTitle : null,
    siteIds: {},
  };

  await enrichAnimeHeaven(result, result.altTitle);
  await enrichAnikoto(result, result.altTitle);

  cacheSet(cacheKey, result);
  return result;
}

// Search AniList by title
export async function searchAnilist(query: string): Promise<{
  id: number; malId: number | null; title: string; coverImage: string; episodes: number | null; status: string; format: string;
}[]> {
  const cacheKey = `alsearch:${query.toLowerCase().trim()}`;
  const cached = cacheGet<any[]>(cacheKey);
  if (cached) return cached;

  const gql = `query ($search: String) {
    Page(page: 1, perPage: 10) {
      media(search: $search, type: ANIME, sort: SEARCH_MATCH) {
        id idMal episodes
        title { romaji english }
        coverImage { large medium }
        status format
      }
    }
  }`;

  const res = await anilistClient.post('', { query: gql, variables: { search: query } });
  const list = res.data?.data?.Page?.media ?? [];

  const results = list.map((m: any) => ({
    id: m.id,
    malId: m.idMal ?? null,
    title: m.title?.english ?? m.title?.romaji,
    coverImage: m.coverImage?.large ?? m.coverImage?.medium ?? '',
    episodes: m.episodes ?? null,
    status: m.status,
    format: m.format,
  }));

  cacheSet(cacheKey, results, 'episodes');
  return results;
}
