import { Router, Request, Response } from 'express';
import axios from 'axios';
import https from 'https';
import { malToAnilist, getSiteIds, getSiteIdsByMal, searchAnilist, SiteIds } from './utils/mapper';
import { cacheStats } from './utils/cache';
import { resolveEmbed } from './resolvers/megacloud';

import { getHeavenEpisodes, getHeavenServers, getHeavenStream } from './scrapers/animeheaven';
import { getAnikotoEpisodes, getAnikotoServers, getAnikotoEmbedUrl } from './scrapers/anikoto';
import { getDesidubEpisodes, getDesidubServers, getDesidubStream } from './scrapers/desidub';
import { getAnimeDetails, getEpisodes as getMalEpisodes, getEpisode as getMalEpisode, getAllEpisodes as getAllMalEpisodes, getCharacters, getCharacterDetails, getAnimePictures, getCharacterPictures, getAnimeThemes, getAnimeVideos, getRecommendations, searchAnime, getExternalLinks, getStreamingPlatforms, debugSearchHtml, MalEpisode } from './scrapers/mal';
import { getSeasonNow, getTopBanners, getStreamingEpisodes, AniListStreamingEpisode, getAnimeImages as getAnilistAnimeImages } from './scrapers/anilist';
import { getEpisodeThumbnail as getTmdbEpisodeThumbnail, getEpisodeData as getTmdbEpisodeData, getShowEpisodeCount as getTmdbEpisodeCount, getAnimeImages as getTmdbAnimeImages, extractSeasonHint } from './scrapers/tmdb';
import { getKitsuAnimeId, getEpisodeThumbnail as getKitsuEpisodeThumbnail, getEpisodeData as getKitsuEpisodeData, getAnimeImages as getKitsuAnimeImages } from './scrapers/kitsu';

const router = Router();

const SOURCES = ['animeheaven', 'anikoto', 'desidub'] as const;
type Source = typeof SOURCES[number];

function publicBase(req: Request): string {
  const proto = (req.headers['x-forwarded-proto'] as string | undefined)?.split(',')[0] || req.protocol;
  return `${proto}://${req.get('host')}`;
}

function proxiedHlsUrl(req: Request, url: string, ref?: string): string {
  const refParam = ref ? `&ref=${encodeURIComponent(ref)}` : '';
  return `${publicBase(req)}/api/proxy/hls?url=${encodeURIComponent(url)}${refParam}`;
}

function proxiedVideoUrl(req: Request, url: string): string {
  return `${publicBase(req)}/api/proxy/video?url=${encodeURIComponent(url)}`;
}

function proxiedSubtitleUrl(req: Request, url: string, ref?: string): string {
  const refParam = ref ? `&ref=${encodeURIComponent(ref)}` : '';
  return `${publicBase(req)}/api/proxy/subtitle?url=${encodeURIComponent(url)}${refParam}`;
}

function rewriteHlsPlaylist(req: Request, body: string, sourceUrl: string, ref?: string): string {
  const base = new URL(sourceUrl);

  // Rewrite a single URI value (relative or absolute) → proxy URL
  const proxyUri = (uri: string) => proxiedHlsUrl(req, new URL(uri, base).toString(), ref);

  let hasDefaultAudio = false;
  const lines = body.split(/\r?\n/);

  // Check if any audio track has DEFAULT=YES
  for (const line of lines) {
    if (line.includes('#EXT-X-MEDIA:TYPE=AUDIO') && line.includes('DEFAULT=YES')) {
      hasDefaultAudio = true;
      break;
    }
  }

  let firstAudioMarked = false;

  return lines
    .map((line) => {
      const trimmed = line.trim();
      if (!trimmed) return line;

      // If this is an audio track and no audio has DEFAULT=YES, promote the first one to DEFAULT=YES,AUTOSELECT=YES
      let processedLine = line;
      if (!hasDefaultAudio && !firstAudioMarked && trimmed.includes('#EXT-X-MEDIA:TYPE=AUDIO')) {
        processedLine = processedLine
          .replace(/DEFAULT=NO/g, 'DEFAULT=YES')
          .replace(/AUTOSELECT=NO/g, 'AUTOSELECT=YES');
        firstAudioMarked = true;
      }

      // Rewrite all URI="..." attributes inside any HLS directive line
      // Covers: #EXT-X-KEY, #EXT-X-MEDIA, #EXT-X-MAP, #EXT-X-I-FRAME-STREAM-INF, etc.
      if (processedLine.trim().startsWith('#') && processedLine.includes('URI=')) {
        return processedLine.replace(/URI="([^"]+)"/g, (_m, uri) => `URI="${proxyUri(uri)}"`);
      }

      if (processedLine.trim().startsWith('#')) return processedLine;

      // Non-# lines are segment/variant URLs — proxy them directly
      return proxyUri(trimmed);
    })
    .join('\n');
}

async function resolveAlId(anilistId?: string, malId?: string): Promise<number | null> {
  if (anilistId) return parseInt(anilistId);
  if (malId) return malToAnilist(parseInt(malId)); // returns null (not throw) if AniList is down
  return null;
}

// Resolve full SiteIds from whichever id was given. Tries AniList first
// (richer data: zoro/gogoanime via Anify); if AniList is
// down/unreachable and we only have a malId, falls back to the MAL-only
// path so search -> info -> episodes keeps working end to end.
async function resolveSiteIds(anilistId?: string, malId?: string): Promise<SiteIds | null> {
  const alId = await resolveAlId(anilistId, malId);
  if (alId) {
    const info = await getSiteIds(alId);
    if (info) return info;
  }
  if (malId) return getSiteIdsByMal(parseInt(malId));
  return null;
}

async function fetchEpisodes(source: Source, siteIds: any, overrides: { heavenId?: string } = {}): Promise<{ episodes: any[]; siteId: string; error?: string }> {
  const zoroId = siteIds.siteIds?.zoro as string | undefined;
  const heavenId = overrides.heavenId || (siteIds.siteIds?.animeheaven as string | undefined);

  if (source === 'animeheaven') {
    if (!heavenId) return { episodes: [], siteId: '', error: 'Not indexed on AnimeHeaven' };
    return { episodes: await getHeavenEpisodes(heavenId), siteId: heavenId };
  }
  if (source === 'anikoto') {
    const slug = siteIds.siteIds?.anikoto as string | undefined;
    if (!slug) return { episodes: [], siteId: '', error: 'Not indexed on Anikoto' };
    return { episodes: await getAnikotoEpisodes(slug), siteId: slug };
  }
  if (source === 'desidub') {
    const slug = siteIds.siteIds?.desidub as string | undefined;
    if (!slug) return { episodes: [], siteId: '', error: 'Not indexed on DesiDub' };
    return { episodes: await getDesidubEpisodes(slug), siteId: slug };
  }
  return { episodes: [], siteId: '', error: 'Unknown source' };
}

router.get('/search', async (req: Request, res: Response) => {
  const q = req.query.q as string;
  if (!q) return res.status(400).json({ error: 'Missing ?q=' });
  try {
    const results = await searchAnilist(q);
    return res.json({ query: q, count: results.length, results, source: 'anilist' });
  } catch (e) {
    // AniList unreachable/down -- fall back to our own MAL scraper.
    // Shape-compatible with the AniList result (id/coverImage/status/format
    // just come back null since MAL search doesn't carry them), plus
    // `source: 'mal'` so the frontend can tell which path served the result.
    try {
      const malResults = await searchAnime(q, 10);
      const results = malResults.map((m) => ({
        id: null,
        malId: m.malId,
        title: m.title,
        coverImage: m.image ?? '',
        episodes: m.episodes,
        status: null,
        format: m.type,
      }));
      return res.json({ query: q, count: results.length, results, source: 'mal', warning: 'AniList is currently unavailable -- showing MAL search results' });
    } catch (e2) {
      return res.status(500).json({ error: 'Search failed', detail: String(e2) });
    }
  }
});

router.get('/info', async (req: Request, res: Response) => {
  const { anilistId, malId } = req.query;
  if (!anilistId && !malId) return res.status(400).json({ error: 'Provide ?anilistId= or ?malId=' });
  try {
    const info = await resolveSiteIds(anilistId as string, malId as string);
    if (!info) return res.status(404).json({ error: 'Anime not found' });

    const anikoto = await fetchEpisodes('anikoto', info);
    const episodeCount = anikoto.error ? null : anikoto.episodes.length;

    return res.json({
      anilistId: info.anilistId,
      malId: info.malId,
      title: info.title,
      episodeCount,
      siteIds: info.siteIds,
    });
  } catch (e) {
    return res.status(500).json({ error: String(e) });
  }
});

