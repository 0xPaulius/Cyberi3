import { Router } from 'express';
import {
  createUser,
  findUserByName,
  readAvatar,
  saveAvatar,
} from '../lib/db.js';
import { randomAvatar, sanitizeAvatar } from '../lib/avatars.js';
import {
  clearSessionCookie,
  hashPassword,
  requireUser,
  setSessionCookie,
  verifyPassword,
} from '../lib/session.js';

const router = Router();

const USERNAME = /^[A-Za-z0-9_.-]{2,20}$/;

export function publicUser(user) {
  return {
    id: user.id,
    username: user.username,
    avatar: readAvatar(user),
    activePlaylistId: user.active_playlist_id,
  };
}

function readCredentials(body) {
  const username = String(body?.username ?? '').trim();
  const password = String(body?.password ?? '');
  if (!USERNAME.test(username)) {
    return { error: 'Username must be 2-20 characters: letters, numbers, . _ or -' };
  }
  if (password.length < 4) return { error: 'Password must be at least 4 characters' };
  return { username, password };
}

router.post('/register', (req, res) => {
  const { username, password, error } = readCredentials(req.body);
  if (error) return res.status(400).json({ error });

  if (findUserByName(username)) {
    return res.status(409).json({ error: 'That username is taken' });
  }

  const user = createUser(username, hashPassword(password), randomAvatar());
  setSessionCookie(res, user.id);
  res.status(201).json(publicUser(user));
});

router.post('/login', (req, res) => {
  const { username, password, error } = readCredentials(req.body);
  if (error) return res.status(400).json({ error });

  const user = findUserByName(username);
  // Same message either way, so the form does not reveal which names exist.
  if (!user || !verifyPassword(password, user.password_hash)) {
    return res.status(401).json({ error: 'Wrong username or password' });
  }

  setSessionCookie(res, user.id);
  res.json(publicUser(user));
});

router.post('/logout', (req, res) => {
  clearSessionCookie(res);
  res.json({ ok: true });
});

router.get('/me', (req, res) => {
  if (!req.user) return res.status(401).json({ error: 'not signed in' });
  res.json(publicUser(req.user));
});

router.put('/me/avatar', requireUser, (req, res) => {
  const avatar = sanitizeAvatar(req.body);
  saveAvatar(req.user.id, avatar);
  res.json({ avatar });
});

export default router;
