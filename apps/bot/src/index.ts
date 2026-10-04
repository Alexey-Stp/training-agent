import 'dotenv/config';
import { Bot, InlineKeyboard, type Context } from 'grammy';
import Redis from 'ioredis';
import { COACH_CHAT_COMMAND, getConfig, getEncKeys, SEASON_PREVIEW_COMMAND } from '@triathlon/core';
import type { CommandJob } from '@triathlon/core';
import { commandQueue, enqueueCommand } from './queue';
import { logger } from './logger';
import { parseCommand } from './parser';
import { handleConnectDialog, RedisDialogStore } from './connect-dialog';
import {
  handleSeasonDialog,
  RedisSeasonDialogStore,
  WIZARD_EXPIRED,
  type KeyboardButton,
  type SeasonDialogOutcome,
} from './season-dialog';
import { routeSeasonDecision, type DecisionJob } from './season-callbacks';
import { routeCoachDecision } from './coach-callbacks';

const config = getConfig();
const [encKey] = getEncKeys(config);

const bot = new Bot(config.TELEGRAM_BOT_TOKEN);

const redis = new Redis({ host: config.REDIS_HOST, port: config.REDIS_PORT });
const dialogStore = new RedisDialogStore(redis);
const seasonDialogStore = new RedisSeasonDialogStore(redis);

function toInlineKeyboard(rows: KeyboardButton[][] | undefined): InlineKeyboard | undefined {
  return rows
    ? InlineKeyboard.from(rows.map((row) => row.map((b) => InlineKeyboard.text(b.text, b.data))))
    : undefined;
}

/** Callback jobs are keyed by the tapped message, so a double tap enqueues one job. */
function callbackJobId(chatId: number, messageId: number): string {
  return `cb-${chatId.toString()}-${messageId.toString()}`;
}

