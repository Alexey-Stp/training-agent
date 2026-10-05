import { InlineKeyboard, type Bot, type Context } from 'grammy';
import {
  isDecisionExpired,
  MSG_DECISION_EXPIRED,
  SEASON_PREVIEW_COMMAND,
  type CommandJob,
} from '@triathlon/core';
import {
  handleSeasonDialog,
  WIZARD_EXPIRED,
  type KeyboardButton,
  type SeasonDialogOutcome,
  type SeasonDialogStore,
} from './season-dialog';
import { routeSeasonDecision, type DecisionJob } from './season-callbacks';
import { routeCoachDecision } from './coach-callbacks';
import { routeBlockReview } from './block-callbacks';
import { checkInJobId, routeCheckIn } from './checkin-callbacks';

interface CallbackLogger {
  info(obj: object, msg: string): void;
  warn(obj: object, msg: string): void;
  error(obj: object, msg: string): void;
}

export interface CallbackDeps {
  /** queue.ts `enqueueCommand` */
  enqueue(job: CommandJob, opts?: { jobId?: string }): Promise<void>;
  seasonDialogStore: SeasonDialogStore;
  /** `COACH_DECISION_TTL_HOURS`: coach buttons on older messages are expired */
  ttlHours: number;
  now(): Date;
  logger: CallbackLogger;
}

export function toInlineKeyboard(rows: KeyboardButton[][] | undefined): InlineKeyboard | undefined {
  return rows
    ? InlineKeyboard.from(rows.map((row) => row.map((b) => InlineKeyboard.text(b.text, b.data))))
    : undefined;
}

/** Callback jobs are keyed by the tapped message, so a double tap enqueues one job. */
export function callbackJobId(chatId: number, messageId: number): string {
  return `cb-${chatId.toString()}-${messageId.toString()}`;
}

export async function enqueueSeasonPreview(
  deps: Pick<CallbackDeps, 'enqueue' | 'logger'>,
  target: { chatId: number; userId: number; messageId: number },
  args: string[],
  jobId?: string
): Promise<void> {
  const { chatId, userId, messageId } = target;
  await deps.enqueue(
    {
      telegramChatId: chatId,
      telegramUserId: userId,
      messageId,
      commandName: SEASON_PREVIEW_COMMAND,
      args,
      rawText: '',
    },
    { jobId }
  );
  deps.logger.info({ userId, chatId, messageId, command: SEASON_PREVIEW_COMMAND }, 'Job enqueued');
}

/** Edits the tapped message; Telegram refuses an edit that changes nothing, which is fine. */
async function editTapped(
  ctx: Context,
  deps: CallbackDeps,
  text: string | null,
  keyboard?: KeyboardButton[][]
) {
  try {
    const reply_markup = toInlineKeyboard(keyboard);
    await (text === null
      ? ctx.editMessageReplyMarkup({ reply_markup })
      : ctx.editMessageText(text, { reply_markup }));
  } catch (error) {
    deps.logger.warn({ error, userId: ctx.from?.id }, 'Could not edit tapped message');
  }
}

/** Wizard button: next step in place of the wizard message, or the preview job. */
async function applyWizardTap(
  ctx: Context,
  deps: CallbackDeps,
  outcome: SeasonDialogOutcome,
  messageId: number
) {
  const userId = ctx.from?.id;
  const chatId = ctx.chat?.id;
  if (outcome.kind === 'reply') await editTapped(ctx, deps, outcome.text, outcome.keyboard);
  if (outcome.kind === 'submit' && userId !== undefined && chatId !== undefined) {
    await editTapped(ctx, deps, outcome.text);
    await enqueueSeasonPreview(
      deps,
      { chatId, userId, messageId },
      outcome.args,
      callbackJobId(chatId, messageId)
    );
  }
  await ctx.answerCallbackQuery();
}

/** Decision button: drop the buttons so they can't be tapped again, then enqueue the decision. */
async function applyDecisionTap(
  ctx: Context,
  deps: CallbackDeps,
  job: DecisionJob,
  messageId: number
) {
  const userId = ctx.from?.id;
  const chatId = ctx.chat?.id;
  if (userId === undefined || chatId === undefined) return;
  await editTapped(ctx, deps, null);
  await deps.enqueue(
    {
      telegramChatId: chatId,
      telegramUserId: userId,
      messageId,
      commandName: job.commandName,
      args: job.args,
      rawText: '',
    },
    { jobId: callbackJobId(chatId, messageId) }
  );
  deps.logger.info({ userId, chatId, messageId, command: job.commandName }, 'Job enqueued');
  await ctx.answerCallbackQuery({ text: job.toast });
}

/** Check-in button: enqueue the answer; the worker edits the message (no TTL, the run decides). */
async function applyCheckInTap(
  ctx: Context,
  deps: CallbackDeps,
  job: DecisionJob,
  messageId: number
) {
  const userId = ctx.from?.id;
  const chatId = ctx.chat?.id;
  if (userId === undefined || chatId === undefined) return;
  await deps.enqueue(
    {
      telegramChatId: chatId,
      telegramUserId: userId,
      messageId,
      commandName: job.commandName,
      args: job.args,
      rawText: '',
    },
    { jobId: checkInJobId(chatId, messageId, job) }
  );
  deps.logger.info({ userId, chatId, messageId, command: job.commandName }, 'Job enqueued');
  await ctx.answerCallbackQuery({ text: job.toast });
}

/**
 * A coach button on a message older than the TTL: nothing is enqueued, the buttons go and the
 * athlete is pointed to /plan today. The worker checks the decision's age too (queued jobs).
 */
async function expiredCoachTap(ctx: Context, deps: CallbackDeps) {
  await editTapped(ctx, deps, null);
  await ctx.answerCallbackQuery();
  await ctx.reply(MSG_DECISION_EXPIRED);
}

/**
 * Inline buttons: morning check-in, coach Apply/Keep/Discuss, the season wizard steps, the
 * season preview and block review Confirm/Decline.
 */
export function registerCallbackHandlers(bot: Bot, deps: CallbackDeps): void {
  bot.on('callback_query:data', async (ctx) => {
    try {
      const { data, message } = ctx.callbackQuery;
      if (!message) {
        await ctx.answerCallbackQuery({ text: WIZARD_EXPIRED });
        return;
      }
      const checkIn = routeCheckIn(data);
      if (checkIn) {
        await applyCheckInTap(ctx, deps, checkIn, message.message_id);
        return;
      }
      const coach = routeCoachDecision(data);
      // message.date: when the message carrying the buttons was sent (Unix seconds)
      if (coach && isDecisionExpired(new Date(message.date * 1000), deps.now(), deps.ttlHours)) {
        await expiredCoachTap(ctx, deps);
        return;
      }
      const decision = coach ?? routeSeasonDecision(data) ?? routeBlockReview(data);
      if (decision) {
        await applyDecisionTap(ctx, deps, decision, message.message_id);
        return;
      }
      const outcome = await handleSeasonDialog(
        ctx.from.id,
        { kind: 'callback', data },
        deps.seasonDialogStore
      );
      await applyWizardTap(ctx, deps, outcome, message.message_id);
    } catch (error) {
      deps.logger.error({ error }, 'Error handling button');
      try {
        await ctx.answerCallbackQuery({
          text: '❌ Sorry, something went wrong. Please try again.',
        });
      } catch (answerError) {
        deps.logger.error({ error: answerError }, 'Failed to answer button');
      }
    }
  });
}
