// Keyless SoundCloud search and metadata.
//
// SoundCloud's documented API needs a registered application, and registration
// has been shut for years. Its web player talks to api-v2 with a client id it
// ships inside one of its script bundles, so the id is read from there and the
// operator has nothing to sign up for. That id rotates, so it is fetched on
// demand and thrown away as soon as a call comes back 401.
//
// SoundCloud is here because YouTube uploaders can forbid embedding, and a
// video the room cannot embed is a video the room cannot play. SoundCloud has
// no equivalent switch beyond embeddable_by, which is checked below.

import { playable } from './tracks.js';

const API = 'https://api-v2.soundcloud.com';
const WEB = 'https://soundcloud.com/discover';
const CACHE_TTL = 1000 * 60 * 30;
const TIMEOUT = 10000;

// The bundles are served to browsers; the default node agent gets a 403.
const UA =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36';

const HOSTS = new Set(['soundcloud.com', 'on.soundcloud.com', 'snd.sc']);

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

function get(url, options = {}) {
  return fetch(url, {
    headers: { 'user-agent': UA },
    signal: AbortSignal.timeout(TIMEOUT),
    ...options,
  });
}

let clientIdPromise = null;

async function scrapeClientId() {
  const home = await get(WEB);
  if (!home.ok) throw new Error(`soundcloud home -> ${home.status}`);
  const html = await home.text();

  const scripts = [...html.matchAll(/<script[^>]+src="(https:\/\/a-v2\.sndcdn\.com\/[^"]+)"/g)].map(
    (match) => match[1],
  );

  // The id lives in one of the last bundles on the page, so start from the end.
  for (const src of scripts.reverse()) {
    const asset = await get(src);
    if (!asset.ok) continue;
    const hit = (await asset.text()).match(/client_id\s*[:=]\s*["']([A-Za-z0-9]{32})["']/);
    if (hit) return hit[1];
  }

  throw new Error('no client id in the soundcloud web player');
}

function clientId({ refresh = false } = {}) {
  if (refresh) clientIdPromise = null;
  clientIdPromise ??= scrapeClientId().catch((error) => {
    // A failed lookup must not be cached, or the next call inherits the failure.
    clientIdPromise = null;
    throw error;
  });
  return clientIdPromise;
}

/** Returns null for a 404, so a missing track reads differently from an outage. */
async function api(path, params = {}, { retry = true } = {}) {
  const url = new URL(API + path);
  for (const [key, value] of Object.entries(params)) url.searchParams.set(key, value);
  url.searchParams.set('client_id', await clientId());

  const res = await get(url);

  // 401 means our scraped id aged out, not that the caller asked for something
  // private, so it is worth one retry with a freshly read id.
  if (res.status === 401 && retry) {
    await clientId({ refresh: true });
    return api(path, params, { retry: false });
  }
  if (res.status === 404) return null;
  if (!res.ok) throw new Error(`soundcloud ${path} -> ${res.status}`);
  return res.json();
}

/**
 * Whether everyone in the room can hear the whole thing.
 *
 * SNIP is the important one: those tracks stream 30 seconds to anyone without
 * a Go+ subscription, so the room would spend the rest of the slot in silence.
 * The flag is regional, so a listener elsewhere can still hit a snip the
 * server never saw; the player reports that and the room skips on.
 */
function openToEveryone(raw) {
  return (
    raw.streamable !== false &&
    raw.sharing !== 'private' &&
    raw.embeddable_by === 'all' &&
    raw.policy !== 'SNIP' &&
    raw.policy !== 'BLOCK'
  );
}

/** SoundCloud serves artwork at a size chosen through the filename. */
function artwork(raw) {
  const url = raw.artwork_url ?? raw.user?.avatar_url ?? null;
  return url ? url.replace('-large.', '-t200x200.') : null;
}

function toTrack(raw) {
  if (raw?.kind !== 'track' || !raw.id) return null;

  const duration = Math.round(Number(raw.duration ?? 0) / 1000);
  if (!Number.isFinite(duration) || duration <= 0) return null;

  return {
    provider: 'soundcloud',
    sourceId: String(raw.id),
    title: raw.title?.trim() || 'Untitled',
    author: raw.user?.username?.trim() || 'Unknown',
    duration,
    artwork: artwork(raw),
  };
}

/** The canonical soundcloud.com URL for anything the user might paste, or null. */
export function parseUrl(input) {
  const raw = String(input ?? '').trim();

  let url;
  try {
    url = new URL(raw);
  } catch {
    return null;
  }

  const host = url.hostname.replace(/^www\.|^m\./, '');
  return HOSTS.has(host) ? url.toString() : null;
}

/** Short links have to be followed before api-v2 will resolve them. */
async function canonical(url) {
  if (new URL(url).hostname.replace(/^www\.|^m\./, '') === 'soundcloud.com') return url;
  const res = await get(url, { redirect: 'follow' });
  return res.url || url;
}

export async function search(query, limit = 10) {
  const key = `s:${query}:${limit}`;
  const hit = cached(key);
  if (hit) return hit;

  // Asking for extra covers what the snip and embed filters throw away.
  const body = await api('/search/tracks', { q: query, limit: 40 });

  const tracks = [];
  for (const raw of body?.collection ?? []) {
    if (!openToEveryone(raw)) continue;
    const track = toTrack(raw);
    if (playable(track)) tracks.push(track);
    if (tracks.length >= limit) break;
  }

  return store(key, tracks);
}

export async function trackById(sourceId) {
  const id = String(sourceId ?? '').trim();
  if (!/^\d+$/.test(id)) return null;

  const key = `t:${id}`;
  const hit = cached(key);
  if (hit) return hit;

  const raw = await api(`/tracks/${id}`);
  if (!raw || !openToEveryone(raw)) return null;

  const track = toTrack(raw);
  return track ? store(key, track) : null;
}

/** Whatever api-v2 says lives at a soundcloud.com URL: a track, a playlist, a user, or null. */
async function resolve(url) {
  const key = `r:${url}`;
  const hit = cached(key);
  if (hit) return hit;

  const raw = await api('/resolve', { url: await canonical(url) });
  return raw ? store(key, raw) : null;
}

export async function trackByUrl(url) {
  const raw = await resolve(url);
  if (!raw) return null;
  // A playlist or a profile link resolves fine and is not something to queue.
  if (raw.kind !== 'track') {
    return {
      error:
        raw.kind === 'playlist'
          ? 'That link is a playlist; use Import to add all of it'
          : 'That link is not a single track',
    };
  }
  if (!openToEveryone(raw)) {
    return { error: 'SoundCloud only offers a preview of that track, so the room cannot play it' };
  }

  return toTrack(raw);
}

// api-v2 answers a batch lookup for this many ids at once.
const BATCH = 50;

/**
 * Every playable track in a set, in set order, up to `limit`.
 *
 * The resolve call carries full objects for only the first few tracks; the
 * rest are stubs with an id and a policy, so those are filled in through
 * /tracks?ids=. Stubs whose policy already says preview-only are dropped
 * before that, which saves a request on the sets where it matters most.
 */
export async function playlistByUrl(url, limit = 500) {
  const raw = await resolve(url);
  if (!raw) return null;
  if (raw.kind !== 'playlist') {
    return { error: raw.kind === 'track' ? 'That link is a single track, not a playlist' : 'That link is not a playlist' };
  }

  const key = `pl:${raw.id}:${limit}`;
  const hit = cached(key);
  if (hit) return hit;

  const entries = (raw.tracks ?? []).filter((t) => t?.id && t.policy !== 'SNIP' && t.policy !== 'BLOCK');
  const full = new Map();
  const missing = [];
  for (const entry of entries) {
    if (entry.title !== undefined) full.set(entry.id, entry);
    else missing.push(entry.id);
    if (full.size + missing.length >= limit) break;
  }

  for (let i = 0; i < missing.length; i += BATCH) {
    const batch = await api('/tracks', { ids: missing.slice(i, i + BATCH).join(',') });
    for (const track of batch ?? []) full.set(track.id, track);
  }

  const tracks = [];
  for (const entry of entries) {
    const track = full.get(entry.id);
    if (!track || !openToEveryone(track)) continue;
    const parsed = toTrack(track);
    if (parsed) tracks.push(parsed);
    if (tracks.length >= limit) break;
  }

  return store(key, {
    provider: 'soundcloud',
    title: raw.title?.trim() || 'SoundCloud playlist',
    author: raw.user?.username?.trim() || null,
    artwork: artwork(raw) ?? tracks[0]?.artwork ?? null,
    tracks,
  });
}