async function enqueueSeasonPreview(
  chatId: number,
  userId: number,
  messageId: number,
  args: string[],
  jobId?: string
): Promise<void> {
  await enqueueCommand(
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
  logger.info({ userId, chatId, messageId, command: SEASON_PREVIEW_COMMAND }, 'Job enqueued');
}

// Middleware to log all updates. Metadata only: message text may contain secrets
// (e.g. an API key typed into the /connect icu dialog).
bot.use(async (ctx, next) => {
  logger.info(
    {
      updateId: ctx.update.update_id,
      fromId: ctx.from?.id,
      chatId: ctx.chat?.id,
      textLength: ctx.message?.text?.length,
    },
    'Received update'
  );
  await next();
});

// Handle all text messages (commands and regular text)
bot.on('message:text', async (ctx) => {
  try {
    const text = ctx.message.text;
    const userId = ctx.from.id;
    const chatId = ctx.chat.id;
    const messageId = ctx.message.message_id;

    // The /connect icu dialog is handled here so the API key is encrypted before it reaches the queue
    const dialog = await handleConnectDialog(userId, text, dialogStore, encKey);
    // One dialog at a time: the connect dialog taking a message ends the season wizard
    if (dialog.kind !== 'pass') await seasonDialogStore.delete(userId);

    if (dialog.kind === 'reply') {
      await ctx.reply(dialog.text);
      return;
    }

    if (dialog.kind === 'submit') {
      try {
        await ctx.deleteMessage();
      } catch (deleteError) {
        logger.warn({ error: deleteError, userId }, 'Could not delete API key message');
      }
      await enqueueCommand({
        telegramChatId: chatId,
        telegramUserId: userId,
        messageId,
        commandName: 'connect_icu',
        args: [],
        rawText: '',
        icuCredentials: dialog.credentials,
      });
      logger.info({ userId, chatId, messageId, command: 'connect_icu' }, 'Job enqueued');
      await ctx.reply('👀 Checking your intervals.icu credentials...');
      return;
    }

    const season = await handleSeasonDialog(userId, { kind: 'text', text }, seasonDialogStore);

    if (season.kind === 'reply') {
      await ctx.reply(season.text, { reply_markup: toInlineKeyboard(season.keyboard) });
      return;
    }

    if (season.kind === 'submit') {
      await enqueueSeasonPreview(chatId, userId, messageId, season.args);
      await ctx.reply(season.text);
      return;
    }

    const parsed = parseCommand(text);

    // Create job payload
    const jobPayload: CommandJob = {
      telegramChatId: chatId,
      telegramUserId: userId,
      messageId,
      commandName: parsed.commandName,
      args: parsed.args,
      rawText: text,
    };

    await enqueueCommand(jobPayload);

    logger.info(
      {
        userId,
        chatId,
        messageId,
        command: parsed.commandName,
      },
      'Job enqueued'
    );

    // Quick acknowledgment: the coach is "typing" an answer, commands get 👀
    if (parsed.commandName === COACH_CHAT_COMMAND) {
      await ctx.replyWithChatAction('typing');
    } else if (parsed.commandName !== 'start') {
      await ctx.react('👀');
    }
  } catch (error) {
    logger.error({ error }, 'Error handling message');
    try {
      await ctx.reply('❌ Sorry, something went wrong. Please try again.');
    } catch (replyError) {
      logger.error({ error: replyError }, 'Failed to send error reply');
    }
  }
});

/** Edits the tapped message; Telegram refuses an edit that changes nothing, which is fine. */
async function editTapped(ctx: Context, text: string | null, keyboard?: KeyboardButton[][]) {
  try {
    const reply_markup = toInlineKeyboard(keyboard);
    await (text === null
      ? ctx.editMessageReplyMarkup({ reply_markup })
      : ctx.editMessageText(text, { reply_markup }));
  } catch (error) {
    logger.warn({ error, userId: ctx.from?.id }, 'Could not edit tapped message');
  }
}

/** Wizard button: next step in place of the wizard message, or the preview job. */
async function applyWizardTap(ctx: Context, outcome: SeasonDialogOutcome, messageId: number) {
  const userId = ctx.from?.id;
  const chatId = ctx.chat?.id;
  if (outcome.kind === 'reply') await editTapped(ctx, outcome.text, outcome.keyboard);
  if (outcome.kind === 'submit' && userId !== undefined && chatId !== undefined) {
    await editTapped(ctx, outcome.text);
    await enqueueSeasonPreview(
      chatId,
      userId,
      messageId,
      outcome.args,
      callbackJobId(chatId, messageId)
    );
  }
  await ctx.answerCallbackQuery();
}

/** Decision button: drop the buttons so they can't be tapped again, then enqueue the decision. */
async function applyDecisionTap(ctx: Context, job: DecisionJob, messageId: number) {
  const userId = ctx.from?.id;
  const chatId = ctx.chat?.id;
  if (userId === undefined || chatId === undefined) return;
  await editTapped(ctx, null);
  await enqueueCommand(
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
  logger.info({ userId, chatId, messageId, command: job.commandName }, 'Job enqueued');
  await ctx.answerCallbackQuery({ text: job.toast });
}

// Inline buttons: coach Apply/Keep, the season wizard steps and the season preview's confirm/cancel
bot.on('callback_query:data', async (ctx) => {
  try {
    const { data, message } = ctx.callbackQuery;
    if (!message) {
      await ctx.answerCallbackQuery({ text: WIZARD_EXPIRED });
      return;
    }
    const decision = routeCoachDecision(data) ?? routeSeasonDecision(data);
    if (decision) {
      await applyDecisionTap(ctx, decision, message.message_id);
      return;
    }
    const outcome = await handleSeasonDialog(
      ctx.from.id,
      { kind: 'callback', data },
      seasonDialogStore
    );
    await applyWizardTap(ctx, outcome, message.message_id);
  } catch (error) {
    logger.error({ error }, 'Error handling button');
    try {
      await ctx.answerCallbackQuery({ text: '❌ Sorry, something went wrong. Please try again.' });
    } catch (answerError) {
      logger.error({ error: answerError }, 'Failed to answer button');
    }
  }
});

// Handle errors
bot.catch((err) => {
  logger.error({ error: err }, 'Bot error');
});

// Start bot
async function start() {
  try {
    logger.info('Starting bot...');
    await bot.start({
      onStart: (botInfo) => {
        logger.info({ username: botInfo.username, id: botInfo.id }, '🤖 Bot started successfully');
      },
    });
  } catch (error) {
    logger.error({ error }, 'Failed to start bot');
    process.exit(1);
  }
}

// Graceful shutdown
process.once('SIGINT', () => {
  logger.info('Received SIGINT, stopping bot...');
  void bot.stop();
  void commandQueue.close();
  redis.disconnect();
});

process.once('SIGTERM', () => {
  logger.info('Received SIGTERM, stopping bot...');
  void bot.stop();
  void commandQueue.close();
  redis.disconnect();
});

void start();
