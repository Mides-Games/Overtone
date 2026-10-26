import { Router } from 'express';

import { requireSession } from '../middlewares/session.js';
import { publicAccount } from '../services/account.service.js';

const router = Router();

/** Who is signed in: public fields only. 401 when nobody is. */
router.get('/me', requireSession, (req, res) => {
  res.set('Cache-Control', 'no-store');
  res.json({ account: publicAccount(req.account) });
});

export default router;
