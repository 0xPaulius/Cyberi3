// The authoritative room. Clients never decide what plays or when it started;
// they mirror this state and seek their own player to match, whichever
// provider the track came from.

import { EventEmitter } from 'node:events';
import {
  addHistory,
  addTrack,
  findUserById,
  firstTrack,
  getPlaylist,
  listTracks,
  markTrackUnplayable,
  readAvatar,
  recentHistory,
  rotateTrackToBottom,
} from './db.js';

const ROOM_NAME = process.env.ROOM_NAME || 'The Basement';

/** Failures a track gets before we stop offering it, even for transient faults. */
const TRANSIENT_FAILURE_LIMIT = 3;

// Clients get a moment past the end of a track before the next one starts, so a
// slightly-behind player is not cut off mid-outro.
const HANDOFF_MS = 1200;

class Room extends EventEmitter {
  constructor() {
    super();
    /** @type {Map<number, {id:number, username:string, avatar:object, sockets:Set<string>}>} */
    this.users = new Map();
    /** @type {number[]} userIds queued for the booth, in order. */
    this.waitlist = [];
    this.current = null;
    this.votes = new Map();
    this.grabs = new Set();
    this.unplayableReports = new Set();
    /** @type {Map<number, number>} playlist track id -> consecutive failures. */
    this.failures = new Map();
    this.timer = null;
  }

  // --- presence ------------------------------------------------------------

  connect(user, socketId) {
    let entry = this.users.get(user.id);
    if (!entry) {
      entry = { id: user.id, username: user.username, avatar: readAvatar(user), sockets: new Set() };
      this.users.set(user.id, entry);
    }
    entry.sockets.add(socketId);
    this.publish();
    return entry;
  }

  /** Returns true when that was the user's last tab. */
  disconnect(userId, socketId) {
    const entry = this.users.get(userId);
    if (!entry) return false;

    entry.sockets.delete(socketId);
    if (entry.sockets.size > 0) return false;

    this.users.delete(userId);
    this.waitlist = this.waitlist.filter((id) => id !== userId);

    // If the DJ closed their last tab the room must not stall on their track.
    if (this.current?.djUserId === userId) this.advance('dj left');
    else this.publish();
    return true;
  }

  updateAvatar(userId, avatar) {
    const entry = this.users.get(userId);
    if (!entry) return;
    entry.avatar = avatar;
    this.publish();
  }

  // --- the booth ----------------------------------------------------------

  get djUserId() {
    return this.current?.djUserId ?? null;
  }

  isPlaying() {
    return Boolean(this.current);
  }

  joinWaitlist(userId) {
    if (!this.users.has(userId)) return { error: 'You are not in the room' };
    if (this.djUserId === userId) return { error: 'You are already playing' };
    if (this.waitlist.includes(userId)) return { error: 'You are already in the queue' };

    const track = this.nextTrackFor(userId);
    if (!track) return { error: 'Add a song to your active playlist first' };

    this.waitlist.push(userId);
    // An idle room should start the moment somebody queues up.
    if (!this.current) this.advance('queue joined');
    else this.publish();
    return { ok: true };
  }

  leaveWaitlist(userId) {
    const before = this.waitlist.length;
    this.waitlist = this.waitlist.filter((id) => id !== userId);

    if (this.djUserId === userId) {
      // Stepping down ends the track without putting them back in the queue.
      this.advance('dj stepped down', { requeueDj: false });
      return { ok: true };
    }
    if (this.waitlist.length !== before) this.publish();
    return { ok: true };
  }

  skip(userId) {
    if (this.djUserId !== userId) return { error: 'Only the DJ can skip this song' };
    this.advance('skipped');
    return { ok: true };
  }

  /**
   * A client could not play the track. Trust the DJ immediately, otherwise wait
   * for a majority so one broken client cannot skip for everyone.
   *
   * Each player decides whether the fault was permanent, since only it knows
   * what its provider's errors mean: an uploader's embed block on YouTube, a
   * subscriber-only preview on SoundCloud. Permanent faults flag the track and
   * the rotation stops offering it. Anything else skips the song but leaves the
   * track alone, because a dropped connection must not cost someone a song.
   */
  reportUnplayable(userId, sourceId, permanent) {
    if (!this.current || this.current.track.sourceId !== sourceId) return;

    this.unplayableReports.add(userId);
    const listeners = this.users.size;
    const majority = Math.max(2, Math.ceil(listeners / 2));
    if (userId !== this.current.djUserId && this.unplayableReports.size < majority) return;

    const { title } = this.current.track;
    const trackId = this.current.playlistTrackId;

    // A track that keeps failing has to stop coming back around: with one song
    // in a playlist the rotation would otherwise re-pick it and loop forever.
    const failures = (this.failures.get(trackId) ?? 0) + 1;
    this.failures.set(trackId, failures);
    const giveUp = Boolean(permanent) || failures >= TRANSIENT_FAILURE_LIMIT;

    this.emit('notice', {
      message: giveUp
        ? `Skipping "${title}" — the room cannot play it. It stays in your playlist, marked unplayable, so you can swap it out.`
        : `Skipping "${title}" — it would not play just now. It stays in your playlist and comes round again.`,
    });
    this.advance(giveUp ? 'blocked' : 'playback failed');
  }

  // --- votes --------------------------------------------------------------

  vote(userId, kind) {
    if (!this.current) return { error: 'Nothing is playing' };
    if (!this.users.has(userId)) return { error: 'You are not in the room' };
    if (userId === this.current.djUserId) return { error: 'You cannot vote on your own song' };
    if (kind !== 'woot' && kind !== 'meh') return { error: 'Unknown vote' };

    if (this.votes.get(userId) === kind) this.votes.delete(userId);
    else this.votes.set(userId, kind);

    this.publish();
    return { ok: true };
  }

