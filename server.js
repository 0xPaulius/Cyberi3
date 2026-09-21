import express from 'express';
import { createServer } from 'node:http';
import { Server } from 'socket.io';
import path from 'node:path';

import authRoutes from './api/auth.js';
import avatarRoutes from './api/avatars.js';
import playlistRoutes from './api/playlists.js';
import searchRoutes from './api/search.js';
import { registerSocketHandlers } from './lib/events.js';
import { ROOM_NAME } from './lib/room.js';
import { attachUser } from './lib/session.js';

const port = Number(process.env.PORT || 3000);
const app = express();

app.use(express.json({ limit: '32kb' }));
app.use(attachUser);

app.use('/api/auth', authRoutes);
app.use('/api/avatars', avatarRoutes);
app.use('/api/playlists', playlistRoutes);
app.use('/api/search', searchRoutes);

app.get('/api/config', (_req, res) => {
  res.json({ roomName: ROOM_NAME });
});

const production = process.env.NODE_ENV === 'production';

app.use(
  '/assets',
  express.static(path.resolve('assets'), {
    maxAge: 0,
    etag: true,
    setHeaders(res, filePath) {
      // Part art is addressed by name and never changes in place. The same
      // goes for imagery with a version in its filename (hall-v1.jpg): a new
      // version is a new name, so the old one can be held indefinitely.
      const versioned = /-v\d+\.\w+$/.test(filePath);
      if (production && (filePath.includes(`${path.sep}avatars${path.sep}`) || versioned)) {
        res.setHeader('Cache-Control', 'public, max-age=604800');
        return;
      }
      // Scripts and styles must not be reused across a deploy. Filenames are
      // unversioned and the ES modules import each other by plain relative
      // path, so there is nothing to bust: a browser holding yesterday's
      // bundle talks yesterday's protocol to a freshly deployed server, which
      // looks like the app being broken rather than stale.
      //
      // "no-cache" would be the proportionate header, since it still allows a
      // 304, but Cloudflare rewrites it: it treats the response as cacheable
      // and stamps its own Browser Cache TTL on the way out, handing browsers
      // a four hour max-age. "no-store" is the one it passes through intact.
      // The whole of this app's client code is a few tens of kilobytes, so
      // re-fetching it per page load costs less than the confusion did.
      res.setHeader('Cache-Control', 'no-store');
    },
  }),
);

app.get('/', (_req, res) => res.sendFile(path.resolve('index.html')));

// Rig tuning page; off unless explicitly enabled.
if (process.env.AVATAR_LAB === '1') {
  app.get('/avatar-lab', (_req, res) => res.sendFile(path.resolve('avatar-lab.html')));
}

const server = createServer(app);
const io = new Server(server, { serveClient: true });
registerSocketHandlers(io);

server.listen(port, () => {
  console.log(`dj.teviai.lt listening on http://localhost:${port}  ("${ROOM_NAME}")`);
});
