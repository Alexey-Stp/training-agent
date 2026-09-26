import 'dotenv/config';
import { Bot } from 'grammy';
import Redis from 'ioredis';
import { getConfig, getEncKeys } from '@triathlon/core';
import type { CommandJob } from '@triathlon/core';
import { commandQueue, enqueueCommand } from './queue';
import { logger } from './logger';
import { parseCommand } from './parser';
import { handleConnectDialog, RedisDialogStore } from './connect-dialog';

const config = getConfig();
const [encKey] = getEncKeys(config);

const bot = new Bot(config.TELEGRAM_BOT_TOKEN);

const redis = new Redis({ host: config.REDIS_HOST, port: config.REDIS_PORT });
const dialogStore = new RedisDialogStore(redis);

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

    // Send quick acknowledgment for non-start commands
    if (parsed.commandName !== 'start') {
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
