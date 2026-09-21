# dj.teviai.lt

A self-hosted listening room in the spirit of plug.dj. One shared room, one DJ
booth, a queue of DJs, and a floor of animated avatars. Everyone hears the same
song at the same time because the server owns the playback clock and every
browser seeks its own player to match. Tracks come from YouTube or SoundCloud.

## Run it

```bash
cp .env.example .env      # then edit SESSION_SECRET
docker compose up -d
```

Open <http://localhost:3000>, pick a username and password, and you're in.

Without Docker:

```bash
npm install
npm run assets            # downloads the CC0 avatar artwork
SESSION_SECRET=dev npm start
```

## How it works

The server is the single source of truth. `lib/room.js` holds the current
track, when it started, who is in the booth and who is queued. Clients never
decide what plays; they mirror the room.

```
DJ joins queue -> room picks a DJ and the top track of their active playlist
               -> broadcasts { provider, sourceId, duration, startedAt }
               -> every client seeks to (now - startedAt) and plays
               -> a timer fires at the end, the played track rotates to the
                  bottom of that DJ's playlist, and the next DJ takes over
```

A few details that matter:

- **Clock sync.** `startedAt` is a server timestamp, so each client estimates
  its clock offset with a round-trip probe (keeping the lowest-latency sample)
  before converting it. Playback is re-checked every 5s and re-seeked if it
  drifts more than 1.5s.
- **Autoplay.** Browsers block audible autoplay, so the room sits behind an
  explicit "Enter the room" click that creates the player.
- **Sync accuracy** is roughly sub-second. Embedded players seek coarsely, so
  sample-accurate sync is not achievable this way.
- **Two providers, one interface.** `assets/js/player.js` owns the clock and the
  volume; `assets/js/players/*` wrap the YouTube IFrame player and the
  SoundCloud widget. Only the provider playing right now is on screen.
- **Serve it by name.** YouTube will not authorise label-owned videos for a page
  whose origin is a bare IP address. Nearly all commercial music comes back as
  error 150 with an `auth` code and `isPlayable: false`, while the same video
  with the same player parameters plays from any hostname. A domain is
  effectively a requirement, not a nicety; see `caddy/Caddyfile`.
- **Unplayable tracks.** YouTube uploaders can disallow embedding (errors 101
  and 150) and SoundCloud serves subscriber-only tracks as 30 second previews.
  Both are refused when a track is added, and if one slips through the client
  reports it: the room trusts the DJ immediately and otherwise waits for a
  majority before skipping. The track stays in the playlist, flagged, rather
  than being deleted.
- **No API key.** YouTube search and metadata go through `youtubei.js` and its
  InnerTube API; SoundCloud goes through the api-v2 its own web player uses,
  with the client id read from that player. Nothing to sign up for.

## Room rules

- One booth, one DJ, plus a waitlist.
- When a track ends the DJ goes to the back of the waitlist and the next person
  steps up. If nobody else is queued, the current DJ keeps playing.
- A played track rotates to the bottom of the DJ's active playlist, so a
  playlist cycles forever.
- **Woot** / **Meh** are one vote per play and switchable; you cannot vote on
  your own song. **Grab** copies the track into your playlist.
- Paste a YouTube or SoundCloud playlist link into the search box (or use
  **Import playlist**) to pull the whole thing into the selected playlist.
  Tracks that are too long, blocked from embedding, or already there are
  skipped and counted; playlists hold 500. **Shuffle** randomises the order.
- Final vote tallies are kept in the history panel.

## Avatars

The artwork is Kenney's [Modular character
pack](https://opengameart.org/content/modular-character-pack) (CC0, public
domain). `scripts/fetch-assets.sh` downloads it and
`scripts/build-avatars.mjs` re-cuts it into a predictable tree plus a manifest.
If the download fails the app falls back to simple placeholder avatars.

Because the pack ships limbs as separate pieces, the avatar is a rigged
skeleton rather than a flat sprite. Each "bone" is a full-stage layer whose
`transform-origin` sits on a joint, so rotating it swings everything inside:

```
.av__body                    whole-body lift (jump, walk bounce)
  .av__leg  (x2)             hip      -> leg + trouser overlay
    .av__shoe                ankle
  .av__torso                 hips     -> bob, lean, twist
    .av__arm  (x2)           shoulder -> arm + sleeve overlay
      .av__hand              wrist
    .av__head                neck     -> eyes, brows, nose, mouth, hair
```

Left limbs are the right-hand artwork mirrored about the body centre, so one
set of coordinates keeps both sides symmetric.

