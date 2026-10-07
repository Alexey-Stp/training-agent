import { Api, GrammyError } from 'grammy';
import type { ChatVerifier } from './settings/store';

export const TEST_MESSAGE =
  '✅ Triathlon Coach: briefs and reviews will be posted to this chat from now on.';

/**
 * Verifies a notification chat with the bot token: the chat must exist for the bot and accept
 * a message. Telegram's own error text is shown, so the athlete knows what to fix.
 */
export function createChatVerifier(api: Pick<Api, 'getChat' | 'sendMessage'>): ChatVerifier {
  return {
    async verify(chatId) {
      try {
        await api.getChat(chatId);
        await api.sendMessage(chatId, TEST_MESSAGE);
        return { ok: true };
      } catch (error) {
        const reason =
          error instanceof GrammyError ? error.description : 'Telegram is not reachable';
        return {
          ok: false,
          message:
            'The bot cannot post there (' + reason + '). Add the bot to that chat and try again.',
        };
      }
    },
  };
}
