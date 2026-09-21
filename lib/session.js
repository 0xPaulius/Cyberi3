// Password hashing and cookie sessions using only node:crypto, so there is no
// native module to compile at image build time.

import crypto from 'node:crypto';
import { parseCookie, stringifySetCookie } from 'cookie';
import { findUserById } from './db.js';

const COOKIE = 'plugdj_session';
const MAX_AGE_SECONDS = 60 * 60 * 24 * 30;
const SCRYPT = { N: 16384, r: 8, p: 1, keylen: 64 };

const secret = process.env.SESSION_SECRET || 'insecure-development-secret';
if (!process.env.SESSION_SECRET) {
  console.warn('SESSION_SECRET is not set; using a development default. Set it in .env.');
}

export function hashPassword(password) {
  const salt = crypto.randomBytes(16);
  const key = crypto.scryptSync(password, salt, SCRYPT.keylen, {
    N: SCRYPT.N,
    r: SCRYPT.r,
    p: SCRYPT.p,
  });
  return ['scrypt', SCRYPT.N, SCRYPT.r, SCRYPT.p, salt.toString('base64'), key.toString('base64')].join('$');
}

export function verifyPassword(password, stored) {
  try {
    const [scheme, N, r, p, salt, expected] = stored.split('$');
    if (scheme !== 'scrypt') return false;
    const expectedKey = Buffer.from(expected, 'base64');
    const actual = crypto.scryptSync(password, Buffer.from(salt, 'base64'), expectedKey.length, {
      N: Number(N),
      r: Number(r),
      p: Number(p),
    });
    return crypto.timingSafeEqual(actual, expectedKey);
  } catch {
    return false;
  }
}

function sign(payload) {
  return crypto.createHmac('sha256', secret).update(payload).digest('base64url');
}

function makeToken(userId) {
  const payload = `${userId}.${Date.now()}`;
  return `${payload}.${sign(payload)}`;
}

function readToken(token) {
  if (!token) return null;
  const index = token.lastIndexOf('.');
  if (index < 0) return null;
  const payload = token.slice(0, index);
  const signature = token.slice(index + 1);
  const expected = sign(payload);
  if (signature.length !== expected.length) return null;
  if (!crypto.timingSafeEqual(Buffer.from(signature), Buffer.from(expected))) return null;

  const [userId, issuedAt] = payload.split('.');
  if (Date.now() - Number(issuedAt) > MAX_AGE_SECONDS * 1000) return null;
  return Number(userId);
}

export function setSessionCookie(res, userId) {
  res.setHeader(
    'Set-Cookie',
    stringifySetCookie({
      name: COOKIE,
      value: makeToken(userId),
      httpOnly: true,
      sameSite: 'lax',
      path: '/',
      maxAge: MAX_AGE_SECONDS,
    }),
  );
}

export function clearSessionCookie(res) {
  res.setHeader(
    'Set-Cookie',
    stringifySetCookie({ name: COOKIE, value: '', httpOnly: true, path: '/', maxAge: 0 }),
  );
}

/** Resolves the logged-in user from a raw Cookie header, or null. */
export function userFromCookieHeader(header) {
  const token = parseCookie(header || '')[COOKIE];
  const userId = readToken(token);
  if (!userId) return null;
  return findUserById(userId) ?? null;
}

/** Express middleware: always sets req.user (possibly null). */
export function attachUser(req, _res, next) {
  req.user = userFromCookieHeader(req.headers.cookie);
  next();
}

/** Express middleware: 401s anonymous requests. */
export function requireUser(req, res, next) {
  if (!req.user) return res.status(401).json({ error: 'not signed in' });
  next();
}
