import { Router, type Request, type Response } from 'express';
import { currentSession, requireSession, type GuardDeps } from '../auth/guard';
import { sendHtml } from '../http';
import { parseDateParam } from '../plan/dates';
import { loadToday, type TodayDeps } from './load';
import { renderToday } from './view';

export interface TodayRouteDeps extends TodayDeps {
  botUsername?: string;
}

/** GET / and GET /today?date=yyyy-MM-dd (an invalid date shows local today). Reads only. */
export function todayRouter(deps: TodayRouteDeps, guard: GuardDeps): Router {
  const router = Router();
  const auth = requireSession(guard);

  const handler = async (req: Request, res: Response) => {
    const session = currentSession(res);
    const model = await loadToday(session.userId, parseDateParam(req.query.date), deps);
    sendHtml(res, 200, renderToday(model, { csrf: session.csrf, botUsername: deps.botUsername }));
  };

  router.get('/', auth, handler);
  router.get('/today', auth, handler);
  return router;
}
