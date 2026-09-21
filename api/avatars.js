import { Router } from 'express';
import { avatarOptions } from '../lib/avatars.js';

const router = Router();

// Cached hard by the client; the option lists only change when assets are rebuilt.
router.get('/options', (_req, res) => {
  res.json(avatarOptions());
});

export default router;
