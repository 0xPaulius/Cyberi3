// YouTube backend for the room player, driving an IFrame API embed.
//
// Everything is expressed in seconds, and errors are classified into permanent
// or transient here, because only this file knows what YouTube's codes mean.

/**
 * 100 means removed, 101 and 150 mean the uploader disallowed embedding: no
 * amount of retrying makes those playable. Everything else YouTube reports
 * (2 for a bad parameter, 5 for an HTML5 player fault) is usually transient
 * and clears if we reload the same video.
 */
const UNEMBEDDABLE = new Set([100, 101, 150]);

function loadApi() {
  return new Promise((resolve) => {
    if (window.YT?.Player) return resolve();
    window.onYouTubeIframeAPIReady = resolve;
    const script = document.createElement('script');
    script.src = 'https://www.youtube.com/iframe_api';
    document.head.append(script);
  });
}

export function createYoutube({ elementId, onError, onPaused }) {
  let player = null;
  let ready = false;

  const api = {
    name: 'youtube',

    async create() {
      await loadApi();
      await new Promise((resolve) => {
        player = new YT.Player(elementId, {
          width: '100%',
          height: '100%',
          playerVars: {
            autoplay: 1,
            controls: 0,
            disablekb: 1,
            modestbranding: 1,
            rel: 0,
            playsinline: 1,
            iv_load_policy: 3,
            origin: window.location.origin,
          },
          events: {
            onReady: () => {
              ready = true;
              resolve();
            },
            onError: (event) => onError(event.data, UNEMBEDDABLE.has(event.data)),
            onStateChange: (event) => {
              if (event.data === YT.PlayerState.PAUSED) onPaused();
            },
          },
        });
      });
    },

    isReady: () => ready,

    load(track, seconds) {
      player.loadVideoById({ videoId: track.sourceId, startSeconds: Math.max(0, seconds) });
    },

    position() {
      return player.getCurrentTime?.() ?? 0;
    },

    seek(seconds) {
      player.seekTo(seconds, true);
    },

    isPlaying() {
      return player.getPlayerState?.() === YT.PlayerState.PLAYING;
    },

    resume() {
      player.playVideo?.();
    },

    setVolume(volume, muted) {
      // A slider at zero has to become a real mute. YouTube's unMute() lifts a
      // zeroed player back to an audible level, so setVolume(0) on its own
      // leaves the room still playing quietly. Muting first also means our
      // level wins: unMute() would otherwise restore what the player remembered.
      if (muted || volume === 0) player.mute();
      else player.unMute();
      player.setVolume(volume);
    },

    stop() {
      player?.stopVideo?.();
    },
  };

  return api;
}
