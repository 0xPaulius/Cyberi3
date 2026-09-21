import { Router } from 'express';
import {
  addTrack,
  addTracks,
  createPlaylist,
  deletePlaylist,
  getPlaylist,
  listPlaylists,
  listTracks,
  removeTrack,
  renamePlaylist,
  reorderTracks,
  setActivePlaylist,
  getTrack,
} from '../lib/db.js';
import * as soundcloud from '../lib/soundcloud.js';
import * as youtube from '../lib/youtube.js';
import { durationLimits, MAX_TRACKS, playable } from '../lib/tracks.js';
import { mapLimit, resolvePlaylistLink } from '../lib/import.js';
import { requireUser } from '../lib/session.js';

const router = Router();
router.use(requireUser);

const EMBED_CHECKS_AT_ONCE = 8;

/**
 * Turns whatever the client sent — a search result, a pasted link — into a
 * track, or into an { error } worth showing. Always resolved here rather than
 * trusted from the request, so nobody can queue a title and duration of their
 * own invention.
 */
async function resolveTrack({ provider, sourceId, url }) {
  const input = String(sourceId ?? url ?? '').trim();
  if (!input) return { error: 'Need a link or a track to add' };

  const soundcloudUrl = soundcloud.parseUrl(input);
  if (soundcloudUrl || provider === 'soundcloud') {
    const track = soundcloudUrl
      ? await soundcloud.trackByUrl(soundcloudUrl)
      : await soundcloud.trackById(input);
    return track ?? { error: 'That SoundCloud track cannot be played here' };
  }

  const videoId = youtube.parseVideoId(input);
  if (!videoId) return { error: 'Need a YouTube or SoundCloud link' };

  const track = await youtube.trackById(videoId);
  if (!track) return { error: 'That video cannot be played here' };
  // Catch an embed block now rather than when the DJ's turn comes and the
  // whole room watches a dead player.
  if (!(await youtube.embeddable(videoId))) {
    return { error: 'The uploader blocked this video from playing outside YouTube' };
  }
  return track;
}

function ownPlaylist(req, res, next) {
  const playlist = getPlaylist(Number(req.params.id));
  if (!playlist || playlist.user_id !== req.user.id) {
    return res.status(404).json({ error: 'Playlist not found' });
  }
  req.playlist = playlist;
  next();
}

const cleanName = (value) => String(value ?? '').trim().slice(0, 60);

router.get('/', (req, res) => {
  res.json({
    playlists: listPlaylists(req.user.id),
    activePlaylistId: req.user.active_playlist_id,
  });
});

router.post('/', (req, res) => {
  const name = cleanName(req.body?.name) || 'New playlist';
  const id = createPlaylist(req.user.id, name);
  res.status(201).json({ id, name, track_count: 0 });
});

router.patch('/:id', ownPlaylist, (req, res) => {
  const name = cleanName(req.body?.name);
  if (!name) return res.status(400).json({ error: 'Name cannot be empty' });
  renamePlaylist(req.playlist.id, name);
  res.json({ id: req.playlist.id, name });
});

router.delete('/:id', ownPlaylist, (req, res) => {
  const remaining = listPlaylists(req.user.id).filter((p) => p.id !== req.playlist.id);
  if (remaining.length === 0) {
    return res.status(400).json({ error: 'You need at least one playlist' });
  }

  deletePlaylist(req.playlist.id);
  if (req.user.active_playlist_id === req.playlist.id) {
    setActivePlaylist(req.user.id, remaining[0].id);
  }
  res.json({ ok: true, activePlaylistId: remaining[0].id });
});

router.post('/:id/activate', ownPlaylist, (req, res) => {
  setActivePlaylist(req.user.id, req.playlist.id);
  res.json({ activePlaylistId: req.playlist.id });
});

router.get('/:id/tracks', ownPlaylist, (req, res) => {
  res.json({ tracks: listTracks(req.playlist.id) });
});