  grab(userId, playlistId) {
    if (!this.current) return { error: 'Nothing is playing' };

    const user = findUserById(userId);
    if (!user) return { error: 'You are not signed in' };

    const target = playlistId ?? user.active_playlist_id;
    const playlist = target ? getPlaylist(target) : null;
    if (!playlist || playlist.user_id !== userId) return { error: 'Pick a playlist first' };

    const { track } = this.current;
    const owned = listTracks(playlist.id).some(
      (t) => t.provider === track.provider && t.source_id === track.sourceId,
    );
    if (owned) return { error: `Already in "${playlist.name}"` };

    addTrack(playlist.id, track);
    this.grabs.add(userId);
    this.publish();
    return { ok: true, playlist: playlist.name };
  }

  tally() {
    let woots = 0;
    let mehs = 0;
    for (const kind of this.votes.values()) {
      if (kind === 'woot') woots += 1;
      else mehs += 1;
    }
    return { woots, mehs, grabs: this.grabs.size };
  }

  // --- playback -----------------------------------------------------------

  /** The track a user would play next, without consuming it. */
  nextTrackFor(userId) {
    const user = findUserById(userId);
    if (!user?.active_playlist_id) return null;

    const playlist = getPlaylist(user.active_playlist_id);
    if (!playlist || playlist.user_id !== userId) return null;

    const row = firstTrack(playlist.id);
    if (!row) return null;

    return {
      playlistId: playlist.id,
      playlistTrackId: row.id,
      track: {
        provider: row.provider,
        sourceId: row.source_id,
        title: row.title,
        author: row.author,
        duration: row.duration,
      },
    };
  }

  elapsedSeconds() {
    if (!this.current) return 0;
    return (Date.now() - this.current.startedAt) / 1000;
  }

  clearTimer() {
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
  }

  /**
   * Ends the current track (recording it) and starts the next eligible DJ's.
   * Users whose playlist has run dry are dropped from the queue and told why.
   */
  advance(reason = 'ended', { requeueDj = true } = {}) {
    this.clearTimer();

    const finished = this.current;
    if (finished) {
      // A video that never played is not history. Either way the track itself
      // survives: flagging a blocked one stops the rotation offering it again,
      // which is what deleting it used to achieve, without throwing away a
      // song its owner deliberately added.
      const played = reason !== 'blocked' && reason !== 'playback failed';

      if (reason === 'blocked') markTrackUnplayable(finished.playlistTrackId);

      if (played) {
        // It works, so an old failure streak says nothing about it any more.
        this.failures.delete(finished.playlistTrackId);

        const { woots, mehs, grabs } = this.tally();
        addHistory({
          provider: finished.track.provider,
          sourceId: finished.track.sourceId,
          title: finished.track.title,
          author: finished.track.author,
          duration: finished.track.duration,
          djUserId: finished.djUserId,
          djUsername: finished.djUsername,
          playedAt: finished.startedAt,
          woots,
          mehs,
          grabs,
        });
      }

      // The finished track goes to the bottom, so a playlist cycles forever.
      rotateTrackToBottom(finished.playlistTrackId, finished.playlistId);

      // The outgoing DJ re-queues at the back of the line.
      if (requeueDj && this.users.has(finished.djUserId)) this.waitlist.push(finished.djUserId);
    }

    this.current = null;
    this.votes.clear();
    this.grabs.clear();
    this.unplayableReports.clear();

    while (this.waitlist.length > 0) {
      const candidate = this.waitlist.shift();
      if (!this.users.has(candidate)) continue;

      const next = this.nextTrackFor(candidate);
      if (!next) {
        this.emit('notice', {
          userId: candidate,
          message: 'Your active playlist is empty, so you left the queue.',
        });
        continue;
      }

      const entry = this.users.get(candidate);
      this.current = {
        djUserId: candidate,
        djUsername: entry.username,
        playlistId: next.playlistId,
        playlistTrackId: next.playlistTrackId,
        track: next.track,
        startedAt: Date.now(),
      };
      this.timer = setTimeout(() => this.advance('ended'), next.track.duration * 1000 + HANDOFF_MS);
      break;
    }

    this.emit('advanced', { reason, history: recentHistory(20) });
    this.publish();
  }

  // --- serialization ------------------------------------------------------

  snapshot() {
    const djUserId = this.djUserId;
    return {
      roomName: ROOM_NAME,
      serverNow: Date.now(),
      dj: djUserId
        ? { userId: djUserId, username: this.current.djUsername, avatar: this.users.get(djUserId)?.avatar }
        : null,
      current: this.current
        ? {
            ...this.current.track,
            startedAt: this.current.startedAt,
            elapsed: this.elapsedSeconds(),
          }
        : null,
      waitlist: this.waitlist.map((id) => ({
        userId: id,
        username: this.users.get(id)?.username,
      })),
      users: [...this.users.values()].map((entry) => ({
        userId: entry.id,
        username: entry.username,
        avatar: entry.avatar,
        isDj: entry.id === djUserId,
        waitlistPosition: this.waitlist.indexOf(entry.id),
      })),
      votes: {
        ...this.tally(),
        byUser: Object.fromEntries(this.votes),
        grabbedBy: [...this.grabs],
      },
    };
  }

  publish() {
    this.emit('state', this.snapshot());
  }
}

export const room = new Room();
export { ROOM_NAME };
