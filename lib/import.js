// Resolving a pasted link to a whole playlist, whichever service it is on.
//
// Both providers return the same shape:
//   { provider, title, author, artwork, tracks: Track[] }
// with tracks in the order the playlist has them, already stripped of what
// the service itself will not stream (deleted videos, preview-only tracks).
// Duration limits, embed blocks and duplicates are the caller's business.

import * as soundcloud from './soundcloud.js';
import * as youtube from './youtube.js';

/**
 * null when the input is not a playlist link at all, { error } when it is one
 * that cannot be read, otherwise the playlist.
 */
export async function resolvePlaylistLink(input, limit) {
  const listId = youtube.parsePlaylistId(input);
  if (listId) return youtube.playlistById(listId, limit);

  const soundcloudUrl = soundcloud.parseUrl(input);
  if (soundcloudUrl) {
    const playlist = await soundcloud.playlistByUrl(soundcloudUrl, limit);
    return playlist ?? { error: 'That SoundCloud link went nowhere' };
  }

  return null;
}

/**
 * Runs `fn` over `items` no more than `limit` at a time. A 500 video playlist
 * means 500 embed checks, and firing them all at once is how oEmbed starts
 * answering 429.
 */
export async function mapLimit(items, limit, fn) {
  const results = new Array(items.length);
  let next = 0;
  async function worker() {
    while (next < items.length) {
      const index = next++;
      results[index] = await fn(items[index], index);
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return results;
}
