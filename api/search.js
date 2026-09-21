import { Router } from 'express';
import * as soundcloud from '../lib/soundcloud.js';
import * as youtube from '../lib/youtube.js';
import { durationLimits, MAX_TRACKS, playable } from '../lib/tracks.js';

const router = Router();

// A search shows both sources at once, weighted towards YouTube because that is
// where most links come from. SoundCloud earns its slots by carrying the tracks
// YouTube uploaders block from embedding.
const RESULT_LIMIT = 8;
const YOUTUBE_SHARE = 5;

/** What the client needs to offer an import: the tracks themselves stay server side. */
function preview(playlist, url) {
  return {
    provider: playlist.provider,
    title: playlist.title,
    author: playlist.author,
    artwork: playlist.artwork,
    count: playlist.tracks.length,
    playable: playlist.tracks.filter(playable).length,
    url,
  };
}

/** Fills the list from both sources, giving away unused slots rather than gaps. */
function merge(youtubeResults, soundcloudResults) {
  const scShare = RESULT_LIMIT - YOUTUBE_SHARE;
  const fromYoutube = youtubeResults.slice(0, Math.max(YOUTUBE_SHARE, RESULT_LIMIT - soundcloudResults.length));
  const fromSoundcloud = soundcloudResults.slice(0, Math.max(scShare, RESULT_LIMIT - youtubeResults.length));
  return [...fromYoutube, ...fromSoundcloud].slice(0, RESULT_LIMIT);
}

router.get('/', async (req, res) => {
  const query = String(req.query.q ?? '').trim();
  if (!query) return res.json({ results: [] });

  try {
    // A pasted link resolves to exactly that track instead of searching. A
    // link to a playlist comes back as a preview the client can offer to
    // import; a watch link with a list= on it gets both.
    const videoId = youtube.parseVideoId(query);
    const listId = youtube.parsePlaylistId(query);
    if (videoId || listId) {
      const playlist = listId ? await youtube.playlistById(listId, MAX_TRACKS) : null;
      const response = { results: [], exact: true };
      if (playlist && !playlist.error) response.playlist = preview(playlist, query);

      if (videoId) {
        const track = await youtube.trackById(videoId);
        if (!track) response.error = 'That video cannot be played here';
        else if (!(await youtube.embeddable(videoId))) {
          response.error = 'The uploader blocked this video from playing outside YouTube';
        } else {
          response.results = [track];
          response.playable = playable(track);
        }
      } else if (playlist?.error) {
        response.error = playlist.error;
      }
      return res.json(response);
    }

    const soundcloudUrl = soundcloud.parseUrl(query);
    if (soundcloudUrl) {
      const playlist = await soundcloud.playlistByUrl(soundcloudUrl, MAX_TRACKS);
      if (playlist && !playlist.error) {
        return res.json({ results: [], exact: true, playlist: preview(playlist, query) });
      }
      const track = await soundcloud.trackByUrl(soundcloudUrl);
      if (!track) return res.json({ results: [], error: 'That SoundCloud link went nowhere' });
      if (track.error) return res.json({ results: [], error: track.error });
      return res.json({ results: [track], exact: true, playable: playable(track) });
    }

    // One source being down or rate limited still leaves the other usable.
    const [fromYoutube, fromSoundcloud] = await Promise.allSettled([
      youtube.search(query, RESULT_LIMIT),
      soundcloud.search(query, RESULT_LIMIT),
    ]);

    for (const [name, outcome] of [['youtube', fromYoutube], ['soundcloud', fromSoundcloud]]) {
      if (outcome.status === 'rejected') console.error(`${name} search failed:`, outcome.reason?.message);
    }

    const results = merge(
      fromYoutube.status === 'fulfilled' ? fromYoutube.value : [],
      fromSoundcloud.status === 'fulfilled' ? fromSoundcloud.value : [],
    );

    if (results.length === 0 && fromYoutube.status === 'rejected' && fromSoundcloud.status === 'rejected') {
      return res.status(502).json({ error: 'Search is unavailable right now', results: [] });
    }

    return res.json({ results, limits: durationLimits });
  } catch (error) {
    console.error('search failed:', error.message);
    res.status(502).json({ error: 'Search is unavailable right now', results: [] });
  }
});

export default router;
