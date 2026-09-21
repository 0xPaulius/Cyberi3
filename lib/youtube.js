// Keyless YouTube search and metadata via youtubei.js (YouTube's InnerTube API).
// No API key, no quota, nothing for the operator to sign up for.

import { Innertube, Log } from 'youtubei.js';
import { playable } from './tracks.js';

// The parser warns about every rich-text run it cannot map, which on a
// playlist page is one line per video with a multi-artist credit.
Log.setLevel(Log.Level.ERROR);

const CACHE_TTL = 1000 * 60 * 30;

let clientPromise;

function client() {
  // retrieve_player: false skips signature deciphering. We only need metadata,
  // the browser's embedded player handles playback.
  clientPromise ??= Innertube.create({ retrieve_player: false, generate_session_locally: true });
  return clientPromise;
}

const cache = new Map();

function cached(key) {
  const hit = cache.get(key);
  if (!hit) return null;
  if (Date.now() - hit.at > CACHE_TTL) {
    cache.delete(key);
    return null;
  }
  return hit.value;
}

function store(key, value) {
  cache.set(key, { at: Date.now(), value });
  if (cache.size > 500) cache.delete(cache.keys().next().value);
  return value;
}

const text = (value) => {
  if (!value) return '';
  if (typeof value === 'string') return value;
  return value.text ?? value.toString?.() ?? '';
};

function toTrack(video) {
  const duration = Number(video?.duration?.seconds ?? 0);
  const id = video?.id ?? video?.video_id;
  if (!id || !Number.isFinite(duration)) return null;
  return {
    provider: 'youtube',
    sourceId: id,
    title: text(video.title) || 'Untitled',
    author: text(video.author?.name ?? video.author) || 'Unknown',
    duration,
  };
}

/**
 * Whether the uploader allows the video to play outside youtube.com.
 *
 * The obvious source, the player endpoint's playabilityStatus, is useless for
 * this: YouTube answers UNPLAYABLE for almost every request that has no signed
 * in session, so trusting it would reject nearly every video. The oEmbed
 * endpoint is not gated that way and answers 401 for exactly the videos the
 * IFrame player rejects with error 101 or 150, which is the case we care about.
 *
 * Fails open. A network blip should not stop someone building a playlist, and
 * the room still skips a video that turns out to be blocked at play time.
 */
export async function embeddable(videoId) {
  const key = `e:${videoId}`;
  const hit = cached(key);
  if (hit !== null) return hit.allowed;

  const target = encodeURIComponent(`https://www.youtube.com/watch?v=${videoId}`);
  try {
    const res = await fetch(`https://www.youtube.com/oembed?format=json&url=${target}`, {
      signal: AbortSignal.timeout(5000),
    });
    if (res.ok) return store(key, { allowed: true }).allowed;
    // 401 is the embed block; 403 and 404 are private and deleted videos,
    // which the player cannot show either. Anything else (429 from a bulk
    // import, a 5xx) says nothing about the video, so it is neither cached
    // nor held against it.
    if ([401, 403, 404].includes(res.status)) return store(key, { allowed: false }).allowed;
    return true;
  } catch {
    return true;
  }
}

export async function search(query, limit = 25) {
  const key = `s:${query}`;
  const hit = cached(key);
  if (hit) return hit;

  const yt = await client();
  const results = await yt.search(query, { type: 'video' });

  const tracks = [];
  for (const video of results.videos ?? []) {
    // Live streams have no meaningful duration, so they cannot be synced.
    if (video.is_live || video.is_upcoming) continue;
    const track = toTrack(video);
    if (playable(track)) tracks.push(track);
    if (tracks.length >= limit) break;
  }

  return store(key, tracks);
}

const ID = /^[A-Za-z0-9_-]{11}$/;

/** Pulls a video id out of any of the URL shapes YouTube uses, or a bare id. */
export function parseVideoId(input) {
  const raw = String(input ?? '').trim();
  if (ID.test(raw)) return raw;

  let url;
  try {
    url = new URL(raw);
  } catch {
    return null;
  }

  const host = url.hostname.replace(/^www\.|^m\./, '');
  if (host === 'youtu.be') {
    const id = url.pathname.slice(1).split('/')[0];
    return ID.test(id) ? id : null;
  }
  if (!host.endsWith('youtube.com')) return null;

  const v = url.searchParams.get('v');
  if (v && ID.test(v)) return v;

  const path = url.pathname.match(/^\/(?:embed|shorts|live|v)\/([A-Za-z0-9_-]{11})/);
  return path ? path[1] : null;
}

async function fromPlayerEndpoint(videoId) {
  try {
    const yt = await client();
    const basic = (await yt.getBasicInfo(videoId))?.basic_info;
    if (!basic?.id || basic.is_live) return null;

    const duration = Number(basic.duration ?? 0);
    if (!Number.isFinite(duration) || duration <= 0) return null;

    return {
      provider: 'youtube',
      sourceId: basic.id,
      title: basic.title ?? 'Untitled',
      author: basic.author ?? 'Unknown',
      duration,
    };
  } catch {
    return null;
  }
}