All motion is CSS keyframes selected by a `data-anim` attribute — nothing
animates per-frame in JS, so a crowded floor stays cheap. Six dance styles
(bob, sway, hands up, twist, jump, headbang), four DJ animations that cycle
every 8-12s (scratch, mix, cue, hype), plus a walk-to-the-booth transition.
The floor goes still between tracks, and `prefers-reduced-motion` falls back to
a gentle bob.

Every duration is derived from the dancer's own tempo: each move declares how
many beats one cycle takes (`--av-cycle`) and the rig turns that into seconds
from `--av-bpm`. The BPM slider in the controls bar sets it (60–300), it is
saved on the avatar, and it goes out with the room state, so everyone sees that
dancer move at that speed. A drag is debounced into one `bpm:set` message.

`/avatar-lab` (set `AVATAR_LAB=1`) renders the rig against a coordinate grid
with every animation side by side, and every hat, face extra and costume
against one reference body. It is how the joint offsets were tuned.

### Extra layers

Hats, face extras and costumes are hand-drawn SVGs in `assets/avatar-extras/`
rather than parts of the Kenney pack, so they live in the repo and skip the
asset build entirely. `lib/avatars.js` reads the directory at startup: adding a
file adds a choice, and no rebuild is involved. Alongside the joke pieces there
is a themed set to match the room: skull helm, demon horns, warlock hood and an
Aero halo; skull paint, glowing eyes and a chrome visor; death knight plate, an
Aero suit and a chrome puffer. An **aura** (frost, ember, void, holy) is a pure
CSS layer under the figure, so it is a fixed list in `lib/avatars.js` rather
than a file.

```
hat/<name>.svg              220x150, crown centre at (110, 44)
face/<name>.svg             200x120, over the eyes, nose and mouth
costume/<name>/body.svg     176x200, replaces the shirt
costume/<name>/waist.svg    176x54,  replaces the pants waist
costume/<name>/sleeve.svg   171x142, replaces the sleeve
costume/<name>/leg.svg      111x166, replaces the trouser leg
```

Each file's own header comment carries the landmarks for its slot. Nothing may
stray outside the box, which is exactly the image and clips. A costume fills
all four slots so the renderer needs no per-costume rules; where one wants bare
skin, as the vest does with its sleeves, that file is deliberately empty. The
sleeve and leg outlines were traced from the pack's own art so a costume limb
lines up with the arm and leg underneath.

Every part defaults to `none`, including for avatars saved before it existed.

### Room art

`assets/img/` holds the rendered pieces: the hall backdrop (`hall-v1.jpg`), the
DJ desk (`booth-v1.webp`, keyed to transparency, with the turntable plane 28%
down from its top — the number `.booth__dj` is positioned from), the idle
screen (`idle-v1.jpg`) and the three gel hands on the vote buttons
(`vote-*-v1.png`), which also serve as the badges over dancers. Everything
small is a stroke icon in `icons.svg`, drawn in `currentColor` so one sprite
suits every button; `assets/js/icons.js` builds them for markup made in JS.
Versioned names are what let these be cached for a week while everything else
is `no-store`, so a replacement gets a new `-vN` rather than the old name.

## Configuration

| Variable         | Default            | Notes                                          |
| ---------------- | ------------------ | ---------------------------------------------- |
| `PORT`           | `3000`             | Host port in compose                            |
| `SESSION_SECRET` | dev fallback       | Signs session cookies; **set this**             |
| `DB_PATH`        | `./data/plugdj.db` | SQLite file, on a named volume under Docker     |
| `ROOM_NAME`      | `The Basement`     | Shown in the header                             |
| `AVATAR_LAB`     | unset              | `1` exposes `/avatar-lab`                       |
| `SITE_HOST`      | unset              | Public hostname; Caddy only, and load-bearing for YouTube |

## Layout

- `server.js` — Express and Socket.IO wiring
- `lib/room.js` — the authoritative room state machine
- `lib/db.js` — SQLite schema and queries
- `lib/session.js` — scrypt password hashing and signed cookie sessions
- `lib/tracks.js` — the track shape both providers resolve to
- `lib/youtube.js`, `lib/soundcloud.js` — cached keyless search and metadata
- `lib/events.js` — socket event handlers
- `api/` — auth, playlists, search, avatar options
- `assets/js/` — `app.js` (room), `player.js` (sync), `players/` (the two
  embeds), `avatar.js` (rig), `playlist.js`, `picker.js`, `socket.js`
- `scripts/` — avatar download and normalization

Passwords are hashed with `scrypt` from Node's standard library and sessions
are signed HMAC cookies, so there is no native crypto dependency to build.
