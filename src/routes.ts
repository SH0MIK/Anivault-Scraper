import { Router, Request, Response } from 'express';
import axios from 'axios';
import { malToAnilist, getSiteIds, searchAnilist } from './utils/mapper';
import { cacheStats } from './utils/cache';
import { resolveEmbed } from './resolvers/megacloud';

import { getEpisodes, getServers, getEmbedUrl } from './scrapers/senshi';
import { getHeavenEpisodes, getHeavenServers, getHeavenStream } from './scrapers/animeheaven';
import { getMiruroEpisodes, getMiruroServers, getMiruroEmbedUrl } from './scrapers/miruro';
import { getAnikotoEpisodes, getAnikotoServers, getAnikotoEmbedUrl } from './scrapers/anikoto';

const router = Router();

const SOURCES = ['senshi', 'animeheaven', 'miruro', 'anikoto'] as const;
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
  return body
    .split(/\r?\n/)
    .map((line) => {
      const trimmed = line.trim();
      if (!trimmed) return line;
      if (trimmed.startsWith('#EXT-X-KEY') && trimmed.includes('URI=')) {
        return line.replace(/URI="([^"]+)"/, (_m, uri) => {
          const absolute = new URL(uri, base).toString();
          return `URI="${proxiedHlsUrl(req, absolute, ref)}"`;
        });
      }
      if (trimmed.startsWith('#')) return line;
      return proxiedHlsUrl(req, new URL(trimmed, base).toString(), ref);
    })
    .join('\n');
}

async function resolveAlId(anilistId?: string, malId?: string): Promise<number | null> {
  if (anilistId) return parseInt(anilistId);
  if (malId) return malToAnilist(parseInt(malId));
  return null;
}

async function fetchEpisodes(source: Source, siteIds: any, overrides: { heavenId?: string } = {}): Promise<{ episodes: any[]; siteId: string; error?: string }> {
  const zoroId = siteIds.siteIds?.zoro as string | undefined;
  const heavenId = overrides.heavenId || (siteIds.siteIds?.animeheaven as string | undefined);

  if (source === 'senshi') {
    if (!siteIds.malId) return { episodes: [], siteId: '', error: 'Missing MAL ID for Senshi' };
    const senshiId = String(siteIds.malId);
    return { episodes: await getEpisodes(senshiId), siteId: senshiId };
  }
  if (source === 'animeheaven') {
    if (!heavenId) return { episodes: [], siteId: '', error: 'Not indexed on AnimeHeaven' };
    return { episodes: await getHeavenEpisodes(heavenId), siteId: heavenId };
  }
  if (source === 'miruro') {
    if (!siteIds.anilistId) return { episodes: [], siteId: '', error: 'Missing AniList ID for Miruro' };
    const alId = siteIds.anilistId as number;
    return { episodes: await getMiruroEpisodes(alId), siteId: String(alId) };
  }
  if (source === 'anikoto') {
    const slug = siteIds.siteIds?.anikoto as string | undefined;
    if (!slug) return { episodes: [], siteId: '', error: 'Not indexed on Anikoto' };
    return { episodes: await getAnikotoEpisodes(slug), siteId: slug };
  }
  return { episodes: [], siteId: '', error: 'Unknown source' };
}

router.get('/search', async (req: Request, res: Response) => {
  const q = req.query.q as string;
  if (!q) return res.status(400).json({ error: 'Missing ?q=' });
  try {
    const results = await searchAnilist(q);
    return res.json({ query: q, count: results.length, results });
  } catch (e) {
    return res.status(500).json({ error: 'Search failed', detail: String(e) });
  }
});

