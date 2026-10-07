import { Router, type Request, type Response } from 'express';
import type { Logger } from 'pino';
import { currentSession, requireCsrf, requireSession, type GuardDeps } from '../auth/guard';
import { sendHtml } from '../http';
import { renderPage } from '../views/layout';
import type { ChatVerifier, ProfileEvents, SettingsRepo, SettingsView } from './store';
import { validateSettings, type FormBody, type ProfileSettings } from './validate';
import { formFromBody, formFromSettings, renderSettings } from './view';

export interface SettingsDeps {
  logger: Pick<Logger, 'warn' | 'info' | 'error'>;
  settings: SettingsRepo;
  chats: ChatVerifier;
  events: ProfileEvents;
}

function renderNoProfile(csrf: string): string {
  const body =
    '<div class="card"><h1>Settings</h1><p>No profile yet. Send <strong>/start</strong> to the coach bot first.</p></div>';
  return renderPage({ title: 'Settings', body, nav: { current: 'settings', csrf } });
}

/** A new chat must accept a bot message before it is saved; an unchanged one is not re-tested. */
async function checkChat(
  deps: SettingsDeps,
  current: SettingsView,
  next: ProfileSettings
): Promise<string | null> {
  if (next.notifyChatId === null || next.notifyChatId === current.notifyChatId) return null;
  const result = await deps.chats.verify(next.notifyChatId);
  return result.ok ? null : result.message;
}

/** Saved settings reach the schedulers through the worker; a failed enqueue is logged, not shown. */
async function announce(deps: SettingsDeps, userId: string): Promise<void> {
  try {
    await deps.events.changed(userId);
  } catch (error) {
    deps.logger.error({ error, userId }, 'Could not queue the schedule refresh');
  }
}

export function settingsRouter(deps: SettingsDeps, guard: GuardDeps): Router {
  const router = Router();

  const auth = requireSession(guard);

  router.get('/settings', auth, async (req: Request, res: Response) => {
    const session = currentSession(res);
    const current = await deps.settings.load(session.userId);
    if (!current) {
      sendHtml(res, 200, renderNoProfile(session.csrf));
      return;
    }
    const notice = req.query.saved === '1' ? 'saved' : null;
    const page = renderSettings({
      csrf: session.csrf,
      form: formFromSettings(current),
      telegramId: current.telegramId,
      notice,
    });
    sendHtml(res, 200, page);
  });

  router.post('/settings', auth, requireCsrf(guard.logger), async (req: Request, res: Response) => {
    const session = currentSession(res);
    const current = await deps.settings.load(session.userId);
    if (!current) {
      sendHtml(res, 409, renderNoProfile(session.csrf));
      return;
    }
    const body = (req.body ?? {}) as FormBody;
    const result = validateSettings(body);
    const errors = result.ok ? {} : result.errors;
    const chatError = result.ok ? await checkChat(deps, current, result.value) : null;
    if (chatError) errors.notifyChatId = chatError;

    if (!result.ok || chatError) {
      const page = renderSettings({
        csrf: session.csrf,
        form: formFromBody(body),
        telegramId: current.telegramId,
        errors,
      });
      sendHtml(res, 400, page);
      return;
    }

    await deps.settings.save(session.userId, result.value);
    deps.logger.info({ userId: session.userId }, 'dashboard settings saved');
    await announce(deps, session.userId);
    res.redirect(303, '/settings?saved=1');
  });

  return router;
}
