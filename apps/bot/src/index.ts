import 'dotenv/config';
import { Bot } from 'grammy';
import { getConfig } from '@triathlon/core';
import type { CommandJob } from '@triathlon/core';
import { commandQueue } from './queue';
import { logger } from './logger';
import { parseCommand } from './parser';

const config = getConfig();

const bot = new Bot(config.TELEGRAM_BOT_TOKEN);

// Middleware to log all updates
bot.use(async (ctx, next) => {
  logger.info({ update: ctx.update }, 'Received update');
  await next();
});

// Handle all text messages (commands and regular text)
bot.on('message:text', async (ctx) => {
  try {
    const text = ctx.message.text;
    const userId = ctx.from.id;
    const chatId = ctx.chat.id;
    const messageId = ctx.message.message_id;

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

    // Enqueue job
    await commandQueue.add('command', jobPayload, {
      attempts: 3,
      backoff: {
        type: 'exponential',
        delay: 2000,
      },
      removeOnComplete: {
        age: 3600, // Keep completed jobs for 1 hour
        count: 100,
      },
      removeOnFail: {
        age: 86400, // Keep failed jobs for 24 hours
      },
    });

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
  bot.stop();
});

process.once('SIGTERM', () => {
  logger.info('Received SIGTERM, stopping bot...');
  bot.stop();
});

start();
