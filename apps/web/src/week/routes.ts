import { Router, type Request, type Response } from 'express';
import { currentSession, requireSession, type GuardDeps } from '../auth/guard';
import { sendHtml } from '../http';
import { loadWeek, parseWeekParam, type WeekDeps } from './load';
import { renderWeek } from './view';

/** GET /week and /week?week=2026-W41 (an invalid key shows the current week). Reads only. */
export function weekRouter(deps: WeekDeps, guard: GuardDeps): Router {
  const router = Router();
  router.get('/week', requireSession(guard), async (req: Request, res: Response) => {
    const session = currentSession(res);
    const model = await loadWeek(session.userId, parseWeekParam(req.query.week), deps);
    sendHtml(res, 200, renderWeek(model, session.csrf));
  });
  return router;
}
