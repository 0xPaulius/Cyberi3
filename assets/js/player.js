// Keeps the room's current track lined up with the server's playback clock.
//
// Nobody "streams" audio from the room: every client plays the same track and
// seeks to the same offset, so the room hears roughly the same thing. Seeks in
// an embedded player are coarse, so expect sub-second rather than exact sync.
//
// Two providers, one interface. This file owns the clock, the volume and the
// decision to give up on a track; assets/js/players/* own the embeds.

import { serverNow, socket } from './socket.js';
import { createSoundcloud } from './players/soundcloud.js';
import { createYoutube } from './players/youtube.js';

const DRIFT_TOLERANCE = 1.5;
const DRIFT_CHECK_MS = 5000;
const DEFAULT_VOLUME = 70;

const backends = new Map();
let active = null;
let current = null;
let pending = null;
let started = false;
let muted = false;
let volume = DEFAULT_VOLUME;
let onStateText = () => {};
let onProviderChange = () => {};
let retriedSourceId = null;

/** Reports a track this client could not play, once per fault. */
function fail(permanent, message) {
  if (!current) return;
  const backend = backends.get(current.provider);

  // A transient fault gets one reload before the room is asked to skip.
  if (!permanent && backend?.isReady() && retriedSourceId !== current.sourceId) {
    retriedSourceId = current.sourceId;
    onStateText('Playback hiccup — retrying.');
    backend.load(current, Math.max(0, elapsed(current)));
    return;
  }

  onStateText(message);
  socket.emit('player:unplayable', { sourceId: current.sourceId, permanent });
}

/**
 * Must be called from a click. Browsers block audible autoplay without a user
 * gesture, so the room sits behind an explicit "enter" button and both players
 * are built while that click still counts.
 */
export async function createPlayer({ onStatus, onProvider } = {}) {
  onStateText = onStatus ?? onStateText;
  onProviderChange = onProvider ?? onProviderChange;

  const shared = {
    onError: (_reason, permanent) =>
      fail(
        permanent,
        permanent
          ? 'The room cannot play this one — skipping.'
          : 'Playback failed — skipping.',
      ),
    onPaused: () => resync(true),
  };

  backends.set('youtube', createYoutube({ elementId: 'ytplayer', ...shared }));
  backends.set('soundcloud', createSoundcloud({ elementId: 'scplayer', ...shared }));

  // One provider failing to load must not cost the room the other.
  await Promise.allSettled([...backends.values()].map((backend) => backend.create()));
  started = true;

  applyVolume();
  if (pending) {
    const next = pending;
    pending = null;
    play(next);
  }

  setInterval(() => resync(false), DRIFT_CHECK_MS);
}

export function isReady() {
  return [...backends.values()].some((backend) => backend.isReady());
}

function elapsed(track) {
  return (serverNow() - track.startedAt) / 1000;
}

/** Points the right player at the room's current track, at the right offset. */
export function play(track) {
  if (!track) return stop();

  // Before "enter the room" there is nothing to play into; that click starts it.
  if (!started) {
    pending = track;
    return;
  }

  const backend = backends.get(track.provider);
  if (!backend?.isReady()) {
    // This provider's embed never loaded here. Say so, rather than leaving one
    // listener in silence for the whole track.
    current = track;
    fail(false, 'This player did not load — skipping.');
    return;
  }

  const sameTrack = current?.sourceId === track.sourceId && current?.startedAt === track.startedAt;
  current = track;

  const seconds = elapsed(track);
  if (seconds > track.duration) return;

  if (sameTrack && active === backend) return resync(true);

  if (active && active !== backend) active.stop();
  active = backend;
  onProviderChange(backend.name);

  // A new track gets a clean slate: no stale warning, and its own retry.
  onStateText('');
  retriedSourceId = null;

  backend.load(track, Math.max(0, seconds));
  applyVolume();
}

export function stop() {
  current = null;
  // Nothing is playing, so a warning about the last track is stale.
  onStateText('');
  active?.stop();
}

function resync(force) {
  if (!active || !current) return;

  const expected = elapsed(current);
  if (expected < 0 || expected > current.duration) return;

  const drift = Math.abs(active.position() - expected);
  if (force || drift > DRIFT_TOLERANCE) active.seek(expected);
  if (!active.isPlaying()) active.resume();
}

function applyVolume() {
  for (const backend of backends.values()) {
    if (backend.isReady()) backend.setVolume(volume, muted);
  }
}

export function setVolume(value) {
  volume = Math.max(0, Math.min(100, Number(value)));
  if (volume > 0) muted = false;
  applyVolume();
  return { volume, muted };
}

export function toggleMute() {
  // A slider at zero is already silent and the button shows it as muted, so
  // one press has to bring the sound back rather than mute a second time.
  muted = !(muted || volume === 0);
  if (!muted && volume === 0) volume = DEFAULT_VOLUME;
  applyVolume();
  return { volume, muted };
}

export function playbackPosition() {
  if (!current) return null;
  return { elapsed: Math.max(0, elapsed(current)), duration: current.duration };
}