router.get('/info', async (req: Request, res: Response) => {
  const { anilistId, malId } = req.query;
  if (!anilistId && !malId) return res.status(400).json({ error: 'Provide ?anilistId= or ?malId=' });
  try {
    const alId = await resolveAlId(anilistId as string, malId as string);
    if (!alId) return res.status(404).json({ error: 'Anime not found on AniList' });
    const info = await getSiteIds(alId);
    if (!info) return res.status(404).json({ error: 'Could not fetch info' });

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

router.get('/episodes', async (req: Request, res: Response) => {
  const { anilistId, malId, source = 'senshi', heavenId } = req.query;
  if (!anilistId && !malId && !(source === 'animeheaven' && heavenId)) return res.status(400).json({ error: 'Provide ?anilistId= or ?malId=, or ?heavenId= for AnimeHeaven' });
  if (!SOURCES.includes(source as Source)) return res.status(400).json({ error: `source must be: ${SOURCES.join(', ')}` });
  try {
    if (source === 'animeheaven' && heavenId && !anilistId && !malId) {
      const episodes = await getHeavenEpisodes(String(heavenId));
      return res.json({ anilistId: null, malId: null, title: null, source, siteId: String(heavenId), count: episodes.length, episodes });
    }

    const alId = await resolveAlId(anilistId as string, malId as string);
    if (!alId) return res.status(404).json({ error: 'Anime not found' });
    const siteIds = await getSiteIds(alId);
    if (!siteIds) return res.status(404).json({ error: 'Could not resolve site IDs' });
    const result = await fetchEpisodes(source as Source, siteIds, { heavenId: heavenId ? String(heavenId) : undefined });
    if (result.error) return res.status(404).json({ error: result.error });
    return res.json({ anilistId: alId, malId: siteIds.malId, title: siteIds.title, source, siteId: result.siteId, count: result.episodes.length, episodes: result.episodes });
  } catch (e) {
    return res.status(500).json({ error: String(e) });
  }
});

router.get('/servers', async (req: Request, res: Response) => {
  const { anilistId, malId, ep, type = 'sub', source = 'senshi', heavenId } = req.query;
  if (!ep) return res.status(400).json({ error: 'Missing ?ep=' });
  if (!anilistId && !malId && !(source === 'animeheaven' && heavenId)) return res.status(400).json({ error: 'Provide ?anilistId= or ?malId=, or ?heavenId= for AnimeHeaven' });
  const epNum = parseInt(ep as string);
  if (isNaN(epNum)) return res.status(400).json({ error: '?ep must be a number' });
  if (!SOURCES.includes(source as Source)) return res.status(400).json({ error: `source must be: ${SOURCES.join(', ')}` });

  try {
    const siteIds = heavenId && source === 'animeheaven'
      ? { anilistId: null, malId: null, title: null, siteIds: { animeheaven: String(heavenId) } }
      : await (async () => {
          const alId = await resolveAlId(anilistId as string, malId as string);
          if (!alId) return null;
          return getSiteIds(alId);
        })();
    if (!siteIds) return res.status(404).json({ error: 'Could not resolve site IDs' });

    const epResult = await fetchEpisodes(source as Source, siteIds, { heavenId: heavenId ? String(heavenId) : undefined });
    if (epResult.error) return res.status(404).json({ error: epResult.error });
    const episode = epResult.episodes.find((e: any) => Math.round(e.num) === epNum);
    if (!episode) return res.status(404).json({ error: `Episode ${epNum} not found` });

    let allServers: any[] = [];
    if (source === 'senshi') allServers = await getServers(episode.id);
    if (source === 'animeheaven') allServers = await getHeavenServers(episode.id);
    if (source === 'miruro') allServers = await getMiruroServers(episode.id);
    if (source === 'anikoto') allServers = await getAnikotoServers(episode.id);

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
      : await (async () => {
          const alId = await resolveAlId(anilistId, malId);
          if (!alId) return null;
          return getSiteIds(alId);
        })();
    if (!siteIds) return res.status(404).json({ error: 'Could not resolve anime' });

    const epResult = await fetchEpisodes(source as Source, siteIds, { heavenId: heavenOverride });
    if (epResult.error) return res.status(404).json({ error: epResult.error });

    const episode = epResult.episodes.find((e: any) => Math.round(e.num) === epNum);
    if (!episode) return res.status(404).json({ error: `Episode ${epNum} not found` });

    let allServers: any[] = [];
    if (source === 'senshi') allServers = await getServers(episode.id);
    if (source === 'animeheaven') allServers = await getHeavenServers(episode.id);
    if (source === 'miruro') allServers = await getMiruroServers(episode.id);
    if (source === 'anikoto') allServers = await getAnikotoServers(episode.id);

    const filtered = allServers.filter((s: any) => s.type === type);
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
      if (source === 'senshi') raw = await getEmbedUrl(server.sourceId);
      if (source === 'animeheaven') raw = await getHeavenStream(server.sourceId);
      if (source === 'miruro') raw = await getMiruroEmbedUrl(server.sourceId);
      if (source === 'anikoto') raw = await getAnikotoEmbedUrl(server.sourceId);
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

    // Miruro streams are usually direct HLS — the embedUrl IS the m3u8
    // regardless of whether the path contains ".m3u8", since CDN providers
    // (moo, bonk, bee, etc.) use extension-less signed URLs. But some
    // providers mix embed-page links into the same streams list with no hls
    // entry at all; getMiruroEmbedUrl now reports which kind it actually
    // picked via embedResult.type, so branch on that instead of assuming.
    //
    // IMPORTANT: do not fall back to a fixed "https://www.miruro.tv/" referer
    // here. Each provider's CDN (bonk/kiwi/bee/moo/...) is a separate edge host
    // that enforces its own Referer/Origin check; sending miruro.tv to a CDN
    // that doesn't expect it gets the request 403'd, which is why most sources
    // were resolving fine but failing to actually play. getMiruroEmbedUrl now
    // resolves the correct provider-specific referer when one exists; if it
    // legitimately found none, we pass undefined through and let the proxy
    // omit the header rather than send a guaranteed-wrong one.
    if (source === 'miruro') {
      const isHls = embedResult.type === 'hls';
      const url = embedResult.embedUrl as string;
      return res.json({
        anilistId: siteIds.anilistId,
        malId: siteIds.malId,
        title: siteIds.title,
        episode: epNum,
        type,
        source,
        server: usedServer,
        availableServers: filtered.map((s: any) => s.name),
        embedUrl: url,
        m3u8: isHls ? url : null,
        hlsProxyUrl: isHls ? proxiedHlsUrl(req, url, embedResult.referer) : null,
        playbackMode: isHls ? 'hls' : 'iframe',
        iframeOnly: !isHls,
        subtitles: [],
        intro: null,
        outro: null,
        note: isHls ? null : 'This provider returned no HLS stream for this episode/category — use embedUrl in an iframe.',
      });
    }

    // Anikoto's embed resolution (getAnikotoEmbedUrl) already fully resolves
    // the stream internally — Megacloud/Megaplay decryption for regular
    // servers, or a direct CDN m3u8 for the Kiwi Mapper side-channel — so,
    // like Miruro, it skips the generic resolveEmbed() fallback below.
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

  // Only senshi/dao/wave/animeheaven embeds are actually tied to senshi.live;
  // defaulting to it unconditionally meant any source whose embedResult had no
  // referer (most miruro providers) silently got sent to upstream CDNs with
  // the wrong Referer/Origin and got rejected — sources resolved but never
  // played. If no ref was supplied, omit the headers entirely instead of
  // guessing; most CDNs tolerate a missing Referer far better than a wrong one.
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
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/137.0.0.0 Safari/537.36',
        'Accept': '*/*',
        'Accept-Language': 'en-US,en;q=0.9',
        ...(referer ? { Referer: referer } : {}),
        ...(origin ? { Origin: origin } : {}),
      },
    });

    const contentType = String(upstream.headers['content-type'] ?? '');
    const body = Buffer.from(upstream.data);
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Cache-Control', 'public, max-age=30');

    if (url.includes('.m3u8') || contentType.includes('mpegurl')) {
      const text = body.toString('utf8');
      if (!text.trim().startsWith('#EXTM3U')) {
        return res.status(502).json({ error: 'Upstream did not return a valid m3u8 playlist', body: text.slice(0, 300) });
      }
      res.type('application/vnd.apple.mpegurl');
      return res.send(rewriteHlsPlaylist(req, text, url, ref));
    }

    res.type(contentType || 'application/octet-stream');
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
  const { anilistId, malId, heavenId, ep, type = 'sub', source = 'senshi', server } = req.query;
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


// ── DEBUG: dump raw miruro pipe sources (remove before production) ──────────
router.get('/debug/miruro-sources', async (req: Request, res: Response) => {
  const { anilistId, provider, category, episodeId } = req.query as Record<string, string>;
  if (!anilistId || !provider || !category || !episodeId) {
    return res.status(400).json({ error: 'Required: anilistId, provider, category, episodeId' });
  }
  try {
    const { getMiruroEmbedUrl } = await import('./scrapers/miruro');
    // sourceId format: anilistId::provider::category::episodeId
    const sourceId = `${anilistId}::${provider}::${category}::${episodeId}`;
    
    // Call fetchSources directly by re-implementing inline here for debug visibility
    const axios2 = (await import('axios')).default;
    const { Buffer: Buf } = await import('buffer');
    const zlib2 = await import('zlib');
    
    const PIPE_URL = 'https://www.miruro.tv/api/secure/pipe';
    const H = {
      'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/137.0.0.0 Safari/537.36',
      'Referer': 'https://www.miruro.tv/',
      'Origin': 'https://www.miruro.tv',
    };
    const encId = Buf.from(episodeId).toString('base64url');
    const payload = { path: 'sources', method: 'GET', query: { episodeId: encId, provider, category, anilistId: parseInt(anilistId) }, body: null, version: '0.1.0' };
    const encodedReq = Buf.from(JSON.stringify(payload)).toString('base64url');
    const r = await axios2.get(`${PIPE_URL}?e=${encodedReq}`, { headers: H, timeout: 15000, responseType: 'text', transformResponse: (d: any) => d });
    const padded = r.data + '='.repeat((4 - (r.data.length % 4)) % 4);
    const raw = JSON.parse(zlib2.gunzipSync(Buf.from(padded, 'base64url')).toString('utf-8'));
    
    return res.json({ sourceId, raw });
  } catch (e: any) {
    return res.status(500).json({ error: String(e?.message || e), stack: String(e?.stack || '') });
  }
});


// ── DEBUG: inspect raw miruro pipe sources for a provider ──────────────────
// GET /api/debug/miruro?anilistId=21&provider=bonk&ep=1&category=sub
router.get('/debug/miruro', async (req: Request, res: Response) => {
  try {
    const anilistId = parseInt(req.query.anilistId as string);
    const provider  = (req.query.provider  as string) || 'bonk';
    const epNum     = parseInt((req.query.ep as string) || '1');
    const category  = ((req.query.category as string) || 'sub') as 'sub' | 'dub' | 'raw';

    if (isNaN(anilistId)) return res.status(400).json({ error: 'anilistId required' });

    const servers = await getMiruroServers(`${anilistId}:${epNum}`);
    const match   = servers.find(s => s.name === `${provider}-${category}`);
    if (!match) return res.json({ error: 'server not found', available: servers.map(s => s.name) });

    // Pull the raw episode ID out of the sourceId
    const parts        = match.sourceId.split('::');
    const rawEpisodeId = parts.slice(3).join('::');

    // Re-encode and call the pipe directly (same as fetchSources does internally)
    const { Buffer } = await import('buffer');
    const zlib        = await import('zlib');
    const encId       = Buffer.from(rawEpisodeId).toString('base64url');
    const payload     = { path: 'sources', method: 'GET', query: { episodeId: encId, provider, category, anilistId }, body: null, version: '0.1.0' };
    const encodedReq  = Buffer.from(JSON.stringify(payload)).toString('base64url');

    const pipeRes = await axios.get(`https://www.miruro.tv/api/secure/pipe?e=${encodedReq}`, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/137.0.0.0 Safari/537.36',
        'Referer': 'https://www.miruro.tv/',
      },
      timeout: 15000,
      responseType: 'text',
      transformResponse: (d: any) => d,
    });

    const padded       = pipeRes.data + '='.repeat((4 - (pipeRes.data.length % 4)) % 4);
    const compressed   = Buffer.from(padded, 'base64url');
    const decompressed = zlib.gunzipSync(compressed);
    const raw          = JSON.parse(decompressed.toString('utf-8'));

    return res.json({
      sourceId:     match.sourceId,
      rawEpisodeId,
      pipeTopLevelKeys: Object.keys(raw),
      streams:      raw.streams ?? null,
      headers:      raw.headers ?? null,
      intro:        raw.intro   ?? null,
      raw,
    });
  } catch (e: any) {
    return res.status(500).json({ error: String(e?.message || e), stack: e?.stack });
  }
});

router.get('/health', (_req, res) => {
  res.json({ status: 'ok', version: '1.1.0-anikoto', sources: SOURCES, uptime: Math.floor(process.uptime()), cache: cacheStats(), timestamp: new Date().toISOString() });
});

export default router;
