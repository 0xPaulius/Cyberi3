// Socket.IO wiring. Everything that mutates room state goes through lib/room.js.

import { BPM, clampBpm } from './avatars.js';
import { findUserById, readAvatar, recentHistory, saveAvatar } from './db.js';
import { room } from './room.js';
import { userFromCookieHeader } from './session.js';

const CHAT_MAX_LENGTH = 300;
const CHAT_MIN_INTERVAL_MS = 600;
const CHAT_BACKLOG = 60;

const chatLog = [];

export function registerSocketHandlers(io) {
  // Broadcasts driven by the room itself (track ended, DJ left, timer fired).
  room.on('state', (snapshot) => io.emit('room:state', snapshot));
  room.on('advanced', ({ history }) => io.emit('room:history', history));
  room.on('notice', ({ userId, message }) => {
    if (userId) io.to(`user:${userId}`).emit('notice', { message });
    else io.emit('notice', { message });
  });

  io.use((socket, next) => {
    const user = userFromCookieHeader(socket.request.headers.cookie);
    if (!user) return next(new Error('not signed in'));
    socket.data.userId = user.id;
    next();
  });

  io.on('connection', (socket) => {
    const user = findUserById(socket.data.userId);
    if (!user) {
      socket.disconnect(true);
      return;
    }

    socket.join(`user:${user.id}`);
    room.connect(user, socket.id);

    socket.emit('hello', {
      you: { id: user.id, username: user.username, avatar: readAvatar(user) },
      state: room.snapshot(),
      history: recentHistory(20),
      chat: chatLog.slice(-CHAT_BACKLOG),
    });

    // Round-trip clock probe. The client uses this to convert the server's
    // startedAt into its own clock before seeking.
    socket.on('time:sync', (clientSent, ack) => {
      if (typeof ack === 'function') ack({ clientSent, serverNow: Date.now() });
    });

    socket.on('waitlist:join', (_payload, ack) => reply(ack, room.joinWaitlist(user.id)));
    socket.on('waitlist:leave', (_payload, ack) => reply(ack, room.leaveWaitlist(user.id)));
    socket.on('dj:skip', (_payload, ack) => reply(ack, room.skip(user.id)));
    socket.on('vote', (payload, ack) => reply(ack, room.vote(user.id, payload?.kind)));
    socket.on('grab', (payload, ack) => reply(ack, room.grab(user.id, payload?.playlistId)));

    socket.on('player:unplayable', (payload) => {
      if (!payload?.sourceId) return;
      room.reportUnplayable(user.id, String(payload.sourceId), payload.permanent === true);
    });

    socket.on('avatar:changed', () => {
      const fresh = findUserById(user.id);
      if (fresh) room.updateAvatar(user.id, readAvatar(fresh));
    });

    // The tempo lives on the avatar so it survives a reload, and goes out with
    // the room state so everyone's copy of this dancer moves at the same speed.
    socket.on('bpm:set', (payload, ack) => {
      const bpm = clampBpm(payload?.bpm);
      if (bpm === null) return reply(ack, { error: `BPM must be ${BPM.min} to ${BPM.max}` });
      const fresh = findUserById(user.id);
      if (!fresh) return reply(ack, { error: 'You are not signed in' });
      const avatar = { ...readAvatar(fresh), bpm };
      saveAvatar(user.id, avatar);
      room.updateAvatar(user.id, avatar);
      reply(ack, { ok: true, bpm });
    });

    socket.on('chat', (payload, ack) => {
      const text = String(payload?.text ?? '').trim().slice(0, CHAT_MAX_LENGTH);
      if (!text) return reply(ack, { error: 'Say something first' });

      const last = socket.data.lastChatAt ?? 0;
      if (Date.now() - last < CHAT_MIN_INTERVAL_MS) {
        return reply(ack, { error: 'Slow down a little' });
      }
      socket.data.lastChatAt = Date.now();

      const message = { userId: user.id, username: user.username, text, at: Date.now() };
      chatLog.push(message);
      if (chatLog.length > CHAT_BACKLOG) chatLog.shift();

      io.emit('chat', message);
      reply(ack, { ok: true });
    });

    socket.on('disconnect', () => {
      room.disconnect(user.id, socket.id);
    });
  });
}

function reply(ack, result) {
  if (typeof ack === 'function') ack(result);
}
