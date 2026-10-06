import express, { type NextFunction, type Request, type Response } from 'express';
import type { Logger } from 'pino';
import { authRouter, type AuthDeps } from './auth/routes';
import { currentSession, requireSession } from './auth/guard';
import { securityHeaders, sendHtml } from './http';
import { renderNotFound } from './views/auth-pages';
import { renderPage } from './views/layout';
import { renderShell } from './views/shell';
import { settingsRouter, type SettingsDeps } from './settings/routes';
import { STYLESHEET, STYLESHEET_PATH } from './views/style';

export interface AppDeps extends AuthDeps, SettingsDeps {
  logger: Pick<Logger, 'warn' | 'info' | 'error'>;
}

export function createApp(deps: AppDeps): express.Express {
  const app = express();
  app.disable('x-powered-by');
  app.set('trust proxy', 'loopback');
  app.use(securityHeaders);

  app.get('/healthz', (_req, res) => {
    res.type('text').send('ok');
  });
  app.get(STYLESHEET_PATH, (_req, res) => {
    res.setHeader('Cache-Control', 'public, max-age=31536000, immutable');
    res.type('css').send(STYLESHEET);
  });

  app.use(express.urlencoded({ extended: false, limit: '16kb' }));
  app.use(authRouter(deps));

  const guard = requireSession(deps);
  app.use(settingsRouter(deps, deps));
  app.get('/', guard, (_req, res) => {
    sendHtml(res, 200, renderShell(currentSession(res).csrf));
  });

  app.use((_req, res) => {
    sendHtml(res, 404, renderNotFound());
  });

  // Express 5 forwards rejected async handlers here: log, generic page, never a stack trace
  app.use((error: unknown, req: Request, res: Response, _next: NextFunction) => {
    deps.logger.error({ error, path: req.path }, 'dashboard request failed');
    if (res.headersSent) return;
    const body = '<div class="card"><h1>Something went wrong</h1><p>Please try again.</p></div>';
    sendHtml(res, 500, renderPage({ title: 'Error', body }));
  });

  return app;
}
