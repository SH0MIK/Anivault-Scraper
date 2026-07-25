<div align="center">

# AniVault Scraper API

**The video-sourcing backend for [AniVault](https://www.anivault.co).**

Resolves anime titles → episodes → live, playable streams (sub & dub) across
multiple streaming providers, with built-in HLS/subtitle/video proxying so
everything plays with clean CORS, no matter what the upstream server sends.

</div>

---

## How it works

```mermaid
flowchart LR
    Client([AniVault site / Senshi Player]) -->|1: search / info| API[Scraper API]
    API -->|AniList + MAL ID mapping| AniList[(AniList GraphQL)]
    Client -->|2: episodes| API
    Client -->|3: servers| API
    Client -->|4: watch| API
    API -->|scrape| Sources{{Senshi · AnimeHeaven<br/>Miruro · Anikoto}}
    Sources -->|embed / m3u8 / mp4| API
    API -->|proxied stream + subtitles| Client
```

A typical playback flow is `search → info → episodes → servers → watch`:
resolve the anime, list its episodes, list which servers have episode N,
then resolve that server into an actual playable stream. `/watch` can also
be called directly if you already know the source/episode.

## Sources

| Source | Status | Notes |
|---|---|---|
| **Senshi** (senshi.live) | ✅ Verified | Behind Cloudflare — requires **FlareSolverr** to solve the challenge before scraping |
| **AnimeHeaven** (animeheaven.me) | ✅ Verified | Not behind Cloudflare, no FlareSolverr needed — direct MP4 sources |
| **Anikoto** (anikoto.net) | ✅ Verified | Megacloud/Megaplay decryption + a direct-CDN side channel |
| **Miruro** (miruro.tv) | ⚠️ **Offline** | Upstream pipe endpoint is currently down — requests will fail until it comes back |

FlareSolverr runs as a separate service; set `FLARESOLVERR_URL` in the
environment so Senshi requests can solve the Cloudflare challenge. The API
also pings it periodically to keep it warm on free-tier hosts.

## Endpoints

All routes are mounted under `/api`.

### `GET /api/search?q=`
Search AniList for a title.
```
GET /api/search?q=naruto
→ { query, count, results[] }
```

### `GET /api/info`
Resolve an anime's AniList/MAL IDs and per-source site IDs.
| Param | Required | Notes |
|---|---|---|
| `anilistId` | one of these | |
| `malId` | one of these | |
```
GET /api/info?malId=20
→ { anilistId, malId, title, siteIds: { zoro, animeheaven, anikoto, ... } }
```

### `GET /api/episodes`
List episodes for a title on a given source.
| Param | Required | Notes |
|---|---|---|
| `anilistId` / `malId` | yes* | *unless `heavenId` is used with `source=animeheaven` |
| `source` | no | `senshi` \| `animeheaven` \| `miruro` \| `anikoto` (default `senshi`) |
| `heavenId` | no | manual AnimeHeaven show id |
```
GET /api/episodes?anilistId=20&source=senshi
→ { anilistId, malId, title, source, siteId, count, episodes[] }
```

### `GET /api/servers`
List available servers (sub/dub) for a specific episode.
| Param | Required | Notes |
|---|---|---|
| `anilistId` / `malId` | yes* | |
| `ep` | **yes** | episode number |
| `type` | no | `sub` \| `dub` \| `all` (default `sub`) |
| `source` | no | default `senshi` |
| `heavenId` | no | manual AnimeHeaven show id |
```
GET /api/servers?anilistId=20&ep=1&type=sub&source=senshi
→ { anilistId, malId, title, episode, type, source, servers[] }
```

### `GET /api/watch/:source/:id/:ep/:type`
Resolve a real, playable stream for an episode — the main playback endpoint.
| Path param | Notes |
|---|---|
| `source` | `senshi` \| `animeheaven` \| `miruro` \| `anikoto` |
| `id` | AniList id (or `mal-{id}`, or AnimeHeaven id) |
| `ep` | episode number |
| `type` | `sub` \| `dub` |

| Query param | Notes |
|---|---|
| `server` | prefer a specific server by name |
| `strict` | `1`/`true` — only use `server`, don't fall back to others |

```
GET /api/watch/senshi/20/1/sub
GET /api/watch/miruro/20/1/sub?server=bonk-sub
→ { embedUrl, m3u8, hlsProxyUrl, playbackMode, subtitles[], server, availableServers[], ... }
```

### `GET /api/watch`
Same as above, as query params instead of a path — useful when building a
URL dynamically.
```
GET /api/watch?source=senshi&anilistId=20&ep=1&type=sub
```

### `GET /api/proxy/hls?url=&ref=`
Proxies an `.m3u8` playlist (and rewrites internal segment/key URIs to also
route through this proxy) so the browser never hits the upstream CDN
directly — fixes CORS and Referer/Origin restrictions.

### `GET /api/proxy/subtitle?url=&ref=`
Proxies a subtitle track with open CORS, converting SRT → WEBVTT on the fly
if needed.

### `GET /api/proxy/video?url=`
Proxies a direct MP4 stream (used by AnimeHeaven), forwarding `Range`
requests for seeking.

### `GET /api/health`
```
→ { status, version, sources[], uptime, cache, timestamp }
```

### Debug (internal)
`GET /api/debug/miruro` and `GET /api/debug/miruro-sources` dump the raw
Miruro pipe response for a given provider/episode — used for diagnosing the
current Miruro outage, not part of the stable public surface.

## Tech stack

| | |
|---|---|
| Runtime | Node.js (Express), TypeScript |
| Scraping | Cheerio, Axios |
| Cloudflare bypass | FlareSolverr |
| Caching | node-cache (in-memory), optional Upstash Redis |
| Hosting | Railway |

## Status

Senshi, AnimeHeaven, and Anikoto are live and verified. Miruro is currently
**offline** upstream — its pipe endpoint is down, and the debug routes above
exist specifically to track when it comes back.