// Streaming-source episode list (animeheaven/anikoto/desidub episode
// IDs, used by /servers and /watch to locate a playable episode). Not to be
// confused with the singular /episode route further down, which is the
// MAL-metadata + thumbnail combined lookup.
router.get('/episodes', async (req: Request, res: Response) => {
  const { anilistId, malId, source = 'anikoto', heavenId } = req.query;
  if (!anilistId && !malId && !(source === 'animeheaven' && heavenId)) return res.status(400).json({ error: 'Provide ?anilistId= or ?malId=, or ?heavenId= for AnimeHeaven' });
  if (!SOURCES.includes(source as Source)) return res.status(400).json({ error: `source must be: ${SOURCES.join(', ')}` });
  try {
    if (source === 'animeheaven' && heavenId && !anilistId && !malId) {
      const episodes = await getHeavenEpisodes(String(heavenId));
      return res.json({ anilistId: null, malId: null, title: null, source, siteId: String(heavenId), count: episodes.length, episodes });
    }

    const siteIds = await resolveSiteIds(anilistId as string, malId as string);
    if (!siteIds) return res.status(404).json({ error: 'Could not resolve site IDs' });
    const result = await fetchEpisodes(source as Source, siteIds, { heavenId: heavenId ? String(heavenId) : undefined });
    if (result.error) return res.status(404).json({ error: result.error });
    return res.json({ anilistId: siteIds.anilistId, malId: siteIds.malId, title: siteIds.title, source, siteId: result.siteId, count: result.episodes.length, episodes: result.episodes });
  } catch (e) {
    return res.status(500).json({ error: String(e) });
  }
});

router.get('/servers', async (req: Request, res: Response) => {
  const { anilistId, malId, ep, type = 'sub', source = 'anikoto', heavenId } = req.query;
  if (!ep) return res.status(400).json({ error: 'Missing ?ep=' });
  if (!anilistId && !malId && !(source === 'animeheaven' && heavenId)) return res.status(400).json({ error: 'Provide ?anilistId= or ?malId=, or ?heavenId= for AnimeHeaven' });
  const epNum = parseInt(ep as string);
  if (isNaN(epNum)) return res.status(400).json({ error: '?ep must be a number' });
  if (!SOURCES.includes(source as Source)) return res.status(400).json({ error: `source must be: ${SOURCES.join(', ')}` });

  try {
    const siteIds = heavenId && source === 'animeheaven'
      ? { anilistId: null, malId: null, title: null, siteIds: { animeheaven: String(heavenId) } }
      : await resolveSiteIds(anilistId as string, malId as string);
    if (!siteIds) return res.status(404).json({ error: 'Could not resolve site IDs' });

    const epResult = await fetchEpisodes(source as Source, siteIds, { heavenId: heavenId ? String(heavenId) : undefined });
    if (epResult.error) return res.status(404).json({ error: epResult.error });
    const episode = epResult.episodes.find((e: any) => Math.round(e.num) === epNum);
    if (!episode) return res.status(404).json({ error: `Episode ${epNum} not found` });

    let allServers: any[] = [];
    if (source === 'animeheaven') allServers = await getHeavenServers(episode.id);
    if (source === 'anikoto') allServers = await getAnikotoServers(episode.id);
    if (source === 'desidub') allServers = await getDesidubServers(episode.id);

    const filtered = type === 'all' ? allServers : allServers.filter((s: any) => s.type === type);
    return res.json({
      anilistId: siteIds.anilistId,
      malId: siteIds.malId,
      title: siteIds.title,
      episode: epNum,
      type,
      source,
      siteId: epResult.siteId,
      servers: filtered.map((s: any) => ({ name: s.name, sourceId: s.sourceId, type: s.type })),
    });
  } catch (e) {
    return res.status(500).json({ error: String(e) });
  }
});

async function watchHandler(req: Request, res: Response) {
  const { source, id, ep, type } = req.params;
  const preferredServer = req.query.server as string | undefined;
  const heavenOverride = req.query.heavenId as string | undefined;

  if (!SOURCES.includes(source as Source)) return res.status(400).json({ error: `source must be: ${SOURCES.join(', ')}` });
  const epNum = parseInt(ep);
  if (isNaN(epNum)) return res.status(400).json({ error: 'ep must be a number' });
  if (!['sub', 'dub', 'raw'].includes(type)) return res.status(400).json({ error: 'type must be: sub, dub, raw' });

  const directHeavenId = source === 'animeheaven' && !id.startsWith('mal-') && !/^\d+$/.test(id);
  const anilistId = directHeavenId || id.startsWith('mal-') ? undefined : id;
  const malId = id.startsWith('mal-') ? id.replace('mal-', '') : undefined;

  try {
    const siteIds = directHeavenId
      ? { anilistId: null, malId: null, title: null, siteIds: { animeheaven: id } }
      : await resolveSiteIds(anilistId, malId);
    if (!siteIds) return res.status(404).json({ error: 'Could not resolve anime' });

    const epResult = await fetchEpisodes(source as Source, siteIds, { heavenId: heavenOverride });
    if (epResult.error) return res.status(404).json({ error: epResult.error });

    const episode = epResult.episodes.find((e: any) => Math.round(e.num) === epNum);
    if (!episode) return res.status(404).json({ error: `Episode ${epNum} not found` });

    let allServers: any[] = [];
    if (source === 'animeheaven') allServers = await getHeavenServers(episode.id);
    if (source === 'anikoto') allServers = await getAnikotoServers(episode.id);
    if (source === 'desidub') allServers = await getDesidubServers(episode.id);

    const filtered = type === 'all'
      ? allServers
      : allServers.filter((s: any) => s.type === type);
    if (!filtered.length) return res.status(404).json({ error: `No ${type} stream available on ${source} for ep ${epNum}` });

    // `strict=1` alongside `server=` restricts to ONLY that server (no
    // fallback to others) — useful for testing a single server in isolation
    // rather than the default "prefer this one, but fall back if it fails"
    // behavior used in production playback.
    const strict = req.query.strict === '1' || req.query.strict === 'true';
    let candidates = filtered;
    if (preferredServer && strict) {
      candidates = filtered.filter((s: any) => s.name.toLowerCase().includes(preferredServer.toLowerCase()));
      if (!candidates.length) {
        return res.status(404).json({ error: `No server matching "${preferredServer}" found`, availableServers: filtered.map((s: any) => s.name) });
      }
    } else if (preferredServer) {
      candidates = [...filtered].sort((a: any, b: any) => {
        const aM = a.name.toLowerCase().includes(preferredServer.toLowerCase()) ? -1 : 1;
        const bM = b.name.toLowerCase().includes(preferredServer.toLowerCase()) ? -1 : 1;
        return aM - bM;
      });
    }

    let embedResult: any = null;
    let usedServer = '';
    for (const server of candidates) {
      let raw: any = null;
      if (source === 'animeheaven') raw = await getHeavenStream(server.sourceId);
      if (source === 'anikoto') raw = await getAnikotoEmbedUrl(server.sourceId);
      if (source === 'desidub') raw = await getDesidubStream(server.sourceId);
      if (raw) { embedResult = raw; usedServer = server.name; break; }
    }
    if (!embedResult) {
      const msg = strict && preferredServer ? `Server "${preferredServer}" failed to resolve a stream` : 'All servers failed';
      return res.status(502).json({ error: msg, triedServers: candidates.map((s: any) => s.name) });
    }

    if (source === 'animeheaven') {
      return res.json({
        anilistId: siteIds.anilistId,
        malId: siteIds.malId,
        title: siteIds.title,
        episode: epNum,
        type,
        source,
        siteId: epResult.siteId,
        server: usedServer,
        availableServers: filtered.map((s: any) => s.name),
        embedUrl: embedResult.embedUrl,
        streamUrl: proxiedVideoUrl(req, embedResult.streamUrl),
        rawStreamUrl: embedResult.streamUrl,
        mp4: embedResult.mp4,
        mp4ProxyUrl: proxiedVideoUrl(req, embedResult.mp4),
        m3u8: null,
        hlsProxyUrl: null,
        playbackMode: 'mp4',
        iframeOnly: false,
        subtitles: [],
        note: 'AnimeHeaven currently exposes direct MP4 sources, not m3u8/HLS.',
      });
    }

    // Anikoto's embed resolution (getAnikotoEmbedUrl) already fully resolves
    // the stream internally — Megacloud/Megaplay decryption for regular
    // servers, or a direct CDN m3u8 for the Kiwi Mapper side-channel — so
    // it skips the generic resolveEmbed() fallback below.
    if (source === 'anikoto') {
      return res.json({
        anilistId: siteIds.anilistId,
        malId: siteIds.malId,
        title: siteIds.title,
        episode: epNum,
        type,
        source,
        server: usedServer,
        availableServers: filtered.map((s: any) => s.name),
        embedUrl: embedResult.embedUrl,
        m3u8: embedResult.m3u8 ?? null,
        hlsProxyUrl: embedResult.m3u8 ? proxiedHlsUrl(req, embedResult.m3u8, embedResult.referer) : null,
        playbackMode: embedResult.m3u8 ? 'hls' : 'iframe',
        iframeOnly: !embedResult.m3u8,
        subtitles: (embedResult.subtitles ?? []).map((s: any) => ({
          ...s,
          url: proxiedSubtitleUrl(req, s.url, embedResult.referer),
        })),
        intro: null,
        outro: null,
        note: embedResult.m3u8 ? null : 'No m3u8 extracted — use embedUrl in an iframe.',
      });
    }

    if (source === 'desidub') {
      const isHls = Boolean(embedResult.m3u8);
      const isMp4 = Boolean(embedResult.mp4);
      return res.json({
        anilistId: siteIds.anilistId,
        malId: siteIds.malId,
        title: siteIds.title,
        episode: epNum,
        type,
        source,
        server: usedServer,
        availableServers: filtered.map((s: any) => s.name),
        embedUrl: embedResult.embedUrl,
        m3u8: embedResult.m3u8 ?? null,
        hlsProxyUrl: isHls ? proxiedHlsUrl(req, embedResult.m3u8, embedResult.referer) : null,
        mp4: embedResult.mp4 ?? null,
        mp4ProxyUrl: isMp4 ? proxiedVideoUrl(req, embedResult.mp4) : null,
        playbackMode: isHls ? 'hls' : isMp4 ? 'mp4' : 'iframe',
        iframeOnly: !isHls && !isMp4,
        subtitles: (embedResult.subtitles ?? []).map((s: any) => ({
          ...s,
          url: proxiedSubtitleUrl(req, s.url, embedResult.referer),
        })),
        intro: null,
        outro: null,
        note: isHls || isMp4 ? null : 'No direct stream extracted — use embedUrl in an iframe.',
      });
    }

    const directM3u8 = typeof embedResult.embedUrl === 'string' && embedResult.embedUrl.includes('.m3u8');
    const stream = directM3u8 ? null : await resolveEmbed(embedResult.embedUrl);
    const hasHls = Boolean(directM3u8 || stream?.m3u8);
    return res.json({
      anilistId: siteIds.anilistId,
      malId: siteIds.malId,
      title: siteIds.title,
      episode: epNum,
      type,
      source,
      server: usedServer,
      availableServers: filtered.map((s: any) => s.name),
      embedUrl: embedResult.embedUrl,
      m3u8: directM3u8 ? embedResult.embedUrl : stream?.m3u8 ?? null,
      hlsProxyUrl: directM3u8 ? proxiedHlsUrl(req, embedResult.embedUrl, embedResult.referer) : (stream?.m3u8 ? proxiedHlsUrl(req, stream.m3u8, embedResult.referer) : null),
      playbackMode: hasHls ? 'hls' : 'iframe',
      iframeOnly: !hasHls,
      subtitles: stream?.subtitles ?? [],
      intro: stream?.intro ?? null,
      outro: stream?.outro ?? null,
      note: directM3u8 || stream ? null : 'Use embedUrl in iframe - m3u8 decrypt failed (key may have rotated)',
    });
  } catch (e) {
    console.error(`[/watch/${source}]`, e);
    return res.status(500).json({ error: 'Stream fetch failed', detail: String(e) });
  }
}

