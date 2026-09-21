// SoundCloud backend for the room player, driving the widget embed.
//
// The widget answers questions through callbacks rather than return values, so
// the position and playing state the sync loop needs are kept up to date from
// its progress event instead of being asked for on demand.

const WIDGET_API = 'https://w.soundcloud.com/player/api.js';
const TRACK_URL = 'https://api.soundcloud.com/tracks/';

// The visual player fills a 16:9 frame with the artwork, which is the closest
// SoundCloud gets to the video the room shows for a YouTube track.
const OPTIONS = {
  auto_play: true,
  visual: true,
  show_artwork: true,
  show_comments: false,
  show_teaser: false,
  hide_related: true,
  buying: false,
  sharing: false,
  download: false,
};

/** Anything at all has to be loaded before the widget API will bind to it. */
const PLACEHOLDER_TRACK = '1';

const query = (options) =>
  new URLSearchParams(Object.entries(options).map(([key, value]) => [key, String(value)]));

const embedUrl = (sourceId, options) =>
  `https://w.soundcloud.com/player/?url=${encodeURIComponent(TRACK_URL + sourceId)}&${query(options)}`;

function loadApi() {
  return new Promise((resolve, reject) => {
    if (window.SC?.Widget) return resolve();
    const script = document.createElement('script');
    script.src = WIDGET_API;
    script.onload = resolve;
    script.onerror = () => reject(new Error('SoundCloud widget failed to load'));
    document.head.append(script);
  });
}

export function createSoundcloud({ elementId, onError, onPaused }) {
  let widget = null;
  let ready = false;
  let positionMs = 0;
  let progressAt = 0;
  let duration = 0;
  let volume = 100;
  let muted = false;
  // Loading and stopping both raise a pause the room did not ask for.
  let expectPause = false;

  return {
    name: 'soundcloud',

    async create() {
      await loadApi();

      const iframe = document.createElement('iframe');
      iframe.id = elementId;
      iframe.allow = 'autoplay';
      iframe.frameBorder = '0';
      iframe.src = embedUrl(PLACEHOLDER_TRACK, { ...OPTIONS, auto_play: false });
      document.getElementById(`${elementId}-slot`).append(iframe);

      widget = SC.Widget(iframe);
      await new Promise((resolve) => {
        widget.bind(SC.Widget.Events.READY, resolve);
        // If the placeholder never reports ready the room should still open;
        // loading a real track rebinds everything anyway.
        setTimeout(resolve, 8000);
      });

      widget.bind(SC.Widget.Events.PLAY_PROGRESS, (event) => {
        positionMs = event?.currentPosition ?? positionMs;
        progressAt = Date.now();
      });
      widget.bind(SC.Widget.Events.ERROR, () => onError('widget error', true));
      widget.bind(SC.Widget.Events.PAUSE, () => {
        if (!expectPause) onPaused();
      });
      widget.bind(SC.Widget.Events.FINISH, () => {
        // Stopping well before the end means we were served a preview rather
        // than the track the server measured.
        if (duration - positionMs / 1000 > 5) onError('finished early', true);
      });

      ready = true;
    },

    isReady: () => ready,

    load(track, seconds) {
      positionMs = Math.max(0, seconds) * 1000;
      duration = track.duration;
      expectPause = true;

      widget.load(TRACK_URL + track.sourceId, {
        ...OPTIONS,
        callback: () => {
          expectPause = false;
          widget.seekTo(positionMs);
          widget.setVolume(muted ? 0 : volume);
          widget.play();

          // Policy is per listener: a track the server saw in full can still be
          // a 30 second preview here, which would leave the room in silence.
          widget.getCurrentSound((sound) => {
            if (sound?.policy === 'SNIP') onError('preview only', true);
          });
        },
      });
    },

    position() {
      return positionMs / 1000;
    },

    seek(seconds) {
      positionMs = Math.max(0, seconds) * 1000;
      widget.seekTo(positionMs);
    },

    /** A paused widget stops reporting progress, which is how we can tell. */
    isPlaying() {
      return Date.now() - progressAt < 2000;
    },

    resume() {
      widget.play();
    },

    setVolume(next, nextMuted) {
      volume = next;
      muted = nextMuted;
      widget?.setVolume(muted ? 0 : volume);
    },

    stop() {
      expectPause = true;
      widget?.pause();
    },
  };
}