router.post('/:id/tracks', ownPlaylist, async (req, res) => {
  if (listTracks(req.playlist.id).length >= MAX_TRACKS) {
    return res.status(400).json({ error: `Playlists hold up to ${MAX_TRACKS} tracks` });
  }

  try {
    const track = await resolveTrack(req.body ?? {});
    if (track.error) return res.status(400).json({ error: track.error });

    if (!playable(track)) {
      const maxMinutes = Math.floor(durationLimits.max / 60);
      return res.status(400).json({ error: `Tracks must be under ${maxMinutes} minutes` });
    }

    const id = addTrack(req.playlist.id, track);
    res.status(201).json({ track: { id, playlist_id: req.playlist.id, ...track } });
  } catch (error) {
    console.error('add track failed:', error.message);
    res.status(502).json({ error: 'Could not reach that music service' });
  }
});

/**
 * Adds everything at a YouTube or SoundCloud playlist link, in order, under
 * the same rules a single add follows. Nothing is rejected outright: a track
 * that is too long, blocked from embedding, or already in the playlist is
 * counted and skipped, and the counts come back so the client can say what
 * happened to the rest.
 */
router.post('/:id/import', ownPlaylist, async (req, res) => {
  const url = String(req.body?.url ?? '').trim();
  if (!url) return res.status(400).json({ error: 'Paste a YouTube or SoundCloud playlist link' });

  const existing = listTracks(req.playlist.id);
  const room = MAX_TRACKS - existing.length;
  if (room <= 0) {
    return res.status(400).json({ error: `Playlists hold up to ${MAX_TRACKS} tracks` });
  }

  try {
    const source = await resolvePlaylistLink(url, MAX_TRACKS);
    if (!source) return res.status(400).json({ error: 'That is not a YouTube or SoundCloud playlist link' });
    if (source.error) return res.status(400).json({ error: source.error });

    const skipped = { duplicate: 0, duration: 0, blocked: 0, full: 0 };
    const seen = new Set(existing.map((t) => `${t.provider}:${t.source_id}`));

    const candidates = [];
    for (const track of source.tracks) {
      const key = `${track.provider}:${track.sourceId}`;
      if (seen.has(key)) {
        skipped.duplicate++;
        continue;
      }
      seen.add(key);
      if (!playable(track)) {
        skipped.duration++;
        continue;
      }
      candidates.push(track);
    }

    // The embed check runs before the size cap so a blocked video does not
    // use up a slot that a later playable one could have had.
    const allowed = await mapLimit(candidates, EMBED_CHECKS_AT_ONCE, (track) =>
      track.provider === 'youtube' ? youtube.embeddable(track.sourceId) : true,
    );
    const accepted = candidates.filter((_, index) => allowed[index]);
    skipped.blocked = candidates.length - accepted.length;

    const added = accepted.slice(0, room);
    skipped.full = accepted.length - added.length;

    addTracks(req.playlist.id, added);

    res.json({
      title: source.title,
      provider: source.provider,
      found: source.tracks.length,
      added: added.length,
      skipped,
      tracks: listTracks(req.playlist.id),
    });
  } catch (error) {
    console.error('import failed:', error.message);
    res.status(502).json({ error: 'Could not reach that music service' });
  }
});

router.delete('/:id/tracks/:trackId', ownPlaylist, (req, res) => {
  const track = getTrack(Number(req.params.trackId));
  if (!track || track.playlist_id !== req.playlist.id) {
    return res.status(404).json({ error: 'Track not found' });
  }
  removeTrack(track.id);
  res.json({ ok: true });
});

router.post('/:id/shuffle', ownPlaylist, (req, res) => {
  const ids = listTracks(req.playlist.id).map((t) => t.id);
  for (let i = ids.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [ids[i], ids[j]] = [ids[j], ids[i]];
  }
  reorderTracks(req.playlist.id, ids);
  res.json({ tracks: listTracks(req.playlist.id) });
});

router.put('/:id/tracks/order', ownPlaylist, (req, res) => {
  const ids = Array.isArray(req.body?.ids) ? req.body.ids.map(Number).filter(Number.isInteger) : null;
  if (!ids) return res.status(400).json({ error: 'Expected an array of track ids' });
  reorderTracks(req.playlist.id, ids);
  res.json({ tracks: listTracks(req.playlist.id) });
});

export default router;
