import Database from 'better-sqlite3';
import { mkdirSync } from 'node:fs';
import path from 'node:path';

const dbPath = process.env.DB_PATH || './data/plugdj.db';
mkdirSync(path.dirname(path.resolve(dbPath)), { recursive: true });

export const db = new Database(dbPath);
db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');

db.exec(`
  CREATE TABLE IF NOT EXISTS users (
    id                 INTEGER PRIMARY KEY AUTOINCREMENT,
    username           TEXT    NOT NULL UNIQUE COLLATE NOCASE,
    password_hash      TEXT    NOT NULL,
    avatar             TEXT    NOT NULL DEFAULT '{}',
    active_playlist_id INTEGER,
    created_at         INTEGER NOT NULL
  );

  CREATE TABLE IF NOT EXISTS playlists (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id    INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    name       TEXT    NOT NULL,
    created_at INTEGER NOT NULL
  );

  CREATE TABLE IF NOT EXISTS playlist_tracks (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    playlist_id INTEGER NOT NULL REFERENCES playlists(id) ON DELETE CASCADE,
    provider    TEXT    NOT NULL DEFAULT 'youtube',
    source_id   TEXT    NOT NULL,
    title       TEXT    NOT NULL,
    author      TEXT,
    duration    INTEGER NOT NULL,
    position    INTEGER NOT NULL,
    unplayable  INTEGER NOT NULL DEFAULT 0
  );

  CREATE INDEX IF NOT EXISTS idx_tracks_playlist ON playlist_tracks(playlist_id, position);
  CREATE INDEX IF NOT EXISTS idx_playlists_user  ON playlists(user_id);

  CREATE TABLE IF NOT EXISTS history (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    provider    TEXT    NOT NULL DEFAULT 'youtube',
    source_id   TEXT    NOT NULL,
    title       TEXT    NOT NULL,
    author      TEXT,
    duration    INTEGER NOT NULL,
    dj_user_id  INTEGER,
    dj_username TEXT    NOT NULL,
    played_at   INTEGER NOT NULL,
    woots       INTEGER NOT NULL DEFAULT 0,
    mehs        INTEGER NOT NULL DEFAULT 0,
    grabs       INTEGER NOT NULL DEFAULT 0
  );
`);

// Older databases are upgraded in place, so nobody loses a playlist to a
// deploy. Every column added since the first release is patched in here, and
// video_id becomes source_id now that a track can come from somewhere that has
// no videos at all. Existing rows are all YouTube, which the default covers.
function columns(table) {
  return new Set(db.prepare('SELECT name FROM pragma_table_info(?)').all(table).map((c) => c.name));
}

const trackColumns = columns('playlist_tracks');
if (!trackColumns.has('unplayable')) {
  db.exec('ALTER TABLE playlist_tracks ADD COLUMN unplayable INTEGER NOT NULL DEFAULT 0');
}
if (!trackColumns.has('provider')) {
  db.exec("ALTER TABLE playlist_tracks ADD COLUMN provider TEXT NOT NULL DEFAULT 'youtube'");
}
if (trackColumns.has('video_id') && !trackColumns.has('source_id')) {
  db.exec('ALTER TABLE playlist_tracks RENAME COLUMN video_id TO source_id');
}

const historyColumns = columns('history');
if (!historyColumns.has('provider')) {
  db.exec("ALTER TABLE history ADD COLUMN provider TEXT NOT NULL DEFAULT 'youtube'");
}
if (historyColumns.has('video_id') && !historyColumns.has('source_id')) {
  db.exec('ALTER TABLE history RENAME COLUMN video_id TO source_id');
}