/**
 * YouTube gates its player endpoint behind "sign in to confirm you're not a
 * bot" for requests from datacenter IPs, which breaks metadata lookup on a
 * hosted server. Its search endpoint is not gated and carries everything we
 * need, so resolve the id through search instead.
 */
async function fromSearchEndpoint(videoId) {
  try {
    const yt = await client();
    const results = await yt.search(videoId, { type: 'video' });
    for (const video of results.videos ?? []) {
      if ((video.id ?? video.video_id) !== videoId) continue;
      return video.is_live || video.is_upcoming ? null : toTrack(video);
    }
    return null;
  } catch {
    return null;
  }
}

export async function trackById(videoId) {
  const key = `v:${videoId}`;
  const hit = cached(key);
  if (hit) return hit;

  const track = (await fromPlayerEndpoint(videoId)) ?? (await fromSearchEndpoint(videoId));
  return track ? store(key, track) : null;
}

const LIST_ID = /^[A-Za-z0-9_-]{2,128}$/;

/**
 * Pulls a playlist id out of a YouTube URL, or null. Only URLs count: a bare
 * id looks too much like a search someone typed.
 */
export function parsePlaylistId(input) {
  let url;
  try {
    url = new URL(String(input ?? '').trim());
  } catch {
    return null;
  }

  const host = url.hostname.replace(/^www\.|^m\.|^music\./, '');
  if (host !== 'youtu.be' && !host.endsWith('youtube.com')) return null;

  const list = url.searchParams.get('list');
  return list && LIST_ID.test(list) ? list : null;
}

/** "1:27:41" or "4:01" to seconds; null for LIVE, SHORTS, or anything else. */
function parseClock(text) {
  const parts = String(text ?? '').trim().split(':');
  if (parts.length < 2 || parts.length > 3 || !parts.every((p) => /^\d+$/.test(p))) return null;
  return parts.reduce((total, part) => total * 60 + Number(part), 0);
}

/**
 * Playlist pages arrive as LockupViews, YouTube's newer layout, where the
 * duration is only a badge drawn over the thumbnail and the author is the
 * first metadata row. Deleted and private videos come through with no
 * duration badge at all, which is what drops them here.
 */
function fromLockup(item) {
  if (item.content_type !== 'VIDEO' || !ID.test(item.content_id ?? '')) return null;

  let duration = null;
  for (const overlay of item.content_image?.overlays ?? []) {
    for (const badge of overlay.badges ?? []) {
      duration ??= parseClock(badge.text);
    }
  }
  if (duration === null) return null;

  const rows = item.metadata?.metadata?.metadata_rows ?? [];
  const author = text(rows[0]?.metadata_parts?.[0]?.text);

  return {
    provider: 'youtube',
    sourceId: item.content_id,
    title: text(item.metadata?.title) || 'Untitled',
    author: author || 'Unknown',
    duration,
  };
}

function fromPlaylistItem(item) {
  if (item.type === 'LockupView') return fromLockup(item);
  if (item.type === 'PlaylistVideo') {
    if (!item.is_playable || item.is_live || item.is_upcoming) return null;
    return toTrack(item);
  }
  return null;
}

/**
 * Every video in a playlist that has a duration, in playlist order, up to
 * `limit`. Returns { error } for the lists YouTube will not hand out: mixes
 * are generated per viewer, Watch Later and Liked Videos need a sign in.
 * Does not check duration limits or embeddability; the caller decides what
 * to do with the ones that fail.
 */
export async function playlistById(listId, limit = 500) {
  if (listId.startsWith('RD')) {
    return { error: 'YouTube mixes are generated per viewer and cannot be imported' };
  }
  if (listId === 'WL' || listId.startsWith('LL')) {
    return { error: 'Watch Later and Liked Videos are private to your YouTube account' };
  }

  const key = `p:${listId}:${limit}`;
  const hit = cached(key);
  if (hit) return hit;

  const yt = await client();
  let first;
  try {
    first = await yt.getPlaylist(listId);
  } catch (error) {
    // youtubei.js throws the same way for "does not exist" and "is private".
    console.error('playlist lookup failed:', error.message);
    return { error: 'That playlist is private or does not exist' };
  }

  let page = first;
  const tracks = [];
  const seen = new Set();
  // A playlist page carries 100 videos; everything past that is a continuation.
  for (let pages = 0; page && pages < 20; pages++) {
    for (const item of page.items ?? []) {
      const track = fromPlaylistItem(item);
      if (!track || seen.has(track.sourceId)) continue;
      seen.add(track.sourceId);
      tracks.push(track);
      if (tracks.length >= limit) break;
    }
    if (tracks.length >= limit || !page.has_continuation) break;
    page = await page.getContinuation();
  }

  return store(key, {
    provider: 'youtube',
    title: first.info?.title?.trim() || 'YouTube playlist',
    author: text(first.info?.author?.name) || null,
    artwork: tracks[0] ? `https://i.ytimg.com/vi/${tracks[0].sourceId}/mqdefault.jpg` : null,
    tracks,
  });
}