router.get('/watch/:source/:id/:ep/:type', watchHandler);

router.get('/proxy/hls', async (req: Request, res: Response) => {
  const url = req.query.url as string | undefined;
  const ref = req.query.ref as string | undefined;
  if (!url) return res.status(400).json({ error: 'Missing ?url=' });
  if (!/^https?:\/\//i.test(url)) return res.status(400).json({ error: '?url must be absolute http(s)' });

  // Not every source's embedResult carries a referer; if none was supplied,
  // omit the header entirely instead of guessing — most CDNs tolerate a
  // missing Referer far better than a wrong one.
  let referer: string | undefined;
  let origin: string | undefined;
  if (ref && /^https?:\/\//i.test(ref)) {
    referer = ref;
    try {
      origin = new URL(ref).origin;
    } catch {
      origin = undefined;
    }
  }

  try {
    const upstream = await axios.get(url, {
      responseType: 'arraybuffer',
      timeout: 15000,
      httpsAgent: new https.Agent({ rejectUnauthorized: false }),
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/137.0.0.0 Safari/537.36',
        'Accept': '*/*',
        'Accept-Language': 'en-US,en;q=0.9',
        ...(referer ? { Referer: referer } : {}),
        ...(origin ? { Origin: origin } : {}),
        ...(req.headers.range ? { Range: req.headers.range } : {}),
      },
      validateStatus: (status) => (status >= 200 && status < 300) || status === 206,
    });

    const contentType = String(upstream.headers['content-type'] ?? '');
    const body = Buffer.from(upstream.data);

    res.status(upstream.status);
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Cache-Control', 'public, max-age=30');

    for (const h of ['accept-ranges', 'content-range', 'content-length', 'etag', 'last-modified']) {
      const val = upstream.headers[h];
      if (val) res.setHeader(h, val);
    }

    if (url.includes('.m3u8') || contentType.includes('mpegurl')) {
      const text = body.toString('utf8');
      if (!text.trim().startsWith('#EXTM3U')) {
        return res.status(502).json({ error: 'Upstream did not return a valid m3u8 playlist', body: text.slice(0, 300) });
      }
      res.type('application/vnd.apple.mpegurl');
      return res.send(rewriteHlsPlaylist(req, text, url, ref));
    }

    // Set correct video MIME types for segments so HLS.js demuxer can process them reliably
    if (url.includes('.ts') || contentType.includes('mp2t')) {
      res.type('video/mp2t');
    } else if (url.includes('.m4s') || url.includes('.mp4') || url.includes('.woff') || contentType.includes('mp4')) {
      res.type('video/mp4');
    } else {
      res.type(contentType || 'application/octet-stream');
    }

    return res.send(body);
  } catch (e: any) {
    return res.status(e?.response?.status || 502).json({ error: 'HLS proxy failed', detail: e?.message || String(e) });
  }
});

// Subtitle files (megacloud/megaplay/vidstream tracks, etc.) usually live on
// CDNs that don't send Access-Control-Allow-Origin, so browsers refuse to
// load them cross-origin straight from the client. We fetch server-side
// (with the correct Referer, same as the HLS proxy) and re-serve with open
// CORS. SRT is also converted to WEBVTT here since <track> only accepts VTT.
router.get('/proxy/subtitle', async (req: Request, res: Response) => {
  const url = req.query.url as string | undefined;
  const ref = req.query.ref as string | undefined;
  if (!url) return res.status(400).json({ error: 'Missing ?url=' });
  if (!/^https?:\/\//i.test(url)) return res.status(400).json({ error: '?url must be absolute http(s)' });

  let referer: string | undefined;
  let origin: string | undefined;
  if (ref && /^https?:\/\//i.test(ref)) {
    referer = ref;
    try {
      origin = new URL(ref).origin;
    } catch {
      origin = undefined;
    }
  }

  try {
    const upstream = await axios.get(url, {
      responseType: 'text',
      transformResponse: (d) => d,
      timeout: 10000,
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/137.0.0.0 Safari/537.36',
        'Accept': '*/*',
        'Accept-Language': 'en-US,en;q=0.9',
        ...(referer ? { Referer: referer } : {}),
        ...(origin ? { Origin: origin } : {}),
      },
    });

    let text = String(upstream.data ?? '');
    if (!text.trim().startsWith('WEBVTT')) {
      // Looks like SRT (or SRT-ish) — convert timestamps (, → .) and prepend header
      text = 'WEBVTT\n\n' + text.replace(/(\d{2}:\d{2}:\d{2}),(\d{3})/g, '$1.$2');
    }

    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Cache-Control', 'public, max-age=300');
    res.type('text/vtt');
    return res.send(text);
  } catch (e: any) {
    return res.status(e?.response?.status || 502).json({ error: 'Subtitle proxy failed', detail: e?.message || String(e) });
  }
});