const q = {
  userByName: db.prepare('SELECT * FROM users WHERE username = ?'),
  userById: db.prepare('SELECT * FROM users WHERE id = ?'),
  insertUser: db.prepare(
    'INSERT INTO users (username, password_hash, avatar, created_at) VALUES (?, ?, ?, ?)',
  ),
  setAvatar: db.prepare('UPDATE users SET avatar = ? WHERE id = ?'),
  setActivePlaylist: db.prepare('UPDATE users SET active_playlist_id = ? WHERE id = ?'),

  playlistsByUser: db.prepare(`
    SELECT p.*, (SELECT COUNT(*) FROM playlist_tracks t WHERE t.playlist_id = p.id) AS track_count
    FROM playlists p WHERE p.user_id = ? ORDER BY p.created_at
  `),
  playlistById: db.prepare('SELECT * FROM playlists WHERE id = ?'),
  insertPlaylist: db.prepare('INSERT INTO playlists (user_id, name, created_at) VALUES (?, ?, ?)'),
  renamePlaylist: db.prepare('UPDATE playlists SET name = ? WHERE id = ?'),
  deletePlaylist: db.prepare('DELETE FROM playlists WHERE id = ?'),

  tracks: db.prepare('SELECT * FROM playlist_tracks WHERE playlist_id = ? ORDER BY position, id'),
  // A flagged track is skipped by the rotation but stays in the playlist for
  // its owner to see and deal with.
  firstTrack: db.prepare(
    'SELECT * FROM playlist_tracks WHERE playlist_id = ? AND unplayable = 0 ORDER BY position, id LIMIT 1',
  ),
  trackById: db.prepare('SELECT * FROM playlist_tracks WHERE id = ?'),
  maxPosition: db.prepare(
    'SELECT COALESCE(MAX(position), 0) AS pos FROM playlist_tracks WHERE playlist_id = ?',
  ),
  insertTrack: db.prepare(`
    INSERT INTO playlist_tracks (playlist_id, provider, source_id, title, author, duration, position)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `),
  deleteTrack: db.prepare('DELETE FROM playlist_tracks WHERE id = ?'),
  markUnplayable: db.prepare('UPDATE playlist_tracks SET unplayable = 1 WHERE id = ?'),
  setTrackPosition: db.prepare('UPDATE playlist_tracks SET position = ? WHERE id = ?'),

  insertHistory: db.prepare(`
    INSERT INTO history (provider, source_id, title, author, duration, dj_user_id, dj_username, played_at, woots, mehs, grabs)
    VALUES (@provider, @sourceId, @title, @author, @duration, @djUserId, @djUsername, @playedAt, @woots, @mehs, @grabs)
  `),
  recentHistory: db.prepare('SELECT * FROM history ORDER BY played_at DESC LIMIT ?'),
};

const now = () => Date.now();

export function findUserByName(username) {
  return q.userByName.get(username);
}

export function findUserById(id) {
  return q.userById.get(id);
}

export function createUser(username, passwordHash, avatar) {
  const info = q.insertUser.run(username, passwordHash, JSON.stringify(avatar), now());
  const userId = Number(info.lastInsertRowid);
  const playlistId = createPlaylist(userId, 'My playlist');
  q.setActivePlaylist.run(playlistId, userId);
  return findUserById(userId);
}

export function saveAvatar(userId, avatar) {
  q.setAvatar.run(JSON.stringify(avatar), userId);
}

export function readAvatar(user) {
  try {
    return JSON.parse(user.avatar);
  } catch {
    return {};
  }
}

export function listPlaylists(userId) {
  return q.playlistsByUser.all(userId);
}

export function getPlaylist(id) {
  return q.playlistById.get(id);
}

export function createPlaylist(userId, name) {
  return Number(q.insertPlaylist.run(userId, name, now()).lastInsertRowid);
}

export function renamePlaylist(id, name) {
  q.renamePlaylist.run(name, id);
}

export function deletePlaylist(id) {
  q.deletePlaylist.run(id);
}

export function setActivePlaylist(userId, playlistId) {
  q.setActivePlaylist.run(playlistId, userId);
}

export function listTracks(playlistId) {
  return q.tracks.all(playlistId);
}

export function firstTrack(playlistId) {
  return q.firstTrack.get(playlistId);
}

export function getTrack(id) {
  return q.trackById.get(id);
}

export function addTrack(playlistId, track) {
  const { pos } = q.maxPosition.get(playlistId);
  return Number(
    q.insertTrack.run(
      playlistId,
      track.provider,
      track.sourceId,
      track.title,
      track.author ?? null,
      track.duration,
      pos + 1,
    ).lastInsertRowid,
  );
}

/** Appends many tracks in order, in one transaction; an import is all or nothing. */
export const addTracks = db.transaction((playlistId, tracks) => {
  let { pos } = q.maxPosition.get(playlistId);
  for (const track of tracks) {
    q.insertTrack.run(
      playlistId,
      track.provider,
      track.sourceId,
      track.title,
      track.author ?? null,
      track.duration,
      ++pos,
    );
  }
  return tracks.length;
});

export function removeTrack(id) {
  q.deleteTrack.run(id);
}

/** Flags a track the player refused, so the rotation stops offering it. */
export function markTrackUnplayable(id) {
  q.markUnplayable.run(id);
}

/** Moves a track to the end of its playlist; how a DJ's playlist cycles after a play. */
export function rotateTrackToBottom(trackId, playlistId) {
  const { pos } = q.maxPosition.get(playlistId);
  q.setTrackPosition.run(pos + 1, trackId);
}

export const reorderTracks = db.transaction((playlistId, orderedIds) => {
  const owned = new Set(q.tracks.all(playlistId).map((t) => t.id));
  let position = 0;
  for (const id of orderedIds) {
    if (!owned.has(id)) continue;
    q.setTrackPosition.run(++position, id);
    owned.delete(id);
  }
  // Anything the client did not mention keeps its relative order at the bottom.
  for (const id of owned) q.setTrackPosition.run(++position, id);
});

export function addHistory(entry) {
  q.insertHistory.run(entry);
}

export function recentHistory(limit = 30) {
  return q.recentHistory.all(limit);
}
