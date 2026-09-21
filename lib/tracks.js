// What a track looks like once a provider has resolved it, and the rules that
// apply whatever it was resolved from.
//
// Every provider returns the same shape:
//   { provider, sourceId, title, author, duration, artwork? }
// where duration is whole seconds and sourceId is whatever that provider needs
// to play the thing again: a YouTube video id, a SoundCloud track id.

export const PROVIDERS = ['youtube', 'soundcloud'];

const MAX_DURATION = 60 * 20; // Keeps one DJ from parking the booth on a 3 hour mix.
const MIN_DURATION = 5;

export const durationLimits = { min: MIN_DURATION, max: MAX_DURATION };

// Per playlist. Also how far into a source playlist an import bothers to read.
export const MAX_TRACKS = 500;

export function playable(track) {
  return Boolean(track) && track.duration >= MIN_DURATION && track.duration <= MAX_DURATION;
}

export function isProvider(value) {
  return PROVIDERS.includes(value);
}