router.get('/proxy/video', async (req: Request, res: Response) => {
  const url = req.query.url as string | undefined;
  if (!url) return res.status(400).json({ error: 'Missing ?url=' });
  if (!/^https?:\/\//i.test(url)) return res.status(400).json({ error: '?url must be absolute http(s)' });

  try {
    const upstream = await axios.get(url, {
      responseType: 'stream',
      timeout: 20000,
      headers: {
        'User-Agent': 'Mozilla/5.0',
        'Accept': '*/*',
        'Referer': 'https://animeheaven.me/',
        'Origin': 'https://animeheaven.me',
        ...(req.headers.range ? { Range: req.headers.range } : {}),
      },
      validateStatus: (status) => (status >= 200 && status < 300) || status === 206,
    });

    res.status(upstream.status);
    res.setHeader('Access-Control-Allow-Origin', '*');
    const acceptRanges = upstream.headers['accept-ranges'];
    const cacheControl = upstream.headers['cache-control'];
    res.setHeader('Accept-Ranges', typeof acceptRanges === 'string' ? acceptRanges : 'bytes');
    res.setHeader('Cache-Control', typeof cacheControl === 'string' ? cacheControl : 'public, max-age=3600');

    for (const header of ['content-type', 'content-length', 'content-range', 'etag', 'last-modified']) {
      const value = upstream.headers[header];
      if (typeof value === 'string' || typeof value === 'number' || Array.isArray(value)) {
        res.setHeader(header, value);
      }
    }

    return upstream.data.pipe(res);
  } catch (e: any) {
    return res.status(e?.response?.status || 502).json({ error: 'Video proxy failed', detail: e?.message || String(e) });
  }
});

router.get('/watch', async (req: Request, res: Response) => {
  const { anilistId, malId, heavenId, ep, type = 'sub', source = 'anikoto', server } = req.query;
  if (!ep) return res.status(400).json({ error: 'Missing ?ep=' });
  if (!anilistId && !malId && !(source === 'animeheaven' && heavenId)) return res.status(400).json({ error: 'Provide ?anilistId= or ?malId=, or ?heavenId= for AnimeHeaven' });
  const id = heavenId && source === 'animeheaven' ? String(heavenId) : anilistId ? String(anilistId) : `mal-${malId}`;
  req.params.source = String(source);
  req.params.id = id;
  req.params.ep = String(ep);
  req.params.type = String(type);
  if (server) req.query.server = server;
  return watchHandler(req, res);
});


router.get('/mal/anime/:id', async (req: Request, res: Response) => {
  const malId = parseInt(req.params.id, 10);
  if (isNaN(malId)) return res.status(400).json({ error: 'id must be a number' });
  try {
    const details = await getAnimeDetails(malId);
    if (!details) return res.status(404).json({ error: 'Anime not found on MAL' });
    return res.json(details);
  } catch (e: any) {
    return res.status(502).json({ error: 'MAL scrape failed', detail: e?.message || String(e) });
  }
});

router.get('/mal/anime/:id/episodes', async (req: Request, res: Response) => {
  const malId = parseInt(req.params.id, 10);
  if (isNaN(malId)) return res.status(400).json({ error: 'id must be a number' });
  const page = req.query.page ? parseInt(req.query.page as string, 10) : 1;
  if (isNaN(page) || page < 1) return res.status(400).json({ error: 'page must be a positive number' });
  try {
    const result = await getMalEpisodes(malId, page);
    return res.json(result);
  } catch (e: any) {
    return res.status(502).json({ error: 'MAL episode scrape failed', detail: e?.message || String(e) });
  }
});

// GET /api/mal/anime/:id/episodes/:epNum -- single episode, Jikan-shaped
router.get('/mal/anime/:id/episodes/:epNum', async (req: Request, res: Response) => {
  const malId = parseInt(req.params.id, 10);
  const epNum = parseInt(req.params.epNum, 10);
  if (isNaN(malId) || isNaN(epNum)) return res.status(400).json({ error: 'id and epNum must be numbers' });
  try {
    const result = await getMalEpisode(malId, epNum);
    if (!result) return res.status(404).json({ error: `Episode ${epNum} not found` });
    return res.json({ data: result });
  } catch (e: any) {
    return res.status(502).json({ error: 'MAL episode scrape failed', detail: e?.message || String(e) });
  }
});

// GET /api/mal/search?q=naruto&limit=8 -- MAL text search, Jikan-shaped
router.get('/mal/search', async (req: Request, res: Response) => {
  const q = req.query.q as string;
  if (!q) return res.status(400).json({ error: 'Missing ?q=' });
  const limit = req.query.limit ? parseInt(req.query.limit as string, 10) : 8;
  try {
    const result = await searchAnime(q, isNaN(limit) ? 8 : limit);
    return res.json({ data: result });
  } catch (e: any) {
    return res.status(502).json({ error: 'MAL search scrape failed', detail: e?.message || String(e) });
  }
});

// TEMP DEBUG: GET /api/mal/search/debug?q=naruto -- shows what MAL actually
// sent back to Railway for a search request, to diagnose why parsing came
// back empty. Safe to remove once search is confirmed working.
router.get('/mal/search/debug', async (req: Request, res: Response) => {
  const q = req.query.q as string;
  if (!q) return res.status(400).json({ error: 'Missing ?q=' });
  try {
    const result = await debugSearchHtml(q);
    return res.json(result);
  } catch (e: any) {
    return res.status(502).json({ error: 'MAL search debug fetch failed', detail: e?.message || String(e) });
  }
});

router.get('/mal/anime/:id/external', async (req: Request, res: Response) => {
  const malId = parseInt(req.params.id, 10);
  if (isNaN(malId)) return res.status(400).json({ error: 'id must be a number' });
  try {
    const result = await getExternalLinks(malId);
    return res.json({ data: result });
  } catch (e: any) {
    return res.status(502).json({ error: 'MAL external-links scrape failed', detail: e?.message || String(e) });
  }
});

router.get('/mal/anime/:id/characters', async (req: Request, res: Response) => {
  const malId = parseInt(req.params.id, 10);
  if (isNaN(malId)) return res.status(400).json({ error: 'id must be a number' });
  try {
    const result = await getCharacters(malId);
    return res.json({ data: result });
  } catch (e: any) {
    return res.status(502).json({ error: 'MAL character scrape failed', detail: e?.message || String(e) });
  }
});

router.get('/mal/character/:id', async (req: Request, res: Response) => {
  const charId = parseInt(req.params.id, 10);
  if (isNaN(charId)) return res.status(400).json({ error: 'id must be a number' });
  try {
    const result = await getCharacterDetails(charId);
    if (!result) return res.status(404).json({ error: 'Character not found on MAL' });
    return res.json(result);
  } catch (e: any) {
    return res.status(502).json({ error: 'MAL character scrape failed', detail: e?.message || String(e) });
  }
});

router.get('/mal/anime/:id/pictures', async (req: Request, res: Response) => {
  const malId = parseInt(req.params.id, 10);
  if (isNaN(malId)) return res.status(400).json({ error: 'id must be a number' });
  try {
    const result = await getAnimePictures(malId);
    return res.json({ data: result });
  } catch (e: any) {
    return res.status(502).json({ error: 'MAL picture scrape failed', detail: e?.message || String(e) });
  }
});

router.get('/mal/character/:id/pictures', async (req: Request, res: Response) => {
  const charId = parseInt(req.params.id, 10);
  if (isNaN(charId)) return res.status(400).json({ error: 'id must be a number' });
  try {
    const result = await getCharacterPictures(charId);
    return res.json({ data: result });
  } catch (e: any) {
    return res.status(502).json({ error: 'MAL picture scrape failed', detail: e?.message || String(e) });
  }
});

router.get('/mal/anime/:id/themes', async (req: Request, res: Response) => {
  const malId = parseInt(req.params.id, 10);
  if (isNaN(malId)) return res.status(400).json({ error: 'id must be a number' });
  try {
    const result = await getAnimeThemes(malId);
    return res.json(result);
  } catch (e: any) {
    return res.status(502).json({ error: 'MAL theme scrape failed', detail: e?.message || String(e) });
  }
});

router.get('/mal/anime/:id/videos', async (req: Request, res: Response) => {
  const malId = parseInt(req.params.id, 10);
  if (isNaN(malId)) return res.status(400).json({ error: 'id must be a number' });
  try {
    const result = await getAnimeVideos(malId);
    return res.json(result);
  } catch (e: any) {
    return res.status(502).json({ error: 'MAL video scrape failed', detail: e?.message || String(e) });
  }
});

router.get('/mal/anime/:id/streaming', async (req: Request, res: Response) => {
  const malId = parseInt(req.params.id, 10);
  if (isNaN(malId)) return res.status(400).json({ error: 'id must be a number' });
  try {
    const result = await getStreamingPlatforms(malId);
    return res.json({ data: result });
  } catch (e: any) {
    return res.status(502).json({ error: 'MAL streaming-platforms scrape failed', detail: e?.message || String(e) });
  }
});

router.get('/mal/anime/:id/recommendations', async (req: Request, res: Response) => {
  const malId = parseInt(req.params.id, 10);
  if (isNaN(malId)) return res.status(400).json({ error: 'id must be a number' });
  try {
    const result = await getRecommendations(malId);
    return res.json({ data: result });
  } catch (e: any) {
    return res.status(502).json({ error: 'MAL recommendations scrape failed', detail: e?.message || String(e) });
  }
});

// AniList's actual error message (e.g. "your IP has been blocked") lives in
// the response body, which axios normally throws away in favor of a generic
// "Request failed with status code 403" on e.message. Surface the real body
// so a 403/429 is self-diagnosing instead of a guessing game.
function aniListErrorDetail(e: any): string {
  const body = e?.response?.data;
  if (body) {
    const msg = body?.errors?.[0]?.message || (typeof body === 'string' ? body : JSON.stringify(body));
    return `HTTP ${e.response.status}: ${String(msg).slice(0, 400)}`;
  }
  return e?.message || String(e);
}

router.get('/anilist/season', async (req: Request, res: Response) => {
  try {
    const result = await getSeasonNow();
    const malId = parseInt(req.query.malId as string, 10);
    if (!isNaN(malId)) {
      const match = result.media.find((m) => m.idMal === malId) || null;
      return res.json({ season: result.season, seasonYear: result.seasonYear, media: match });
    }
    return res.json(result);
  } catch (e: any) {
    return res.status(502).json({ error: 'AniList season fetch failed', detail: aniListErrorDetail(e) });
  }
});

router.get('/anilist/top-banners', async (req: Request, res: Response) => {
  try {
    const limit = parseInt(req.query.limit as string, 10) || 200;
    const result = await getTopBanners(limit);
    const malId = req.query.malId as string;
    if (malId) {
      return res.json({ data: { [malId]: result[malId] ?? null } });
    }
    return res.json({ data: result });
  } catch (e: any) {
    return res.status(502).json({ error: 'AniList top-banners fetch failed', detail: aniListErrorDetail(e) });
  }
});

router.get('/anilist/id', async (req: Request, res: Response) => {
  const malId = parseInt(req.query.malId as string, 10);
  if (isNaN(malId)) return res.status(400).json({ error: 'malId required' });
  try {
    const anilistId = await malToAnilist(malId);
    if (!anilistId) return res.status(404).json({ error: 'Not found on AniList', malId });
    return res.json({ malId, anilistId });
  } catch (e: any) {
    return res.status(502).json({ error: 'AniList ID lookup failed', detail: aniListErrorDetail(e) });
  }
});

router.get('/anilist/episodes', async (req: Request, res: Response) => {
  const malId = parseInt(req.query.malId as string, 10);
  if (isNaN(malId)) return res.status(400).json({ error: 'malId required' });
  try {
    const episodes = await getStreamingEpisodes(malId);
    const ep = parseInt(req.query.ep as string, 10);
    if (!isNaN(ep)) {
      // Same "episode N" title-matching rule episode-thumb.ts already uses,
      // done here too so callers that only care about one episode don't
      // need to duplicate the regex client-side.
      const match = episodes.find((e) => {
        const m = (e.title ?? '').match(/(?:episode|ep\.?)\s*(\d+)/i);
        return m ? parseInt(m[1], 10) === ep : false;
      }) || null;
      return res.json({ malId, ep, episode: match });
    }
    return res.json({ malId, episodes });
  } catch (e: any) {
    return res.status(502).json({ error: 'AniList episodes fetch failed', detail: aniListErrorDetail(e) });
  }
});

// GET /api/anilist/anime?malId=21[&list=1]
// Poster + cover (banner) art from AniList — same shape as /tmdb/anime and
// /kitsu/anime, so all three can be used interchangeably. AniList maps
// straight off the MAL ID (no title search needed), same as
// /anilist/episodes above.
router.get('/anilist/anime', async (req: Request, res: Response) => {
  const malId = parseInt(req.query.malId as string, 10);
  if (isNaN(malId)) return res.status(400).json({ error: 'malId required' });

  const isList = req.query.list === '1';

  try {
    const { result, log } = await getAnilistAnimeImages(malId, isList);
    if (!result) return res.status(404).json({ error: 'No AniList images found', log });
    return res.json({ data: result, log });
  } catch (e: any) {
    return res.status(502).json({ error: 'AniList anime-images fetch failed', detail: aniListErrorDetail(e) });
  }
});

// Extracted out of resolveTmdbTitles so the combined /episodes endpoint can
// reuse the same base-title/season-hint logic on a title list it already
// has (from a MAL lookup it did for other reasons), without re-fetching MAL.
function computeTmdbTitleCandidates(rawTitles: string[], log: string[]): { titles: string[]; seasonHint: number | null } {
  let seasonHint: number | null = null;
  const baseTitles: string[] = [];
  for (const t of rawTitles) {
    const { base, season } = extractSeasonHint(t);
    if (season !== null && seasonHint === null) seasonHint = season;
    baseTitles.push(base);
  }
  const titles = [...new Set([...baseTitles, ...rawTitles])];
  log.push(`Titles to try: ${titles.join(' | ')}${seasonHint ? ` (season hint: ${seasonHint})` : ''}`);
  return { titles, seasonHint };
}

// Shared by every /tmdb/* route: resolves the candidate title(s) to search
// TMDB with, either from ?title= directly or from ?malId= via the MAL
// scraper (English title first, falling back to romaji/Japanese if English
// has no TMDB match), PLUS the implied season number.
//
// TMDB lists anime as one show with multiple seasons -- "Youjo Senki II"
// isn't a separate searchable title, only "Youjo Senki" is, with Season 2
// nested under it. So each raw title gets its season marker stripped via
// extractSeasonHint before searching; the stripped ("base") titles are tried
// first, with the original raw titles kept as a fallback in case the
// stripping was wrong for a given title. Returns null if neither ?title=
// nor a resolvable ?malId= was given.
async function resolveTmdbTitles(
  req: Request,
  log: string[]
): Promise<{ titles: string[]; seasonHint: number | null } | null> {
  const rawTitle = req.query.title as string | undefined;
  let rawTitles: string[];

  if (rawTitle) {
    rawTitles = [rawTitle];
  } else {
    const malId = parseInt(req.query.malId as string, 10);
    if (isNaN(malId)) return null;
    const details = await getAnimeDetails(malId);
    if (!details) return null;
    rawTitles = [...new Set([details.titleEnglish, details.title, details.titleJapanese].filter(
      (t): t is string => !!t
    ))];
  }

  return computeTmdbTitleCandidates(rawTitles, log);
}

// GET /api/tmdb/episode-thumb?ep=5(&title=...|&malId=16498)[&list=1]
// Ported from the site's episode-thumb.ts "Source 2: TMDB" block. Searches
// TMDB for the show by (base) title, then checks the hinted season first
// (falling back to seasons 1 and 2) for the requested episode number.
// `list=1` skips the cache (used by the admin debug view which wants a
// fresh lookup each time it's opened).
router.get('/tmdb/episode-thumb', async (req: Request, res: Response) => {
  const epNum = parseInt(req.query.ep as string, 10);
  if (isNaN(epNum)) return res.status(400).json({ error: 'Missing/invalid ?ep=' });
  if (!(req.query.title as string) && isNaN(parseInt(req.query.malId as string, 10))) {
    return res.status(400).json({ error: 'Provide ?title= or ?malId=' });
  }

  const isList = req.query.list === '1';
  const log: string[] = [];

  try {
    const resolved = await resolveTmdbTitles(req, log);
    if (!resolved) return res.status(404).json({ error: 'MAL ID not found', log });

    for (const title of resolved.titles) {
      const { result, log: srcLog } = await getTmdbEpisodeThumbnail(title, epNum, resolved.seasonHint, isList);
      log.push(...srcLog);
      if (result) return res.json({ data: result, log });
    }

    return res.status(404).json({ error: 'No TMDB still found', log });
  } catch (e: any) {
    return res.status(502).json({ error: 'TMDB episode-thumb fetch failed', detail: e?.message || String(e), log });
  }
});

// GET /api/tmdb/anime(?title=...|?malId=16498)[&list=1]
// Poster (cover), backdrop (banner), and logo for a show in one call — same
// title/season resolution as /tmdb/episode-thumb. Poster is fetched from the
// hinted season first (falling back to season 1, then the show-level
// poster) since TMDB gives each season its own key art; backdrop and logo
// are show-level (shared across all seasons) so no fallback is needed there.
router.get('/tmdb/anime', async (req: Request, res: Response) => {
  if (!(req.query.title as string) && isNaN(parseInt(req.query.malId as string, 10))) {
    return res.status(400).json({ error: 'Provide ?title= or ?malId=' });
  }

  const isList = req.query.list === '1';
  const log: string[] = [];

  try {
    const resolved = await resolveTmdbTitles(req, log);
    if (!resolved) return res.status(404).json({ error: 'MAL ID not found', log });

    for (const title of resolved.titles) {
      const { result, log: srcLog } = await getTmdbAnimeImages(title, resolved.seasonHint, isList);
      log.push(...srcLog);
      if (result) return res.json({ data: result, log });
    }

    return res.status(404).json({ error: 'No TMDB images found', log });
  } catch (e: any) {
    return res.status(502).json({ error: 'TMDB anime-images fetch failed', detail: e?.message || String(e), log });
  }
});

// Shared by /kitsu/* routes: resolves a MAL ID / title into a Kitsu anime
// ID (MAL mapping first, title search as fallback — see kitsu.ts). Fetches
// the MAL title lazily only when needed (malId given, no title, and the
// mapping fails) so the common case (malId with a working mapping) doesn't
// pay for an extra MAL scrape it doesn't need.
async function resolveKitsuAnimeId(req: Request, log: string[]): Promise<number | null | 'mal-not-found'> {
  const rawTitle = req.query.title as string | undefined;
  const malId = parseInt(req.query.malId as string, 10);

  let title = rawTitle ?? null;
  if (!title && !isNaN(malId)) {
    const details = await getAnimeDetails(malId);
    if (!details) return 'mal-not-found';
    title = details.titleEnglish || details.title;
    log.push(`Resolved MAL ID ${malId} -> title '${title}' (for Kitsu title-search fallback)`);
  }

  return getKitsuAnimeId(isNaN(malId) ? null : malId, title, log);
}

// GET /api/kitsu/episode-thumb?ep=5(&title=...|&malId=16498)[&list=1]
// Ported from the site's episode-thumb.ts "Source 1: Kitsu" block. Unlike
// TMDB, Kitsu mirrors MAL's per-season split (Season 2 has its own Kitsu
// anime ID mapped from the Season 2 MAL ID directly), so no season-hint
// stripping is needed here -- the MAL ID resolves straight to the right
// Kitsu anime, falling back to a title search only if that mapping is
// missing. `list=1` skips the cache.
router.get('/kitsu/episode-thumb', async (req: Request, res: Response) => {
  const epNum = parseInt(req.query.ep as string, 10);
  if (isNaN(epNum)) return res.status(400).json({ error: 'Missing/invalid ?ep=' });
  if (!(req.query.title as string) && isNaN(parseInt(req.query.malId as string, 10))) {
    return res.status(400).json({ error: 'Provide ?title= or ?malId=' });
  }

  const isList = req.query.list === '1';
  const log: string[] = [];

  try {
    const kitsuAnimeId = await resolveKitsuAnimeId(req, log);
    if (kitsuAnimeId === 'mal-not-found') return res.status(404).json({ error: 'MAL ID not found', log });
    if (!kitsuAnimeId) return res.status(404).json({ error: 'No Kitsu anime match found', log });

    const { result, log: srcLog } = await getKitsuEpisodeThumbnail(kitsuAnimeId, epNum, isList);
    log.push(...srcLog);
    if (!result) return res.status(404).json({ error: 'No Kitsu episode thumbnail found', log });

    return res.json({ data: result, log });
  } catch (e: any) {
    return res.status(502).json({ error: 'Kitsu episode-thumb fetch failed', detail: e?.message || String(e), log });
  }
});

// GET /api/kitsu/anime(?title=...|?malId=16498)[&list=1]
// Poster + cover (banner) art from Kitsu — same MAL-ID/title resolution as
// /kitsu/episode-thumb. Kitsu has no logo art type and no per-season art
// (each Kitsu anime ID is its own show, so there's nothing to fall back
// between the way TMDB's poster needed to).
router.get('/kitsu/anime', async (req: Request, res: Response) => {
  if (!(req.query.title as string) && isNaN(parseInt(req.query.malId as string, 10))) {
    return res.status(400).json({ error: 'Provide ?title= or ?malId=' });
  }

  const isList = req.query.list === '1';
  const log: string[] = [];

  try {
    const kitsuAnimeId = await resolveKitsuAnimeId(req, log);
    if (kitsuAnimeId === 'mal-not-found') return res.status(404).json({ error: 'MAL ID not found', log });
    if (!kitsuAnimeId) return res.status(404).json({ error: 'No Kitsu anime match found', log });

    const { result, log: srcLog } = await getKitsuAnimeImages(kitsuAnimeId, isList);
    log.push(...srcLog);
    if (!result) return res.status(404).json({ error: 'No Kitsu images found', log });

    return res.json({ data: result, log });
  } catch (e: any) {
    return res.status(502).json({ error: 'Kitsu anime-images fetch failed', detail: e?.message || String(e), log });
  }
});

// Same "episode N" title-matching rule used elsewhere (episode-thumb.ts,
// /anilist/episodes) for pulling a specific episode out of AniList's
// streamingEpisodes list, which has no explicit episode-number field.
function matchAnilistEpisode(episodes: AniListStreamingEpisode[], epNum: number): AniListStreamingEpisode | null {
  return episodes.find((e) => {
    const m = (e.title ?? '').match(/(?:episode|ep\.?)\s*(\d+)/i);
    return m ? parseInt(m[1], 10) === epNum : false;
  }) ?? null;
}

// Shared by /episodes/thumbnail (single ep) and /episodes/all (every ep):
// TMDB -> Kitsu -> AniList streamingEpisodes (last resort), returns
// whichever one hits first. `anilistEpisodes`, when passed in, is reused
// instead of re-fetched -- callers looping over every episode of a show
// fetch AniList's streamingEpisodes list ONCE up front and pass it into
// every call here, since it's the same list regardless of which episode
// is being resolved.
export interface ResolvedEpisode {
  title: string | null;
  titleJapanese: string | null;
  aired: string | null;
  filler: boolean | null;
  recap: boolean | null;
  infoSource: 'tmdb' | 'mal' | 'anilist' | 'kitsu' | null;
  thumbnail: string | null;
  thumbnailSource: 'tmdb' | 'kitsu' | 'anilist' | null;
  log: string[];
}

// Combined title/air-date/filler/recap/thumbnail resolution, TMDB -> MAL ->
// AniList -> Kitsu priority. TMDB goes first because MAL's own episode-list
// page can lag or drop a row for an airing show (confirmed against One
// Piece ep 1175: MAL's site had it, our scrape of that page didn't), while
// TMDB's per-episode REST endpoint has been reliably ahead of that.
//
// filler/recap have no equivalent anywhere but MAL, so those two fields are
// always sourced from MAL when available regardless of which source won
// title/aired/thumbnail -- a TMDB-sourced title doesn't blank out MAL's
// filler flag.
//
// This used to be two separate functions (resolveEpisodeThumbnail +
// resolveEpisodeInfo), each independently calling TMDB and Kitsu for the
// same episode row -- fine for a single episode, but whole-show mode calls
// this once per episode, so on a long-running show (One Piece: 1175+
// episodes) that doubled the outbound TMDB/Kitsu call count and was enough
// extra latency to trip the upstream request timeout. Merged into one pass
// using tmdb.getEpisodeData / kitsu.getEpisodeData (each a single request
// returning both fields) so a whole-show fetch costs the same per-episode
// call count it did before info resolution existed.
//
// `knownMalEpisode` lets whole-show mode pass in the row it already has
// from getAllMalEpisodes's bulk page scrape instead of triggering a fresh
// per-episode getMalEpisode() call here -- for an airing show that bypasses
// the page cache (see getEpisodes in mal.ts), calling getMalEpisode() once
// per episode in a loop re-scrapes the same MAL pages over and over, which
// is what actually caused the One Piece fetch to time out. Pass `undefined`
// (the default) to fetch it normally -- used by single-episode mode, which
// only does this once anyway.
async function resolveEpisode(
  malId: number,
  epNum: number,
  details: Awaited<ReturnType<typeof getAnimeDetails>>,
  isList: boolean,
  anilistEpisodes?: AniListStreamingEpisode[],
  knownMalEpisode?: MalEpisode | null
): Promise<ResolvedEpisode> {
  const log: string[] = [];
  const primaryTitle = details ? (details.titleEnglish || details.title) : null;

  const malEpisode = knownMalEpisode !== undefined
    ? knownMalEpisode
    : await getMalEpisode(malId, epNum).catch((e: any) => {
        log.push(`MAL lookup failed (${e?.message})`);
        return null;
      });

  let title: string | null = null;
  let titleJapanese: string | null = null;
  let aired: string | null = null;
  let infoSource: ResolvedEpisode['infoSource'] = null;
  let thumbnail: string | null = null;
  let thumbnailSource: ResolvedEpisode['thumbnailSource'] = null;

  // 1) TMDB (title + aired + thumbnail in one request)
  if (details) {
    const rawTitles = [...new Set([details.titleEnglish, details.title, details.titleJapanese].filter(
      (t): t is string => !!t
    ))];
    const { titles, seasonHint } = computeTmdbTitleCandidates(rawTitles, log);

    for (const t of titles) {
      const { result, log: srcLog } = await getTmdbEpisodeData(t, epNum, seasonHint, isList, malEpisode?.aired ?? null);
      log.push(...srcLog);
      if (result) {
        if (result.title) { title = result.title; aired = result.aired; infoSource = 'tmdb'; }
        if (result.thumbnail) { thumbnail = result.thumbnail; thumbnailSource = 'tmdb'; }
        if (title || thumbnail) break;
      }
    }
    if (!title) log.push('Episode info: not found on TMDB, trying MAL');
    if (!thumbnail) log.push('Thumbnail: not found on TMDB, trying Kitsu');
  } else {
    log.push('Episode info: no anime details, skipping TMDB, trying MAL');
    log.push('Thumbnail: no anime details, skipping TMDB, trying Kitsu');
  }

  // 2) MAL (title/aired only -- MAL has no thumbnail source)
  if (!title && malEpisode?.title) {
    title = malEpisode.title;
    titleJapanese = malEpisode.titleJapanese;
    aired = malEpisode.aired;
    infoSource = 'mal';
    log.push('Episode info: found via MAL');
  } else if (!title) {
    log.push('Episode info: not found on MAL, trying AniList');
  }

  // 3) Kitsu (title + aired + thumbnail in one request) -- tried before
  // AniList for thumbnail (matches the old priority) but only fills in
  // title/aired if still missing after MAL.
  if (!thumbnail || !title) {
    try {
      const kitsuAnimeId = await getKitsuAnimeId(malId, primaryTitle, log);
      if (kitsuAnimeId) {
        const { result } = await getKitsuEpisodeData(kitsuAnimeId, epNum, isList);
        if (result) {
          if (!thumbnail && result.thumbnail) {
            thumbnail = result.thumbnail;
            thumbnailSource = 'kitsu';
            log.push('Thumbnail: found via Kitsu');
          } else if (!thumbnail) {
            log.push('Thumbnail: not found on Kitsu, trying AniList');
          }
          if (!title && result.title) {
            title = result.title;
            titleJapanese = result.titleJapanese;
            aired = result.aired;
            infoSource = 'kitsu';
            log.push('Episode info: found via Kitsu');
          }
        } else {
          if (!thumbnail) log.push('Thumbnail: not found on Kitsu, trying AniList');
        }
      } else {
        if (!thumbnail) log.push('Thumbnail: no Kitsu anime match, trying AniList');
      }
    } catch (e: any) {
      log.push(`Kitsu lookup failed (${e?.message}), trying AniList`);
    }
  }

  // 4) AniList streamingEpisodes (last resort for both) -- one list fetch
  // (or reuse of the caller-supplied one) covers both title and thumbnail
  // since both live on the same matched entry. Titles come formatted
  // "Episode N - Real Title", so strip the leading "Episode N - " off.
  if (!title || !thumbnail) {
    try {
      const episodes = anilistEpisodes ?? (await getStreamingEpisodes(malId));
      const match = matchAnilistEpisode(episodes, epNum);
      if (!title && match?.title) {
        title = match.title.replace(/^episode\s*\d+\s*[-:]\s*/i, '').trim() || match.title;
        infoSource = 'anilist';
        log.push('Episode info: found via AniList streamingEpisodes');
      } else if (!title) {
        log.push('Episode info: not found on any source');
      }
      if (!thumbnail && match?.thumbnail) {
        thumbnail = match.thumbnail;
        thumbnailSource = 'anilist';
        log.push('Thumbnail: found via AniList streamingEpisodes');
      } else if (!thumbnail) {
        log.push('Thumbnail: not found on any source');
      }
    } catch (e: any) {
      log.push(`AniList lookup failed (${e?.message})`);
    }
  }

  return {
    title,
    titleJapanese: titleJapanese ?? malEpisode?.titleJapanese ?? null,
    aired: aired ?? malEpisode?.aired ?? null,
    filler: malEpisode?.filler ?? null,
    recap: malEpisode?.recap ?? null,
    infoSource,
    thumbnail,
    thumbnailSource,
    log,
  };
}

export interface ResolvedAnimeArt {
  poster: string | null;
  posterSource: 'tmdb' | 'kitsu' | 'anilist' | null;
  cover: string | null;
  coverSource: 'tmdb' | 'kitsu' | 'anilist' | null;
  logo: string | null;
  logoSource: 'tmdb' | null;
  log: string[];
}

// Shared by /anime (single anime metadata + art). Same fallback shape as
// resolveEpisodeThumbnail above: TMDB -> Kitsu -> AniList, tried in that
// order, first hit wins -- except poster and cover are resolved
// INDEPENDENTLY of each other, so e.g. a TMDB poster with no TMDB backdrop
// still lets Kitsu fill in the cover instead of forcing both down to the
// same source. Logo has no fallback at all -- TMDB is the only one of the
// three sources that has a logo art type (Kitsu and AniList don't), so
// logo is always TMDB-or-nothing, per request.
async function resolveAnimeArt(
  malId: number,
  details: Awaited<ReturnType<typeof getAnimeDetails>>,
  isList: boolean
): Promise<ResolvedAnimeArt> {
  const log: string[] = [];
  const primaryTitle = details ? (details.titleEnglish || details.title) : null;

  let poster: string | null = null;
  let posterSource: ResolvedAnimeArt['posterSource'] = null;
  let cover: string | null = null;
  let coverSource: ResolvedAnimeArt['coverSource'] = null;
  let logo: string | null = null;
  let logoSource: ResolvedAnimeArt['logoSource'] = null;

  // 1) TMDB -- covers poster, cover (backdrop), and logo all at once
  if (details) {
    const rawTitles = [...new Set([details.titleEnglish, details.title, details.titleJapanese].filter(
      (t): t is string => !!t
    ))];
    const { titles, seasonHint } = computeTmdbTitleCandidates(rawTitles, log);

    for (const t of titles) {
      const { result, log: srcLog } = await getTmdbAnimeImages(t, seasonHint, isList);
      log.push(...srcLog);
      if (result) {
        if (result.poster) { poster = result.poster; posterSource = 'tmdb'; }
        if (result.backdrop) { cover = result.backdrop; coverSource = 'tmdb'; }
        if (result.logo) { logo = result.logo; logoSource = 'tmdb'; }
        break;
      }
    }
    if (!poster) log.push('Poster: not found on TMDB, trying Kitsu');
    if (!cover) log.push('Cover: not found on TMDB, trying Kitsu');
    if (!logo) log.push('Logo: not found on TMDB (no fallback -- TMDB is the only logo source)');
  } else {
    log.push('No anime details -- skipping TMDB, trying Kitsu');
  }

  // 2) Kitsu -- only fills whichever of poster/cover TMDB didn't
  if (!poster || !cover) {
    try {
      const kitsuAnimeId = await getKitsuAnimeId(malId, primaryTitle, log);
      if (kitsuAnimeId) {
        const { result } = await getKitsuAnimeImages(kitsuAnimeId, isList);
        if (result) {
          if (!poster && result.poster) { poster = result.poster; posterSource = 'kitsu'; log.push('Poster: found via Kitsu'); }
          if (!cover && result.cover) { cover = result.cover; coverSource = 'kitsu'; log.push('Cover: found via Kitsu'); }
        }
        if (!poster) log.push('Poster: not found on Kitsu, trying AniList');
        if (!cover) log.push('Cover: not found on Kitsu, trying AniList');
      } else {
        log.push('No Kitsu anime match, trying AniList');
      }
    } catch (e: any) {
      log.push(`Kitsu lookup failed (${e?.message}), trying AniList`);
    }
  }

  // 3) AniList -- last resort, only fills whichever of poster/cover is still missing
  if (!poster || !cover) {
    try {
      const { result } = await getAnilistAnimeImages(malId, isList);
      if (result) {
        if (!poster && result.poster) { poster = result.poster; posterSource = 'anilist'; log.push('Poster: found via AniList'); }
        if (!cover && result.cover) { cover = result.cover; coverSource = 'anilist'; log.push('Cover: found via AniList'); }
      }
      if (!poster) log.push('Poster: not found on any source');
      if (!cover) log.push('Cover: not found on any source');
    } catch (e: any) {
      log.push(`AniList lookup failed (${e?.message})`);
    }
  }

  return { poster, posterSource, cover, coverSource, logo, logoSource, log };
}

// Bounded-concurrency map -- runs `fn` over `items` with at most `limit` in
// flight at once. Used by /episodes/all so a 1000+ episode show doesn't
// either (a) fire hundreds of simultaneous outbound requests at once (the
// exact thing that caused raw TLS/socket-reset errors on Railway, per the
// note on /episodes/thumbnail below) or (b) run fully sequentially and take
// minutes to respond.
async function mapWithConcurrency<T, R>(items: T[], limit: number, fn: (item: T, index: number) => Promise<R>): Promise<R[]> {
  const results: R[] = new Array(items.length);
  let next = 0;
  async function worker() {
    while (true) {
      const i = next++;
      if (i >= items.length) return;
      results[i] = await fn(items[i], i);
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return results;
}

// GET /api/anime?malId=23283[&list=1]
//
// Universal single-anime endpoint: MAL metadata (title, synopsis, genres,
// score, etc. -- everything getAnimeDetails already scrapes) PLUS poster,
// cover, and logo art resolved via resolveAnimeArt above, all in one call.
// Same TMDB -> Kitsu -> AniList fallback sequence as /episode uses for
// episode thumbnails; logo is TMDB-only (see resolveAnimeArt).
router.get('/anime', async (req: Request, res: Response) => {
  const malId = parseInt(req.query.malId as string, 10);
  if (isNaN(malId)) return res.status(400).json({ error: 'malId required' });

  const isList = req.query.list === '1';

  try {
    const details = await getAnimeDetails(malId);
    if (!details) return res.status(404).json({ error: 'MAL ID not found' });

    const { poster, posterSource, cover, coverSource, logo, logoSource, log } = await resolveAnimeArt(malId, details, isList);

    return res.json({
      data: {
        malId,
        title: details.title,
        titleEnglish: details.titleEnglish,
        titleJapanese: details.titleJapanese,
        synopsis: details.synopsis,
        type: details.type,
        episodes: details.episodes,
        status: details.status,
        aired: details.aired,
        premiered: details.premiered,
        duration: details.duration,
        rating: details.rating,
        score: details.score,
        scoredBy: details.scoredBy,
        rank: details.rank,
        popularity: details.popularity,
        members: details.members,
        genres: details.genres,
        studios: details.studios,
        source: details.source,
        streamingPlatforms: details.streamingPlatforms,
        poster,
        posterSource,
        cover,
        coverSource,
        logo,
        logoSource,
      },
      log,
    });
  } catch (e: any) {
    return res.status(502).json({ error: 'Combined anime fetch failed', detail: e?.message || String(e) });
  }
});

// GET /api/episode?malId=23283[&concurrency=5][&list=1]                -- all episodes
// GET /api/episode?malId=23283&ep=5[&list=1]                           -- one episode
//
// MAL-metadata + thumbnail combined lookup (distinct from the plural
// /episodes route above, which is the streaming-source episode ID list used
// for playback). Presence of ?ep= picks single-episode vs. whole-show mode;
// same response shape either way (title/aired/filler/recap + thumbnail
// resolved via Kitsu -> TMDB -> AniList), just wrapped in `episodes: []`
// instead of `data: {}` for the whole-show case.
//
// Thumbnail resolution is the slow part (each one is its own Kitsu/TMDB/
// AniList round trip). Single-episode mode runs it once, sequentially --
// firing several outbound HTTPS connections at once (MAL + AniList + Kitsu
// + TMDB simultaneously) here previously produced raw TLS/socket-reset
// errors, which points at Railway's container having a tight limit on
// concurrent outbound connections rather than a slowness problem.
// Whole-show mode runs it with bounded concurrency (?concurrency=, default
// 5, capped at 10) instead -- fully sequential would be too slow for
// long-running shows, fully parallel hits the same socket-reset problem.
// AniList's streamingEpisodes list is fetched once up front and shared
// across every episode's fallback lookup either way.
router.get('/episode', async (req: Request, res: Response) => {
  const malId = parseInt(req.query.malId as string, 10);
  if (isNaN(malId)) return res.status(400).json({ error: 'malId required' });

  const isList = req.query.list === '1';
  const hasEp = req.query.ep !== undefined;
  const epNum = parseInt(req.query.ep as string, 10);
  if (hasEp && isNaN(epNum)) return res.status(400).json({ error: '?ep must be a number' });

  try {
    const details = await getAnimeDetails(malId).catch(() => null);

    // Single episode
    if (hasEp) {
      const info = await resolveEpisode(malId, epNum, details, isList);

      if (!info.thumbnail && !info.title) return res.status(404).json({ error: 'No episode data found from any source', log: info.log });

      return res.json({
        data: {
          malId,
          episode: epNum,
          title: info.title,
          titleJapanese: info.titleJapanese,
          aired: info.aired,
          filler: info.filler,
          recap: info.recap,
          infoSource: info.infoSource,
          thumbnail: info.thumbnail,
          thumbnailSource: info.thumbnailSource,
        },
        log: info.log,
      });
    }

    // Whole show
    const concurrency = Math.min(Math.max(parseInt(req.query.concurrency as string, 10) || 5, 1), 10);
    const malEpisodes = await getAllMalEpisodes(malId).catch((e: any) => {
      throw new Error(`MAL episode list fetch failed: ${e?.message || e}`);
    });
    if (!malEpisodes.length) return res.status(404).json({ error: 'No episodes found on MAL for this malId' });

    const anilistEpisodes = await getStreamingEpisodes(malId).catch(() => [] as AniListStreamingEpisode[]);

    const episodes = await mapWithConcurrency(malEpisodes, concurrency, async (ep) => {
      const info = await resolveEpisode(malId, ep.malId, details, isList, anilistEpisodes, ep);
      return {
        episode: ep.malId,
        title: info.title ?? ep.title,
        titleJapanese: info.titleJapanese ?? ep.titleJapanese,
        aired: info.aired ?? ep.aired,
        filler: info.filler ?? ep.filler,
        recap: info.recap ?? ep.recap,
        infoSource: info.infoSource ?? 'mal',
        thumbnail: info.thumbnail,
        thumbnailSource: info.thumbnailSource,
      };
    });

    // MAL's episode-list page can lag or drop the newest row(s) for an
    // airing show (this is the "1174 vs 1175" bug -- MAL's own site had ep
    // 1175, our scrape of the page didn't). Cross-check the count TMDB
    // currently lists and pad in whatever tail episodes MAL is missing,
    // sourcing those extra rows through the same TMDB -> AniList -> Kitsu
    // chain (MAL skipped, since it's the source that's missing them).
    //
    // Gating this on "is MAL's own stated total bigger than what we
    // scraped" (details.episodes vs lastMalEp) alone -- what this did right
    // after the AoT fix -- broke padding for every currently-airing show:
    // MAL shows "Episodes: Unknown" while a show is still airing, so
    // details.episodes is null for One Piece, and `if (malStatedTotal &&
    // ...)` silently skipped padding entirely, bringing back the original
    // 1174-vs-1175 bug this was built to fix.
    //
    // The actual distinction that matters is airing status, not whether
    // MAL happened to print a number:
    //  - Still airing (status "Currently Airing"): MAL's total is
    //    necessarily unknown/growing, so there's nothing to bound padding
    //    against from MAL's side -- allow it, bounded by TMDB's count.
    //  - Finished, with a stated total bigger than the scrape: MAL's own
    //    page says there should be more than we found -- pad up to that
    //    stated total specifically (still the AoT-fix guard: never padded
    //    past what MAL itself claims *this entry* has, so a split-season
    //    MAL id like Attack on Titan S1 can't inherit S2's episodes just
    //    because TMDB's franchise-wide count is bigger).
    //  - Finished, stated total already matches the scrape: no padding,
    //    regardless of what TMDB's franchise total says (the AoT case).
    const lastMalEp = malEpisodes[malEpisodes.length - 1]?.malId ?? episodes.length;
    const malStatedTotal = details?.episodes ?? null;
    const isAiring = details?.status === 'Currently Airing';
    const malScrapeLooksIncomplete = isAiring || (malStatedTotal !== null && malStatedTotal > lastMalEp);

    if (malScrapeLooksIncomplete) {
      let tmdbCount: number | null = null;
      if (details) {
        const rawTitles = [...new Set([details.titleEnglish, details.title, details.titleJapanese].filter(
          (t): t is string => !!t
        ))];
        const dummyLog: string[] = [];
        const { titles } = computeTmdbTitleCandidates(rawTitles, dummyLog);
        for (const t of titles) {
          const found = await getTmdbEpisodeCount(t).catch(() => null);
          if (found) { tmdbCount = found.count; break; }
        }
      }

      // Pad up to whichever cap actually applies:
      //  - MAL states a total for this entry -> never pad past it (the
      //    split-season guard), further capped by TMDB's count if smaller.
      //  - MAL's total is unknown (still airing) -> nothing from MAL to
      //    cap against, so TMDB's count is the only ceiling; if TMDB has
      //    no count either, there's nothing to pad with.
      const targetTotal = malStatedTotal !== null
        ? (tmdbCount ? Math.min(malStatedTotal, tmdbCount) : malStatedTotal)
        : (tmdbCount ?? lastMalEp);

      if (targetTotal > lastMalEp) {
      const missingNums = Array.from({ length: targetTotal - lastMalEp }, (_, i) => lastMalEp + 1 + i);
      const padded = await mapWithConcurrency(missingNums, concurrency, async (num) => {
        // knownMalEpisode: null (not undefined) -- these are exactly the
        // episodes MAL's own list didn't have, so skip MAL entirely instead
        // of triggering a scrape that's already known to be missing this row.
        const info = await resolveEpisode(malId, num, details, isList, anilistEpisodes, null);
        return {
          episode: num,
          title: info.title,
          titleJapanese: info.titleJapanese,
          aired: info.aired,
          filler: info.filler,
          recap: info.recap,
          infoSource: info.infoSource,
          thumbnail: info.thumbnail,
          thumbnailSource: info.thumbnailSource,
        };
      });
      // Only keep padded rows that actually resolved to something -- an
      // empty TMDB placeholder row is worse than just stopping at MAL's count.
      episodes.push(...padded.filter((e) => e.title));
      }
    }

    return res.json({
      malId,
      title: details ? (details.titleEnglish || details.title) : null,
      count: episodes.length,
      episodes,
    });
  } catch (e: any) {
    return res.status(502).json({ error: 'Combined episode fetch failed', detail: e?.message || String(e) });
  }
});

router.get('/health', (_req, res) => {
  // Unified with anivault.co's /healthz shape ({ status, checks, external })
  // so status.anivault.co can render both services the same way.
  //
  // Note: `sources` below is a static list of configured scraper backends,
  // not a live reachability check against animeheaven/anikoto
  // themselves — probing those would mean firing real scrape requests on
  // every health check, which risks tripping their own rate limits/WAFs.
  // Worth adding later as opt-in, lower-frequency probes if that's wanted.
  const stats = cacheStats();
  const process_: { ok: boolean; label: string; detail: string; badges: { label: string; value: string }[]; critical: boolean } = {
    ok: true,
    label: 'Scraper Process',
    detail: 'API process is running and serving requests.',
    badges: [{ label: 'Uptime', value: `${Math.floor(process.uptime() / 60)}m` }],
    critical: true,
  };
  const cache: { ok: boolean; label: string; detail: string; badges: { label: string; value: string }[]; critical: boolean } = {
    ok: true,
    label: 'Response Cache',
    detail: 'In-memory cache is active.',
    badges: [
      { label: 'Keys', value: String(stats.keys ?? 0) },
      { label: 'Hits', value: String(stats.hits ?? 0) },
      { label: 'Misses', value: String(stats.misses ?? 0) },
    ],
    critical: false,
  };

  res.json({
    status: 'ok',
    checks: { process: process_, cache },
    external: {},
    meta: { version: '1.1.0-anikoto', sources: SOURCES },
    timestamp: new Date().toISOString(),
  });
});

export default router;
